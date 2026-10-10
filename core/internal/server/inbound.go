package server

import (
	"math"
	"time"
	"unicode/utf8"

	"gomp/core/internal/world"
	"gomp/wire/proto"
	"gomp/wire/transport"
)

const (
	maxBadMessages = 50
	maxChatRunes   = 256
	chatRate       = 2.0 // messages per second
	chatBurst      = 8
	eventRate      = 100.0 // remote events per second
	eventBurst     = 300
	worldLimit     = 20000 // |x|, |y| bound in metres
)

// reservedEvents cannot be triggered by clients through callRemote, so a
// cheater cannot fake server events like playerDeath.
var reservedEvents = map[string]bool{
	"incomingConnection": true, "playerJoin": true, "playerReady": true, "playerQuit": true,
	"playerChat": true, "playerCommand": true, "playerDeath": true, "playerDamage": true,
	"playerSpawn": true, "playerEnterVehicle": true, "playerExitVehicle": true,
	"playerStartEnterVehicle": true, "playerStartExitVehicle": true, "playerWeaponChange": true,
	"playerEnterColshape": true, "playerExitColshape": true, "playerEnterCheckpoint": true,
	"playerExitCheckpoint": true, "playerStreamIn": true, "playerStreamOut": true,
	"vehicleDeath": true, "vehicleDamage": true, "vehicleHornToggle": true, "vehicleSirenToggle": true,
	"trailerAttached": true, "entityCreated": true, "entityDestroyed": true, "entityModelChange": true,
	"packagesLoaded": true, "serverShutdown": true, "playerSyncViolation": true, "playerReachWaypoint": true,
}

func (s *Server) processInbound() {
	for _, c := range s.byID {
		if c == nil {
			continue
		}
		c.conn.Drain(func(m transport.Message) {
			if c.kicked == "" && s.clientOf(c.p) == c {
				s.handleMessage(c, m.Data)
			}
		})
		if c.badMessages > maxBadMessages {
			s.kick(c, "protocol error")
		}
	}
}

func (s *Server) handleMessage(c *client, data []byte) {
	s.metrics.msgIn.Add(1)
	id, ok := proto.PeekID(data)
	if !ok {
		c.badMessages++
		return
	}
	decode := func(m proto.Message) bool {
		if err := proto.DecodeInto(data, m); err != nil {
			c.badMessages++
			return false
		}
		return true
	}
	switch id {
	case proto.MsgPedSync:
		if decode(&c.pedSync) {
			s.onPedSync(c, &c.pedSync)
		}
	case proto.MsgVehicleSync:
		if decode(&c.vehSync) {
			s.onVehicleSync(c, &c.vehSync)
		}
	case proto.MsgPassengerSync:
		if decode(&c.passSync) {
			s.onPassengerSync(c, &c.passSync)
		}
	case proto.MsgUnoccupiedSync:
		if decode(&c.unoccSync) {
			s.onUnoccupiedSync(c, &c.unoccSync)
		}
	case proto.MsgWeaponShot:
		var m proto.WeaponShot
		if decode(&m) {
			s.onWeaponShot(c, &m)
		}
	case proto.MsgWeaponHit:
		var m proto.WeaponHit
		if decode(&m) {
			s.onWeaponHit(c, &m)
		}
	case proto.MsgSelfDamage:
		var m proto.SelfDamage
		if decode(&m) {
			s.onSelfDamage(c, &m)
		}
	case proto.MsgEnterVehicleRequest:
		var m proto.EnterVehicleRequest
		if decode(&m) {
			s.onEnterRequest(c, &m)
		}
	case proto.MsgEnterVehicleComplete:
		var m proto.EnterVehicleComplete
		if decode(&m) {
			s.onEnterComplete(c, &m)
		}
	case proto.MsgExitVehicleRequest:
		var m proto.ExitVehicleRequest
		if decode(&m) {
			s.onExitRequest(c)
		}
	case proto.MsgExitVehicleComplete:
		var m proto.ExitVehicleComplete
		if decode(&m) {
			s.onExitComplete(c)
		}
	case proto.MsgTeleportAck:
		var m proto.TeleportAck
		if decode(&m) {
			s.onTeleportAck(c, m.Seq)
		}
	case proto.MsgReady:
		var m proto.Ready
		if decode(&m) {
			s.onReady(c)
		}
	case proto.MsgChat:
		var m proto.Chat
		if decode(&m) {
			s.onChat(c, m.Text)
		}
	case proto.MsgScriptEvent:
		var m proto.ScriptEvent
		if decode(&m) {
			s.onRemoteEvent(c, &m)
		}
	case proto.MsgProcCall:
		var m proto.ProcCall
		if decode(&m) {
			s.onClientProcCall(c, &m)
		}
	case proto.MsgProcResult:
		var m proto.ProcResult
		if decode(&m) {
			s.onClientProcResult(c, &m)
		}
	default:
		c.badMessages++
	}
}

// newer reports whether client timestamp t is after last (wrap-aware).
func newer(t, last uint32) bool { return int32(t-last) > 0 }

func validPos(p proto.Vec3) bool {
	return p.IsFinite() && math.Abs(float64(p.X)) < worldLimit && math.Abs(float64(p.Y)) < worldLimit && p.Z > -1000 && p.Z < 5000
}

// ------------------------------------------------------------------ on foot

func (s *Server) onPedSync(c *client, m *proto.PedSync) {
	p := c.p
	if !p.Spawned || p.InVehicle() || p.TeleportPending {
		return
	}
	if p.SyncTime != 0 && !newer(m.Time, p.SyncTime) {
		return // reordered or duplicate
	}
	p.SyncTime = m.Time
	if !validPos(m.Pos) || !m.Vel.IsFinite() || (m.Flags&proto.PedAiming != 0 && !m.AimPos.IsFinite()) {
		c.badMessages++
		return
	}
	if s.cfg.GoMP.AnticheatEnabled && !c.acExempt {
		if r := c.mover.CheckFoot(s.now, p.Pos, m.Pos, s.acLimits); !r.OK {
			s.violation(c, "speed", r.Limit)
			return
		}
	}
	s.metrics.syncIn.Add(1)
	if !p.Dead {
		s.applyWeaponSwitch(c, m.Weapon)
		p.Flags, p.Move = m.Flags, m.Move
		p.AimPos = m.AimPos
	} else {
		p.Flags, p.Move = m.Flags&(proto.PedRagdoll|proto.PedFalling|proto.PedSwimming), proto.MoveIdle
	}
	p.Pos, p.Vel, p.Heading = m.Pos, m.Vel, m.Heading
	p.LastValidPos = m.Pos
	p.LastSyncAt = s.now
	s.grid.Upsert(p.Key(), p.Dimension, p.Pos)
	s.markSync(p)
}

// applyWeaponSwitch accepts the client's selected weapon if the server agrees
// it owns it, otherwise re-sends the loadout.
func (s *Server) applyWeaponSwitch(c *client, w uint32) {
	p := c.p
	if w == p.Weapon {
		return
	}
	if _, owned := p.Weapons[w]; !owned && w != unarmed {
		s.sendLoadout(c)
		return
	}
	old := p.Weapon
	p.Weapon = w
	s.hostUpdate(p, "weapon", int64(w))
	s.emit("playerWeaponChange", p.Key(), int64(old), int64(w))
}

// violation records an anti-cheat violation and snaps the player back.
func (s *Server) violation(c *client, kind, detail string) {
	p := c.p
	s.metrics.violations.Add(1)
	if s.now.Sub(p.LastViolationAt) > 30*time.Second {
		p.Violations = 0
	}
	p.Violations++
	p.LastViolationAt = s.now
	s.log.Debug("sync violation", "player", p.Name, "kind", kind, "detail", detail, "count", p.Violations)
	s.emit("playerSyncViolation", p.Key(), kind, detail)
	target := p.LastValidPos
	if p.Vehicle != nil && p.IsDriver() {
		target = p.Vehicle.Pos
	}
	s.teleport(p, target, proto.KeepHeading, proto.PosCorrection)
	if s.cfg.GoMP.KickOnViolations && p.Violations >= s.cfg.GoMP.MaxViolations {
		s.kick(c, "anti-cheat: "+kind)
	}
}

// teleport moves a player (or the vehicle they drive) and waits for the client's ack.
func (s *Server) teleport(p *world.Player, pos proto.Vec3, heading float32, reason proto.SetPositionReason) {
	c := s.clientOf(p)
	if c == nil {
		return
	}
	p.TeleportSeq++
	p.TeleportPending = true
	p.TeleportAt = s.now
	p.Pos = pos
	if !math.IsNaN(float64(heading)) {
		p.Heading = heading
	}
	p.LastValidPos = pos
	if v := p.Vehicle; v != nil && p.IsDriver() {
		v.Pos = pos
		s.grid.Upsert(v.Key(), v.Dimension, v.Pos)
		s.markSync(v)
	}
	c.mover.Reset()
	s.indexEntity(p)
	s.markSync(p)
	s.sendTo(c, transport.Reliable, &proto.SetPosition{Seq: p.TeleportSeq, Reason: reason, Pos: pos, Heading: heading})
	if reason == proto.PosCorrection {
		s.metrics.corrections.Add(1)
	}
}

func (s *Server) onTeleportAck(c *client, seq uint16) {
	p := c.p
	if p.TeleportPending && seq == p.TeleportSeq {
		p.TeleportPending = false
		c.mover.Reset()
	}
}

func (s *Server) onReady(c *client) {
	p := c.p
	if p.Ready {
		return
	}
	p.Ready = true
	s.hostUpdate(p, "ready", true)
	s.emit("playerReady", p.Key())
	if s.cfg.GoMP.AutoSpawn && !p.Spawned && !s.scriptsActive() {
		s.spawnPlayer(p, s.defaultSpawn(), float32(s.cfg.GoMP.SpawnHeading))
	}
}

// spawnPlayer resurrects p at pos (player.spawn).
func (s *Server) spawnPlayer(p *world.Player, pos proto.Vec3, heading float32) {
	c := s.clientOf(p)
	if c == nil {
		return
	}
	if p.Vehicle != nil {
		s.removeFromVehicle(p, false)
	}
	s.clearReservation(p)
	wasDead := p.Dead
	p.Dead = false
	p.Health = 100
	p.Spawned = true
	p.Vel = proto.Vec3{}
	c.shots.Reset()
	c.respawnAt = time.Time{}
	s.teleport(p, pos, heading, proto.PosSpawn)
	props := proto.Props{proto.PropHealth: int64(100), proto.PropHeading: float64(heading)}
	if wasDead {
		props[proto.PropDead] = false
	}
	s.replicate(p, props, true)
	s.hostUpdate(p, "health", int64(100))
	s.hostUpdate(p, "dead", false)
	s.hostUpdate(p, "spawned", true)
	s.emit("playerSpawn", p.Key())
}

// ------------------------------------------------------------------ chat & scripting

func refill(tokens *float32, last *time.Time, now time.Time, rate, burst float32) {
	if last.IsZero() {
		*tokens = burst
	} else {
		*tokens = min(burst, *tokens+rate*float32(now.Sub(*last).Seconds()))
	}
	*last = now
}

func (s *Server) onChat(c *client, text string) {
	refill(&c.chatTokens, &c.chatLast, s.now, chatRate, chatBurst)
	if c.chatTokens < 1 {
		return
	}
	c.chatTokens--
	if text == "" || !utf8.ValidString(text) || utf8.RuneCountInString(text) > maxChatRunes {
		return
	}
	if text[0] == '/' {
		if len(text) > 1 {
			s.emit("playerCommand", c.p.Key(), text[1:])
		}
		return
	}
	s.emit("playerChat", c.p.Key(), text)
}

func (s *Server) onRemoteEvent(c *client, m *proto.ScriptEvent) {
	refill(&c.evTokens, &c.evLast, s.now, eventRate, eventBurst)
	if c.evTokens < 1 {
		s.metrics.droppedEvents.Add(1)
		return
	}
	c.evTokens--
	if m.Name == "" || reservedEvents[m.Name] {
		c.badMessages++
		return
	}
	args := make([]proto.Value, 0, len(m.Args)+1)
	args = append(args, c.p.Key())
	args = append(args, m.Args...)
	s.emitArgs(m.Name, args)
}

func (s *Server) onClientProcCall(c *client, m *proto.ProcCall) {
	host := s.procHost(m.Name)
	if host == 0 {
		s.sendTo(c, transport.Reliable, &proto.ProcResult{CallID: m.CallID, OK: false, Error: "procedure not found: " + m.Name})
		return
	}
	s.nextProcID++
	id := s.nextProcID
	s.serverProcs[id] = serverProc{player: c.p.Ref(), clientCallID: m.CallID, host: host, expires: s.now.Add(procTimeout)}
	s.flushDeltas()
	s.sendToHost(host, hostOp("procReq", int64(id), c.p.Key(), m.Name, m.Args))
}

func (s *Server) onClientProcResult(c *client, m *proto.ProcResult) {
	pp, ok := c.procs[m.CallID]
	if !ok {
		return
	}
	delete(c.procs, m.CallID)
	if m.OK {
		s.sendToHost(pp.host, hostOp("procRes", int64(pp.hostCallID), true, m.Result))
	} else {
		s.sendToHost(pp.host, hostOp("procRes", int64(pp.hostCallID), false, m.Error))
	}
}
