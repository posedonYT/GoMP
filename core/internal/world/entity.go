// Package world is the authoritative server-side data model: entities, id
// pools with generations, and colshape geometry. It contains no networking;
// the server package replicates changes.
package world

import (
	"math"
	"time"

	"gomp/wire/proto"
)

// Ref identifies an entity across id reuse.
type Ref struct {
	Type proto.EntityType
	ID   uint16
	Gen  uint16
}

// Entity is implemented by every entity kind.
type Entity interface {
	Base() *EntityBase
}

// EntityBase holds the fields common to all entities.
type EntityBase struct {
	Type      proto.EntityType
	ID        uint16
	Gen       uint16
	Model     uint32
	Pos       proto.Vec3
	Rot       proto.Vec3 // Euler degrees
	Dimension uint32
	Alpha     uint8
	// Props are replicated, mostly cosmetic properties the core does not interpret.
	Props proto.Props
	// Shared is setVariable data replicated to streamers.
	Shared map[string]proto.Value
	// Destroyed is set once the entity left the world.
	Destroyed bool
	// Origin is the script host that created the entity (0 = core).
	Origin int
	// VisibleFor overrides streaming visibility per player id (showFor/hideFor).
	VisibleFor map[uint16]bool
}

// Base implements Entity.
func (b *EntityBase) Base() *EntityBase { return b }

// Ref returns the entity reference.
func (b *EntityBase) Ref() Ref { return Ref{Type: b.Type, ID: b.ID, Gen: b.Gen} }

// Key returns the reference without generation.
func (b *EntityBase) Key() proto.EntityRef { return proto.EntityRef{Type: b.Type, ID: b.ID} }

// SetProp stores a replicated property (nil deletes it).
func (b *EntityBase) SetProp(id proto.PropID, v proto.Value) {
	if v == nil {
		delete(b.Props, id)
		return
	}
	if b.Props == nil {
		b.Props = make(proto.Props)
	}
	b.Props[id] = v
}

// SetShared stores a shared variable (nil deletes it).
func (b *EntityBase) SetShared(k string, v proto.Value) {
	if v == nil {
		delete(b.Shared, k)
		return
	}
	if b.Shared == nil {
		b.Shared = make(map[string]proto.Value)
	}
	b.Shared[k] = v
}

// Player is a connected client's character.
type Player struct {
	EntityBase
	Name       string
	Serial     string
	SocialClub string
	RGSCID     string
	GameType   string
	IP         string

	Health  int // 0..100
	Armour  int // 0..100
	Heading float32
	Vel     proto.Vec3
	Move    proto.MoveState
	Flags   proto.PedFlags
	AimPos  proto.Vec3

	Weapon  uint32
	Weapons map[uint32]uint16 // hash -> ammo

	Vehicle      *Vehicle
	Seat         uint8
	Entering     *Vehicle // vehicle with a reserved seat while the enter task runs
	EnteringSeat uint8
	EnterExpires time.Time
	Exiting      bool

	Dead    bool
	Spawned bool
	Ready   bool

	OwnShared map[string]proto.Value

	// Sync bookkeeping.
	SyncSeq      uint32 // bumped whenever replicated sync state changes
	SyncTime     uint32 // last accepted client timestamp
	LastSyncAt   time.Time
	LastValidPos proto.Vec3

	TeleportSeq     uint16
	TeleportPending bool
	TeleportAt      time.Time

	Violations      int
	LastViolationAt time.Time

	DisableOutgoingSync bool
	Ping                int
	PacketLoss          float64
}

// InVehicle reports whether the player sits in a vehicle.
func (p *Player) InVehicle() bool { return p.Vehicle != nil }

// IsDriver reports whether the player drives a vehicle.
func (p *Player) IsDriver() bool { return p.Vehicle != nil && p.Seat == proto.SeatDriver }

// Vehicle is a world vehicle.
type Vehicle struct {
	EntityBase
	Quat   proto.Quat
	Vel    proto.Vec3
	AngVel proto.Vec3
	Steer  float32
	Gas    float32
	Brake  float32
	Flags  proto.VehicleFlags

	Engine       bool
	Locked       bool
	Dead         bool
	Movable      bool
	BodyHealth   float32
	EngineHealth float32

	Occupants        []*Player // index = seat (0 = driver)
	Reserved         []*Player // seats reserved by an enter task
	Controller       *Player   // syncs the vehicle while nobody drives it
	ControllerPinned bool      // set by scripts through vehicle.controller

	SyncSeq    uint32
	SyncTime   uint32
	LastSyncAt time.Time

	// Net is opaque per-vehicle state owned by the server package.
	Net any
}

// Driver returns the driver or nil.
func (v *Vehicle) Driver() *Player {
	if len(v.Occupants) == 0 {
		return nil
	}
	return v.Occupants[0]
}

// SeatFree reports whether seat exists and is neither occupied nor reserved.
func (v *Vehicle) SeatFree(seat uint8) bool {
	i := int(seat)
	return i < len(v.Occupants) && v.Occupants[i] == nil && v.Reserved[i] == nil
}

// FirstFreeSeat returns the lowest free seat, preferring the driver seat.
func (v *Vehicle) FirstFreeSeat() (uint8, bool) {
	for i := range v.Occupants {
		if v.SeatFree(uint8(i)) {
			return uint8(i), true
		}
	}
	return 0, false
}

// NumOccupants counts seated players.
func (v *Vehicle) NumOccupants() int {
	n := 0
	for _, p := range v.Occupants {
		if p != nil {
			n++
		}
	}
	return n
}

// Heading returns the yaw in degrees [0, 360).
func (v *Vehicle) Heading() float32 {
	h := float32(math.Mod(float64(v.Quat.Euler().Z), 360))
	if h < 0 {
		h += 360
	}
	return h
}

// Object is a static prop.
type Object struct{ EntityBase }

// Ped is a script-created, non-AI ped.
type Ped struct {
	EntityBase
	Heading    float32
	Controller *Player
}

// Blip is a map icon (not distance-streamed).
type Blip struct{ EntityBase }

// Marker is a 3D marker.
type Marker struct{ EntityBase }

// Checkpoint is a race-style checkpoint; enter/exit is evaluated by the server.
type Checkpoint struct {
	EntityBase
	Radius float32
	Inside map[uint16]bool
}

// TextLabel is a 3D text label.
type TextLabel struct{ EntityBase }

// Dummy is a script entity with shared variables only (sent to everybody).
type Dummy struct {
	EntityBase
	DummyType int
}
