package server

import (
	"errors"
	"fmt"
	"maps"
	"runtime/debug"
	"strconv"
	"strings"

	"gomp/core/internal/hostbridge"
	"gomp/core/internal/world"
	"gomp/wire/proto"
	"gomp/wire/transport"
)

var (
	errNoEntity = errors.New("entity does not exist")
	errStaleRef = errors.New("stale player reference")
)

// execHostOp runs one command from a script host. Malformed commands return
// errors; they never take the core down.
func (s *Server) execHostOp(h *hostState, op hostbridge.Op) (err error) {
	defer func() {
		if r := recover(); r != nil {
			s.log.Error("panic while executing script command", "op", op[0], "panic", r, "stack", string(debug.Stack()))
			err = fmt.Errorf("internal error: %v", r)
		}
	}()
	name, _ := op[0].(string)
	x := &args{a: op[1:]}
	switch name {
	case hostbridge.CmdSubscribe, hostbridge.CmdUnsubscribe:
		for _, n := range x.list(0) {
			if ev, ok := n.(string); ok {
				if name == hostbridge.CmdSubscribe {
					h.subs[ev] = true
				} else {
					delete(h.subs, ev)
				}
			}
		}
	case hostbridge.CmdLoaded:
		h.loaded = true
		if !s.scriptsLoaded {
			s.scriptsLoaded = true
		}
		s.log.Info("script host loaded packages", "host", h.name, "packages", x.val(0))
	case hostbridge.CmdCreate:
		return s.apiCreate(h, x)
	case hostbridge.CmdDestroy:
		ent, err := s.resolveCmd(x, 0)
		if err != nil {
			return err
		}
		if ent.Base().Type == proto.EntityPlayer {
			return errors.New("players cannot be destroyed; use kick")
		}
		s.destroyEntity(ent)
	case hostbridge.CmdSet:
		ent, err := s.resolveCmd(x, 0)
		if err != nil {
			return err
		}
		key := x.str(3)
		if x.err != nil {
			return x.err
		}
		return s.apiSet(ent, key, &args{a: op[5:]})
	case hostbridge.CmdCall:
		ent, err := s.resolveCmd(x, 0)
		if err != nil {
			return err
		}
		method := x.str(3)
		list := x.list(4)
		if x.err != nil {
			return x.err
		}
		return s.apiCall(h, ent, method, &args{a: list})
	case hostbridge.CmdGlobal:
		method := x.str(0)
		list := x.list(1)
		if x.err != nil {
			return x.err
		}
		return s.apiGlobal(method, &args{a: list})
	case hostbridge.CmdProcResult:
		id := uint32(x.int(0))
		ok := x.bool(1)
		if x.err != nil {
			return x.err
		}
		sp, found := s.serverProcs[id]
		if !found {
			return nil // timed out or player left
		}
		delete(s.serverProcs, id)
		if c := s.clientByRef(sp.player); c != nil {
			res := &proto.ProcResult{CallID: sp.clientCallID, OK: ok}
			if ok {
				res.Result = x.val(2)
			} else {
				res.Error = fmt.Sprint(x.val(2))
			}
			s.sendTo(c, transport.Reliable, res)
		}
	case hostbridge.CmdProcCall:
		hostCallID := uint32(x.int(0))
		pid, gen := x.int(1), x.int(2)
		procName := x.str(3)
		list := x.list(4)
		if x.err != nil {
			return x.err
		}
		c := s.clientByRef(world.Ref{Type: proto.EntityPlayer, ID: uint16(pid), Gen: uint16(gen)})
		if c == nil {
			s.sendToHost(h.id, hostOp(hostbridge.OpProcRes, int64(hostCallID), false, "player not connected"))
			return nil
		}
		c.nextProcID++
		c.procs[c.nextProcID] = clientProc{host: h.id, hostCallID: hostCallID, expires: s.now.Add(procTimeout)}
		s.sendTo(c, transport.Reliable, &proto.ProcCall{CallID: c.nextProcID, Name: procName, Args: list})
	case hostbridge.CmdShutdownReady:
		h.shutdownReady = true
	default:
		return fmt.Errorf("unknown operation %q", name)
	}
	return x.err
}

// resolveCmd reads (type, id, gen) at i. Generations are enforced for players,
// whose ids are reused by the core; other entities are owned by the host.
func (s *Server) resolveCmd(x *args, i int) (world.Entity, error) {
	t := proto.EntityType(x.int(i))
	id := x.int(i + 1)
	gen := x.int(i + 2)
	if x.err != nil {
		return nil, x.err
	}
	if id < 0 || id >= int64(proto.NoID) {
		return nil, errNoEntity
	}
	ent := s.world.Get(t, uint16(id))
	if ent == nil {
		return nil, errNoEntity
	}
	if t == proto.EntityPlayer && ent.Base().Gen != uint16(gen) {
		return nil, errStaleRef
	}
	return ent, nil
}

func propsFromState(st map[string]proto.Value) (proto.Props, error) {
	raw, _ := st["props"].(map[string]proto.Value)
	if len(raw) == 0 {
		return nil, nil
	}
	props := make(proto.Props, len(raw))
	for k, v := range raw {
		id, err := strconv.Atoi(k)
		if err != nil || id <= 0 || id > 255 {
			return nil, fmt.Errorf("invalid prop id %q", k)
		}
		if v != nil {
			props[proto.PropID(id)] = v
		}
	}
	return props, nil
}

// apiCreate creates an entity with an id chosen by the host inside its range.
func (s *Server) apiCreate(h *hostState, x *args) error {
	t := proto.EntityType(x.int(0))
	id := x.int(1)
	st := x.kv(2)
	if x.err != nil {
		return x.err
	}
	sx := &args{a: []proto.Value{st["model"], st["pos"], st["rot"], st["dim"], st["alpha"], st["heading"]}}
	base := world.EntityBase{Alpha: 255, Origin: h.id}
	if sx.has(0) {
		base.Model = sx.u32(0)
	}
	base.Pos = sx.vec(1)
	if sx.has(2) {
		base.Rot = sx.vec(2)
	}
	if sx.has(3) {
		base.Dimension = uint32(sx.int(3))
	}
	if sx.has(4) {
		base.Alpha = uint8(clampInt(sx.int(4), 0, 255))
	}
	heading := float32(0)
	if sx.has(5) {
		heading = float32(sx.float(5))
	}
	if sx.err != nil {
		return sx.err
	}
	props, err := propsFromState(st)
	if err != nil {
		return err
	}
	base.Props = props
	if sh, ok := st["shared"].(map[string]proto.Value); ok && len(sh) > 0 {
		base.Shared = maps.Clone(sh)
	}
	num := func(k string, def float32) float32 {
		if f, ok := asFloat(st[k]); ok {
			return float32(f)
		}
		return def
	}
	var ent world.Entity
	switch t {
	case proto.EntityVehicle:
		if !sx.has(2) {
			base.Rot = proto.Vec3{Z: heading}
		}
		v := world.NewVehicle(base.Model, base.Pos, base.Rot.Z, s.vehicles.Seats(base.Model))
		v.EntityBase = base
		v.Quat = proto.QuatFromEuler(base.Rot)
		v.Engine, _ = st["engine"].(bool)
		v.Locked, _ = st["locked"].(bool)
		if m, ok := st["movable"].(bool); ok {
			v.Movable = m
		}
		ent = v
	case proto.EntityObject:
		ent = &world.Object{EntityBase: base}
	case proto.EntityPed:
		ent = &world.Ped{EntityBase: base, Heading: heading}
	case proto.EntityBlip:
		ent = &world.Blip{EntityBase: base}
	case proto.EntityMarker:
		ent = &world.Marker{EntityBase: base}
	case proto.EntityCheckpoint:
		ent = &world.Checkpoint{EntityBase: base, Radius: num("radius", 1)}
	case proto.EntityTextLabel:
		ent = &world.TextLabel{EntityBase: base}
	case proto.EntityDummy:
		dt, _ := asFloat(st["dummyType"])
		ent = &world.Dummy{EntityBase: base, DummyType: int(dt)}
	case proto.EntityColshape:
		cs := &world.Colshape{EntityBase: base, Radius: num("radius", 0), Width: num("width", 0),
			Depth: num("depth", 0), Height: num("height", 0), MinZ: num("minZ", -1e4), MaxZ: num("maxZ", 1e4)}
		kind, _ := asFloat(st["shape"])
		cs.Kind = world.ShapeKind(kind)
		if cs.Kind > world.ShapePolygon {
			return fmt.Errorf("unknown colshape kind %d", cs.Kind)
		}
		if pts, ok := st["points"].([]proto.Value); ok {
			px := &args{a: pts}
			for i := range pts {
				cs.Points = append(cs.Points, px.vec(i))
			}
			if px.err != nil {
				return px.err
			}
		}
		ent = cs
	default:
		return fmt.Errorf("cannot create entities of type %d", t)
	}
	if id < 0 || id >= int64(s.poolCap(t)) {
		return fmt.Errorf("id %d outside the host's range", id)
	}
	if err := s.world.Add(ent, int(id)); err != nil {
		return err
	}
	s.indexEntity(ent)
	if t == proto.EntityBlip || t == proto.EntityDummy {
		s.publishGlobal(ent)
	}
	s.hostCreate(ent)
	return nil
}

// ------------------------------------------------------------------ setters

func (s *Server) apiSet(ent world.Entity, key string, x *args) error {
	b := ent.Base()
	switch key {
	case "pos":
		pos := x.vec(0)
		if x.err != nil {
			return x.err
		}
		if !validPos(pos) {
			return errors.New("position out of the world")
		}
		s.setPosition(ent, pos)
		return nil
	case "rot":
		rot := x.vec(0)
		if x.err != nil {
			return x.err
		}
		s.setRotation(ent, rot)
		return nil
	case "dim":
		d := x.int(0)
		if x.err != nil {
			return x.err
		}
		s.setDimension(ent, uint32(d))
		return nil
	case "model":
		m := x.u32(0)
		if x.err != nil {
			return x.err
		}
		b.Model = m
		s.replicate(ent, proto.Props{proto.PropModel: int64(m)}, true)
		s.hostUpdate(ent, "model", int64(m))
		return nil
	case "alpha":
		a := uint8(clampInt(x.int(0), 0, 255))
		if x.err != nil {
			return x.err
		}
		b.Alpha = a
		s.replicate(ent, proto.Props{proto.PropAlpha: int64(a)}, true)
		s.hostUpdate(ent, "alpha", int64(a))
		return nil
	case "props":
		raw := x.kv(0)
		if x.err != nil {
			return x.err
		}
		props, err := propsFromState(map[string]proto.Value{"props": raw})
		if err != nil {
			return err
		}
		// nil values delete; keep them in the replicated update.
		for k, v := range raw {
			if v == nil {
				id, _ := strconv.Atoi(k)
				if props == nil {
					props = proto.Props{}
				}
				props[proto.PropID(id)] = nil
			}
		}
		s.setProps(ent, props, true)
		return nil
	case "shared":
		s.setShared(ent, x.kv(0), false)
		return x.err
	case "own":
		s.setShared(ent, x.kv(0), true)
		return x.err
	}
	switch e := ent.(type) {
	case *world.Player:
		return s.setPlayer(e, key, x)
	case *world.Vehicle:
		return s.setVehicle(e, key, x)
	case *world.Ped:
		if key == "heading" {
			e.Heading = float32(x.float(0))
			s.replicate(e, proto.Props{proto.PropHeading: float64(e.Heading)}, false)
			s.hostUpdate(e, "heading", float64(e.Heading))
			return x.err
		}
	case *world.Checkpoint:
		if key == "radius" {
			e.Radius = float32(x.float(0))
			s.maxShapeRadius = max(s.maxShapeRadius, e.Radius)
			s.replicate(e, proto.Props{proto.PropCheckpointRadius: float64(e.Radius)}, false)
			s.hostUpdate(e, "radius", float64(e.Radius))
			return x.err
		}
	}
	return fmt.Errorf("unknown property %q for %s", key, b.Type)
}

func (s *Server) setPlayer(p *world.Player, key string, x *args) error {
	c := s.clientOf(p)
	switch key {
	case "health", "armour":
		v := int(clampInt(x.int(0), 0, 100))
		if x.err != nil {
			return x.err
		}
		if key == "health" {
			if p.Dead && v > 0 {
				return errors.New("player is dead; use spawn")
			}
			p.Health = v
			s.replicate(p, proto.Props{proto.PropHealth: int64(v)}, true)
			s.hostUpdate(p, "health", int64(v))
			if v == 0 {
				s.killPlayer(p, 0, nil)
			}
		} else {
			p.Armour = v
			s.replicate(p, proto.Props{proto.PropArmour: int64(v)}, true)
			s.hostUpdate(p, "armour", int64(v))
		}
	case "name":
		n := x.str(0)
		if x.err != nil {
			return x.err
		}
		if !validName(n) {
			return errors.New("invalid name")
		}
		p.Name = n
		s.replicate(p, proto.Props{proto.PropName: n}, true)
		s.hostUpdate(p, "name", n)
	case "heading":
		h := float32(x.float(0))
		if x.err != nil {
			return x.err
		}
		p.Heading = h
		s.teleport(p, p.Pos, h, proto.PosTeleport)
		s.hostUpdate(p, "heading", float64(h))
	case "weapon":
		w := x.u32(0)
		if x.err != nil {
			return x.err
		}
		if _, owned := p.Weapons[w]; !owned && w != unarmed {
			p.Weapons[w] = 0
		}
		old := p.Weapon
		p.Weapon = w
		if c != nil {
			s.sendLoadout(c)
		}
		if old != w {
			s.emit("playerWeaponChange", p.Key(), int64(old), int64(w))
		}
	case "weaponAmmo":
		a := uint16(clampInt(x.int(0), 0, 65535))
		if x.err != nil {
			return x.err
		}
		if p.Weapon != unarmed {
			p.Weapons[p.Weapon] = a
			if c != nil {
				s.sendLoadout(c)
			}
		}
	case "disableOutgoingSync":
		p.DisableOutgoingSync = x.bool(0)
		s.markSync(p)
	case "eyeColor":
		s.setProps(p, proto.Props{proto.PropEyeColor: x.int(0)}, true)
	case "gameType":
		p.GameType = x.str(0)
		s.hostUpdate(p, "gameType", p.GameType)
	default:
		return fmt.Errorf("unknown player property %q", key)
	}
	return x.err
}

func (s *Server) setVehicle(v *world.Vehicle, key string, x *args) error {
	switch key {
	case "engine":
		v.Engine = x.bool(0)
		if v.Engine {
			v.Flags |= proto.VehEngineOn
		} else {
			v.Flags &^= proto.VehEngineOn
		}
		s.replicate(v, proto.Props{proto.PropEngine: v.Engine}, false)
		s.hostUpdate(v, "engine", v.Engine)
	case "locked":
		v.Locked = x.bool(0)
		s.replicate(v, proto.Props{proto.PropLocked: v.Locked}, false)
		s.hostUpdate(v, "locked", v.Locked)
	case "dead":
		if x.bool(0) {
			s.killVehicle(v)
		}
	case "movable":
		v.Movable = x.bool(0)
		s.replicate(v, proto.Props{proto.PropMovable: v.Movable}, false)
		s.hostUpdate(v, "movable", v.Movable)
	case "bodyHealth", "engineHealth":
		f := float32(x.float(0))
		if x.err != nil {
			return x.err
		}
		if key == "bodyHealth" {
			v.BodyHealth = f
			s.replicate(v, proto.Props{proto.PropBodyHealth: float64(f)}, false)
		} else {
			v.EngineHealth = f
			s.replicate(v, proto.Props{proto.PropEngineHealth: float64(f)}, false)
		}
		s.vstate(v).healthUntil = s.now.Add(healthLock)
		s.hostUpdate(v, key, float64(f))
	case "controller":
		if !x.has(0) {
			s.setController(v, nil, false)
			s.assignController(v)
			return nil
		}
		r, ok := x.ref(0)
		if !ok {
			return x.err
		}
		p := s.world.Players.Get(r.ID)
		if p == nil || r.Type != proto.EntityPlayer {
			return errNoEntity
		}
		if v.Driver() == nil {
			s.setController(v, p, true)
		}
	case "heading":
		rot := v.Rot
		rot.Z = float32(x.float(0))
		s.setRotation(v, rot)
	default:
		return fmt.Errorf("unknown vehicle property %q", key)
	}
	return x.err
}

func (s *Server) setPosition(ent world.Entity, pos proto.Vec3) {
	b := ent.Base()
	switch e := ent.(type) {
	case *world.Player:
		if e.Vehicle != nil {
			s.removeFromVehicle(e, true)
		}
		s.teleport(e, pos, proto.KeepHeading, proto.PosTeleport)
		s.hostUpdate(e, "pos", pos)
		return
	case *world.Vehicle:
		b.Pos = pos
		s.vstate(e).mover.Reset()
		if d := e.Driver(); d != nil {
			s.teleport(d, pos, proto.KeepHeading, proto.PosTeleport)
		} else {
			s.replicate(e, proto.Props{proto.PropPosition: pos}, false)
		}
		s.grid.Upsert(b.Key(), b.Dimension, pos)
		s.moveOccupants(e)
		s.markSync(e)
		s.hostUpdate(e, "pos", pos)
		return
	}
	b.Pos = pos
	s.indexEntity(ent)
	s.replicate(ent, proto.Props{proto.PropPosition: pos}, false)
	s.hostUpdate(ent, "pos", pos)
}

func (s *Server) setRotation(ent world.Entity, rot proto.Vec3) {
	b := ent.Base()
	b.Rot = rot
	if v, ok := ent.(*world.Vehicle); ok {
		v.Quat = proto.QuatFromEuler(rot)
		s.markSync(v)
	}
	s.replicate(ent, proto.Props{proto.PropRotation: rot}, false)
	s.hostUpdate(ent, "rot", rot)
}

// setShared merges shared variables (setVariable) or own variables
// (setOwnVariable, players only). nil values delete keys.
func (s *Server) setShared(ent world.Entity, kv map[string]proto.Value, own bool) {
	if len(kv) == 0 {
		return
	}
	b := ent.Base()
	msg := &proto.SharedData{Type: b.Type, EntID: b.ID, Own: own, Values: kv}
	if own {
		p, ok := ent.(*world.Player)
		if !ok {
			return
		}
		for k, v := range kv {
			if v == nil {
				delete(p.OwnShared, k)
			} else {
				if p.OwnShared == nil {
					p.OwnShared = map[string]proto.Value{}
				}
				p.OwnShared[k] = v
			}
		}
		if c := s.clientOf(p); c != nil {
			s.sendTo(c, transport.Reliable, msg)
		}
		s.hostUpdate(p, "own", kv)
		return
	}
	for k, v := range kv {
		b.SetShared(k, v)
	}
	switch b.Type {
	case proto.EntityDummy:
		s.toAll(transport.Reliable, msg)
	case proto.EntityBlip:
		for _, c := range s.byID {
			if c != nil {
				if _, ok := c.blips[b.ID]; ok {
					s.sendTo(c, transport.Reliable, msg)
				}
			}
		}
	default:
		s.toStreamers(ent, transport.Reliable, msg, true)
	}
	s.hostUpdate(ent, "shared", kv)
}

// updatePropMap edits one key inside a map-valued cosmetic property.
func (s *Server) updatePropMap(ent world.Entity, id proto.PropID, key string, v proto.Value) {
	b := ent.Base()
	m := map[string]proto.Value{}
	if old, ok := b.Props[id].(map[string]proto.Value); ok {
		maps.Copy(m, old)
	}
	if v == nil {
		delete(m, key)
	} else {
		m[key] = v
	}
	s.setProps(ent, proto.Props{id: m}, true)
}

// ------------------------------------------------------------------ methods

func (s *Server) apiCall(h *hostState, ent world.Entity, method string, x *args) error {
	switch method {
	case "setVariable":
		s.setShared(ent, map[string]proto.Value{x.str(0): x.val(1)}, false)
		return x.err
	case "setVariables":
		s.setShared(ent, x.kv(0), false)
		return x.err
	case "setOwnVariable":
		s.setShared(ent, map[string]proto.Value{x.str(0): x.val(1)}, true)
		return x.err
	case "setOwnVariables":
		s.setShared(ent, x.kv(0), true)
		return x.err
	}
	switch e := ent.(type) {
	case *world.Player:
		return s.callPlayer(h, e, method, x)
	case *world.Vehicle:
		return s.callVehicle(e, method, x)
	case *world.Marker, *world.Checkpoint:
		return s.callVisual(ent, method, x)
	case *world.Blip:
		return s.callBlip(e, method, x)
	}
	return fmt.Errorf("unknown method %q for %s", method, ent.Base().Type)
}

func (s *Server) callPlayer(h *hostState, p *world.Player, method string, x *args) error {
	c := s.clientOf(p)
	if c == nil {
		return errNoEntity
	}
	switch method {
	case "spawn":
		pos := x.vec(0)
		heading := p.Heading
		if x.has(1) {
			heading = float32(x.float(1))
		}
		if x.err != nil {
			return x.err
		}
		if !validPos(pos) {
			return errors.New("position out of the world")
		}
		s.spawnPlayer(p, pos, heading)
	case "giveWeapon":
		var hashes []uint32
		if list, ok := x.val(0).([]proto.Value); ok {
			lx := &args{a: list}
			for i := range list {
				hashes = append(hashes, lx.u32(i))
			}
			if lx.err != nil {
				return lx.err
			}
		} else {
			hashes = []uint32{x.u32(0)}
		}
		ammo := clampInt(x.int(1), 0, 65535)
		if x.err != nil {
			return x.err
		}
		for _, w := range hashes {
			if s.weapons.Get(w) == nil {
				return fmt.Errorf("unknown weapon hash %d", w)
			}
			p.Weapons[w] = uint16(clampInt(int64(p.Weapons[w])+ammo, 0, 65535))
		}
		old := p.Weapon
		p.Weapon = hashes[len(hashes)-1]
		s.sendLoadout(c)
		if old != p.Weapon {
			s.emit("playerWeaponChange", p.Key(), int64(old), int64(p.Weapon))
		}
	case "removeWeapon":
		w := x.u32(0)
		if x.err != nil {
			return x.err
		}
		delete(p.Weapons, w)
		if p.Weapon == w {
			p.Weapon = unarmed
		}
		s.sendLoadout(c)
	case "removeAllWeapons":
		clear(p.Weapons)
		p.Weapon = unarmed
		s.sendLoadout(c)
	case "setWeaponAmmo":
		w := x.u32(0)
		a := clampInt(x.int(1), 0, 65535)
		if x.err != nil {
			return x.err
		}
		if _, ok := p.Weapons[w]; !ok {
			return errors.New("player does not own this weapon")
		}
		p.Weapons[w] = uint16(a)
		s.sendLoadout(c)
	case "putIntoVehicle":
		r, ok := x.ref(0)
		seat := x.int(1)
		if !ok || x.err != nil {
			return x.err
		}
		v := s.world.Vehicles.Get(r.ID)
		if v == nil || r.Type != proto.EntityVehicle {
			return errNoEntity
		}
		if seat < 0 {
			seat = 0 // RAGE.MP 0.3 used -1 for the driver
		}
		if p.Dead {
			return errors.New("player is dead")
		}
		if !s.putIntoVehicle(p, v, uint8(clampInt(seat, 0, 255))) {
			return errors.New("seat does not exist")
		}
	case "removeFromVehicle":
		s.removeFromVehicle(p, true)
	case "kick":
		reason := "kicked"
		if x.has(0) {
			reason = x.str(0)
		}
		s.kick(c, reason)
	case "kickSilent":
		c.kicked = "kicked"
		c.conn.Disconnect("")
	case "ban":
		reason := "banned"
		if x.has(0) {
			reason = x.str(0)
		}
		if p.Serial != "" {
			s.bans[p.Serial] = reason
		}
		s.bans[p.IP] = reason
		s.kick(c, "banned: "+reason)
	case "outputChatBox":
		s.sendTo(c, transport.Reliable, &proto.Chat{Text: x.str(0)})
	case "notify":
		s.sendTo(c, transport.Reliable, &proto.Notify{Text: x.str(0)})
	case "call", "callUnreliable":
		name := x.str(0)
		list := x.list(1)
		if x.err != nil {
			return x.err
		}
		ch := transport.Reliable
		if method == "callUnreliable" {
			ch = transport.Unreliable
		}
		s.sendTo(c, ch, &proto.ScriptEvent{Name: name, Args: list})
	case "callToStreamed":
		self := x.bool(0)
		name := x.str(1)
		list := x.list(2)
		if x.err != nil {
			return x.err
		}
		s.toStreamers(p, transport.Reliable, &proto.ScriptEvent{Name: name, Args: list}, self)
	case "invoke":
		hash, err := parseNativeHash(x.val(0))
		if err != nil {
			return err
		}
		s.sendTo(c, transport.Reliable, &proto.Invoke{Hash: hash, Args: x.list(1)})
	case "eval":
		s.sendTo(c, transport.Reliable, &proto.ScriptEvent{Name: "__gomp:eval", Args: []proto.Value{x.str(0)}})
	case "setClothes":
		comp, d, t, pal := x.int(0), x.int(1), x.int(2), x.int(3)
		if x.err != nil {
			return x.err
		}
		s.updatePropMap(p, proto.PropClothes, strconv.FormatInt(comp, 10), []proto.Value{d, t, pal})
	case "setProp":
		prop, d, t := x.int(0), x.int(1), x.int(2)
		if x.err != nil {
			return x.err
		}
		s.updatePropMap(p, proto.PropAccessories, strconv.FormatInt(prop, 10), []proto.Value{d, t})
	case "setHeadBlend":
		if len(x.a) < 9 {
			return errors.New("setHeadBlend needs 9 arguments")
		}
		vals := make([]proto.Value, 9)
		for i := range 9 {
			vals[i] = x.float(i)
		}
		if x.err != nil {
			return x.err
		}
		s.setProps(p, proto.Props{proto.PropHeadBlend: vals}, true)
	case "updateHeadBlend":
		old, _ := p.Props[proto.PropHeadBlend].([]proto.Value)
		vals := make([]proto.Value, 9)
		for i := range 9 {
			vals[i] = float64(0)
			if i < len(old) {
				vals[i] = old[i]
			}
		}
		vals[6], vals[7], vals[8] = x.float(0), x.float(1), x.float(2)
		if x.err != nil {
			return x.err
		}
		s.setProps(p, proto.Props{proto.PropHeadBlend: vals}, true)
	case "setFaceFeature":
		idx, scale := x.int(0), x.float(1)
		if x.err != nil {
			return x.err
		}
		s.updatePropMap(p, proto.PropFaceFeatures, strconv.FormatInt(idx, 10), scale)
	case "setHeadOverlay":
		ov := x.int(0)
		val := x.list(1)
		if x.err != nil {
			return x.err
		}
		s.updatePropMap(p, proto.PropHeadOverlays, strconv.FormatInt(ov, 10), val)
	case "setDecoration":
		col, ov := x.u32(0), x.u32(1)
		if x.err != nil {
			return x.err
		}
		s.updatePropMap(p, proto.PropDecorations, strconv.FormatUint(uint64(col), 10)+":"+strconv.FormatUint(uint64(ov), 10), int64(ov))
	case "clearDecorations":
		s.setProps(p, proto.Props{proto.PropDecorations: nil}, true)
	case "setHairColor":
		a, b := x.int(0), x.int(1)
		if x.err != nil {
			return x.err
		}
		s.setProps(p, proto.Props{proto.PropHairColor: []proto.Value{a, b}}, true)
	case "setCustomization":
		return s.setCustomization(p, x)
	case "playAnimation":
		m := &proto.PlayAnim{PlayerID: p.ID, Dict: x.str(0), Name: x.str(1), Speed: float32(x.float(2)), Flag: int32(x.int(3))}
		if x.err != nil {
			return x.err
		}
		s.toStreamers(p, transport.Reliable, m, true)
	case "playScenario":
		m := &proto.PlayAnim{PlayerID: p.ID, Dict: "@scenario", Name: x.str(0)}
		if x.err != nil {
			return x.err
		}
		s.toStreamers(p, transport.Reliable, m, true)
	case "stopAnimation":
		s.toStreamers(p, transport.Reliable, &proto.PlayAnim{PlayerID: p.ID, Stop: true}, true)
	case "enableVoiceTo", "disableVoiceTo":
		// Voice chat is not implemented yet; accepted for compatibility.
	default:
		return fmt.Errorf("unknown player method %q", method)
	}
	return x.err
}

// setCustomization mirrors PlayerMp.setCustomization(gender, shapeFirst,
// shapeSecond, shapeThird, skinFirst, skinSecond, skinThird, shapeMix,
// skinMix, thirdMix, eyeColor, hairColor, highlightColor, faceFeatures[]).
func (s *Server) setCustomization(p *world.Player, x *args) error {
	if len(x.a) < 14 {
		return errors.New("setCustomization needs 14 arguments")
	}
	male := x.bool(0)
	blend := make([]proto.Value, 9)
	for i := range 9 {
		blend[i] = x.float(1 + i)
	}
	eye, hair, highlight := x.int(10), x.int(11), x.int(12)
	feats := map[string]proto.Value{}
	for i, f := range x.list(13) {
		if v, ok := asFloat(f); ok {
			feats[strconv.Itoa(i)] = v
		}
	}
	if x.err != nil {
		return x.err
	}
	model := proto.Joaat("mp_f_freemode_01")
	if male {
		model = proto.Joaat("mp_m_freemode_01")
	}
	p.Model = model
	s.replicate(p, proto.Props{proto.PropModel: int64(model)}, true)
	s.hostUpdate(p, "model", int64(model))
	s.setProps(p, proto.Props{
		proto.PropHeadBlend:    blend,
		proto.PropEyeColor:     eye,
		proto.PropHairColor:    []proto.Value{hair, highlight},
		proto.PropFaceFeatures: feats,
	}, true)
	return nil
}

func parseNativeHash(v proto.Value) (uint64, error) {
	switch h := v.(type) {
	case int64:
		return uint64(h), nil
	case float64:
		return uint64(h), nil
	case string:
		n, err := strconv.ParseUint(strings.TrimPrefix(strings.ToLower(h), "0x"), 16, 64)
		if err != nil {
			return 0, fmt.Errorf("invalid native hash %q", h)
		}
		return n, nil
	}
	return 0, fmt.Errorf("invalid native hash %v", v)
}

func (s *Server) callVehicle(v *world.Vehicle, method string, x *args) error {
	switch method {
	case "explode":
		s.toStreamers(v, transport.Reliable, &proto.VehicleExplode{VehicleID: v.ID}, false)
		v.EngineHealth = vehicleDeathHealth
		v.BodyHealth = 0
		s.killVehicle(v)
	case "repair":
		v.BodyHealth, v.EngineHealth, v.Dead = 1000, 1000, false
		s.vstate(v).healthUntil = s.now.Add(healthLock)
		s.replicate(v, proto.Props{proto.PropBodyHealth: float64(1000), proto.PropEngineHealth: float64(1000), proto.PropDead: false}, false)
		s.hostUpdate(v, "bodyHealth", float64(1000))
		s.hostUpdate(v, "engineHealth", float64(1000))
		s.hostUpdate(v, "dead", false)
	case "setColor":
		a, b := x.int(0), x.int(1)
		if x.err != nil {
			return x.err
		}
		s.setProps(v, proto.Props{proto.PropColors: []proto.Value{a, b}, proto.PropColorRGB: nil}, false)
	case "setColorRGB":
		vals := make([]proto.Value, 6)
		for i := range 6 {
			vals[i] = clampInt(x.int(i), 0, 255)
		}
		if x.err != nil {
			return x.err
		}
		s.setProps(v, proto.Props{proto.PropColorRGB: vals}, false)
	case "setExtra":
		i, on := x.int(0), x.bool(1)
		if x.err != nil {
			return x.err
		}
		s.updatePropMap(v, proto.PropExtras, strconv.FormatInt(i, 10), on)
	case "setMod":
		t, idx := x.int(0), x.int(1)
		if x.err != nil {
			return x.err
		}
		s.updatePropMap(v, proto.PropMods, strconv.FormatInt(t, 10), idx)
	case "setNeonColor":
		enabled := true
		if old, ok := v.Props[proto.PropNeon].([]proto.Value); ok && len(old) == 4 {
			enabled, _ = old[0].(bool)
		}
		vals := []proto.Value{enabled, clampInt(x.int(0), 0, 255), clampInt(x.int(1), 0, 255), clampInt(x.int(2), 0, 255)}
		if x.err != nil {
			return x.err
		}
		s.setProps(v, proto.Props{proto.PropNeon: vals}, false)
	case "setPaint":
		vals := []proto.Value{x.int(0), x.int(1), x.int(2), x.int(3)}
		if x.err != nil {
			return x.err
		}
		s.setProps(v, proto.Props{proto.PropPaint: vals}, false)
	case "spawn":
		pos := x.vec(0)
		heading := float32(x.float(1))
		if x.err != nil {
			return x.err
		}
		for _, p := range v.Occupants {
			if p != nil {
				s.removeFromVehicle(p, true)
			}
		}
		v.BodyHealth, v.EngineHealth, v.Dead = 1000, 1000, false
		s.setRotation(v, proto.Vec3{Z: heading})
		s.setPosition(v, pos)
		s.replicate(v, proto.Props{proto.PropBodyHealth: float64(1000), proto.PropEngineHealth: float64(1000), proto.PropDead: false}, false)
		s.hostUpdate(v, "dead", false)
	case "setOccupant":
		seat := x.int(0)
		r, ok := x.ref(1)
		if !ok || x.err != nil {
			return x.err
		}
		p := s.world.Players.Get(r.ID)
		if p == nil {
			return errNoEntity
		}
		if seat < 0 {
			seat = 0
		}
		if !s.putIntoVehicle(p, v, uint8(clampInt(seat, 0, 255))) {
			return errors.New("seat does not exist")
		}
	default:
		return fmt.Errorf("unknown vehicle method %q", method)
	}
	return x.err
}

func (s *Server) callVisual(ent world.Entity, method string, x *args) error {
	b := ent.Base()
	switch method {
	case "setColor":
		vals := []proto.Value{clampInt(x.int(0), 0, 255), clampInt(x.int(1), 0, 255), clampInt(x.int(2), 0, 255), clampInt(x.int(3), 0, 255)}
		if x.err != nil {
			return x.err
		}
		id := proto.PropMarkerColor
		if b.Type == proto.EntityCheckpoint {
			id = proto.PropCheckpointColor
		}
		s.setProps(ent, proto.Props{id: vals}, false)
	case "showFor", "hideFor":
		r, ok := x.ref(0)
		if !ok {
			return x.err
		}
		if b.VisibleFor == nil {
			b.VisibleFor = map[uint16]bool{}
		}
		b.VisibleFor[r.ID] = method == "showFor"
	default:
		return fmt.Errorf("unknown method %q for %s", method, b.Type)
	}
	return x.err
}

func (s *Server) callBlip(bl *world.Blip, method string, x *args) error {
	switch method {
	case "routeFor", "unrouteFor":
		var targets []proto.Value
		switch v := x.val(0).(type) {
		case []proto.Value:
			targets = v
		case proto.EntityRef:
			targets = []proto.Value{v}
		}
		route := method == "routeFor"
		for _, t := range targets {
			r, ok := t.(proto.EntityRef)
			if !ok || r.Type != proto.EntityPlayer {
				continue
			}
			if c := s.byID[min(int(r.ID), len(s.byID)-1)]; c != nil && c.p.ID == r.ID {
				evArgs := []proto.Value{bl.Key(), route}
				if route {
					evArgs = append(evArgs, x.val(1), x.val(2))
				}
				s.sendTo(c, transport.Reliable, &proto.ScriptEvent{Name: "__gomp:blipRoute", Args: evArgs})
			}
		}
		return nil
	}
	return fmt.Errorf("unknown blip method %q", method)
}

// ------------------------------------------------------------------ global

func (s *Server) apiGlobal(method string, x *args) error {
	switch method {
	case "broadcast":
		s.toAll(transport.Reliable, &proto.Chat{Text: x.str(0)})
	case "broadcastInRange":
		pos := x.vec(0)
		r := float32(x.float(1))
		dim := x.int(2)
		text := x.str(3)
		if x.err != nil {
			return x.err
		}
		b, _ := proto.Marshal(&proto.Chat{Text: text})
		for _, c := range s.byID {
			if c != nil && c.p.Pos.DistSq(pos) <= r*r && (dim < 0 || sameDim(c.p.Dimension, uint32(dim))) {
				_ = c.conn.Send(transport.Reliable, b)
			}
		}
	case "callClients":
		name := x.str(1)
		list := x.list(2)
		unreliable := x.bool(3)
		if x.err != nil {
			return x.err
		}
		ch := transport.Reliable
		if unreliable {
			ch = transport.Unreliable
		}
		b, err := proto.Marshal(&proto.ScriptEvent{Name: name, Args: list})
		if err != nil {
			return err
		}
		if !x.has(0) {
			for _, c := range s.byID {
				if c != nil {
					_ = c.conn.Send(ch, b)
				}
			}
			return nil
		}
		for _, t := range x.list(0) {
			id, ok := asFloat(t)
			if !ok || id < 0 || int(id) >= len(s.byID) {
				continue
			}
			if c := s.byID[int(id)]; c != nil {
				_ = c.conn.Send(ch, b)
			}
		}
	case "time":
		h, m, sec := x.int(0), x.int(1), x.int(2)
		if x.err != nil {
			return x.err
		}
		s.world.Time = world.Clock{Hour: uint8(clampInt(h, 0, 23)), Minute: uint8(clampInt(m, 0, 59)), Second: uint8(clampInt(sec, 0, 59))}
		s.broadcastWorld(0)
	case "weather", "weatherTransition":
		w := strings.ToUpper(x.str(0))
		dur := uint32(0)
		if method == "weatherTransition" && x.has(1) {
			dur = uint32(clampInt(x.int(1), 0, 600000))
		}
		if x.err != nil {
			return x.err
		}
		s.world.Weather = w
		s.broadcastWorld(dur)
	case "requestIpl", "removeIpl":
		name := x.str(0)
		if x.err != nil {
			return x.err
		}
		load := method == "requestIpl"
		s.world.Ipls[name] = load
		s.toAll(transport.Reliable, &proto.Ipl{Name: name, Load: load})
	case "trafficLights":
		s.world.TrafficLightsLocked = x.bool(0)
		s.world.TrafficLightsState = int(x.int(1))
	default:
		return fmt.Errorf("unknown global method %q", method)
	}
	return x.err
}

func (s *Server) broadcastWorld(transitionMs uint32) {
	t := s.world.Time
	s.toAll(transport.Reliable, &proto.World{Hour: t.Hour, Minute: t.Minute, Second: t.Second, Weather: s.world.Weather, TransitionMs: transitionMs})
}
