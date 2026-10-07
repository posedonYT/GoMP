package world

import (
	"fmt"

	"gomp/wire/proto"
)

// Pool capacities for script-created entity kinds.
const (
	MaxVehicles    = 8000
	MaxObjects     = 32000
	MaxPeds        = 2000
	MaxBlips       = 4000
	MaxMarkers     = 4000
	MaxCheckpoints = 2000
	MaxColshapes   = 16000
	MaxLabels      = 8000
	MaxDummies     = 8000
)

// Clock is the in-game time of day.
type Clock struct {
	Hour, Minute, Second uint8
}

// World owns every entity.
type World struct {
	Players     *Pool[Player]
	Vehicles    *Pool[Vehicle]
	Objects     *Pool[Object]
	Peds        *Pool[Ped]
	Blips       *Pool[Blip]
	Markers     *Pool[Marker]
	Checkpoints *Pool[Checkpoint]
	Colshapes   *Pool[Colshape]
	Labels      *Pool[TextLabel]
	Dummies     *Pool[Dummy]

	Time                Clock
	Weather             string
	TrafficLightsLocked bool
	TrafficLightsState  int
	Ipls                map[string]bool // name -> loaded
}

// New creates an empty world. Player ids range over 0..maxPlayers-1.
func New(maxPlayers int) *World {
	return &World{
		Players:     NewPool[Player](maxPlayers),
		Vehicles:    NewPool[Vehicle](MaxVehicles),
		Objects:     NewPool[Object](MaxObjects),
		Peds:        NewPool[Ped](MaxPeds),
		Blips:       NewPool[Blip](MaxBlips),
		Markers:     NewPool[Marker](MaxMarkers),
		Checkpoints: NewPool[Checkpoint](MaxCheckpoints),
		Colshapes:   NewPool[Colshape](MaxColshapes),
		Labels:      NewPool[TextLabel](MaxLabels),
		Dummies:     NewPool[Dummy](MaxDummies),
		Time:        Clock{Hour: 12},
		Weather:     "EXTRASUNNY",
		Ipls:        make(map[string]bool),
	}
}

// Get returns the live entity of type t with id, or nil.
func (w *World) Get(t proto.EntityType, id uint16) Entity {
	switch t {
	case proto.EntityPlayer:
		if e := w.Players.Get(id); e != nil {
			return e
		}
	case proto.EntityVehicle:
		if e := w.Vehicles.Get(id); e != nil {
			return e
		}
	case proto.EntityObject:
		if e := w.Objects.Get(id); e != nil {
			return e
		}
	case proto.EntityPed:
		if e := w.Peds.Get(id); e != nil {
			return e
		}
	case proto.EntityBlip:
		if e := w.Blips.Get(id); e != nil {
			return e
		}
	case proto.EntityMarker:
		if e := w.Markers.Get(id); e != nil {
			return e
		}
	case proto.EntityCheckpoint:
		if e := w.Checkpoints.Get(id); e != nil {
			return e
		}
	case proto.EntityColshape:
		if e := w.Colshapes.Get(id); e != nil {
			return e
		}
	case proto.EntityTextLabel:
		if e := w.Labels.Get(id); e != nil {
			return e
		}
	case proto.EntityDummy:
		if e := w.Dummies.Get(id); e != nil {
			return e
		}
	}
	return nil
}

// Resolve returns the entity for r only if its generation still matches.
func (w *World) Resolve(r Ref) Entity {
	e := w.Get(r.Type, r.ID)
	if e == nil || e.Base().Gen != r.Gen {
		return nil
	}
	return e
}

func add[T any](p *Pool[T], e *T, b *EntityBase, at int) error {
	if at >= 0 {
		if !p.AllocAt(uint16(at), e) {
			return fmt.Errorf("world: %s id %d is out of range or in use", b.Type, at)
		}
		b.ID = uint16(at)
	} else {
		id, err := p.Alloc(e)
		if err != nil {
			return err
		}
		b.ID = id
	}
	b.Gen = p.Gen(b.ID)
	return nil
}

// Add inserts e, assigning the lowest free id, or exactly id at when at >= 0.
func (w *World) Add(e Entity, at int) error {
	b := e.Base()
	switch x := e.(type) {
	case *Player:
		b.Type = proto.EntityPlayer
		return add(w.Players, x, b, at)
	case *Vehicle:
		b.Type = proto.EntityVehicle
		return add(w.Vehicles, x, b, at)
	case *Object:
		b.Type = proto.EntityObject
		return add(w.Objects, x, b, at)
	case *Ped:
		b.Type = proto.EntityPed
		return add(w.Peds, x, b, at)
	case *Blip:
		b.Type = proto.EntityBlip
		return add(w.Blips, x, b, at)
	case *Marker:
		b.Type = proto.EntityMarker
		return add(w.Markers, x, b, at)
	case *Checkpoint:
		b.Type = proto.EntityCheckpoint
		return add(w.Checkpoints, x, b, at)
	case *Colshape:
		b.Type = proto.EntityColshape
		return add(w.Colshapes, x, b, at)
	case *TextLabel:
		b.Type = proto.EntityTextLabel
		return add(w.Labels, x, b, at)
	case *Dummy:
		b.Type = proto.EntityDummy
		return add(w.Dummies, x, b, at)
	}
	return fmt.Errorf("world: unsupported entity %T", e)
}

// Remove frees e's id and marks it destroyed.
func (w *World) Remove(e Entity) {
	b := e.Base()
	if b.Destroyed {
		return
	}
	b.Destroyed = true
	switch b.Type {
	case proto.EntityPlayer:
		w.Players.Free(b.ID)
	case proto.EntityVehicle:
		w.Vehicles.Free(b.ID)
	case proto.EntityObject:
		w.Objects.Free(b.ID)
	case proto.EntityPed:
		w.Peds.Free(b.ID)
	case proto.EntityBlip:
		w.Blips.Free(b.ID)
	case proto.EntityMarker:
		w.Markers.Free(b.ID)
	case proto.EntityCheckpoint:
		w.Checkpoints.Free(b.ID)
	case proto.EntityColshape:
		w.Colshapes.Free(b.ID)
	case proto.EntityTextLabel:
		w.Labels.Free(b.ID)
	case proto.EntityDummy:
		w.Dummies.Free(b.ID)
	}
}

// Each calls fn for every live entity of type t.
func (w *World) Each(t proto.EntityType, fn func(Entity)) {
	switch t {
	case proto.EntityPlayer:
		w.Players.Each(func(_ uint16, e *Player) { fn(e) })
	case proto.EntityVehicle:
		w.Vehicles.Each(func(_ uint16, e *Vehicle) { fn(e) })
	case proto.EntityObject:
		w.Objects.Each(func(_ uint16, e *Object) { fn(e) })
	case proto.EntityPed:
		w.Peds.Each(func(_ uint16, e *Ped) { fn(e) })
	case proto.EntityBlip:
		w.Blips.Each(func(_ uint16, e *Blip) { fn(e) })
	case proto.EntityMarker:
		w.Markers.Each(func(_ uint16, e *Marker) { fn(e) })
	case proto.EntityCheckpoint:
		w.Checkpoints.Each(func(_ uint16, e *Checkpoint) { fn(e) })
	case proto.EntityColshape:
		w.Colshapes.Each(func(_ uint16, e *Colshape) { fn(e) })
	case proto.EntityTextLabel:
		w.Labels.Each(func(_ uint16, e *TextLabel) { fn(e) })
	case proto.EntityDummy:
		w.Dummies.Each(func(_ uint16, e *Dummy) { fn(e) })
	}
}

// AllTypes lists every entity type in creation-safe order.
var AllTypes = []proto.EntityType{
	proto.EntityPlayer, proto.EntityVehicle, proto.EntityObject, proto.EntityPed, proto.EntityBlip,
	proto.EntityMarker, proto.EntityCheckpoint, proto.EntityColshape, proto.EntityTextLabel, proto.EntityDummy,
}

// NewVehicle builds a vehicle with seats slots.
func NewVehicle(model uint32, pos proto.Vec3, heading float32, seats int) *Vehicle {
	if seats < 1 {
		seats = 1
	}
	return &Vehicle{
		EntityBase:   EntityBase{Type: proto.EntityVehicle, Model: model, Pos: pos, Rot: proto.Vec3{Z: heading}, Alpha: 255},
		Quat:         proto.QuatFromEuler(proto.Vec3{Z: heading}),
		Engine:       false,
		Movable:      true,
		BodyHealth:   1000,
		EngineHealth: 1000,
		Occupants:    make([]*Player, seats),
		Reserved:     make([]*Player, seats),
	}
}
