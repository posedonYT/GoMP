package server

import (
	"time"

	"gomp/core/internal/anticheat"
	"gomp/core/internal/world"
	"gomp/wire/proto"
	"gomp/wire/transport"
)

const (
	maxEnterDistance = 12
	enterTimeout     = 8 * time.Second
	// healthLock ignores client-reported vehicle health briefly after the
	// server changed it, so in-flight syncs do not undo a repair.
	healthLock = time.Second
	// vehicleDeathHealth is GTA's engine health of a destroyed vehicle.
	vehicleDeathHealth = -4000
)

// vehicleState is server-only bookkeeping per vehicle.
type vehicleState struct {
	mover       anticheat.Mover
	healthUntil time.Time
}

func (s *Server) vstate(v *world.Vehicle) *vehicleState {
	if v.Net == nil {
		v.Net = &vehicleState{}
	}
	return v.Net.(*vehicleState)
}

func (s *Server) vehicleMaxSpeed(v *world.Vehicle) float32 {
	if s.cfg.GoMP.MaxVehicleSpeed > 0 {
		return float32(s.cfg.GoMP.MaxVehicleSpeed)
	}
	return s.vehicles.MaxSpeed(v.Model)
}

// ------------------------------------------------------------------ driver sync

func (s *Server) onVehicleSync(c *client, m *proto.VehicleSync) {
	p := c.p
	v := p.Vehicle
	if v == nil || !p.IsDriver() || v.ID != m.VehicleID || p.TeleportPending || p.Dead {
		return
	}
	if v.SyncTime != 0 && !newer(m.Time, v.SyncTime) {
		return
	}
	v.SyncTime = m.Time
	if !validPos(m.Pos) || !m.Vel.IsFinite() || !m.AngVel.IsFinite() {
		c.badMessages++
		return
	}
	if s.cfg.GoMP.AnticheatEnabled {
		if r := c.mover.CheckVehicle(s.now, v.Pos, m.Pos, s.vehicleMaxSpeed(v), s.acLimits); !r.OK {
			s.violation(c, "vehicle speed", r.Limit)
			return
		}
	}
	if !v.Movable && v.Pos.DistSq(m.Pos) > 1 {
		// Frozen by a script: keep the server position.
		s.teleport(p, v.Pos, proto.KeepHeading, proto.PosCorrection)
		return
	}
	s.metrics.syncIn.Add(1)
	s.applyVehicleFlags(v, m.Flags)
	if s.now.After(s.vstate(v).healthUntil) {
		s.applyVehicleHealth(v, m.BodyHealth, m.EngineHealth, m.Flags&proto.VehDestroyed != 0)
	}
	v.Pos, v.Quat, v.Vel, v.AngVel = m.Pos, m.Rot, m.Vel, m.AngVel
	v.Rot = v.Quat.Euler()
	v.Steer, v.Gas, v.Brake = m.Steer, m.Gas, m.Brake
	v.LastSyncAt = s.now
	// Drive-by aim belongs to the driver.
	if m.Flags&proto.VehDriverAiming != 0 && m.AimPos.IsFinite() {
		s.applyWeaponSwitch(c, m.Weapon)
		p.Flags |= proto.PedAiming
		p.AimPos = m.AimPos
	} else {
		p.Flags &^= proto.PedAiming
	}
	s.grid.Upsert(v.Key(), v.Dimension, v.Pos)
	s.moveOccupants(v)
	s.markSync(v)
}

// applyVehicleFlags updates engine/horn/siren state and fires toggle events.
func (s *Server) applyVehicleFlags(v *world.Vehicle, f proto.VehicleFlags) {
	old := v.Flags
	v.Flags = f &^ proto.VehDriverAiming
	if (old^f)&proto.VehHorn != 0 {
		s.emit("vehicleHornToggle", v.Key(), f&proto.VehHorn != 0)
	}
	if (old^f)&proto.VehSiren != 0 {
		s.emit("vehicleSirenToggle", v.Key(), f&proto.VehSiren != 0)
	}
	if engine := f&proto.VehEngineOn != 0; engine != v.Engine {
		v.Engine = engine
		s.hostUpdate(v, "engine", engine)
	}
}

// applyVehicleHealth accepts client-reported damage (health only decreases
// through sync; repairs come from the server).
func (s *Server) applyVehicleHealth(v *world.Vehicle, body, engine float32, destroyed bool) {
	bodyLoss := max(0, v.BodyHealth-body)
	engineLoss := max(0, v.EngineHealth-engine)
	if bodyLoss > 0 || engineLoss > 0 {
		v.BodyHealth -= bodyLoss
		v.EngineHealth -= engineLoss
		s.hostUpdate(v, "bodyHealth", float64(v.BodyHealth))
		s.hostUpdate(v, "engineHealth", float64(v.EngineHealth))
		s.emit("vehicleDamage", v.Key(), float64(bodyLoss), float64(engineLoss))
	}
	if !v.Dead && (destroyed || v.EngineHealth <= vehicleDeathHealth) {
		s.killVehicle(v)
	}
}

func (s *Server) killVehicle(v *world.Vehicle) {
	if v.Dead {
		return
	}
	v.Dead = true
	v.Engine = false
	s.replicate(v, proto.Props{proto.PropDead: true, proto.PropEngine: false}, false)
	s.hostUpdate(v, "dead", true)
	s.hostUpdate(v, "engine", false)
	s.emit("vehicleDeath", v.Key())
}

// moveOccupants keeps seated players at the vehicle position for streaming.
func (s *Server) moveOccupants(v *world.Vehicle) {
	for _, p := range v.Occupants {
		if p != nil {
			p.Pos = v.Pos
			p.LastValidPos = v.Pos
			if c := s.clientOf(p); c != nil {
				c.mover.Reset()
			}
			s.grid.Upsert(p.Key(), p.Dimension, p.Pos)
			s.markHostSync(p)
		}
	}
}

func (s *Server) onPassengerSync(c *client, m *proto.PassengerSync) {
	p := c.p
	v := p.Vehicle
	if v == nil || v.ID != m.VehicleID || p.Seat != m.Seat || p.IsDriver() || p.Dead {
		return
	}
	if p.SyncTime != 0 && !newer(m.Time, p.SyncTime) {
		return
	}
	p.SyncTime = m.Time
	if m.Flags&proto.PedAiming != 0 && !m.AimPos.IsFinite() {
		c.badMessages++
		return
	}
	s.metrics.syncIn.Add(1)
	s.applyWeaponSwitch(c, m.Weapon)
	p.Flags = m.Flags
	p.AimPos = m.AimPos
	p.Pos = v.Pos
	s.markSync(p)
}

func (s *Server) onUnoccupiedSync(c *client, m *proto.UnoccupiedSync) {
	v := s.world.Vehicles.Get(m.VehicleID)
	if v == nil || v.Controller != c.p || v.Driver() != nil || !v.Movable {
		return
	}
	if v.SyncTime != 0 && !newer(m.Time, v.SyncTime) {
		return
	}
	v.SyncTime = m.Time
	if !validPos(m.Pos) || !m.Vel.IsFinite() || !m.AngVel.IsFinite() {
		c.badMessages++
		return
	}
	if s.cfg.GoMP.AnticheatEnabled {
		// Pushed or towed vehicles never exceed the class limit either.
		if r := s.vstate(v).mover.CheckVehicle(s.now, v.Pos, m.Pos, s.vehicleMaxSpeed(v), s.acLimits); !r.OK {
			s.metrics.violations.Add(1)
			return
		}
	}
	s.metrics.syncIn.Add(1)
	v.Pos, v.Quat, v.Vel, v.AngVel = m.Pos, m.Rot, m.Vel, m.AngVel
	v.Rot = v.Quat.Euler()
	v.Steer, v.Gas, v.Brake = 0, 0, 0
	v.LastSyncAt = s.now
	s.grid.Upsert(v.Key(), v.Dimension, v.Pos)
	s.moveOccupants(v)
	s.markSync(v)
}

// ------------------------------------------------------------------ entering & leaving

func (s *Server) onEnterRequest(c *client, m *proto.EnterVehicleRequest) {
	p := c.p
	reply := func(r proto.EnterResult, seat uint8) {
		s.sendTo(c, transport.Reliable, &proto.EnterVehicleResponse{VehicleID: m.VehicleID, Seat: seat, Result: r})
	}
	if p.Dead || !p.Spawned || p.Vehicle != nil || p.Entering != nil {
		reply(proto.EnterBusy, m.Seat)
		return
	}
	v := s.world.Vehicles.Get(m.VehicleID)
	if v == nil || v.Dead || !sameDim(v.Dimension, p.Dimension) || !c.stream.Has(v.Key()) {
		reply(proto.EnterNoVehicle, m.Seat)
		return
	}
	if p.Pos.DistSq(v.Pos) > maxEnterDistance*maxEnterDistance {
		reply(proto.EnterTooFar, m.Seat)
		return
	}
	if v.Locked {
		reply(proto.EnterLocked, m.Seat)
		return
	}
	seat := m.Seat
	if seat == proto.SeatAny {
		var ok bool
		if seat, ok = v.FirstFreeSeat(); !ok {
			reply(proto.EnterSeatTaken, m.Seat)
			return
		}
	} else if int(seat) >= len(v.Occupants) {
		reply(proto.EnterInvalidSeat, seat)
		return
	} else if !v.SeatFree(seat) {
		reply(proto.EnterSeatTaken, seat)
		return
	}
	v.Reserved[seat] = p
	p.Entering, p.EnteringSeat, p.EnterExpires = v, seat, s.now.Add(enterTimeout)
	reply(proto.EnterAllowed, seat)
	task := &proto.VehicleTask{PlayerID: p.ID, Task: proto.TaskEnterStart, VehicleID: v.ID, Seat: seat}
	s.toStreamers(p, transport.Reliable, task, false)
	s.emit("playerStartEnterVehicle", p.Key(), v.Key(), int64(seat))
}

func (s *Server) onEnterComplete(c *client, m *proto.EnterVehicleComplete) {
	p := c.p
	v := p.Entering
	if v == nil || v.ID != m.VehicleID || p.EnteringSeat != m.Seat {
		return
	}
	seat := p.EnteringSeat
	s.clearReservation(p)
	if m.Aborted || p.Dead || v.Destroyed || v.Dead || v.Occupants[seat] != nil {
		if !m.Aborted {
			// The seat vanished meanwhile: pull the client back out.
			s.sendTo(c, transport.Reliable, &proto.PutIntoVehicle{VehicleID: proto.NoID})
		}
		return
	}
	s.seatPlayer(p, v, seat)
	s.toStreamers(p, transport.Reliable, &proto.VehicleTask{PlayerID: p.ID, Task: proto.TaskEnterWarp, VehicleID: v.ID, Seat: seat}, false)
	s.emit("playerEnterVehicle", p.Key(), v.Key(), int64(seat))
}

func (s *Server) onExitRequest(c *client) {
	p := c.p
	if p.Vehicle == nil || p.Exiting {
		return
	}
	p.Exiting = true
	s.toStreamers(p, transport.Reliable, &proto.VehicleTask{PlayerID: p.ID, Task: proto.TaskExitStart, VehicleID: p.Vehicle.ID, Seat: p.Seat}, false)
	s.emit("playerStartExitVehicle", p.Key())
}

func (s *Server) onExitComplete(c *client) {
	p := c.p
	if p.Vehicle == nil {
		return
	}
	v, seat := p.Vehicle, p.Seat
	s.vacateSeat(p)
	s.toStreamers(p, transport.Reliable, &proto.VehicleTask{PlayerID: p.ID, Task: proto.TaskExitWarp, VehicleID: v.ID, Seat: seat}, false)
	s.emit("playerExitVehicle", p.Key(), v.Key(), int64(seat))
	if seat == proto.SeatDriver && v.Driver() == nil {
		s.setController(v, p, false)
	}
}

// seatPlayer places p into seat (both directions of bookkeeping).
func (s *Server) seatPlayer(p *world.Player, v *world.Vehicle, seat uint8) {
	v.Occupants[seat] = p
	p.Vehicle, p.Seat, p.Exiting = v, seat, false
	p.Pos = v.Pos
	p.Vel = proto.Vec3{}
	if c := s.clientOf(p); c != nil {
		c.mover.Reset()
	}
	if seat == proto.SeatDriver && v.Controller != nil {
		s.setController(v, nil, false)
	}
	s.grid.Upsert(p.Key(), p.Dimension, p.Pos)
	s.replicate(p, proto.Props{proto.PropVehicle: []proto.Value{int64(v.ID), int64(seat)}}, false)
	s.hostUpdate(p, "veh", int64(v.ID))
	s.hostUpdate(p, "seat", int64(seat))
	s.markSync(p)
	s.dropSyncCache(p.Key()) // a driver's state travels in the vehicle sync
}

// vacateSeat removes p from its vehicle without notifications to p's client.
func (s *Server) vacateSeat(p *world.Player) {
	v := p.Vehicle
	if v == nil {
		return
	}
	if int(p.Seat) < len(v.Occupants) && v.Occupants[p.Seat] == p {
		v.Occupants[p.Seat] = nil
	}
	p.Vehicle, p.Exiting = nil, false
	if c := s.clientOf(p); c != nil {
		c.mover.Reset()
	}
	if !p.Base().Destroyed {
		s.replicate(p, proto.Props{proto.PropVehicle: nil}, false)
		s.hostUpdate(p, "veh", int64(-1))
		s.markSync(p)
		s.dropSyncCache(p.Key())
	}
}

// removeFromVehicle is the script-initiated exit (player.removeFromVehicle).
func (s *Server) removeFromVehicle(p *world.Player, event bool) {
	v, seat := p.Vehicle, p.Seat
	if v == nil {
		return
	}
	s.vacateSeat(p)
	if c := s.clientOf(p); c != nil {
		s.sendTo(c, transport.Reliable, &proto.PutIntoVehicle{VehicleID: proto.NoID})
	}
	s.toStreamers(p, transport.Reliable, &proto.VehicleTask{PlayerID: p.ID, Task: proto.TaskExitWarp, VehicleID: v.ID, Seat: seat}, false)
	if event {
		s.emit("playerExitVehicle", p.Key(), v.Key(), int64(seat))
	}
	if seat == proto.SeatDriver && v.Driver() == nil && v.Movable {
		s.assignController(v)
	}
}

// putIntoVehicle is the script-initiated warp (player.putIntoVehicle).
func (s *Server) putIntoVehicle(p *world.Player, v *world.Vehicle, seat uint8) bool {
	if int(seat) >= len(v.Occupants) || p.Dead {
		return false
	}
	if occ := v.Occupants[seat]; occ != nil && occ != p {
		s.removeFromVehicle(occ, true)
	}
	if r := v.Reserved[seat]; r != nil {
		s.clearReservation(r)
	}
	if p.Vehicle != nil {
		s.removeFromVehicle(p, true)
	}
	s.clearReservation(p)
	if !sameDim(p.Dimension, v.Dimension) {
		s.setDimension(p, v.Dimension)
	}
	s.seatPlayer(p, v, seat)
	if c := s.clientOf(p); c != nil {
		// The client may not have the vehicle streamed yet.
		s.streamInNow(c, v)
		s.sendTo(c, transport.Reliable, &proto.PutIntoVehicle{VehicleID: v.ID, Seat: seat})
	}
	s.toStreamers(p, transport.Reliable, &proto.VehicleTask{PlayerID: p.ID, Task: proto.TaskEnterWarp, VehicleID: v.ID, Seat: seat}, false)
	s.emit("playerEnterVehicle", p.Key(), v.Key(), int64(seat))
	return true
}

func (s *Server) clearReservation(p *world.Player) {
	v := p.Entering
	if v == nil {
		return
	}
	if int(p.EnteringSeat) < len(v.Reserved) && v.Reserved[p.EnteringSeat] == p {
		v.Reserved[p.EnteringSeat] = nil
	}
	p.Entering = nil
}

func sameDim(a, b uint32) bool {
	return a == b || a == proto.GlobalDimension || b == proto.GlobalDimension
}

// ------------------------------------------------------------------ controllers

// assignControllers picks a syncing player for every unoccupied vehicle with streamers.
func (s *Server) assignControllers() {
	s.world.Vehicles.Each(func(_ uint16, v *world.Vehicle) {
		if v.Driver() == nil {
			s.assignController(v)
		}
	})
}

func (s *Server) assignController(v *world.Vehicle) {
	key := v.Key()
	cur := v.Controller
	if cur != nil {
		if _, streams := s.streamers[key][cur.ID]; !streams || s.clientOf(cur) == nil {
			cur = nil
		}
	}
	if cur != nil && v.ControllerPinned {
		return
	}
	var best *world.Player
	bestD := float32(-1)
	for id := range s.streamers[key] {
		c := s.byID[id]
		if c == nil || c.p.Dead {
			continue
		}
		if d := c.p.Pos.DistSq(v.Pos); bestD < 0 || d < bestD {
			best, bestD = c.p, d
		}
	}
	// Hysteresis: keep the current controller unless someone is much closer.
	if cur != nil && best != nil && best != cur && cur.Pos.DistSq(v.Pos) <= bestD*2.25 {
		best = cur
	}
	if best != v.Controller {
		s.setController(v, best, false)
	}
}

func (s *Server) setController(v *world.Vehicle, p *world.Player, pinned bool) {
	old := v.Controller
	v.Controller, v.ControllerPinned = p, pinned && p != nil
	if old == p {
		return
	}
	if c := s.clientOf(old); c != nil {
		s.sendTo(c, transport.Reliable, &proto.ControllerAssign{VehicleID: v.ID, Controlled: false})
	}
	if c := s.clientOf(p); c != nil {
		s.vstate(v).mover.Reset()
		s.sendTo(c, transport.Reliable, &proto.ControllerAssign{VehicleID: v.ID, Controlled: true})
	}
	id := int64(-1)
	if p != nil {
		id = int64(p.ID)
	}
	s.hostUpdate(v, "controller", id)
}
