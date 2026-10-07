package bot

import (
	"context"
	"math"
	"math/rand/v2"
	"net"
	"net/netip"
	"time"

	"gomp/wire/proto"
)

func resolve(addr string) (netip.AddrPort, error) {
	ua, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return netip.AddrPort{}, err
	}
	return ua.AddrPort(), nil
}

// Behavior drives a bot every tick.
type Behavior interface {
	Tick(b *Bot, now time.Time, dt float64)
}

// Run pumps the connection and runs behavior at rate Hz until ctx ends or
// the connection closes.
func (b *Bot) Run(ctx context.Context, behavior Behavior, rate int) error {
	if rate <= 0 {
		rate = 30
	}
	tick := time.NewTicker(time.Second / time.Duration(rate))
	defer tick.Stop()
	last := time.Now()
	for {
		select {
		case <-ctx.Done():
			return nil
		case now := <-tick.C:
			b.Pump(now)
			if closed, reason := b.Closed(); closed {
				return &DisconnectedError{Reason: reason}
			}
			if behavior != nil {
				behavior.Tick(b, now, now.Sub(last).Seconds())
			}
			last = now
			b.Flush(now)
		}
	}
}

// DisconnectedError reports that the server closed the connection.
type DisconnectedError struct{ Reason string }

func (e *DisconnectedError) Error() string { return "bot disconnected: " + e.Reason }

func headingOf(v proto.Vec3) float32 {
	h := math.Atan2(float64(-v.X), float64(v.Y)) * 180 / math.Pi
	if h < 0 {
		h += 360
	}
	return float32(h)
}

// ------------------------------------------------------------------ walker

// Walker wanders between random waypoints around Home.
type Walker struct {
	Home   proto.Vec3
	Radius float32
	Rng    *rand.Rand
	target proto.Vec3
	speed  float32
	move   proto.MoveState
	pause  float64
}

// NewWalker creates a walker with its own deterministic RNG.
func NewWalker(home proto.Vec3, radius float32, seed uint64) *Walker {
	return &Walker{Home: home, Radius: radius, Rng: rand.New(rand.NewPCG(seed, seed^0xABCDEF))}
}

func (w *Walker) pick(from proto.Vec3) {
	a := w.Rng.Float64() * 2 * math.Pi
	r := float32(math.Sqrt(w.Rng.Float64())) * w.Radius
	w.target = proto.Vec3{X: w.Home.X + r*float32(math.Cos(a)), Y: w.Home.Y + r*float32(math.Sin(a)), Z: from.Z}
	switch w.Rng.IntN(3) {
	case 0:
		w.speed, w.move = 1.4, proto.MoveWalk
	case 1:
		w.speed, w.move = 4.5, proto.MoveRun
	default:
		w.speed, w.move = 7.0, proto.MoveSprint
	}
}

// Step moves the bot toward its waypoint; it returns false while not spawned.
func (w *Walker) Step(b *Bot, dt float64) bool {
	b.Lock()
	defer b.Unlock()
	if !b.Spawned || b.Dead || b.VehicleID != proto.NoID {
		return false
	}
	if w.target == (proto.Vec3{}) {
		w.pick(b.Pos)
	}
	if w.pause > 0 {
		w.pause -= dt
		b.Vel, b.Move = proto.Vec3{}, proto.MoveIdle
		return true
	}
	d := w.target.Sub(b.Pos)
	d.Z = 0
	dist := d.Len()
	step := w.speed * float32(dt)
	if dist <= step || dist < 0.1 {
		b.Pos.X, b.Pos.Y = w.target.X, w.target.Y
		w.pick(b.Pos)
		w.pause = w.Rng.Float64() * 1.5
		b.Vel, b.Move = proto.Vec3{}, proto.MoveIdle
		return true
	}
	dir := d.Scale(1 / dist)
	b.Pos = b.Pos.Add(dir.Scale(step))
	b.Vel = dir.Scale(w.speed)
	b.Heading = headingOf(dir)
	b.Move = w.move
	return true
}

// Tick implements Behavior.
func (w *Walker) Tick(b *Bot, now time.Time, dt float64) {
	if w.Step(b, dt) {
		b.SendPedSync(now)
	}
}

// ------------------------------------------------------------------ driver

// Driver gets a vehicle via a chat command and drives circles around Center.
type Driver struct {
	Center      proto.Vec3
	Radius      float32
	Speed       float32 // m/s
	Command     string  // e.g. "/veh sultan"
	angle       float64
	lastRequest time.Time
	fallback    *Walker
}

// NewDriver creates a driver; while it has no vehicle it walks.
func NewDriver(center proto.Vec3, radius, speed float32, command string, seed uint64) *Driver {
	return &Driver{Center: center, Radius: radius, Speed: speed, Command: command, angle: float64(seed%360) * math.Pi / 180,
		fallback: NewWalker(center, 20, seed)}
}

// Tick implements Behavior.
func (d *Driver) Tick(b *Bot, now time.Time, dt float64) {
	b.Lock()
	inVeh, seat, spawned, dead := b.VehicleID != proto.NoID, b.Seat, b.Spawned, b.Dead
	b.Unlock()
	if !spawned || dead {
		return
	}
	if !inVeh {
		if d.Command != "" && now.Sub(d.lastRequest) > 3*time.Second {
			d.lastRequest = now
			b.Say(d.Command)
		}
		d.fallback.Tick(b, now, dt)
		return
	}
	if seat != proto.SeatDriver {
		b.SendPassengerSync(now)
		return
	}
	d.angle += float64(d.Speed/d.Radius) * dt
	c, s := float32(math.Cos(d.angle)), float32(math.Sin(d.angle))
	b.Lock()
	b.Pos = proto.Vec3{X: d.Center.X + d.Radius*c, Y: d.Center.Y + d.Radius*s, Z: b.Pos.Z}
	tangent := proto.Vec3{X: -s, Y: c}
	b.Vel = tangent.Scale(d.Speed)
	b.Heading = headingOf(tangent)
	h := b.Heading
	b.Unlock()
	b.SendVehicleSync(now, proto.QuatFromEuler(proto.Vec3{Z: h}), proto.VehEngineOn|proto.VehLightsOn, 0.7)
}

// ------------------------------------------------------------------ shooter

// Shooter walks and fires at the nearest visible player.
type Shooter struct {
	Walker   *Walker
	Range    float32
	HitRate  float64
	Interval time.Duration
	lastShot time.Time
}

// NewShooter creates a shooter around home.
func NewShooter(home proto.Vec3, radius float32, seed uint64) *Shooter {
	return &Shooter{Walker: NewWalker(home, radius, seed), Range: 40, HitRate: 0.6, Interval: 250 * time.Millisecond}
}

var bones = []uint16{31086, 24818, 24818, 24818, 11816, 58271, 51826, 45509, 40269}

// Tick implements Behavior.
func (s *Shooter) Tick(b *Bot, now time.Time, dt float64) {
	if !s.Walker.Step(b, dt) {
		return
	}
	b.Lock()
	var best *Remote
	bestD := s.Range * s.Range
	for _, r := range b.Players {
		if r.Dead || r.Vehicle != proto.NoID {
			continue
		}
		if d := r.Pos.DistSq(b.Pos); d < bestD {
			best, bestD = r, d
		}
	}
	armed := b.Weapon != 0 && b.Weapon != proto.Joaat("weapon_unarmed") && b.Weapons[b.Weapon] > 0
	if best != nil && armed {
		b.Flags |= proto.PedAiming
		b.AimPos = best.Pos
	} else {
		b.Flags &^= proto.PedAiming
	}
	var target Remote
	if best != nil {
		target = *best
	}
	b.Unlock()
	b.SendPedSync(now)
	if best == nil || !armed || now.Sub(s.lastShot) < s.Interval {
		return
	}
	s.lastShot = now
	if s.Walker.Rng.Float64() < s.HitRate {
		b.Shoot(now, target.Pos, proto.EntityPlayer, target.ID, bones[s.Walker.Rng.IntN(len(bones))])
	} else {
		miss := target.Pos.Add(proto.Vec3{X: 2, Y: 2, Z: 1})
		b.Shoot(now, miss, proto.EntityNone, 0, 0)
	}
}

// Idle stands still and keeps syncing (useful as a target).
type Idle struct{}

// Tick implements Behavior.
func (Idle) Tick(b *Bot, now time.Time, _ float64) {
	b.Lock()
	ok := b.Spawned && b.VehicleID == proto.NoID
	b.Unlock()
	if ok {
		b.SendPedSync(now)
	}
}
