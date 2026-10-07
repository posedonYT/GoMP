// Package bot is a headless GoMP client. It speaks the same protocol as the
// game client, keeps a mirror of what the server streams to it and offers
// actions (walk, drive, shoot, enter vehicles, chat, remote events). Tests
// and the stress tool drive many bots in one process.
package bot

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"gomp/wire/proto"
	"gomp/wire/transport"
)

// Epoch is the shared clock origin of all bots in a process. Sync timestamps
// are milliseconds since Epoch, so receivers can measure end-to-end latency.
var Epoch = time.Now()

// NowMs returns the bot clock.
func NowMs(t time.Time) uint32 { return uint32(t.Sub(Epoch).Milliseconds()) }

// Config configures a bot.
type Config struct {
	Server string // host:port
	Name   string
	Serial string
	// Conn overrides the socket (faultnet in stress tests).
	Conn transport.PacketConn
	// ConnectTimeout bounds the handshake (0 = 10s).
	ConnectTimeout time.Duration
}

// Remote is the bot's view of another player.
type Remote struct {
	ID       uint16
	Name     string
	Pos      proto.Vec3
	Vel      proto.Vec3
	Heading  float32
	Flags    proto.PedFlags
	Weapon   uint32
	Health   int
	Armour   int
	Dead     bool
	Vehicle  uint16
	Seat     uint8
	SyncTime uint32
	RecvAt   time.Time
	Shared   map[string]proto.Value
	Props    proto.Props
	Task     proto.VehicleTaskKind
}

// RemoteVehicle is the bot's view of a vehicle.
type RemoteVehicle struct {
	ID           uint16
	Model        uint32
	Pos          proto.Vec3
	Rot          proto.Quat
	Vel          proto.Vec3
	Flags        proto.VehicleFlags
	Engine       bool
	Locked       bool
	Dead         bool
	BodyHealth   float32
	EngineHealth float32
	SyncTime     uint32
	RecvAt       time.Time
	Shared       map[string]proto.Value
	Props        proto.Props
}

// LatencySink receives end-to-end sync latencies (sender clock → receive).
type LatencySink func(kind proto.MsgID, latency time.Duration)

// Bot is one headless client.
type Bot struct {
	cfg  Config
	conn *transport.Client

	mu sync.Mutex
	// Own state.
	ID          uint16
	Name        string
	Pos         proto.Vec3
	Vel         proto.Vec3
	Heading     float32
	Move        proto.MoveState
	Flags       proto.PedFlags
	AimPos      proto.Vec3
	Health      int
	Armour      int
	Dead        bool
	Spawned     bool
	Weapon      uint32
	Weapons     map[uint32]uint16
	VehicleID   uint16
	Seat        uint8
	Shared      map[string]proto.Value
	OwnShared   map[string]proto.Value
	Props       proto.Props
	Welcome     proto.Welcome
	WorldState  proto.World
	Controlled  map[uint16]bool
	Players     map[uint16]*Remote
	Vehicles    map[uint16]*RemoteVehicle
	Others      map[proto.EntityRef]*proto.EntityCreate
	Chat        []string
	Notes       []string
	Events      []proto.ScriptEvent
	Invokes     []proto.Invoke
	Anims       []proto.PlayAnim
	ShotsSeen   int
	Corrections int
	Teleports   int
	EnterResult *proto.EnterVehicleResponse
	Procs       map[string]func(args []proto.Value) (proto.Value, error)

	pendingEnter   *pendingEnter
	scratchPed     proto.PlayerSyncOut
	scratchVeh     proto.VehicleSyncOut
	scratchPass    proto.PassengerSyncOut
	procWait       map[uint32]chan proto.ProcResult
	nextProc       uint32
	shotSeq        uint16
	latency        LatencySink
	lastVehicleOut map[uint16]bool
}

type pendingEnter struct {
	vehicle uint16
	seat    uint8
	at      time.Time
}

// EnterDuration is how long the simulated enter animation takes.
const EnterDuration = 300 * time.Millisecond

// Connect dials the server and performs the handshake.
func Connect(ctx context.Context, cfg Config) (*Bot, error) {
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = 10 * time.Second
	}
	info := proto.ConnectInfo{Version: proto.ClientVersion, Name: cfg.Name, Serial: cfg.Serial, SocialClub: cfg.Name, GameType: "gta5", Build: 3258}
	tcfg := transport.ClientConfig{Payload: info.Marshal(), ConnectTimeout: cfg.ConnectTimeout}
	var conn *transport.Client
	var err error
	if cfg.Conn != nil {
		addr, rerr := resolve(cfg.Server)
		if rerr != nil {
			return nil, rerr
		}
		conn, err = transport.DialConn(ctx, cfg.Conn, addr, tcfg)
	} else {
		conn, err = transport.Dial(ctx, cfg.Server, tcfg)
	}
	if err != nil {
		return nil, err
	}
	b := &Bot{
		cfg: cfg, conn: conn, Name: cfg.Name, Health: 100, ID: proto.NoID, VehicleID: proto.NoID,
		Weapons: map[uint32]uint16{}, Controlled: map[uint16]bool{}, Players: map[uint16]*Remote{},
		Vehicles: map[uint16]*RemoteVehicle{}, Others: map[proto.EntityRef]*proto.EntityCreate{},
		Procs: map[string]func([]proto.Value) (proto.Value, error){}, procWait: map[uint32]chan proto.ProcResult{},
		Shared: map[string]proto.Value{}, OwnShared: map[string]proto.Value{}, lastVehicleOut: map[uint16]bool{},
	}
	return b, nil
}

// SetLatencySink installs a latency callback.
func (b *Bot) SetLatencySink(f LatencySink) {
	b.mu.Lock()
	b.latency = f
	b.mu.Unlock()
}

// Close disconnects.
func (b *Bot) Close() error { return b.conn.Close("bot closed") }

// Closed reports whether the connection ended and why.
func (b *Bot) Closed() (bool, string) { return b.conn.Closed() }

// Stats returns transport statistics.
func (b *Bot) Stats() transport.Stats { return b.conn.Stats() }

// Lock/Unlock guard the public state fields for readers in other goroutines.
func (b *Bot) Lock()   { b.mu.Lock() }
func (b *Bot) Unlock() { b.mu.Unlock() }

// View runs fn with the state locked.
func (b *Bot) View(fn func(b *Bot)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	fn(b)
}

func (b *Bot) send(ch transport.Channel, m proto.Message) {
	data, err := proto.Marshal(m)
	if err != nil {
		panic(fmt.Sprintf("bot: encode %T: %v", m, err))
	}
	_ = b.conn.Send(ch, data)
}

// Flush transmits queued messages.
func (b *Bot) Flush(now time.Time) { b.conn.Flush(now) }

// Pump processes everything received so far.
func (b *Bot) Pump(now time.Time) {
	var msgs [][]byte
	b.conn.Drain(func(m transport.Message) { msgs = append(msgs, m.Data) })
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, data := range msgs {
		// Hot sync messages decode into reusable structs (no allocation).
		var m proto.Message
		switch id, _ := proto.PeekID(data); id {
		case proto.MsgPlayerSyncOut:
			m = &b.scratchPed
		case proto.MsgVehicleSyncOut:
			m = &b.scratchVeh
		case proto.MsgPassengerSyncOut:
			m = &b.scratchPass
		}
		if m != nil {
			if proto.DecodeInto(data, m) != nil {
				continue
			}
		} else {
			var err error
			if m, err = proto.Unmarshal(data); err != nil {
				continue
			}
		}
		b.handle(m, now)
	}
	if pe := b.pendingEnter; pe != nil && now.Sub(pe.at) >= EnterDuration {
		b.pendingEnter = nil
		b.send(transport.Reliable, &proto.EnterVehicleComplete{VehicleID: pe.vehicle, Seat: pe.seat})
		b.VehicleID, b.Seat = pe.vehicle, pe.seat
		if v := b.Vehicles[pe.vehicle]; v != nil {
			b.Pos = v.Pos
		}
	}
}

// Notify is signalled when datagrams arrive (best effort).
func (b *Bot) Notify() <-chan struct{} { return b.conn.Notify() }

func (b *Bot) handle(m proto.Message, now time.Time) {
	switch x := m.(type) {
	case *proto.Welcome:
		b.Welcome = *x
		b.ID = x.PlayerID
	case *proto.EntityCreate:
		b.onCreate(x, now)
	case *proto.EntityDestroy:
		switch x.Type {
		case proto.EntityPlayer:
			delete(b.Players, x.EntID)
		case proto.EntityVehicle:
			delete(b.Vehicles, x.EntID)
			delete(b.Controlled, x.EntID)
			if b.VehicleID == x.EntID {
				b.VehicleID = proto.NoID
			}
		default:
			delete(b.Others, proto.EntityRef{Type: x.Type, ID: x.EntID})
		}
	case *proto.EntitySetProps:
		b.onProps(x.Type, x.EntID, x.Props)
	case *proto.PlayerSyncOut:
		r := b.Players[x.PlayerID]
		if r == nil || (r.SyncTime != 0 && int32(x.Time-r.SyncTime) <= 0) {
			return
		}
		r.SyncTime, r.RecvAt = x.Time, now
		r.Pos, r.Vel, r.Heading, r.Flags, r.Weapon = x.Pos, x.Vel, x.Heading, x.Flags, x.Weapon
		if b.latency != nil {
			b.latency(proto.MsgPlayerSyncOut, now.Sub(Epoch)-time.Duration(x.Time)*time.Millisecond)
		}
	case *proto.PassengerSyncOut:
		if r := b.Players[x.PlayerID]; r != nil {
			r.Flags, r.Weapon, r.SyncTime, r.RecvAt = x.Flags, x.Weapon, x.Time, now
		}
	case *proto.VehicleSyncOut:
		v := b.Vehicles[x.VehicleID]
		if v == nil || (v.SyncTime != 0 && int32(x.Time-v.SyncTime) <= 0) {
			return
		}
		if b.VehicleID == x.VehicleID && b.Seat == proto.SeatDriver {
			return // our own vehicle echoed by a stale server view
		}
		v.SyncTime, v.RecvAt = x.Time, now
		v.Pos, v.Rot, v.Vel, v.Flags = x.Pos, x.Rot, x.Vel, x.Flags
		v.BodyHealth, v.EngineHealth = x.BodyHealth, x.EngineHealth
		if b.latency != nil {
			b.latency(proto.MsgVehicleSyncOut, now.Sub(Epoch)-time.Duration(x.Time)*time.Millisecond)
		}
		if b.VehicleID == x.VehicleID {
			b.Pos = x.Pos // passengers ride along
		}
	case *proto.WeaponShotOut:
		b.ShotsSeen++
	case *proto.SharedData:
		var target map[string]proto.Value
		switch {
		case x.Own:
			target = b.OwnShared
		case x.Type == proto.EntityPlayer && x.EntID == b.ID:
			target = b.Shared
		case x.Type == proto.EntityPlayer:
			if r := b.Players[x.EntID]; r != nil {
				if r.Shared == nil {
					r.Shared = map[string]proto.Value{}
				}
				target = r.Shared
			}
		case x.Type == proto.EntityVehicle:
			if v := b.Vehicles[x.EntID]; v != nil {
				if v.Shared == nil {
					v.Shared = map[string]proto.Value{}
				}
				target = v.Shared
			}
		default:
			if o := b.Others[proto.EntityRef{Type: x.Type, ID: x.EntID}]; o != nil {
				if o.Shared == nil {
					o.Shared = map[string]proto.Value{}
				}
				target = o.Shared
			}
		}
		if target != nil {
			for k, v := range x.Values {
				if v == nil {
					delete(target, k)
				} else {
					target[k] = v
				}
			}
		}
	case *proto.SetPosition:
		b.Pos = x.Pos
		if x.Heading == x.Heading { // not NaN
			b.Heading = x.Heading
		}
		b.Vel = proto.Vec3{}
		switch x.Reason {
		case proto.PosSpawn:
			b.Spawned, b.Dead, b.Health = true, false, 100
			if b.VehicleID != proto.NoID {
				b.VehicleID = proto.NoID
			}
		case proto.PosCorrection:
			b.Corrections++
		default:
			b.Teleports++
		}
		if b.VehicleID != proto.NoID && b.Seat == proto.SeatDriver {
			if v := b.Vehicles[b.VehicleID]; v != nil {
				v.Pos = x.Pos
			}
		}
		b.send(transport.Reliable, &proto.TeleportAck{Seq: x.Seq})
	case *proto.Loadout:
		b.Weapon = x.Current
		b.Weapons = map[uint32]uint16{}
		for _, w := range x.Weapons {
			b.Weapons[w.Hash] = w.Ammo
		}
	case *proto.PutIntoVehicle:
		b.pendingEnter = nil
		if x.VehicleID == proto.NoID {
			b.VehicleID = proto.NoID
		} else {
			b.VehicleID, b.Seat = x.VehicleID, x.Seat
			if v := b.Vehicles[x.VehicleID]; v != nil {
				b.Pos = v.Pos
			}
		}
	case *proto.EnterVehicleResponse:
		r := *x
		b.EnterResult = &r
		if x.Result == proto.EnterAllowed {
			b.pendingEnter = &pendingEnter{vehicle: x.VehicleID, seat: x.Seat, at: now}
		}
	case *proto.VehicleTask:
		if r := b.Players[x.PlayerID]; r != nil {
			r.Task = x.Task
			switch x.Task {
			case proto.TaskEnterWarp:
				r.Vehicle, r.Seat = x.VehicleID, x.Seat
			case proto.TaskExitWarp:
				r.Vehicle = proto.NoID
			}
		}
	case *proto.ControllerAssign:
		if x.Controlled {
			b.Controlled[x.VehicleID] = true
		} else {
			delete(b.Controlled, x.VehicleID)
		}
	case *proto.World:
		b.WorldState = *x
	case *proto.Chat:
		b.Chat = append(b.Chat, x.Text)
	case *proto.Notify:
		b.Notes = append(b.Notes, x.Text)
	case *proto.ScriptEvent:
		b.Events = append(b.Events, *x)
	case *proto.Invoke:
		b.Invokes = append(b.Invokes, *x)
	case *proto.PlayAnim:
		b.Anims = append(b.Anims, *x)
	case *proto.ProcCall:
		res := &proto.ProcResult{CallID: x.CallID}
		if fn := b.Procs[x.Name]; fn != nil {
			v, err := fn(x.Args)
			if err != nil {
				res.Error = err.Error()
			} else {
				res.OK, res.Result = true, v
			}
		} else {
			res.Error = "no handler for " + x.Name
		}
		b.send(transport.Reliable, res)
	case *proto.ProcResult:
		if ch := b.procWait[x.CallID]; ch != nil {
			delete(b.procWait, x.CallID)
			ch <- *x
		}
	case *proto.VehicleExplode:
		if v := b.Vehicles[x.VehicleID]; v != nil {
			v.Dead = true
		}
	}
}

func (b *Bot) onCreate(x *proto.EntityCreate, now time.Time) {
	switch x.Type {
	case proto.EntityPlayer:
		if x.EntID == b.ID {
			b.Props = x.Props
			b.applySelfProps(x.Props)
			if x.Shared != nil {
				b.Shared = x.Shared
			}
			return
		}
		r := &Remote{ID: x.EntID, Pos: x.Pos, Vehicle: proto.NoID, Health: 100, Shared: x.Shared, Props: x.Props, RecvAt: now}
		b.Players[x.EntID] = r
		b.applyRemoteProps(r, x.Props)
	case proto.EntityVehicle:
		v := &RemoteVehicle{ID: x.EntID, Model: x.Model, Pos: x.Pos, Rot: proto.QuatFromEuler(x.Rot), Shared: x.Shared,
			Props: x.Props, BodyHealth: 1000, EngineHealth: 1000, RecvAt: now}
		b.Vehicles[x.EntID] = v
		b.applyVehicleProps(v, x.Props)
	default:
		c := *x
		b.Others[proto.EntityRef{Type: x.Type, ID: x.EntID}] = &c
	}
}

func intOf(v proto.Value) int {
	switch n := v.(type) {
	case int64:
		return int(n)
	case float64:
		return int(n)
	}
	return 0
}

func floatOf(v proto.Value) float32 {
	switch n := v.(type) {
	case int64:
		return float32(n)
	case float64:
		return float32(n)
	}
	return 0
}

func (b *Bot) applySelfProps(p proto.Props) {
	for id, v := range p {
		switch id {
		case proto.PropHealth:
			b.Health = intOf(v)
		case proto.PropArmour:
			b.Armour = intOf(v)
		case proto.PropDead:
			b.Dead, _ = v.(bool)
		case proto.PropName:
			b.Name, _ = v.(string)
		case proto.PropWeapon:
			b.Weapon = uint32(intOf(v))
		}
	}
}

func (b *Bot) applyRemoteProps(r *Remote, p proto.Props) {
	for id, v := range p {
		switch id {
		case proto.PropName:
			r.Name, _ = v.(string)
		case proto.PropHealth:
			r.Health = intOf(v)
		case proto.PropArmour:
			r.Armour = intOf(v)
		case proto.PropDead:
			r.Dead, _ = v.(bool)
		case proto.PropWeapon:
			r.Weapon = uint32(intOf(v))
		case proto.PropVehicle:
			if arr, ok := v.([]proto.Value); ok && len(arr) == 2 {
				r.Vehicle, r.Seat = uint16(intOf(arr[0])), uint8(intOf(arr[1]))
			} else {
				r.Vehicle = proto.NoID
			}
		case proto.PropPosition:
			if pos, ok := v.(proto.Vec3); ok {
				r.Pos = pos
			}
		}
	}
}

func (b *Bot) applyVehicleProps(veh *RemoteVehicle, p proto.Props) {
	for id, v := range p {
		switch id {
		case proto.PropEngine:
			veh.Engine, _ = v.(bool)
		case proto.PropLocked:
			veh.Locked, _ = v.(bool)
		case proto.PropDead:
			veh.Dead, _ = v.(bool)
		case proto.PropBodyHealth:
			veh.BodyHealth = floatOf(v)
		case proto.PropEngineHealth:
			veh.EngineHealth = floatOf(v)
		case proto.PropPosition:
			if pos, ok := v.(proto.Vec3); ok {
				veh.Pos = pos
			}
		case proto.PropRotation:
			if rot, ok := v.(proto.Vec3); ok {
				veh.Rot = proto.QuatFromEuler(rot)
			}
		}
		if veh.Props == nil {
			veh.Props = proto.Props{}
		}
		if v == nil {
			delete(veh.Props, id)
		} else {
			veh.Props[id] = v
		}
	}
}

func (b *Bot) onProps(t proto.EntityType, id uint16, p proto.Props) {
	switch t {
	case proto.EntityPlayer:
		if id == b.ID {
			if b.Props == nil {
				b.Props = proto.Props{}
			}
			for k, v := range p {
				b.Props[k] = v
			}
			b.applySelfProps(p)
			return
		}
		if r := b.Players[id]; r != nil {
			if r.Props == nil {
				r.Props = proto.Props{}
			}
			for k, v := range p {
				r.Props[k] = v
			}
			b.applyRemoteProps(r, p)
		}
	case proto.EntityVehicle:
		if v := b.Vehicles[id]; v != nil {
			b.applyVehicleProps(v, p)
		}
	default:
		if o := b.Others[proto.EntityRef{Type: t, ID: id}]; o != nil {
			if o.Props == nil {
				o.Props = proto.Props{}
			}
			for k, v := range p {
				o.Props[k] = v
			}
		}
	}
}

// ------------------------------------------------------------------ actions

// Ready tells the server the client finished loading (playerReady).
func (b *Bot) Ready() { b.send(transport.Reliable, &proto.Ready{}) }

// Say sends a chat line or command ("/veh adder").
func (b *Bot) Say(text string) { b.send(transport.Reliable, &proto.Chat{Text: text}) }

// CallRemote triggers a server event (mp.events.callRemote).
func (b *Bot) CallRemote(name string, args ...proto.Value) {
	b.send(transport.Reliable, &proto.ScriptEvent{Name: name, Args: args})
}

// CallProc calls a server procedure and waits for the result. The caller
// must keep pumping the bot (Run or Pump) while waiting.
func (b *Bot) CallProc(ctx context.Context, name string, args ...proto.Value) (proto.Value, error) {
	b.mu.Lock()
	b.nextProc++
	id := b.nextProc
	ch := make(chan proto.ProcResult, 1)
	b.procWait[id] = ch
	b.mu.Unlock()
	b.send(transport.Reliable, &proto.ProcCall{CallID: id, Name: name, Args: args})
	select {
	case r := <-ch:
		if !r.OK {
			return nil, errors.New(r.Error)
		}
		return r.Result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// SendPedSync reports the bot's on-foot state.
func (b *Bot) SendPedSync(now time.Time) {
	b.mu.Lock()
	m := &proto.PedSync{Time: NowMs(now), Pos: b.Pos, Vel: b.Vel, Heading: b.Heading, Move: b.Move, Flags: b.Flags, Weapon: b.Weapon, AimPos: b.AimPos}
	b.mu.Unlock()
	b.send(transport.Unreliable, m)
}

// SendVehicleSync reports the driven vehicle's state.
func (b *Bot) SendVehicleSync(now time.Time, rot proto.Quat, flags proto.VehicleFlags, gas float32) {
	b.mu.Lock()
	id := b.VehicleID
	body, engine := float32(1000), float32(1000)
	if v := b.Vehicles[id]; v != nil {
		body, engine = v.BodyHealth, v.EngineHealth
	}
	m := &proto.VehicleSync{VehicleID: id, Time: NowMs(now), Pos: b.Pos, Rot: rot, Vel: b.Vel, Gas: gas,
		Flags: flags, BodyHealth: body, EngineHealth: engine}
	if b.Flags&proto.PedAiming != 0 {
		m.Flags |= proto.VehDriverAiming
		m.Weapon, m.AimPos = b.Weapon, b.AimPos
	}
	b.mu.Unlock()
	b.send(transport.Unreliable, m)
}

// SendPassengerSync reports a passenger's state.
func (b *Bot) SendPassengerSync(now time.Time) {
	b.mu.Lock()
	m := &proto.PassengerSync{VehicleID: b.VehicleID, Seat: b.Seat, Time: NowMs(now), Flags: b.Flags, Weapon: b.Weapon, AimPos: b.AimPos}
	b.mu.Unlock()
	b.send(transport.Unreliable, m)
}

// SendUnoccupiedSync reports a controlled empty vehicle.
func (b *Bot) SendUnoccupiedSync(now time.Time, id uint16, pos, vel proto.Vec3, rot proto.Quat) {
	b.send(transport.Unreliable, &proto.UnoccupiedSync{VehicleID: id, Time: NowMs(now), Pos: pos, Rot: rot, Vel: vel})
}

// Shoot fires the current weapon at target and, if hit, claims a hit on bone.
func (b *Bot) Shoot(now time.Time, target proto.Vec3, hitType proto.EntityType, hitID uint16, bone uint16) {
	b.mu.Lock()
	b.shotSeq++
	seq := b.shotSeq
	origin := b.Pos
	origin.Z += 0.6
	w := b.Weapon
	b.mu.Unlock()
	// Shots and hits share the reliable ordered channel so a hit can never
	// overtake the shot it refers to.
	b.send(transport.Reliable, &proto.WeaponShot{Seq: seq, Time: NowMs(now), Weapon: w, Origin: origin, Target: target})
	if hitType != proto.EntityNone {
		b.send(transport.Reliable, &proto.WeaponHit{ShotSeq: seq, Weapon: w, TargetType: hitType, TargetID: hitID, Bone: bone, HitPos: target})
	}
}

// Melee claims a melee hit on another player.
func (b *Bot) Melee(target *Remote, bone uint16) {
	b.mu.Lock()
	w := b.Weapon
	b.mu.Unlock()
	b.send(transport.Reliable, &proto.WeaponHit{Weapon: w, Flags: proto.HitMelee, TargetType: proto.EntityPlayer, TargetID: target.ID, Bone: bone, HitPos: target.Pos})
}

// EnterVehicle asks to enter; the bot completes the enter task automatically.
func (b *Bot) EnterVehicle(id uint16, seat uint8) {
	b.mu.Lock()
	b.EnterResult = nil
	b.mu.Unlock()
	b.send(transport.Reliable, &proto.EnterVehicleRequest{VehicleID: id, Seat: seat})
}

// ExitVehicle leaves the current vehicle (request + completion).
func (b *Bot) ExitVehicle() {
	b.send(transport.Reliable, &proto.ExitVehicleRequest{})
	b.send(transport.Reliable, &proto.ExitVehicleComplete{})
	b.mu.Lock()
	b.VehicleID = proto.NoID
	b.mu.Unlock()
}

// SelfDamage reports environment damage.
func (b *Bot) SelfDamage(cause proto.DamageCause, health, armour uint8) {
	b.send(transport.Reliable, &proto.SelfDamage{Cause: cause, Health: health, Armour: armour})
}

// SendRaw queues an arbitrary message (tests of malicious clients).
func (b *Bot) SendRaw(ch transport.Channel, m proto.Message) { b.send(ch, m) }
