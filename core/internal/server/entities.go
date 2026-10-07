package server

import (
	"maps"
	"strconv"

	"gomp/core/internal/gamedata"
	"gomp/core/internal/world"
	"gomp/wire/proto"
	"gomp/wire/transport"
)

var unarmed = gamedata.Unarmed

func propKey(id proto.PropID) string { return strconv.Itoa(int(id)) }

// createMessage builds the stream-in message for ent, combining core-managed
// fields with cosmetic props.
func (s *Server) createMessage(ent world.Entity) *proto.EntityCreate {
	b := ent.Base()
	m := &proto.EntityCreate{Type: b.Type, EntID: b.ID, Model: b.Model, Pos: b.Pos, Rot: b.Rot}
	props := make(proto.Props, len(b.Props)+8)
	maps.Copy(props, b.Props)
	if b.Alpha != 255 {
		props[proto.PropAlpha] = int64(b.Alpha)
	}
	switch e := ent.(type) {
	case *world.Player:
		props[proto.PropName] = e.Name
		props[proto.PropHealth] = int64(e.Health)
		props[proto.PropArmour] = int64(e.Armour)
		props[proto.PropWeapon] = int64(e.Weapon)
		props[proto.PropHeading] = float64(e.Heading)
		if e.Dead {
			props[proto.PropDead] = true
		}
		if e.Vehicle != nil {
			props[proto.PropVehicle] = []proto.Value{int64(e.Vehicle.ID), int64(e.Seat)}
		}
	case *world.Vehicle:
		m.Rot = e.Quat.Euler()
		props[proto.PropEngine] = e.Engine
		props[proto.PropLocked] = e.Locked
		props[proto.PropBodyHealth] = float64(e.BodyHealth)
		props[proto.PropEngineHealth] = float64(e.EngineHealth)
		if e.Dead {
			props[proto.PropDead] = true
		}
		if !e.Movable {
			props[proto.PropMovable] = false
		}
	case *world.Ped:
		props[proto.PropHeading] = float64(e.Heading)
	case *world.Checkpoint:
		props[proto.PropCheckpointRadius] = float64(e.Radius)
	}
	if len(props) > 0 {
		m.Props = props
	}
	if len(b.Shared) > 0 {
		m.Shared = maps.Clone(b.Shared)
	}
	return m
}

// replicate sends core-managed property values (already applied to the typed
// fields by the caller) to streamers.
func (s *Server) replicate(ent world.Entity, props proto.Props, self bool) {
	b := ent.Base()
	s.toStreamers(ent, transport.Reliable, &proto.EntitySetProps{Type: b.Type, EntID: b.ID, Props: props}, self)
}

// streamable reports whether an entity type is distance-streamed via the grid.
func streamable(t proto.EntityType) bool {
	switch t {
	case proto.EntityPlayer, proto.EntityVehicle, proto.EntityObject, proto.EntityPed,
		proto.EntityMarker, proto.EntityCheckpoint, proto.EntityTextLabel:
		return true
	}
	return false
}

// indexEntity (re)inserts ent into the spatial structures after it was
// created or moved by the server.
func (s *Server) indexEntity(ent world.Entity) {
	b := ent.Base()
	switch e := ent.(type) {
	case *world.Player:
		if e.Spawned {
			s.grid.Upsert(b.Key(), b.Dimension, b.Pos)
		}
	case *world.Colshape:
		s.indexShape(e)
	case *world.Checkpoint:
		s.grid.Upsert(b.Key(), b.Dimension, b.Pos)
		s.shapes.Upsert(b.Key(), b.Dimension, b.Pos)
		s.maxShapeRadius = max(s.maxShapeRadius, e.Radius)
	default:
		if streamable(b.Type) {
			s.grid.Upsert(b.Key(), b.Dimension, b.Pos)
		}
	}
}

const largeShapeRadius = 400

func (s *Server) indexShape(cs *world.Colshape) {
	r := cs.BoundingRadius()
	if r > largeShapeRadius {
		s.shapes.Remove(cs.Key())
		s.largeShapes[cs.ID] = cs
		return
	}
	delete(s.largeShapes, cs.ID)
	s.shapes.Upsert(cs.Key(), cs.Dimension, cs.Pos)
	s.maxShapeRadius = max(s.maxShapeRadius, r)
}

// destroyEntity removes ent from the world and from every client.
func (s *Server) destroyEntity(ent world.Entity) {
	b := ent.Base()
	if b.Destroyed {
		return
	}
	key := b.Key()
	if v, ok := ent.(*world.Vehicle); ok {
		// Occupants are told explicitly before the vehicle disappears.
		v.Movable = false // marks the vehicle as going away for removeFromVehicle
		if v.Controller != nil {
			s.setController(v, nil, false)
		}
		for _, p := range v.Occupants {
			if p != nil {
				s.removeFromVehicle(p, true)
			}
		}
		for _, p := range v.Reserved {
			if p != nil {
				s.clearReservation(p)
			}
		}
		v.Controller = nil
	}
	msg := &proto.EntityDestroy{Type: b.Type, EntID: b.ID}
	switch b.Type {
	case proto.EntityBlip:
		for _, c := range s.byID {
			if c != nil {
				if _, ok := c.blips[b.ID]; ok {
					delete(c.blips, b.ID)
					s.sendTo(c, transport.Reliable, msg)
				}
			}
		}
	case proto.EntityDummy:
		for _, c := range s.byID {
			if c != nil {
				delete(c.dummies, b.ID)
			}
		}
		s.toAll(transport.Reliable, msg)
	default:
		for id := range s.streamers[key] {
			if c := s.byID[id]; c != nil {
				c.stream.Remove(key)
				s.sendTo(c, transport.Reliable, msg)
				if b.Type == proto.EntityPlayer {
					s.emit("playerStreamOut", key, c.p.Key())
				}
			}
		}
	}
	delete(s.streamers, key)
	s.dropSyncCache(key)
	s.grid.Remove(key)
	s.shapes.Remove(key)
	if cs, ok := ent.(*world.Colshape); ok {
		delete(s.largeShapes, cs.ID)
	}
	s.hostDestroy(ent)
	s.world.Remove(ent)
}

// syncGlobals sends blips (by dimension) and dummies that c does not have yet,
// and removes blips that are no longer visible after a dimension change.
func (s *Server) syncGlobals(c *client) {
	dim := c.p.Dimension
	s.world.Blips.Each(func(id uint16, bl *world.Blip) {
		visible := bl.Dimension == dim || bl.Dimension == proto.GlobalDimension
		gen, has := c.blips[id]
		switch {
		case visible && (!has || gen != bl.Gen):
			c.blips[id] = bl.Gen
			s.sendTo(c, transport.Reliable, s.createMessage(bl))
		case !visible && has:
			delete(c.blips, id)
			s.sendTo(c, transport.Reliable, &proto.EntityDestroy{Type: proto.EntityBlip, EntID: id})
		}
	})
	for id, gen := range c.blips {
		if bl := s.world.Blips.Get(id); bl == nil || bl.Gen != gen {
			delete(c.blips, id)
		}
	}
	s.world.Dummies.Each(func(id uint16, d *world.Dummy) {
		if gen, has := c.dummies[id]; !has || gen != d.Gen {
			c.dummies[id] = d.Gen
			s.sendTo(c, transport.Reliable, s.createMessage(d))
		}
	})
}

// publishGlobal sends a newly created blip or dummy to every player that should see it.
func (s *Server) publishGlobal(ent world.Entity) {
	for _, c := range s.byID {
		if c != nil {
			s.syncGlobals(c)
		}
	}
	_ = ent
}

// sendLoadout replaces the client's weapons with the server's view.
func (s *Server) sendLoadout(c *client) {
	p := c.p
	m := &proto.Loadout{Current: p.Weapon}
	for h, ammo := range p.Weapons {
		m.Weapons = append(m.Weapons, proto.WeaponAmmo{Hash: h, Ammo: ammo})
	}
	s.sendTo(c, transport.Reliable, m)
	s.hostUpdate(p, "weapons", weaponsValue(p))
	s.hostUpdate(p, "weapon", int64(p.Weapon))
}

func weaponsValue(p *world.Player) map[string]proto.Value {
	m := make(map[string]proto.Value, len(p.Weapons))
	for h, a := range p.Weapons {
		m[strconv.FormatUint(uint64(h), 10)] = int64(a)
	}
	return m
}
