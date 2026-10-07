package server

import (
	"testing"
	"time"

	"gomp/core/internal/gamedata"
	"gomp/tools/bot"
	"gomp/wire/proto"
	"gomp/wire/transport"
)

func TestJoinSpawnAndMovementSync(t *testing.T) {
	h := newHarness(t, nil, nil)
	a := h.spawned("Alice")
	b := h.spawned("Bob")
	aid, bid := botID(a), botID(b)
	if aid == bid || aid == proto.NoID {
		t.Fatalf("ids %d %d", aid, bid)
	}
	eventually(t, 2*time.Second, "players stream each other", func() bool { return sees(a, bid) && sees(b, aid) })
	if r := remote(b, aid); r.Name != "Alice" || r.Health != 100 {
		t.Fatalf("remote view %+v", r)
	}

	// Alice walks 10 m; Bob must see her final position precisely.
	start := proto.Vec3{X: 100, Y: 100, Z: 30}
	a.View(func(b *bot.Bot) { b.Pos = start })
	target := proto.Vec3{X: 110, Y: 104, Z: 30}
	moveTo(a, target)
	eventually(t, 2*time.Second, "bob sees alice at the target", func() bool {
		return remote(b, aid).Pos.Dist(target) < 0.01
	})
	r := remote(b, aid)
	if r.Heading == 0 && r.Vel == (proto.Vec3{}) {
		t.Fatalf("no velocity/heading relayed: %+v", r)
	}
	var m Snapshot
	h.exec(func(s *Server) { m = s.metrics.Snapshot() })
	if m.SyncIn == 0 || m.SyncOut == 0 || m.Players != 2 {
		t.Fatalf("metrics %+v", m)
	}
}

func TestStreamingByDistanceAndDimension(t *testing.T) {
	h := newHarness(t, nil, nil)
	a := h.spawned("A")
	b := h.spawned("B")
	aid, bid := botID(a), botID(b)
	eventually(t, 2*time.Second, "streamed in", func() bool { return sees(b, aid) })

	// Far away: streamed out.
	h.teleportBot(a, proto.Vec3{X: 2000, Y: 2000, Z: 30})
	eventually(t, 2*time.Second, "streamed out by distance", func() bool { return !sees(b, aid) && !sees(a, bid) })

	// Back, but in another dimension: still invisible.
	h.exec(func(s *Server) { s.setDimension(s.world.Players.Get(aid), 7) })
	h.teleportBot(a, proto.Vec3{X: 101, Y: 101, Z: 30})
	never(t, 400*time.Millisecond, "dimension leak", func() bool { return sees(b, aid) })

	// Same dimension again: visible.
	h.exec(func(s *Server) { s.setDimension(s.world.Players.Get(aid), 0) })
	eventually(t, 2*time.Second, "visible again", func() bool { return sees(b, aid) && sees(a, bid) })
}

func TestShootingDamageDeathRespawn(t *testing.T) {
	h := newHarness(t, nil, nil)
	shooter := h.spawned("Shooter")
	victim := h.spawned("Victim")
	sid, vid := botID(shooter), botID(victim)
	eventually(t, 2*time.Second, "stream", func() bool { return sees(shooter, vid) && sees(victim, sid) })
	h.giveWeapon(shooter, "weapon_pistol", 50)

	vpos := remote(shooter, vid).Pos
	// Torso hit: 26 damage.
	shooter.Shoot(time.Now(), vpos, proto.EntityPlayer, vid, gamedata.BoneSkelSpine3)
	eventually(t, 2*time.Second, "victim took damage", func() bool {
		hp := 0
		victim.View(func(b *bot.Bot) { hp = b.Health })
		return hp == 74
	})
	eventually(t, time.Second, "shooter sees the new health", func() bool { return remote(shooter, vid).Health == 74 })
	eventually(t, time.Second, "victim saw the shot", func() bool {
		n := 0
		victim.View(func(b *bot.Bot) { n = b.ShotsSeen })
		return n >= 1
	})
	// Head shots (52 each) kill.
	for range 2 {
		time.Sleep(200 * time.Millisecond) // respect the fire rate
		shooter.Shoot(time.Now(), vpos, proto.EntityPlayer, vid, gamedata.BoneSkelHead)
	}
	eventually(t, 2*time.Second, "victim died", func() bool {
		dead := false
		victim.View(func(b *bot.Bot) { dead = b.Dead })
		return dead && remote(shooter, vid).Dead
	})
	// Ammo is server-authoritative: 3 shots fired.
	eventually(t, time.Second, "ammo decremented", func() bool {
		ok := false
		h.exec(func(s *Server) { ok = s.world.Players.Get(sid).Weapons[proto.Joaat("weapon_pistol")] == 47 })
		return ok
	})
	// Without scripts the core respawns automatically.
	eventually(t, 3*time.Second, "victim respawned", func() bool {
		var dead bool
		var hp int
		victim.View(func(b *bot.Bot) { dead, hp = b.Dead, b.Health })
		return !dead && hp == 100
	})
	var m Snapshot
	h.exec(func(s *Server) { m = s.metrics.Snapshot() })
	if m.Deaths != 1 || m.HitsOK != 3 || m.ShotsOK != 3 {
		t.Fatalf("metrics %+v", m)
	}
}

func TestCheatedShotsAreRejected(t *testing.T) {
	h := newHarness(t, nil, nil)
	shooter := h.spawned("S")
	victim := h.spawned("V")
	vid := botID(victim)
	eventually(t, 2*time.Second, "stream", func() bool { return sees(shooter, vid) })
	vpos := remote(shooter, vid).Pos

	// Weapon not owned: rejected.
	shooter.View(func(b *bot.Bot) { b.Weapon = proto.Joaat("weapon_heavysniper") })
	shooter.Shoot(time.Now(), vpos, proto.EntityPlayer, vid, gamedata.BoneSkelHead)
	// Hit claim without a shot.
	shooter.SendRaw(transport.Reliable, &proto.WeaponHit{ShotSeq: 999, Weapon: proto.Joaat("weapon_pistol"),
		TargetType: proto.EntityPlayer, TargetID: vid, Bone: gamedata.BoneSkelHead, HitPos: vpos})
	never(t, 300*time.Millisecond, "victim damaged by cheats", func() bool {
		hp := 0
		victim.View(func(b *bot.Bot) { hp = b.Health })
		return hp != 100
	})

	h.giveWeapon(shooter, "weapon_pistol", 100)
	// Rapid fire far beyond the pistol's cadence: most shots are rejected.
	for range 20 {
		shooter.Shoot(time.Now(), vpos, proto.EntityNone, 0, 0)
	}
	// A hit far away from the victim's real position.
	time.Sleep(200 * time.Millisecond)
	shooter.Shoot(time.Now(), vpos.Add(proto.Vec3{X: 30}), proto.EntityPlayer, vid, gamedata.BoneSkelHead)
	var m Snapshot
	eventually(t, 2*time.Second, "rejections counted", func() bool {
		h.exec(func(s *Server) { m = s.metrics.Snapshot() })
		return m.ShotsBad >= 10 && m.HitsBad >= 3
	})
	hp := 0
	victim.View(func(b *bot.Bot) { hp = b.Health })
	if hp != 100 {
		t.Fatalf("victim lost health to rejected hits: %d", hp)
	}
}

func TestEnvironmentDamageIsRateLimited(t *testing.T) {
	h := newHarness(t, func(c *configT) { c.GoMP.MaxSelfHealthPerSec = 10 }, nil)
	a := h.spawned("Faller")
	a.SelfDamage(proto.CauseFall, 30, 0)
	eventually(t, 2*time.Second, "fall damage", func() bool {
		hp := 0
		a.View(func(b *bot.Bot) { hp = b.Health })
		return hp == 70
	})
	// Budget: 200 burst - 30 used; a flood of 255-damage reports cannot exceed it.
	for range 5 {
		a.SelfDamage(proto.CauseFire, 255, 0)
	}
	eventually(t, 2*time.Second, "dead from fire", func() bool {
		dead := false
		a.View(func(b *bot.Bot) { dead = b.Dead })
		return dead
	})
}

func TestVehicleEnterDriveExitAndController(t *testing.T) {
	h := newHarness(t, nil, nil)
	driver := h.spawned("Driver")
	watcher := h.spawned("Watcher")
	did := botID(driver)
	vid := h.spawnVehicle("sultan", proto.Vec3{X: 103, Y: 100, Z: 30}, 90)
	eventually(t, 2*time.Second, "vehicle streamed", func() bool {
		ok := false
		driver.View(func(b *bot.Bot) { _, ok = b.Vehicles[vid] })
		ok2 := false
		watcher.View(func(b *bot.Bot) { _, ok2 = b.Vehicles[vid] })
		return ok && ok2
	})
	// An unoccupied vehicle gets a controller.
	eventually(t, 3*time.Second, "controller assigned", func() bool {
		n := 0
		driver.View(func(b *bot.Bot) { n += len(b.Controlled) })
		watcher.View(func(b *bot.Bot) { n += len(b.Controlled) })
		return n == 1
	})

	driver.EnterVehicle(vid, proto.SeatDriver)
	eventually(t, 2*time.Second, "driver seated", func() bool {
		var v uint16
		driver.View(func(b *bot.Bot) { v = b.VehicleID })
		return v == vid
	})
	eventually(t, 2*time.Second, "watcher sees driver in vehicle", func() bool {
		r := remote(watcher, did)
		return r.Vehicle == vid && r.Seat == proto.SeatDriver
	})
	// Nobody controls a driven vehicle.
	eventually(t, 2*time.Second, "controller released", func() bool {
		n := 0
		driver.View(func(b *bot.Bot) { n += len(b.Controlled) })
		watcher.View(func(b *bot.Bot) { n += len(b.Controlled) })
		return n == 0
	})

	// Drive 30 m east at 15 m/s.
	pos := proto.Vec3{X: 103, Y: 100, Z: 30}
	rot := proto.QuatFromEuler(proto.Vec3{Z: 270})
	for range 60 {
		pos.X += 0.5
		driver.View(func(b *bot.Bot) { b.Pos, b.Vel = pos, proto.Vec3{X: 15} })
		driver.SendVehicleSync(time.Now(), rot, proto.VehEngineOn, 1)
		time.Sleep(33 * time.Millisecond)
	}
	eventually(t, 2*time.Second, "watcher sees the vehicle move", func() bool {
		var vp proto.Vec3
		var eng bool
		watcher.View(func(b *bot.Bot) {
			if v := b.Vehicles[vid]; v != nil {
				vp, eng = v.Pos, v.Flags&proto.VehEngineOn != 0
			}
		})
		return vp.Dist(pos) < 0.01 && eng
	})
	h.exec(func(s *Server) {
		v := s.world.Vehicles.Get(vid)
		if !v.Engine || v.Pos.Dist(pos) > 0.01 {
			t.Errorf("server vehicle state %+v", v.Pos)
		}
		if p := s.world.Players.Get(did); p.Pos.Dist(pos) > 0.01 {
			t.Errorf("driver position not following vehicle: %v", p.Pos)
		}
	})

	driver.ExitVehicle()
	eventually(t, 2*time.Second, "watcher sees exit", func() bool { return remote(watcher, did).Vehicle == proto.NoID })
	eventually(t, 2*time.Second, "leaving driver controls the vehicle", func() bool {
		ok := false
		driver.View(func(b *bot.Bot) { ok = b.Controlled[vid] })
		return ok
	})
}

func TestEnterVehicleRules(t *testing.T) {
	h := newHarness(t, nil, nil)
	a := h.spawned("A")
	b := h.spawned("B")
	vid := h.spawnVehicle("adder", proto.Vec3{X: 102, Y: 101, Z: 30}, 0) // 2 seats
	eventually(t, 2*time.Second, "vehicle streamed", func() bool {
		ok1, ok2 := false, false
		a.View(func(x *bot.Bot) { _, ok1 = x.Vehicles[vid] })
		b.View(func(x *bot.Bot) { _, ok2 = x.Vehicles[vid] })
		return ok1 && ok2
	})
	result := func(x *bot.Bot) proto.EnterResult {
		r := proto.EnterResult(255)
		x.View(func(x *bot.Bot) {
			if x.EnterResult != nil {
				r = x.EnterResult.Result
			}
		})
		return r
	}
	a.EnterVehicle(vid, proto.SeatDriver)
	eventually(t, 2*time.Second, "A allowed", func() bool { return result(a) == proto.EnterAllowed })
	// The driver seat is reserved while A's animation runs.
	b.EnterVehicle(vid, proto.SeatDriver)
	eventually(t, 2*time.Second, "B refused", func() bool { return result(b) == proto.EnterSeatTaken })
	b.EnterVehicle(vid, 5)
	eventually(t, 2*time.Second, "invalid seat", func() bool { return result(b) == proto.EnterInvalidSeat })
	b.EnterVehicle(vid, proto.SeatAny)
	eventually(t, 2*time.Second, "B gets passenger seat", func() bool { return result(b) == proto.EnterAllowed })
	eventually(t, 2*time.Second, "both seated", func() bool {
		var av, bv uint16
		var bs uint8
		a.View(func(x *bot.Bot) { av = x.VehicleID })
		b.View(func(x *bot.Bot) { bv, bs = x.VehicleID, x.Seat })
		return av == vid && bv == vid && bs == 1
	})
	// Locked vehicles refuse entry.
	v2 := h.spawnVehicle("sultan", proto.Vec3{X: 98, Y: 99, Z: 30}, 0)
	h.exec(func(s *Server) { _ = s.setVehicle(s.world.Vehicles.Get(v2), "locked", &args{a: []proto.Value{true}}) })
	c := h.spawned("C")
	eventually(t, 2*time.Second, "C sees v2", func() bool {
		ok := false
		c.View(func(x *bot.Bot) { _, ok = x.Vehicles[v2] })
		return ok
	})
	c.EnterVehicle(v2, proto.SeatDriver)
	eventually(t, 2*time.Second, "locked", func() bool { return result(c) == proto.EnterLocked })
	// Too far away.
	h.teleportBot(c, proto.Vec3{X: 140, Y: 100, Z: 30})
	c.EnterVehicle(v2, proto.SeatDriver)
	eventually(t, 2*time.Second, "too far", func() bool { return result(c) == proto.EnterTooFar })
}

func TestPassengerSyncAndPutIntoVehicle(t *testing.T) {
	h := newHarness(t, nil, nil)
	drv := h.spawned("Drv")
	pas := h.spawned("Pas")
	pid := botID(pas)
	vid := h.spawnVehicle("kuruma", proto.Vec3{X: 150, Y: 150, Z: 30}, 0)
	// Scripts warp players into seats (putIntoVehicle); the vehicle is far away
	// and must be streamed to them first.
	h.exec(func(s *Server) {
		v := s.world.Vehicles.Get(vid)
		if !s.putIntoVehicle(s.world.Players.Get(botID(drv)), v, 0) || !s.putIntoVehicle(s.world.Players.Get(pid), v, 2) {
			t.Error("putIntoVehicle failed")
		}
	})
	eventually(t, 2*time.Second, "both warped", func() bool {
		var dv, pv uint16
		drv.View(func(b *bot.Bot) { dv = b.VehicleID })
		pas.View(func(b *bot.Bot) { pv = b.VehicleID })
		return dv == vid && pv == vid
	})
	pas.View(func(b *bot.Bot) {
		b.Flags = proto.PedAiming
		b.AimPos = proto.Vec3{X: 160, Y: 150, Z: 31}
	})
	pas.SendPassengerSync(time.Now())
	eventually(t, 2*time.Second, "driver sees passenger aiming", func() bool {
		r := remote(drv, pid)
		return r.Vehicle == vid && r.Seat == 2 && r.Flags&proto.PedAiming != 0
	})
	// Script removal.
	h.exec(func(s *Server) { s.removeFromVehicle(s.world.Players.Get(pid), true) })
	eventually(t, 2*time.Second, "passenger removed", func() bool {
		var pv uint16
		pas.View(func(b *bot.Bot) { pv = b.VehicleID })
		return pv == proto.NoID && remote(drv, pid).Vehicle == proto.NoID
	})
}

func TestUnoccupiedVehicleSyncByController(t *testing.T) {
	h := newHarness(t, nil, nil)
	a := h.spawned("A")
	b := h.spawned("B")
	vid := h.spawnVehicle("sultan", proto.Vec3{X: 101, Y: 105, Z: 30}, 0)
	var ctrl, other *bot.Bot
	eventually(t, 3*time.Second, "controller", func() bool {
		a.View(func(x *bot.Bot) {
			if x.Controlled[vid] {
				ctrl, other = a, b
			}
		})
		b.View(func(x *bot.Bot) {
			if x.Controlled[vid] {
				ctrl, other = b, a
			}
		})
		return ctrl != nil
	})
	// The controller pushes the car; the other player sees it move.
	pos := proto.Vec3{X: 101, Y: 105, Z: 30}
	for range 20 {
		pos.Y += 0.1
		ctrl.SendUnoccupiedSync(time.Now(), vid, pos, proto.Vec3{Y: 3}, proto.IdentityQuat)
		time.Sleep(33 * time.Millisecond)
	}
	eventually(t, 2*time.Second, "other sees the pushed car", func() bool {
		var vp proto.Vec3
		other.View(func(x *bot.Bot) {
			if v := x.Vehicles[vid]; v != nil {
				vp = v.Pos
			}
		})
		return vp.Dist(pos) < 0.01
	})
	// A non-controller cannot move it.
	other.SendUnoccupiedSync(time.Now(), vid, proto.Vec3{X: 500, Y: 500, Z: 30}, proto.Vec3{}, proto.IdentityQuat)
	never(t, 300*time.Millisecond, "non-controller moved the car", func() bool {
		moved := false
		h.exec(func(s *Server) { moved = s.world.Vehicles.Get(vid).Pos.X > 400 })
		return moved
	})
	// When the controller walks away, control passes to the other player.
	h.teleportBot(ctrl, proto.Vec3{X: 3000, Y: 3000, Z: 30})
	eventually(t, 4*time.Second, "control handed over", func() bool {
		ok := false
		other.View(func(x *bot.Bot) { ok = x.Controlled[vid] })
		return ok
	})
}

func TestSpeedHackCorrected(t *testing.T) {
	h := newHarness(t, nil, nil)
	cheat := h.spawned("Cheater")
	obs := h.spawned("Observer")
	cid := botID(cheat)
	eventually(t, 2*time.Second, "stream", func() bool { return sees(obs, cid) })
	var legit proto.Vec3
	cheat.View(func(b *bot.Bot) {
		legit = b.Pos
		b.Pos = b.Pos.Add(proto.Vec3{X: 200})
	})
	cheat.SendPedSync(time.Now())
	eventually(t, 2*time.Second, "correction received", func() bool {
		n := 0
		var p proto.Vec3
		cheat.View(func(b *bot.Bot) { n, p = b.Corrections, b.Pos })
		return n == 1 && p.Dist(legit) < 0.01
	})
	never(t, 300*time.Millisecond, "observer saw the teleport", func() bool {
		return remote(obs, cid).Pos.Dist(legit) > 1
	})
	var m Snapshot
	h.exec(func(s *Server) { m = s.metrics.Snapshot() })
	if m.Violations != 1 || m.Corrections != 1 {
		t.Fatalf("metrics %+v", m)
	}
}

func TestReorderedSyncIgnored(t *testing.T) {
	h := newHarness(t, nil, nil)
	a := h.spawned("A")
	b := h.spawned("B")
	aid := botID(a)
	eventually(t, 2*time.Second, "stream", func() bool { return sees(b, aid) })
	base := proto.Vec3{X: 100, Y: 100, Z: 30}
	now := time.Now()
	newer := &proto.PedSync{Time: bot.NowMs(now) + 100, Pos: base.Add(proto.Vec3{X: 1})}
	older := &proto.PedSync{Time: bot.NowMs(now) + 50, Pos: base.Add(proto.Vec3{X: 0.5})}
	a.SendRaw(transport.Unreliable, newer)
	a.SendRaw(transport.Unreliable, older)
	eventually(t, 2*time.Second, "newest position wins", func() bool {
		return remote(b, aid).Pos.Dist(newer.Pos) < 0.01
	})
	never(t, 200*time.Millisecond, "older sample applied", func() bool {
		return remote(b, aid).Pos.Dist(older.Pos) < 0.01
	})
}

func TestMalformedMessagesKick(t *testing.T) {
	h := newHarness(t, nil, nil)
	a := h.spawned("Fuzzer")
	for range 60 {
		a.SendRaw(transport.Reliable, &proto.Chat{Text: ""}) // valid, ignored
	}
	// Send server→client message ids, which a client must never send.
	for range 60 {
		a.SendRaw(transport.Reliable, &proto.Welcome{})
	}
	eventually(t, 3*time.Second, "kicked", func() bool {
		closed, reason := a.Closed()
		return closed && reason == "protocol error"
	})
}

func TestConnectionRules(t *testing.T) {
	h := newHarness(t, func(c *configT) {
		c.MaxPlayers = 2
		c.DisallowMultipleConnectionsPerIP = false
	}, nil)
	h.bot("one")
	h.bot("two")
	_, err := bot.Connect(t.Context(), bot.Config{Server: h.addr, Name: "three", ConnectTimeout: 2 * time.Second})
	var re *transport.RejectedError
	if err == nil || !asRejected(err, &re) || re.Reason != "server full" {
		t.Fatalf("third player: %v", err)
	}
	_, err = bot.Connect(t.Context(), bot.Config{Server: h.addr, Name: " bad name", ConnectTimeout: 2 * time.Second})
	if err == nil {
		t.Fatal("invalid name accepted")
	}
}
