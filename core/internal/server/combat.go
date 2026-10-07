package server

import (
	"gomp/core/internal/combat"
	"gomp/core/internal/world"
	"gomp/wire/proto"
	"gomp/wire/transport"
)

const (
	maxMuzzleOffset = 6   // metres between the player and the reported shot origin
	hitSlack        = 3   // metres of tolerance for hit positions on peds
	vehicleHitSlack = 6   // vehicles are larger
	lagWindow       = 0.5 // seconds of target movement tolerated for latency
)

// Reasons reported in playerDeath for environment damage (GTA weapon hashes).
var causeHashes = map[proto.DamageCause]uint32{
	proto.CauseFall:      proto.Joaat("weapon_fall"),
	proto.CauseFire:      proto.Joaat("weapon_fire"),
	proto.CauseDrown:     proto.Joaat("weapon_drowning"),
	proto.CauseVehicle:   proto.Joaat("weapon_rammed_by_car"),
	proto.CauseExplosion: proto.Joaat("weapon_explosion"),
}

func (s *Server) rejectShot(r combat.Reject) {
	s.metrics.shotsRejected.Add(1)
	s.log.Debug("shot rejected", "reason", r.String())
}

func (s *Server) onWeaponShot(c *client, m *proto.WeaponShot) {
	p := c.p
	if p.Dead || !p.Spawned {
		s.rejectShot(combat.RejectDead)
		return
	}
	w := s.weapons.Get(m.Weapon)
	if w == nil {
		s.rejectShot(combat.RejectUnknownWeapon)
		return
	}
	ammo, owned := p.Weapons[w.Hash]
	if !owned && w.Hash != unarmed {
		s.rejectShot(combat.RejectWeaponNotOwned)
		s.sendLoadout(c)
		return
	}
	if !m.Origin.IsFinite() || !m.Target.IsFinite() || m.Origin.DistSq(p.Pos) > maxMuzzleOffset*maxMuzzleOffset {
		s.rejectShot(combat.RejectHitMismatch)
		return
	}
	if !c.shots.FireAllowed(w, s.now) {
		s.rejectShot(combat.RejectFireRate)
		return
	}
	if w.UsesAmmo() {
		if ammo == 0 {
			s.rejectShot(combat.RejectNoAmmo)
			return
		}
		p.Weapons[w.Hash] = ammo - 1
		s.hostUpdate(p, "weapons", weaponsValue(p))
	}
	if p.Weapon != w.Hash {
		s.applyWeaponSwitch(c, w.Hash)
	}
	c.shots.Record(m.Seq, w, m.Origin, s.now)
	s.metrics.shotsAccepted.Add(1)
	out := &proto.WeaponShotOut{PlayerID: p.ID, WeaponShot: *m}
	s.toStreamers(p, transport.Unreliable, out, false)
}

func (s *Server) onWeaponHit(c *client, m *proto.WeaponHit) {
	p := c.p
	reject := func(r combat.Reject) {
		s.metrics.hitsRejected.Add(1)
		s.log.Debug("hit rejected", "player", p.Name, "reason", r.String())
	}
	if p.Dead || !p.Spawned {
		reject(combat.RejectDead)
		return
	}
	w := s.weapons.Get(m.Weapon)
	if w == nil {
		reject(combat.RejectUnknownWeapon)
		return
	}
	target := s.world.Get(m.TargetType, m.TargetID)
	if target == nil || (m.TargetType != proto.EntityPlayer && m.TargetType != proto.EntityVehicle) {
		reject(combat.RejectBadTarget)
		return
	}
	tb := target.Base()
	if !c.stream.Has(tb.Key()) || !sameDim(tb.Dimension, p.Dimension) || !m.HitPos.IsFinite() {
		reject(combat.RejectBadTarget)
		return
	}
	var origin proto.Vec3
	if m.Flags&proto.HitMelee != 0 {
		if !w.IsMelee() {
			reject(combat.RejectHitMismatch)
			return
		}
		if _, owned := p.Weapons[w.Hash]; !owned && w.Hash != unarmed {
			reject(combat.RejectWeaponNotOwned)
			return
		}
		if !c.shots.FireAllowed(w, s.now) {
			reject(combat.RejectFireRate)
			return
		}
		origin = p.Pos
	} else {
		shot, ok := c.shots.Claim(m.ShotSeq, m.Weapon, s.now)
		if !ok {
			reject(combat.RejectNoShot)
			return
		}
		origin = shot.Origin
	}
	// Range check from where the shot was fired to the target's current position.
	reach := w.Range + 2
	if origin.DistSq(tb.Pos) > reach*reach {
		reject(combat.RejectTooFar)
		return
	}
	// The claimed impact must be near the target, allowing for its motion during latency.
	var speed float32
	slack := float32(hitSlack)
	switch t := target.(type) {
	case *world.Player:
		speed = t.Vel.Len()
		if t.Vehicle != nil {
			speed = t.Vehicle.Vel.Len()
			slack = vehicleHitSlack
		}
	case *world.Vehicle:
		speed = t.Vel.Len()
		slack = vehicleHitSlack
	}
	tol := slack + speed*lagWindow
	if m.HitPos.DistSq(tb.Pos) > tol*tol {
		reject(combat.RejectHitMismatch)
		return
	}
	s.metrics.hitsAccepted.Add(1)
	switch t := target.(type) {
	case *world.Player:
		if t == p || t.Dead {
			return
		}
		s.damagePlayer(t, combat.DamagePerHit(w, m.Bone, s.combat), p, w.Hash, m.Bone)
	case *world.Vehicle:
		if t.Dead {
			return
		}
		dmg := float32(w.Damage)
		s.damageVehicle(t, dmg, dmg*0.5)
	}
}

// damagePlayer applies validated damage and replicates the new health.
func (s *Server) damagePlayer(t *world.Player, dmg int, attacker *world.Player, weapon uint32, bone uint16) {
	if t.Dead || dmg <= 0 {
		return
	}
	h, a, hl, al := combat.Apply(t.Health, t.Armour, dmg)
	t.Health, t.Armour = h, a
	s.replicate(t, proto.Props{proto.PropHealth: int64(h), proto.PropArmour: int64(a)}, true)
	s.hostUpdate(t, "health", int64(h))
	s.hostUpdate(t, "armour", int64(a))
	var attackerRef proto.Value
	if attacker != nil {
		attackerRef = attacker.Key()
	}
	s.emit("playerDamage", t.Key(), int64(hl), int64(al), attackerRef, int64(weapon), int64(bone))
	if h == 0 {
		s.killPlayer(t, weapon, attacker)
	}
}

// killPlayer marks t dead (playerDeath). Without scripts, auto-respawn kicks in.
func (s *Server) killPlayer(t *world.Player, reason uint32, killer *world.Player) {
	if t.Dead {
		return
	}
	t.Dead = true
	t.Health = 0
	s.metrics.deaths.Add(1)
	s.clearReservation(t)
	s.replicate(t, proto.Props{proto.PropDead: true, proto.PropHealth: int64(0)}, true)
	s.hostUpdate(t, "dead", true)
	s.hostUpdate(t, "health", int64(0))
	var killerRef proto.Value
	if killer != nil && killer != t {
		killerRef = killer.Key()
	}
	s.emit("playerDeath", t.Key(), int64(reason), killerRef)
	if c := s.clientOf(t); c != nil && s.cfg.GoMP.AutoSpawn && !s.scriptsActive() {
		c.respawnAt = s.now.Add(s.respawnDelay)
	}
}

func (s *Server) damageVehicle(v *world.Vehicle, body, engine float32) {
	v.BodyHealth = max(0, v.BodyHealth-body)
	v.EngineHealth -= engine
	s.vstate(v).healthUntil = s.now.Add(healthLock)
	s.replicate(v, proto.Props{proto.PropBodyHealth: float64(v.BodyHealth), proto.PropEngineHealth: float64(v.EngineHealth)}, false)
	s.hostUpdate(v, "bodyHealth", float64(v.BodyHealth))
	s.hostUpdate(v, "engineHealth", float64(v.EngineHealth))
	s.emit("vehicleDamage", v.Key(), float64(body), float64(engine))
	if v.EngineHealth <= vehicleDeathHealth {
		s.killVehicle(v)
	}
}

// onSelfDamage applies environment damage reported by the victim, rate limited.
func (s *Server) onSelfDamage(c *client, m *proto.SelfDamage) {
	p := c.p
	if p.Dead || !p.Spawned {
		return
	}
	rate := float32(s.cfg.GoMP.MaxSelfHealthPerSec)
	refill(&c.envBudget, &c.envLast, s.now, rate, 200)
	want := float32(m.Health) + float32(m.Armour)
	if want <= 0 {
		return
	}
	scale := float32(1)
	if want > c.envBudget {
		scale = c.envBudget / want
	}
	c.envBudget -= want * scale
	hl := min(p.Health, int(float32(m.Health)*scale+0.5))
	al := min(p.Armour, int(float32(m.Armour)*scale+0.5))
	if hl == 0 && al == 0 {
		return
	}
	p.Health -= hl
	p.Armour -= al
	s.replicate(p, proto.Props{proto.PropHealth: int64(p.Health), proto.PropArmour: int64(p.Armour)}, true)
	s.hostUpdate(p, "health", int64(p.Health))
	s.hostUpdate(p, "armour", int64(p.Armour))
	s.emit("playerDamage", p.Key(), int64(hl), int64(al), nil, int64(causeHashes[m.Cause]), int64(0))
	if p.Health == 0 {
		s.killPlayer(p, causeHashes[m.Cause], nil)
	}
}
