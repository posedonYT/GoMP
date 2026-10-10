package server

import (
	"cmp"
	"slices"

	"gomp/core/internal/streaming"
	"gomp/core/internal/world"
	"gomp/wire/proto"
	"gomp/wire/transport"
)

// markSync records that ent's sync state changed this tick, for both the
// network snapshot and the script hosts' mirror.
func (s *Server) markSync(ent world.Entity) {
	switch e := ent.(type) {
	case *world.Player:
		if e.SyncSeq++; e.SyncSeq == 0 {
			e.SyncSeq = 1
		}
	case *world.Vehicle:
		if e.SyncSeq++; e.SyncSeq == 0 {
			e.SyncSeq = 1
		}
	default:
		return
	}
	s.netDirty = append(s.netDirty, ent.Base().Key())
	s.markHostSync(ent)
}

// syncSlot returns the cache slot of a player or vehicle (nil for other types).
func (s *Server) syncSlot(k proto.EntityRef) **cachedSync {
	switch k.Type {
	case proto.EntityPlayer:
		if int(k.ID) < len(s.playerSync) {
			return &s.playerSync[k.ID]
		}
	case proto.EntityVehicle:
		if int(k.ID) < len(s.vehicleSync) {
			return &s.vehicleSync[k.ID]
		}
	}
	return nil
}

func (s *Server) dropSyncCache(k proto.EntityRef) {
	if slot := s.syncSlot(k); slot != nil {
		*slot = nil
	}
}

// prepareSyncCache encodes the latest sync message of every entity that
// changed this tick, once, so all receivers share the bytes.
//
// Nothing here allocates in the steady state: the seen set, the messages and
// each entity's byte buffer are reused (receivers copy the bytes when they
// queue them, so last tick's buffer is free).
func (s *Server) prepareSyncCache() {
	seen := s.syncSeen
	clear(seen)
	for _, k := range s.netDirty {
		if seen[k] {
			continue
		}
		seen[k] = true
		ent := s.world.Get(k.Type, k.ID)
		slot := s.syncSlot(k)
		if ent == nil || slot == nil {
			if slot != nil {
				*slot = nil
			}
			continue
		}
		var msg proto.Message
		var seq uint32
		switch e := ent.(type) {
		case *world.Player:
			seq = e.SyncSeq
			switch {
			case e.DisableOutgoingSync:
				msg = nil
			case e.Vehicle == nil:
				s.msgPed = proto.PlayerSyncOut{PlayerID: e.ID, PedSync: proto.PedSync{
					Time: e.SyncTime, Pos: e.Pos, Vel: e.Vel, Heading: e.Heading,
					Move: e.Move, Flags: e.Flags, Weapon: e.Weapon, AimPos: e.AimPos}}
				msg = &s.msgPed
			case e.Seat != proto.SeatDriver:
				s.msgPassenger = proto.PassengerSyncOut{PlayerID: e.ID, PassengerSync: proto.PassengerSync{
					VehicleID: e.Vehicle.ID, Seat: e.Seat, Time: e.SyncTime, Flags: e.Flags,
					Weapon: e.Weapon, AimPos: e.AimPos}}
				msg = &s.msgPassenger
			}
		case *world.Vehicle:
			seq = e.SyncSeq
			vs := proto.VehicleSync{
				VehicleID: e.ID, Time: e.SyncTime, Pos: e.Pos, Rot: e.Quat, Vel: e.Vel, AngVel: e.AngVel,
				Steer: e.Steer, Gas: e.Gas, Brake: e.Brake, Flags: e.Flags,
				BodyHealth: e.BodyHealth, EngineHealth: e.EngineHealth,
			}
			if d := e.Driver(); d != nil {
				if d.DisableOutgoingSync {
					break
				}
				if d.Flags&proto.PedAiming != 0 {
					vs.Flags |= proto.VehDriverAiming
					vs.Weapon, vs.AimPos = d.Weapon, d.AimPos
				}
			}
			s.msgVehicle = proto.VehicleSyncOut{VehicleSync: vs}
			msg = &s.msgVehicle
		}
		if msg == nil {
			*slot = nil
			continue
		}
		cs := *slot
		if cs == nil {
			cs = &cachedSync{}
		}
		b, err := proto.MarshalAppend(cs.bytes, msg)
		if err != nil {
			continue
		}
		cs.seq, cs.bytes = seq, b
		*slot = cs
	}
	s.netDirty = s.netDirty[:0]
}

// sendSync distributes sync snapshots to every receiver in parallel. Each
// receiver gets updates by a priority accumulator (near entities more often)
// within its per-tick bandwidth budget.
func (s *Server) sendSync() {
	s.prepareSyncCache()
	clients := s.clientList()
	budget := s.bytesPerTick
	parallel(len(clients), func(i int) {
		c := clients[i]
		if !c.p.Spawned {
			return
		}
		due := c.due[:0]
		for _, e := range c.stream.Entries() {
			var cs *cachedSync
			switch e.Key.Type {
			case proto.EntityPlayer:
				cs = s.playerSync[e.Key.ID]
			case proto.EntityVehicle:
				cs = s.vehicleSync[e.Key.ID]
			default:
				continue
			}
			if cs == nil || cs.seq == e.LastSeq {
				continue
			}
			e.Acc += streaming.SyncWeight(e.DistSq)
			if e.Acc >= 1 {
				due = append(due, dueSync{e: e, cs: cs})
			}
		}
		c.due = due
		if len(due) == 0 {
			return
		}
		slices.SortFunc(due, func(a, b dueSync) int { return cmp.Compare(b.e.Acc, a.e.Acc) })
		left := budget
		out := c.out[:0]
		for _, d := range due {
			cost := len(d.cs.bytes) + 3 // chunk header
			if cost > left {
				continue // smaller messages may still fit; skipped ones keep accumulating
			}
			out = append(out, d.cs.bytes)
			left -= cost
			d.e.LastSeq = d.cs.seq
			d.e.Acc = 0
		}
		_ = c.conn.SendMany(transport.Unreliable, out)
		s.metrics.syncOut.Add(uint64(len(out)))
		if len(out) < len(due) {
			s.metrics.syncDeferred.Add(uint64(len(due) - len(out)))
		}
		clear(out)
		c.out = out[:0]
	})
}

type dueSync struct {
	e  *streaming.Entry
	cs *cachedSync
}
