package server

import (
	"errors"
	"fmt"
	"maps"
	"strconv"

	"gomp/core/internal/hostbridge"
	"gomp/core/internal/world"
	"gomp/wire/proto"
)

// hostState tracks one connected script host.
type hostState struct {
	id            int
	name          string
	subs          map[string]bool
	loaded        bool
	shutdownReady bool
}

func hostOp(name string, args ...proto.Value) hostbridge.Op {
	return append(hostbridge.Op{name}, args...)
}

// scriptsActive reports whether a script host is connected (it then owns
// spawning; the core's auto-spawn is disabled).
func (s *Server) scriptsActive() bool { return len(s.hosts) > 0 }

func (s *Server) sendToHost(host int, op hostbridge.Op) {
	if s.scripts != nil && s.hosts[host] != nil {
		s.scripts.Send(host, op)
	}
}

// procHost returns the host that registered procedure name (0 = none).
func (s *Server) procHost(name string) int {
	for id, h := range s.hosts {
		if h.subs["proc:"+name] {
			return id
		}
	}
	return 0
}

// emit sends a server event to subscribed hosts.
func (s *Server) emit(name string, args ...proto.Value) { s.emitArgs(name, args) }

func (s *Server) emitArgs(name string, args []proto.Value) {
	if len(s.hosts) == 0 {
		return
	}
	var targets []int
	for id, h := range s.hosts {
		if h.subs[name] {
			targets = append(targets, id)
		}
	}
	if len(targets) == 0 {
		return
	}
	s.metrics.hostEvents.Add(1)
	// Deltas first: handlers must observe the state that caused the event.
	s.flushDeltas()
	op := hostOp(hostbridge.OpEvent, name, args)
	for _, id := range targets {
		s.scripts.Send(id, op)
	}
}

// hostUpdate queues a mirror change. Map values (props, shared, own) merge.
func (s *Server) hostUpdate(ent world.Entity, key string, v proto.Value) {
	if len(s.hosts) == 0 {
		return
	}
	i, ok := s.hostPendingIx[ent]
	if !ok {
		i = len(s.hostPending)
		s.hostPendingIx[ent] = i
		s.hostPending = append(s.hostPending, pendingUpdate{ent: ent, fields: map[string]proto.Value{}})
	}
	f := s.hostPending[i].fields
	if m, isMap := v.(map[string]proto.Value); isMap && (key == "props" || key == "shared" || key == "own") {
		if old, ok := f[key].(map[string]proto.Value); ok {
			maps.Copy(old, m)
			return
		}
		f[key] = maps.Clone(m)
		return
	}
	f[key] = v
}

func (s *Server) markHostSync(ent world.Entity) {
	if len(s.hosts) > 0 {
		s.hostSyncDirty[ent] = struct{}{}
	}
}

func syncFields(ent world.Entity, f map[string]proto.Value) {
	switch e := ent.(type) {
	case *world.Player:
		f["pos"] = e.Pos
		f["heading"] = float64(e.Heading)
		f["vel"] = e.Vel
		f["flags"] = int64(e.Flags)
		f["move"] = int64(e.Move)
		if e.Flags&proto.PedAiming != 0 {
			f["aimPos"] = e.AimPos
		}
	case *world.Vehicle:
		f["pos"] = e.Pos
		f["rot"] = e.Rot
		f["vel"] = e.Vel
		f["steer"] = float64(e.Steer)
		f["vflags"] = int64(e.Flags)
	}
}

// flushDeltas turns pending mirror changes into update ops, in order.
func (s *Server) flushDeltas() {
	if len(s.hosts) == 0 {
		s.hostPending = s.hostPending[:0]
		clear(s.hostPendingIx)
		clear(s.hostSyncDirty)
		return
	}
	for ent := range s.hostSyncDirty {
		i, ok := s.hostPendingIx[ent]
		if !ok {
			i = len(s.hostPending)
			s.hostPendingIx[ent] = i
			s.hostPending = append(s.hostPending, pendingUpdate{ent: ent, fields: map[string]proto.Value{}})
		}
		syncFields(ent, s.hostPending[i].fields)
	}
	clear(s.hostSyncDirty)
	for _, pu := range s.hostPending {
		b := pu.ent.Base()
		if b.Destroyed || len(pu.fields) == 0 {
			continue
		}
		s.scripts.Broadcast(hostOp(hostbridge.OpUpdate, int64(b.Type), int64(b.ID), pu.fields))
		s.metrics.hostOpsOut.Add(1)
	}
	s.hostPending = s.hostPending[:0]
	clear(s.hostPendingIx)
}

// flushHosts sends everything queued this tick.
func (s *Server) flushHosts() {
	if s.scripts == nil {
		return
	}
	s.flushDeltas()
	s.scripts.Flush()
}

// fullState serialises every mirrored field of ent.
func (s *Server) fullState(ent world.Entity) map[string]proto.Value {
	b := ent.Base()
	st := map[string]proto.Value{
		"model": int64(b.Model), "pos": b.Pos, "rot": b.Rot, "dim": int64(b.Dimension), "alpha": int64(b.Alpha),
	}
	if len(b.Props) > 0 {
		props := make(map[string]proto.Value, len(b.Props))
		for id, v := range b.Props {
			props[propKey(id)] = v
		}
		st["props"] = props
	}
	if len(b.Shared) > 0 {
		st["shared"] = maps.Clone(b.Shared)
	}
	switch e := ent.(type) {
	case *world.Player:
		st["name"] = e.Name
		st["health"] = int64(e.Health)
		st["armour"] = int64(e.Armour)
		st["heading"] = float64(e.Heading)
		st["vel"] = e.Vel
		st["weapon"] = int64(e.Weapon)
		st["weapons"] = weaponsValue(e)
		st["veh"], st["seat"] = int64(-1), int64(0)
		if e.Vehicle != nil {
			st["veh"], st["seat"] = int64(e.Vehicle.ID), int64(e.Seat)
		}
		st["dead"] = e.Dead
		st["spawned"] = e.Spawned
		st["ready"] = e.Ready
		st["ip"] = e.IP
		st["serial"] = e.Serial
		st["sc"] = e.SocialClub
		st["rgscId"] = e.RGSCID
		st["gameType"] = e.GameType
		st["ping"] = int64(e.Ping)
		st["loss"] = e.PacketLoss
		st["flags"] = int64(e.Flags)
		st["move"] = int64(e.Move)
		if len(e.OwnShared) > 0 {
			st["own"] = maps.Clone(e.OwnShared)
		}
	case *world.Vehicle:
		st["engine"] = e.Engine
		st["locked"] = e.Locked
		st["dead"] = e.Dead
		st["movable"] = e.Movable
		st["bodyHealth"] = float64(e.BodyHealth)
		st["engineHealth"] = float64(e.EngineHealth)
		st["vel"] = e.Vel
		st["steer"] = float64(e.Steer)
		st["vflags"] = int64(e.Flags)
		st["seats"] = int64(len(e.Occupants))
		st["controller"] = int64(-1)
		if e.Controller != nil {
			st["controller"] = int64(e.Controller.ID)
		}
	case *world.Colshape:
		st["shape"] = int64(e.Kind)
		st["radius"] = float64(e.Radius)
		st["width"] = float64(e.Width)
		st["depth"] = float64(e.Depth)
		st["height"] = float64(e.Height)
	case *world.Checkpoint:
		st["radius"] = float64(e.Radius)
	case *world.Ped:
		st["heading"] = float64(e.Heading)
	case *world.Dummy:
		st["dummyType"] = int64(e.DummyType)
	}
	return st
}

// hostCreate announces an entity created by the core (or by another host).
func (s *Server) hostCreate(ent world.Entity) {
	if len(s.hosts) == 0 {
		return
	}
	s.flushDeltas()
	b := ent.Base()
	op := hostOp(hostbridge.OpCreate, int64(b.Type), int64(b.ID), int64(b.Gen), s.fullState(ent))
	for id := range s.hosts {
		if id != b.Origin {
			s.scripts.Send(id, op)
		}
	}
}

func (s *Server) hostDestroy(ent world.Entity) {
	if len(s.hosts) == 0 {
		return
	}
	s.flushDeltas()
	b := ent.Base()
	s.scripts.Broadcast(hostOp(hostbridge.OpDestroy, int64(b.Type), int64(b.ID), int64(b.Gen)))
}

// ------------------------------------------------------------------ host lifecycle

func (s *Server) onHostEvent(e hostbridge.Event) {
	switch e.Kind {
	case hostbridge.HostUp:
		s.onHostUp(e.Host, e.Name)
	case hostbridge.HostDown:
		s.onHostDown(e.Host, e.Reason)
	case hostbridge.HostOps:
		h := s.hosts[e.Host]
		if h == nil {
			return
		}
		for _, op := range e.Ops {
			s.metrics.hostOpsIn.Add(1)
			err := s.execHostOp(h, op)
			switch {
			case err == nil:
			case errors.Is(err, errNoEntity) || errors.Is(err, errStaleRef):
				// Like RAGE.MP: calls on entities that just left are ignored.
				s.log.Debug("script command on a gone entity", "op", op[0], "err", err)
			default:
				s.log.Warn("script command failed", "op", op[0], "err", err)
				s.scripts.Send(h.id, hostOp(hostbridge.OpError, fmt.Sprintf("%v: %v", op[0], err)))
			}
		}
	}
}

func (s *Server) onHostUp(id int, name string) {
	h := &hostState{id: id, name: name, subs: map[string]bool{}}
	s.hosts[id] = h
	ranges := map[string]proto.Value{}
	for _, t := range world.AllTypes {
		if t == proto.EntityPlayer {
			continue
		}
		ranges[strconv.Itoa(int(t))] = []proto.Value{int64(0), int64(s.poolCap(t))}
	}
	info := map[string]proto.Value{
		"tickRate":       int64(s.tickRate),
		"maxPlayers":     int64(s.cfg.MaxPlayers),
		"streamDistance": s.cfg.StreamDistance,
		"ranges":         ranges,
		"weather":        s.world.Weather,
		"time":           []proto.Value{int64(s.world.Time.Hour), int64(s.world.Time.Minute), int64(s.world.Time.Second)},
	}
	cfg := make(map[string]proto.Value, len(s.cfg.Raw))
	for k, v := range s.cfg.Raw {
		cfg[k] = proto.NormalizeValue(jsonToValue(v))
	}
	s.scripts.Send(id, hostOp(hostbridge.OpHello, int64(hostbridge.Version), cfg, info))
	for _, c := range s.clientList() {
		b := c.p.Base()
		s.scripts.Send(id, hostOp(hostbridge.OpCreate, int64(b.Type), int64(b.ID), int64(b.Gen), s.fullState(c.p)))
	}
	s.scripts.Send(id, hostOp(hostbridge.OpReady))
}

func jsonToValue(v any) proto.Value {
	switch x := v.(type) {
	case map[string]any:
		m := make(map[string]proto.Value, len(x))
		for k, e := range x {
			m[k] = jsonToValue(e)
		}
		return m
	case []any:
		a := make([]proto.Value, len(x))
		for i, e := range x {
			a[i] = jsonToValue(e)
		}
		return a
	}
	return v
}

func (s *Server) poolCap(t proto.EntityType) int {
	switch t {
	case proto.EntityVehicle:
		return s.world.Vehicles.Cap()
	case proto.EntityObject:
		return s.world.Objects.Cap()
	case proto.EntityPed:
		return s.world.Peds.Cap()
	case proto.EntityBlip:
		return s.world.Blips.Cap()
	case proto.EntityMarker:
		return s.world.Markers.Cap()
	case proto.EntityCheckpoint:
		return s.world.Checkpoints.Cap()
	case proto.EntityColshape:
		return s.world.Colshapes.Cap()
	case proto.EntityTextLabel:
		return s.world.Labels.Cap()
	case proto.EntityDummy:
		return s.world.Dummies.Cap()
	}
	return 0
}

// onHostDown removes everything the host created, like stopping a resource.
func (s *Server) onHostDown(id int, reason string) {
	h := s.hosts[id]
	if h == nil {
		return
	}
	s.log.Warn("script host disconnected", "host", h.name, "reason", reason)
	delete(s.hosts, id)
	var owned []world.Entity
	for _, t := range world.AllTypes {
		s.world.Each(t, func(e world.Entity) {
			if e.Base().Origin == id {
				owned = append(owned, e)
			}
		})
	}
	for _, e := range owned {
		s.destroyEntity(e)
	}
	for cid, sp := range s.serverProcs {
		if sp.host == id {
			delete(s.serverProcs, cid)
			if c := s.clientByRef(sp.player); c != nil {
				s.sendTo(c, 1, &proto.ProcResult{CallID: sp.clientCallID, Error: "script host restarted"})
			}
		}
	}
	for _, c := range s.byID {
		if c == nil {
			continue
		}
		for pid, pp := range c.procs {
			if pp.host == id {
				delete(c.procs, pid)
			}
		}
	}
	if len(s.hosts) == 0 {
		s.hostPending = s.hostPending[:0]
		clear(s.hostPendingIx)
		clear(s.hostSyncDirty)
	}
}
