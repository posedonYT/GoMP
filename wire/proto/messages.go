package proto

import (
	"fmt"
	"math"
	"sort"
)

// MsgID is the first byte of every application message.
type MsgID uint8

const (
	// Client → server.
	MsgPedSync              MsgID = 0x10
	MsgVehicleSync          MsgID = 0x11
	MsgPassengerSync        MsgID = 0x12
	MsgUnoccupiedSync       MsgID = 0x13
	MsgWeaponShot           MsgID = 0x14
	MsgWeaponHit            MsgID = 0x15
	MsgSelfDamage           MsgID = 0x16
	MsgEnterVehicleRequest  MsgID = 0x17
	MsgEnterVehicleComplete MsgID = 0x18
	MsgExitVehicleRequest   MsgID = 0x19
	MsgExitVehicleComplete  MsgID = 0x1A
	MsgTeleportAck          MsgID = 0x1B
	MsgReady                MsgID = 0x1C

	// Both directions.
	MsgChat        MsgID = 0x20
	MsgScriptEvent MsgID = 0x21
	MsgProcCall    MsgID = 0x22
	MsgProcResult  MsgID = 0x23

	// Server → client.
	MsgWelcome              MsgID = 0x80
	MsgEntityCreate         MsgID = 0x81
	MsgEntityDestroy        MsgID = 0x82
	MsgEntitySetProps       MsgID = 0x83
	MsgPlayerSyncOut        MsgID = 0x84
	MsgVehicleSyncOut       MsgID = 0x85
	MsgPassengerSyncOut     MsgID = 0x86
	MsgWeaponShotOut        MsgID = 0x87
	MsgSharedData           MsgID = 0x88
	MsgSetPosition          MsgID = 0x89
	MsgLoadout              MsgID = 0x8A
	MsgPutIntoVehicle       MsgID = 0x8B
	MsgEnterVehicleResponse MsgID = 0x8C
	MsgVehicleTask          MsgID = 0x8D
	MsgControllerAssign     MsgID = 0x8E
	MsgWorld                MsgID = 0x8F
	MsgIpl                  MsgID = 0x90
	MsgNotify               MsgID = 0x91
	MsgInvoke               MsgID = 0x92
	MsgPlayAnim             MsgID = 0x93
	MsgVehicleExplode       MsgID = 0x94
)

// Message is implemented by every protocol message.
type Message interface {
	ID() MsgID
	encode(w *Writer) error
	decode(r *Reader)
}

// Encode appends the message id and body to w.
func Encode(w *Writer, m Message) error {
	w.U8(uint8(m.ID()))
	return m.encode(w)
}

// MarshalAppend encodes m into dst[:0], reusing its storage (hot paths encode
// the same kind of message every tick).
func MarshalAppend(dst []byte, m Message) ([]byte, error) {
	w := NewWriter(dst[:0])
	if err := Encode(w, m); err != nil {
		return nil, err
	}
	return w.Bytes(), nil
}

// Marshal encodes m into a new byte slice.
func Marshal(m Message) ([]byte, error) {
	w := NewWriter(make([]byte, 0, 64))
	if err := Encode(w, m); err != nil {
		return nil, err
	}
	return w.Bytes(), nil
}

// PeekID returns the message id of an encoded message.
func PeekID(b []byte) (MsgID, bool) {
	if len(b) == 0 {
		return 0, false
	}
	return MsgID(b[0]), true
}

// New allocates an empty message for id.
func New(id MsgID) (Message, bool) {
	var m Message
	switch id {
	case MsgPedSync:
		m = &PedSync{}
	case MsgVehicleSync:
		m = &VehicleSync{}
	case MsgPassengerSync:
		m = &PassengerSync{}
	case MsgUnoccupiedSync:
		m = &UnoccupiedSync{}
	case MsgWeaponShot:
		m = &WeaponShot{}
	case MsgWeaponHit:
		m = &WeaponHit{}
	case MsgSelfDamage:
		m = &SelfDamage{}
	case MsgEnterVehicleRequest:
		m = &EnterVehicleRequest{}
	case MsgEnterVehicleComplete:
		m = &EnterVehicleComplete{}
	case MsgExitVehicleRequest:
		m = &ExitVehicleRequest{}
	case MsgExitVehicleComplete:
		m = &ExitVehicleComplete{}
	case MsgTeleportAck:
		m = &TeleportAck{}
	case MsgReady:
		m = &Ready{}
	case MsgChat:
		m = &Chat{}
	case MsgScriptEvent:
		m = &ScriptEvent{}
	case MsgProcCall:
		m = &ProcCall{}
	case MsgProcResult:
		m = &ProcResult{}
	case MsgWelcome:
		m = &Welcome{}
	case MsgEntityCreate:
		m = &EntityCreate{}
	case MsgEntityDestroy:
		m = &EntityDestroy{}
	case MsgEntitySetProps:
		m = &EntitySetProps{}
	case MsgPlayerSyncOut:
		m = &PlayerSyncOut{}
	case MsgVehicleSyncOut:
		m = &VehicleSyncOut{}
	case MsgPassengerSyncOut:
		m = &PassengerSyncOut{}
	case MsgWeaponShotOut:
		m = &WeaponShotOut{}
	case MsgSharedData:
		m = &SharedData{}
	case MsgSetPosition:
		m = &SetPosition{}
	case MsgLoadout:
		m = &Loadout{}
	case MsgPutIntoVehicle:
		m = &PutIntoVehicle{}
	case MsgEnterVehicleResponse:
		m = &EnterVehicleResponse{}
	case MsgVehicleTask:
		m = &VehicleTask{}
	case MsgControllerAssign:
		m = &ControllerAssign{}
	case MsgWorld:
		m = &World{}
	case MsgIpl:
		m = &Ipl{}
	case MsgNotify:
		m = &Notify{}
	case MsgInvoke:
		m = &Invoke{}
	case MsgPlayAnim:
		m = &PlayAnim{}
	case MsgVehicleExplode:
		m = &VehicleExplode{}
	default:
		return nil, false
	}
	return m, true
}

// Unmarshal decodes a message (id byte + body). Trailing bytes are an error.
func Unmarshal(b []byte) (Message, error) {
	id, ok := PeekID(b)
	if !ok {
		return nil, ErrShortBuffer
	}
	m, ok := New(id)
	if !ok {
		return nil, fmt.Errorf("proto: unknown message id 0x%02x", uint8(id))
	}
	if err := DecodeInto(b, m); err != nil {
		return nil, err
	}
	return m, nil
}

// DecodeInto decodes b into m, which must match the id byte.
func DecodeInto(b []byte, m Message) error {
	var r Reader
	r.Reset(b)
	if id := MsgID(r.U8()); r.Err() == nil && id != m.ID() {
		return fmt.Errorf("proto: message id 0x%02x does not match %T", uint8(id), m)
	}
	m.decode(&r)
	if r.Err() != nil {
		return fmt.Errorf("proto: decode %T: %w", m, r.Err())
	}
	if r.Remaining() != 0 {
		return fmt.Errorf("proto: decode %T: %d trailing bytes", m, r.Remaining())
	}
	return nil
}

func (w *Writer) velocity(v Vec3) {
	w.I16(QuantizeSigned(v.X, VelocityScale))
	w.I16(QuantizeSigned(v.Y, VelocityScale))
	w.I16(QuantizeSigned(v.Z, VelocityScale))
}

func (r *Reader) velocity() Vec3 {
	return Vec3{
		DequantizeSigned(r.I16(), VelocityScale),
		DequantizeSigned(r.I16(), VelocityScale),
		DequantizeSigned(r.I16(), VelocityScale),
	}
}

func (w *Writer) angVelocity(v Vec3) {
	w.I16(QuantizeSigned(v.X, AngVelocityScale))
	w.I16(QuantizeSigned(v.Y, AngVelocityScale))
	w.I16(QuantizeSigned(v.Z, AngVelocityScale))
}

func (r *Reader) angVelocity() Vec3 {
	return Vec3{
		DequantizeSigned(r.I16(), AngVelocityScale),
		DequantizeSigned(r.I16(), AngVelocityScale),
		DequantizeSigned(r.I16(), AngVelocityScale),
	}
}

// Props writes properties sorted by id.
func (w *Writer) Props(p Props) error {
	ids := make([]int, 0, len(p))
	for id := range p {
		ids = append(ids, int(id))
	}
	sort.Ints(ids)
	w.Uvarint(uint64(len(ids)))
	for _, id := range ids {
		w.U8(uint8(id))
		if err := w.Value(p[PropID(id)]); err != nil {
			return fmt.Errorf("prop %d: %w", id, err)
		}
	}
	return nil
}

// Props reads a property set.
func (r *Reader) Props() Props {
	n := r.Len(r.Remaining() / 2)
	if n == 0 {
		return nil
	}
	p := make(Props, n)
	for i := 0; i < n && r.Err() == nil; i++ {
		id := PropID(r.U8())
		p[id] = r.Value()
	}
	return p
}

// KV writes a string-keyed value map sorted by key.
func (w *Writer) KV(m map[string]Value) error {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	w.Uvarint(uint64(len(keys)))
	for _, k := range keys {
		w.String(k)
		if err := w.Value(m[k]); err != nil {
			return fmt.Errorf("key %q: %w", k, err)
		}
	}
	return nil
}

// KV reads a string-keyed value map.
func (r *Reader) KV() map[string]Value {
	n := r.Len(r.Remaining() / 2)
	if n == 0 {
		return nil
	}
	m := make(map[string]Value, n)
	for i := 0; i < n && r.Err() == nil; i++ {
		k := r.String()
		m[k] = r.Value()
	}
	return m
}

// ---------------------------------------------------------------- sync

// PedSync is the on-foot state of the sending player.
type PedSync struct {
	Time    uint32 // sender clock, milliseconds
	Pos     Vec3
	Vel     Vec3
	Heading float32
	Move    MoveState
	Flags   PedFlags
	Weapon  uint32
	AimPos  Vec3 // only when Flags&PedAiming
}

func (*PedSync) ID() MsgID { return MsgPedSync }

func (m *PedSync) encode(w *Writer) error {
	w.U32(m.Time)
	w.Vec3(m.Pos)
	w.velocity(m.Vel)
	w.U16(QuantizeHeading(m.Heading))
	w.U8(uint8(m.Move))
	w.U16(uint16(m.Flags))
	w.U32(m.Weapon)
	if m.Flags&PedAiming != 0 {
		w.Vec3(m.AimPos)
	}
	return nil
}

func (m *PedSync) decode(r *Reader) {
	m.Time = r.U32()
	m.Pos = r.Vec3()
	m.Vel = r.velocity()
	m.Heading = DequantizeHeading(r.U16())
	m.Move = MoveState(r.U8())
	m.Flags = PedFlags(r.U16())
	m.Weapon = r.U32()
	if m.Flags&PedAiming != 0 {
		m.AimPos = r.Vec3()
	} else {
		m.AimPos = Vec3{}
	}
}

// PlayerSyncOut relays a player's PedSync to streamers.
type PlayerSyncOut struct {
	PlayerID uint16
	PedSync
}

func (*PlayerSyncOut) ID() MsgID { return MsgPlayerSyncOut }

func (m *PlayerSyncOut) encode(w *Writer) error {
	w.U16(m.PlayerID)
	return m.PedSync.encode(w)
}

func (m *PlayerSyncOut) decode(r *Reader) {
	m.PlayerID = r.U16()
	m.PedSync.decode(r)
}

// VehicleSync is sent by the driver of a vehicle.
type VehicleSync struct {
	VehicleID    uint16
	Time         uint32
	Pos          Vec3
	Rot          Quat
	Vel          Vec3
	AngVel       Vec3
	Steer        float32 // [-1, 1]
	Gas          float32 // [-1, 1], negative = reverse
	Brake        float32 // [0, 1]
	Flags        VehicleFlags
	BodyHealth   float32
	EngineHealth float32
	Weapon       uint32 // only when Flags&VehDriverAiming
	AimPos       Vec3   // only when Flags&VehDriverAiming
}

func (*VehicleSync) ID() MsgID { return MsgVehicleSync }

func (m *VehicleSync) encode(w *Writer) error {
	w.U16(m.VehicleID)
	w.U32(m.Time)
	w.Vec3(m.Pos)
	w.U32(PackQuat(m.Rot))
	w.velocity(m.Vel)
	w.angVelocity(m.AngVel)
	w.I8(QuantizeUnitS8(m.Steer))
	w.I8(QuantizeUnitS8(m.Gas))
	w.U8(QuantizeUnitU8(m.Brake))
	w.U16(uint16(m.Flags))
	w.I16(QuantizeHealth(m.BodyHealth))
	w.I16(QuantizeHealth(m.EngineHealth))
	if m.Flags&VehDriverAiming != 0 {
		w.U32(m.Weapon)
		w.Vec3(m.AimPos)
	}
	return nil
}

func (m *VehicleSync) decode(r *Reader) {
	m.VehicleID = r.U16()
	m.Time = r.U32()
	m.Pos = r.Vec3()
	m.Rot = UnpackQuat(r.U32())
	m.Vel = r.velocity()
	m.AngVel = r.angVelocity()
	m.Steer = DequantizeUnitS8(r.I8())
	m.Gas = DequantizeUnitS8(r.I8())
	m.Brake = DequantizeUnitU8(r.U8())
	m.Flags = VehicleFlags(r.U16())
	m.BodyHealth = float32(r.I16())
	m.EngineHealth = float32(r.I16())
	if m.Flags&VehDriverAiming != 0 {
		m.Weapon = r.U32()
		m.AimPos = r.Vec3()
	} else {
		m.Weapon, m.AimPos = 0, Vec3{}
	}
}

// VehicleSyncOut relays vehicle state (driven or unoccupied) to streamers.
type VehicleSyncOut struct {
	VehicleSync
}

func (*VehicleSyncOut) ID() MsgID                { return MsgVehicleSyncOut }
func (m *VehicleSyncOut) encode(w *Writer) error { return m.VehicleSync.encode(w) }
func (m *VehicleSyncOut) decode(r *Reader)       { m.VehicleSync.decode(r) }

// PassengerSync is sent by a passenger (seat >= 1).
type PassengerSync struct {
	VehicleID uint16
	Seat      uint8
	Time      uint32
	Flags     PedFlags
	Weapon    uint32
	AimPos    Vec3 // only when Flags&PedAiming
}

func (*PassengerSync) ID() MsgID { return MsgPassengerSync }

func (m *PassengerSync) encode(w *Writer) error {
	w.U16(m.VehicleID)
	w.U8(m.Seat)
	w.U32(m.Time)
	w.U16(uint16(m.Flags))
	w.U32(m.Weapon)
	if m.Flags&PedAiming != 0 {
		w.Vec3(m.AimPos)
	}
	return nil
}

func (m *PassengerSync) decode(r *Reader) {
	m.VehicleID = r.U16()
	m.Seat = r.U8()
	m.Time = r.U32()
	m.Flags = PedFlags(r.U16())
	m.Weapon = r.U32()
	if m.Flags&PedAiming != 0 {
		m.AimPos = r.Vec3()
	} else {
		m.AimPos = Vec3{}
	}
}

// PassengerSyncOut relays a passenger's state.
type PassengerSyncOut struct {
	PlayerID uint16
	PassengerSync
}

func (*PassengerSyncOut) ID() MsgID { return MsgPassengerSyncOut }

func (m *PassengerSyncOut) encode(w *Writer) error {
	w.U16(m.PlayerID)
	return m.PassengerSync.encode(w)
}

func (m *PassengerSyncOut) decode(r *Reader) {
	m.PlayerID = r.U16()
	m.PassengerSync.decode(r)
}

// UnoccupiedSync is sent by the controller of an empty vehicle.
type UnoccupiedSync struct {
	VehicleID uint16
	Time      uint32
	Pos       Vec3
	Rot       Quat
	Vel       Vec3
	AngVel    Vec3
}

func (*UnoccupiedSync) ID() MsgID { return MsgUnoccupiedSync }

func (m *UnoccupiedSync) encode(w *Writer) error {
	w.U16(m.VehicleID)
	w.U32(m.Time)
	w.Vec3(m.Pos)
	w.U32(PackQuat(m.Rot))
	w.velocity(m.Vel)
	w.angVelocity(m.AngVel)
	return nil
}

func (m *UnoccupiedSync) decode(r *Reader) {
	m.VehicleID = r.U16()
	m.Time = r.U32()
	m.Pos = r.Vec3()
	m.Rot = UnpackQuat(r.U32())
	m.Vel = r.velocity()
	m.AngVel = r.angVelocity()
}

// ---------------------------------------------------------------- combat

// WeaponShot announces that the sender fired one shot.
type WeaponShot struct {
	Seq    uint16
	Time   uint32
	Weapon uint32
	Origin Vec3
	Target Vec3
}

func (*WeaponShot) ID() MsgID { return MsgWeaponShot }

func (m *WeaponShot) encode(w *Writer) error {
	w.U16(m.Seq)
	w.U32(m.Time)
	w.U32(m.Weapon)
	w.Vec3(m.Origin)
	w.Vec3(m.Target)
	return nil
}

func (m *WeaponShot) decode(r *Reader) {
	m.Seq = r.U16()
	m.Time = r.U32()
	m.Weapon = r.U32()
	m.Origin = r.Vec3()
	m.Target = r.Vec3()
}

// WeaponShotOut relays a shot so streamers can render it.
type WeaponShotOut struct {
	PlayerID uint16
	WeaponShot
}

func (*WeaponShotOut) ID() MsgID { return MsgWeaponShotOut }

func (m *WeaponShotOut) encode(w *Writer) error {
	w.U16(m.PlayerID)
	return m.WeaponShot.encode(w)
}

func (m *WeaponShotOut) decode(r *Reader) {
	m.PlayerID = r.U16()
	m.WeaponShot.decode(r)
}

// WeaponHit claims that a shot (or melee attack) hit an entity.
type WeaponHit struct {
	ShotSeq    uint16
	Weapon     uint32
	Flags      HitFlags
	TargetType EntityType
	TargetID   uint16
	Bone       uint16
	HitPos     Vec3
}

func (*WeaponHit) ID() MsgID { return MsgWeaponHit }

func (m *WeaponHit) encode(w *Writer) error {
	w.U16(m.ShotSeq)
	w.U32(m.Weapon)
	w.U8(uint8(m.Flags))
	w.U8(uint8(m.TargetType))
	w.U16(m.TargetID)
	w.U16(m.Bone)
	w.Vec3(m.HitPos)
	return nil
}

func (m *WeaponHit) decode(r *Reader) {
	m.ShotSeq = r.U16()
	m.Weapon = r.U32()
	m.Flags = HitFlags(r.U8())
	m.TargetType = EntityType(r.U8())
	m.TargetID = r.U16()
	m.Bone = r.U16()
	m.HitPos = r.Vec3()
}

// SelfDamage reports damage the sender took from the environment.
type SelfDamage struct {
	Cause  DamageCause
	Health uint8
	Armour uint8
}

func (*SelfDamage) ID() MsgID { return MsgSelfDamage }

func (m *SelfDamage) encode(w *Writer) error {
	w.U8(uint8(m.Cause))
	w.U8(m.Health)
	w.U8(m.Armour)
	return nil
}

func (m *SelfDamage) decode(r *Reader) {
	m.Cause = DamageCause(r.U8())
	m.Health = r.U8()
	m.Armour = r.U8()
}

// ---------------------------------------------------------------- vehicles

// EnterVehicleRequest asks to enter a vehicle seat (SeatAny picks one).
type EnterVehicleRequest struct {
	VehicleID uint16
	Seat      uint8
}

func (*EnterVehicleRequest) ID() MsgID { return MsgEnterVehicleRequest }

func (m *EnterVehicleRequest) encode(w *Writer) error {
	w.U16(m.VehicleID)
	w.U8(m.Seat)
	return nil
}

func (m *EnterVehicleRequest) decode(r *Reader) {
	m.VehicleID = r.U16()
	m.Seat = r.U8()
}

// EnterVehicleResponse answers an EnterVehicleRequest.
type EnterVehicleResponse struct {
	VehicleID uint16
	Seat      uint8
	Result    EnterResult
}

func (*EnterVehicleResponse) ID() MsgID { return MsgEnterVehicleResponse }

func (m *EnterVehicleResponse) encode(w *Writer) error {
	w.U16(m.VehicleID)
	w.U8(m.Seat)
	w.U8(uint8(m.Result))
	return nil
}

func (m *EnterVehicleResponse) decode(r *Reader) {
	m.VehicleID = r.U16()
	m.Seat = r.U8()
	m.Result = EnterResult(r.U8())
}

// EnterVehicleComplete reports that the enter animation finished (or aborted).
type EnterVehicleComplete struct {
	VehicleID uint16
	Seat      uint8
	Aborted   bool
}

func (*EnterVehicleComplete) ID() MsgID { return MsgEnterVehicleComplete }

func (m *EnterVehicleComplete) encode(w *Writer) error {
	w.U16(m.VehicleID)
	w.U8(m.Seat)
	w.Bool(m.Aborted)
	return nil
}

func (m *EnterVehicleComplete) decode(r *Reader) {
	m.VehicleID = r.U16()
	m.Seat = r.U8()
	m.Aborted = r.Bool()
}

// ExitVehicleRequest starts leaving the current vehicle.
type ExitVehicleRequest struct{}

func (*ExitVehicleRequest) ID() MsgID            { return MsgExitVehicleRequest }
func (*ExitVehicleRequest) encode(*Writer) error { return nil }
func (*ExitVehicleRequest) decode(*Reader)       {}

// ExitVehicleComplete reports that the exit animation finished.
type ExitVehicleComplete struct{}

func (*ExitVehicleComplete) ID() MsgID            { return MsgExitVehicleComplete }
func (*ExitVehicleComplete) encode(*Writer) error { return nil }
func (*ExitVehicleComplete) decode(*Reader)       {}

// PutIntoVehicle forces the receiving client into a seat (VehicleID NoID = remove).
type PutIntoVehicle struct {
	VehicleID uint16
	Seat      uint8
}

func (*PutIntoVehicle) ID() MsgID { return MsgPutIntoVehicle }

func (m *PutIntoVehicle) encode(w *Writer) error {
	w.U16(m.VehicleID)
	w.U8(m.Seat)
	return nil
}

func (m *PutIntoVehicle) decode(r *Reader) {
	m.VehicleID = r.U16()
	m.Seat = r.U8()
}

// VehicleTask tells streamers which vehicle animation a remote player plays.
type VehicleTask struct {
	PlayerID  uint16
	Task      VehicleTaskKind
	VehicleID uint16
	Seat      uint8
}

func (*VehicleTask) ID() MsgID { return MsgVehicleTask }

func (m *VehicleTask) encode(w *Writer) error {
	w.U16(m.PlayerID)
	w.U8(uint8(m.Task))
	w.U16(m.VehicleID)
	w.U8(m.Seat)
	return nil
}

func (m *VehicleTask) decode(r *Reader) {
	m.PlayerID = r.U16()
	m.Task = VehicleTaskKind(r.U8())
	m.VehicleID = r.U16()
	m.Seat = r.U8()
}

// ControllerAssign grants or revokes the sync of an unoccupied vehicle.
type ControllerAssign struct {
	VehicleID  uint16
	Controlled bool
}

func (*ControllerAssign) ID() MsgID { return MsgControllerAssign }

func (m *ControllerAssign) encode(w *Writer) error {
	w.U16(m.VehicleID)
	w.Bool(m.Controlled)
	return nil
}

func (m *ControllerAssign) decode(r *Reader) {
	m.VehicleID = r.U16()
	m.Controlled = r.Bool()
}

// VehicleExplode blows up a vehicle on every streamer.
type VehicleExplode struct {
	VehicleID uint16
}

func (*VehicleExplode) ID() MsgID { return MsgVehicleExplode }

func (m *VehicleExplode) encode(w *Writer) error {
	w.U16(m.VehicleID)
	return nil
}

func (m *VehicleExplode) decode(r *Reader) { m.VehicleID = r.U16() }

// ---------------------------------------------------------------- session

// TeleportAck confirms a SetPosition.
type TeleportAck struct {
	Seq uint16
}

func (*TeleportAck) ID() MsgID { return MsgTeleportAck }

func (m *TeleportAck) encode(w *Writer) error {
	w.U16(m.Seq)
	return nil
}

func (m *TeleportAck) decode(r *Reader) { m.Seq = r.U16() }

// Ready is sent once the client has loaded and can be spawned (playerReady).
type Ready struct{}

func (*Ready) ID() MsgID            { return MsgReady }
func (*Ready) encode(*Writer) error { return nil }
func (*Ready) decode(*Reader)       {}

// Welcome is the first reliable message after the transport handshake.
type Welcome struct {
	PlayerID       uint16
	ServerName     string
	GameMode       string
	TickRate       uint8
	StreamDistance float32
	Hour           uint8
	Minute         uint8
	Second         uint8
	Weather        string
}

func (*Welcome) ID() MsgID { return MsgWelcome }

func (m *Welcome) encode(w *Writer) error {
	w.U16(m.PlayerID)
	w.String(m.ServerName)
	w.String(m.GameMode)
	w.U8(m.TickRate)
	w.F32(m.StreamDistance)
	w.U8(m.Hour)
	w.U8(m.Minute)
	w.U8(m.Second)
	w.String(m.Weather)
	return nil
}

func (m *Welcome) decode(r *Reader) {
	m.PlayerID = r.U16()
	m.ServerName = r.String()
	m.GameMode = r.String()
	m.TickRate = r.U8()
	m.StreamDistance = r.F32()
	m.Hour = r.U8()
	m.Minute = r.U8()
	m.Second = r.U8()
	m.Weather = r.String()
}

// SetPosition moves the receiving client (teleport, anti-cheat correction or spawn).
type SetPosition struct {
	Seq     uint16
	Reason  SetPositionReason
	Pos     Vec3
	Heading float32 // NaN keeps the current heading
}

func (*SetPosition) ID() MsgID { return MsgSetPosition }

func (m *SetPosition) encode(w *Writer) error {
	w.U16(m.Seq)
	w.U8(uint8(m.Reason))
	w.Vec3(m.Pos)
	w.F32(m.Heading)
	return nil
}

func (m *SetPosition) decode(r *Reader) {
	m.Seq = r.U16()
	m.Reason = SetPositionReason(r.U8())
	m.Pos = r.Vec3()
	m.Heading = r.F32()
}

// KeepHeading is the SetPosition.Heading value that keeps the current heading.
var KeepHeading = float32(math.NaN())

// WeaponAmmo is one loadout slot.
type WeaponAmmo struct {
	Hash uint32
	Ammo uint16
}

// Loadout replaces the receiving player's weapons.
type Loadout struct {
	Current uint32
	Weapons []WeaponAmmo
}

func (*Loadout) ID() MsgID { return MsgLoadout }

func (m *Loadout) encode(w *Writer) error {
	w.U32(m.Current)
	w.Uvarint(uint64(len(m.Weapons)))
	for _, wa := range m.Weapons {
		w.U32(wa.Hash)
		w.U16(wa.Ammo)
	}
	return nil
}

func (m *Loadout) decode(r *Reader) {
	m.Current = r.U32()
	n := r.Len(r.Remaining() / 6)
	m.Weapons = m.Weapons[:0]
	for i := 0; i < n && r.Err() == nil; i++ {
		m.Weapons = append(m.Weapons, WeaponAmmo{Hash: r.U32(), Ammo: r.U16()})
	}
	if len(m.Weapons) == 0 {
		m.Weapons = nil
	}
}

// ---------------------------------------------------------------- entities

// EntityCreate streams an entity in.
type EntityCreate struct {
	Type   EntityType
	EntID  uint16
	Model  uint32
	Pos    Vec3
	Rot    Vec3
	Props  Props
	Shared map[string]Value
}

func (*EntityCreate) ID() MsgID { return MsgEntityCreate }

func (m *EntityCreate) encode(w *Writer) error {
	w.U8(uint8(m.Type))
	w.U16(m.EntID)
	w.U32(m.Model)
	w.Vec3(m.Pos)
	w.Vec3(m.Rot)
	if err := w.Props(m.Props); err != nil {
		return err
	}
	return w.KV(m.Shared)
}

func (m *EntityCreate) decode(r *Reader) {
	m.Type = EntityType(r.U8())
	m.EntID = r.U16()
	m.Model = r.U32()
	m.Pos = r.Vec3()
	m.Rot = r.Vec3()
	m.Props = r.Props()
	m.Shared = r.KV()
}

// EntityDestroy streams an entity out.
type EntityDestroy struct {
	Type  EntityType
	EntID uint16
}

func (*EntityDestroy) ID() MsgID { return MsgEntityDestroy }

func (m *EntityDestroy) encode(w *Writer) error {
	w.U8(uint8(m.Type))
	w.U16(m.EntID)
	return nil
}

func (m *EntityDestroy) decode(r *Reader) {
	m.Type = EntityType(r.U8())
	m.EntID = r.U16()
}

// EntitySetProps updates replicated properties.
type EntitySetProps struct {
	Type  EntityType
	EntID uint16
	Props Props
}

func (*EntitySetProps) ID() MsgID { return MsgEntitySetProps }

func (m *EntitySetProps) encode(w *Writer) error {
	w.U8(uint8(m.Type))
	w.U16(m.EntID)
	return w.Props(m.Props)
}

func (m *EntitySetProps) decode(r *Reader) {
	m.Type = EntityType(r.U8())
	m.EntID = r.U16()
	m.Props = r.Props()
}

// SharedData replicates setVariable / setOwnVariable. A nil value deletes the key.
type SharedData struct {
	Type   EntityType
	EntID  uint16
	Own    bool
	Values map[string]Value
}

func (*SharedData) ID() MsgID { return MsgSharedData }

func (m *SharedData) encode(w *Writer) error {
	w.U8(uint8(m.Type))
	w.U16(m.EntID)
	w.Bool(m.Own)
	return w.KV(m.Values)
}

func (m *SharedData) decode(r *Reader) {
	m.Type = EntityType(r.U8())
	m.EntID = r.U16()
	m.Own = r.Bool()
	m.Values = r.KV()
}

// ---------------------------------------------------------------- scripting & misc

// Chat carries a chat line (client→server: typed text; server→client: line to show).
type Chat struct {
	Text string
}

func (*Chat) ID() MsgID { return MsgChat }

func (m *Chat) encode(w *Writer) error {
	w.String(m.Text)
	return nil
}

func (m *Chat) decode(r *Reader) { m.Text = r.String() }

// ScriptEvent is mp.events.callRemote (client→server) or player.call (server→client).
type ScriptEvent struct {
	Name string
	Args []Value
}

func (*ScriptEvent) ID() MsgID { return MsgScriptEvent }

func (m *ScriptEvent) encode(w *Writer) error {
	w.String(m.Name)
	return w.Values(m.Args)
}

func (m *ScriptEvent) decode(r *Reader) {
	m.Name = r.String()
	m.Args = r.Values()
}

// ProcCall invokes a remote procedure (callProc / callRemoteProc).
type ProcCall struct {
	CallID uint32
	Name   string
	Args   []Value
}

func (*ProcCall) ID() MsgID { return MsgProcCall }

func (m *ProcCall) encode(w *Writer) error {
	w.U32(m.CallID)
	w.String(m.Name)
	return w.Values(m.Args)
}

func (m *ProcCall) decode(r *Reader) {
	m.CallID = r.U32()
	m.Name = r.String()
	m.Args = r.Values()
}

// ProcResult answers a ProcCall.
type ProcResult struct {
	CallID uint32
	OK     bool
	Result Value  // when OK
	Error  string // when !OK
}

func (*ProcResult) ID() MsgID { return MsgProcResult }

func (m *ProcResult) encode(w *Writer) error {
	w.U32(m.CallID)
	w.Bool(m.OK)
	if m.OK {
		return w.Value(m.Result)
	}
	w.String(m.Error)
	return nil
}

func (m *ProcResult) decode(r *Reader) {
	m.CallID = r.U32()
	m.OK = r.Bool()
	if m.OK {
		m.Result, m.Error = r.Value(), ""
	} else {
		m.Result, m.Error = nil, r.String()
	}
}

// World carries time and weather.
type World struct {
	Hour         uint8
	Minute       uint8
	Second       uint8
	Weather      string
	TransitionMs uint32
}

func (*World) ID() MsgID { return MsgWorld }

func (m *World) encode(w *Writer) error {
	w.U8(m.Hour)
	w.U8(m.Minute)
	w.U8(m.Second)
	w.String(m.Weather)
	w.U32(m.TransitionMs)
	return nil
}

func (m *World) decode(r *Reader) {
	m.Hour = r.U8()
	m.Minute = r.U8()
	m.Second = r.U8()
	m.Weather = r.String()
	m.TransitionMs = r.U32()
}

// Ipl loads or unloads an interior placement.
type Ipl struct {
	Name string
	Load bool
}

func (*Ipl) ID() MsgID { return MsgIpl }

func (m *Ipl) encode(w *Writer) error {
	w.String(m.Name)
	w.Bool(m.Load)
	return nil
}

func (m *Ipl) decode(r *Reader) {
	m.Name = r.String()
	m.Load = r.Bool()
}

// Notify shows a GTA notification (player.notify).
type Notify struct {
	Text string
}

func (*Notify) ID() MsgID { return MsgNotify }

func (m *Notify) encode(w *Writer) error {
	w.String(m.Text)
	return nil
}

func (m *Notify) decode(r *Reader) { m.Text = r.String() }

// Invoke calls a game native on the client (player.invoke).
type Invoke struct {
	Hash uint64
	Args []Value
}

func (*Invoke) ID() MsgID { return MsgInvoke }

func (m *Invoke) encode(w *Writer) error {
	w.U64(m.Hash)
	return w.Values(m.Args)
}

func (m *Invoke) decode(r *Reader) {
	m.Hash = r.U64()
	m.Args = r.Values()
}

// PlayAnim plays or stops an animation on a player (Dict "@scenario" plays scenario Name).
type PlayAnim struct {
	PlayerID uint16
	Dict     string
	Name     string
	Speed    float32
	Flag     int32
	Stop     bool
}

func (*PlayAnim) ID() MsgID { return MsgPlayAnim }

func (m *PlayAnim) encode(w *Writer) error {
	w.U16(m.PlayerID)
	w.String(m.Dict)
	w.String(m.Name)
	w.F32(m.Speed)
	w.I32(m.Flag)
	w.Bool(m.Stop)
	return nil
}

func (m *PlayAnim) decode(r *Reader) {
	m.PlayerID = r.U16()
	m.Dict = r.String()
	m.Name = r.String()
	m.Speed = r.F32()
	m.Flag = r.I32()
	m.Stop = r.Bool()
}
