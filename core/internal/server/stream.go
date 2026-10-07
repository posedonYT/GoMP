package server

import (
	"math"
	"sort"

	"gomp/core/internal/streaming"
	"gomp/core/internal/world"
	"gomp/wire/proto"
	"gomp/wire/transport"
)

// streamHysteresis keeps entities streamed until they are this much farther
// than the stream distance.
const streamHysteresis = 1.1

func (s *Server) streamLimits() streaming.Limits {
	d := float32(s.cfg.StreamDistance)
	g := s.cfg.GoMP
	return streaming.Limits{
		EnterSq: d * d,
		LeaveSq: d * d * streamHysteresis * streamHysteresis,
		Caps: map[proto.EntityType]int{
			proto.EntityPlayer:     g.MaxStreamedPlayers,
			proto.EntityVehicle:    g.MaxStreamedVehicles,
			proto.EntityObject:     g.MaxStreamedObjects,
			proto.EntityPed:        g.MaxStreamedOther,
			proto.EntityMarker:     g.MaxStreamedOther,
			proto.EntityCheckpoint: g.MaxStreamedOther,
			proto.EntityTextLabel:  g.MaxStreamedOther,
		},
	}
}

// visibleTo applies per-player visibility overrides (showFor/hideFor) and
// the "visible" property of markers and checkpoints.
func visibleTo(b *world.EntityBase, pid uint16) bool {
	if v, ok := b.VisibleFor[pid]; ok {
		return v
	}
	if v, ok := b.Props[proto.PropVisible].(bool); ok {
		return v
	}
	return true
}

// computeStream fills c.addQ/c.remQ. It only reads shared state and may run in parallel.
func (s *Server) computeStream(c *client, lim streaming.Limits) {
	p := c.p
	cands := c.cands[:0]
	if p.Spawned {
		radius := float32(math.Sqrt(float64(lim.LeaveSq)))
		self := p.Key()
		s.grid.Query(p.Dimension, p.Pos, radius, func(k streaming.Key, _ proto.Vec3, d2 float32) {
			if k == self {
				return
			}
			ent := s.world.Get(k.Type, k.ID)
			if ent == nil {
				return
			}
			b := ent.Base()
			if !visibleTo(b, p.ID) {
				return
			}
			if pl, ok := ent.(*world.Player); ok && !pl.Spawned {
				return
			}
			cands = append(cands, streaming.Candidate{Key: k, Gen: b.Gen, DistSq: d2})
		})
		// Pin the own vehicle, its occupants and a vehicle being entered.
		pin := func(e world.Entity) {
			b := e.Base()
			if b.Key() == self {
				return
			}
			for i := range cands {
				if cands[i].Key == b.Key() {
					cands[i].Pinned = true
					return
				}
			}
			cands = append(cands, streaming.Candidate{Key: b.Key(), Gen: b.Gen, DistSq: p.Pos.DistSq(b.Pos), Pinned: true})
		}
		if v := p.Vehicle; v != nil {
			pin(v)
			for _, o := range v.Occupants {
				if o != nil {
					pin(o)
				}
			}
		}
		if v := p.Entering; v != nil {
			pin(v)
		}
	}
	c.addQ, c.remQ = streaming.DiffInto(c.stream, cands, lim, c.addQ[:0], c.remQ[:0])
	c.cands = cands
}

// streamOrder creates vehicles before players so seat props resolve on clients.
func streamOrder(t proto.EntityType) int {
	switch t {
	case proto.EntityVehicle:
		return 0
	case proto.EntityPlayer:
		return 1
	default:
		return 2
	}
}

// streamSlice returns the clients due for a stream update this tick.
func (s *Server) streamSlice() []*client {
	slot := s.tick % s.streamEvery
	out := s.sliceBuf[:0]
	for _, c := range s.byID {
		if c != nil && uint64(c.p.ID)%s.streamEvery == slot {
			out = append(out, c)
		}
	}
	s.sliceBuf = out
	return out
}

func (s *Server) updateStreaming() {
	clients := s.streamSlice()
	lim := s.limits
	parallel(len(clients), func(i int) { s.computeStream(clients[i], lim) })
	for _, c := range clients {
		for _, k := range c.remQ {
			s.streamOut(c, k)
		}
		sort.SliceStable(c.addQ, func(i, j int) bool {
			return streamOrder(c.addQ[i].Key.Type) < streamOrder(c.addQ[j].Key.Type)
		})
		for _, cand := range c.addQ {
			ent := s.world.Get(cand.Key.Type, cand.Key.ID)
			if ent == nil || ent.Base().Gen != cand.Gen {
				continue
			}
			s.streamIn(c, ent, cand)
		}
	}
}

func (s *Server) streamIn(c *client, ent world.Entity, cand streaming.Candidate) {
	b := ent.Base()
	key := b.Key()
	if old := c.stream.Get(key); old != nil {
		s.streamOut(c, key)
	}
	c.stream.Add(cand)
	set := s.streamers[key]
	if set == nil {
		set = make(map[uint16]struct{})
		s.streamers[key] = set
	}
	set[c.p.ID] = struct{}{}
	s.sendTo(c, transport.Reliable, s.createMessage(ent))
	s.metrics.streamIns.Add(1)
	switch e := ent.(type) {
	case *world.Player:
		s.emit("playerStreamIn", key, c.p.Key())
		if e.Vehicle != nil && e.Vehicle.Controller == nil && e.Vehicle.Driver() == nil {
			s.assignController(e.Vehicle)
		}
	case *world.Vehicle:
		if e.Driver() == nil && e.Controller == nil {
			s.assignController(e)
		}
	}
}

// streamInNow streams ent to c immediately (e.g. before putIntoVehicle).
func (s *Server) streamInNow(c *client, ent world.Entity) {
	b := ent.Base()
	if e := c.stream.Get(b.Key()); e != nil && e.Gen == b.Gen {
		return
	}
	s.streamIn(c, ent, streaming.Candidate{Key: b.Key(), Gen: b.Gen, DistSq: c.p.Pos.DistSq(b.Pos), Pinned: true})
}

func (s *Server) streamOut(c *client, k streaming.Key) {
	if !c.stream.Has(k) {
		return
	}
	c.stream.Remove(k)
	s.unindexStreamer(k, c.p.ID)
	s.sendTo(c, transport.Reliable, &proto.EntityDestroy{Type: k.Type, EntID: k.ID})
	if k.Type == proto.EntityPlayer {
		s.emit("playerStreamOut", k, c.p.Key())
	}
	if k.Type == proto.EntityVehicle {
		if v := s.world.Vehicles.Get(k.ID); v != nil && v.Controller == c.p {
			s.setController(v, nil, false)
			s.assignController(v)
		}
	}
}

func (s *Server) unindexStreamer(k streaming.Key, pid uint16) {
	if set := s.streamers[k]; set != nil {
		delete(set, pid)
		if len(set) == 0 {
			delete(s.streamers, k)
		}
	}
}

// setDimension moves an entity to another dimension and restreams it.
func (s *Server) setDimension(ent world.Entity, dim uint32) {
	b := ent.Base()
	if b.Dimension == dim {
		return
	}
	b.Dimension = dim
	s.hostUpdate(ent, "dim", int64(dim))
	switch e := ent.(type) {
	case *world.Player:
		if e.Spawned {
			s.grid.Upsert(b.Key(), dim, b.Pos)
		}
		if c := s.clientOf(e); c != nil {
			s.syncGlobals(c)
		}
	case *world.Blip, *world.Dummy:
		s.publishGlobal(ent)
		return
	default:
		s.indexEntity(ent)
	}
	// Streamers outside the new dimension drop it at the next stream update;
	// do it now so no stale sync is sent.
	for id := range s.streamers[b.Key()] {
		if c := s.byID[id]; c != nil && !sameDim(c.p.Dimension, dim) {
			s.streamOut(c, b.Key())
		}
	}
}

// ------------------------------------------------------------------ colshapes & checkpoints

// updateShapes fires enter/exit events for colshapes and checkpoints.
func (s *Server) updateShapes() {
	if s.world.Colshapes.Len() == 0 && s.world.Checkpoints.Len() == 0 {
		return
	}
	radius := s.maxShapeRadius + 1
	for _, c := range s.sliceBuf {
		if !c.p.Spawned || s.clientOf(c.p) != c {
			continue
		}
		p := c.p
		pk := p.Key()
		inside := map[proto.EntityRef]bool{}
		s.shapes.Query(p.Dimension, p.Pos, radius, func(k streaming.Key, _ proto.Vec3, _ float32) {
			switch k.Type {
			case proto.EntityColshape:
				if cs := s.world.Colshapes.Get(k.ID); cs != nil && cs.Contains(p.Pos) {
					inside[k] = true
				}
			case proto.EntityCheckpoint:
				if cp := s.world.Checkpoints.Get(k.ID); cp != nil && visibleTo(&cp.EntityBase, p.ID) &&
					p.Pos.DistSq(cp.Pos) <= cp.Radius*cp.Radius {
					inside[k] = true
				}
			}
		})
		for _, cs := range s.largeShapes {
			if sameDim(cs.Dimension, p.Dimension) && cs.Contains(p.Pos) {
				inside[cs.Key()] = true
			}
		}
		// Exits first, then entries.
		s.world.Colshapes.Each(func(_ uint16, cs *world.Colshape) {
			if cs.Inside[p.ID] && !inside[cs.Key()] {
				delete(cs.Inside, p.ID)
				s.emit("playerExitColshape", pk, cs.Key())
			}
		})
		s.world.Checkpoints.Each(func(_ uint16, cp *world.Checkpoint) {
			if cp.Inside[p.ID] && !inside[cp.Key()] {
				delete(cp.Inside, p.ID)
				s.emit("playerExitCheckpoint", pk, cp.Key())
			}
		})
		for k := range inside {
			switch k.Type {
			case proto.EntityColshape:
				cs := s.world.Colshapes.Get(k.ID)
				if !cs.Inside[p.ID] {
					if cs.Inside == nil {
						cs.Inside = map[uint16]bool{}
					}
					cs.Inside[p.ID] = true
					s.emit("playerEnterColshape", pk, k)
				}
			case proto.EntityCheckpoint:
				cp := s.world.Checkpoints.Get(k.ID)
				if !cp.Inside[p.ID] {
					if cp.Inside == nil {
						cp.Inside = map[uint16]bool{}
					}
					cp.Inside[p.ID] = true
					s.emit("playerEnterCheckpoint", pk, k)
				}
			}
		}
	}
}
