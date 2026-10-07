// Package anticheat validates client-authoritative movement with token
// buckets: allowance accrues at the maximum legal speed over server time and
// each sync consumes the distance moved. Network jitter only shifts when
// allowance is consumed, while teleports and speed hacks exhaust it.
package anticheat

import (
	"math"
	"time"

	"gomp/wire/proto"
)

// Limits configure movement checks.
type Limits struct {
	MaxFootSpeed float32 // horizontal m/s on foot
	Tolerance    float32 // multiplier >= 1
}

const (
	// burstSeconds is how much unused allowance may be banked.
	burstSeconds = 1.5
	// slack absorbs small corrections (snapping to ground, entering cover).
	slack = 2.0
	// fallSpeed bounds downward motion (free fall + parachute dives).
	fallSpeed = 90
	// climbSpeed bounds upward motion on foot (jumps, ladders, climbing).
	climbSpeed = 12
)

type bucket struct {
	allowance float32
	last      time.Time
}

func (b *bucket) consume(now time.Time, dist, speed float32) bool {
	if b.last.IsZero() {
		b.last = now
		b.allowance = speed*burstSeconds + slack
	}
	dt := float32(now.Sub(b.last).Seconds())
	if dt < 0 {
		dt = 0
	}
	b.last = now
	b.allowance = min(b.allowance+speed*dt, speed*burstSeconds+slack)
	if dist <= b.allowance {
		b.allowance -= dist
		return true
	}
	return false
}

// Mover validates one player's successive positions.
type Mover struct {
	horiz, up, down bucket
	vehicle         bucket
}

// Reset clears the history (spawn, teleport, entering or leaving a vehicle).
func (m *Mover) Reset() { *m = Mover{} }

// Result of a movement check.
type Result struct {
	OK    bool
	Dist  float32 // metres moved
	Limit string  // which limit was exceeded
}

// CheckFoot validates an on-foot move from prev to cur at server time now.
func (m *Mover) CheckFoot(now time.Time, prev, cur proto.Vec3, lim Limits) Result {
	if !cur.IsFinite() {
		return Result{OK: false, Limit: "non-finite position"}
	}
	h := float32(math.Sqrt(float64(cur.Dist2DSq(prev))))
	dz := cur.Z - prev.Z
	r := Result{OK: true, Dist: h}
	if !m.horiz.consume(now, h, lim.MaxFootSpeed*lim.Tolerance) {
		r.OK, r.Limit = false, "horizontal speed"
	}
	if dz > 0 {
		if !m.up.consume(now, dz, climbSpeed*lim.Tolerance) {
			r.OK, r.Limit = false, "vertical speed"
		}
		m.down.consume(now, 0, fallSpeed)
	} else {
		if !m.down.consume(now, -dz, fallSpeed*lim.Tolerance) {
			r.OK, r.Limit = false, "fall speed"
		}
		m.up.consume(now, 0, climbSpeed)
	}
	return r
}

// CheckVehicle validates a vehicle move with a model-specific speed bound.
func (m *Mover) CheckVehicle(now time.Time, prev, cur proto.Vec3, maxSpeed float32, lim Limits) Result {
	if !cur.IsFinite() {
		return Result{OK: false, Limit: "non-finite position"}
	}
	d := cur.Dist(prev)
	// Vehicles can additionally fall freely (off cliffs, crashed aircraft).
	speed := maxSpeed*lim.Tolerance + fallSpeed*0.5
	if !m.vehicle.consume(now, d, speed) {
		return Result{OK: false, Dist: d, Limit: "vehicle speed"}
	}
	return Result{OK: true, Dist: d}
}
