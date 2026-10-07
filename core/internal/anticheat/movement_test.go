package anticheat

import (
	"math"
	"math/rand/v2"
	"testing"
	"time"

	"gomp/wire/proto"
)

var lim = Limits{MaxFootSpeed: 12, Tolerance: 1.25}

// walk simulates a client moving at speed m/s, synced at 30 Hz, with packets
// arriving at the server with random jitter (bunching).
func walk(m *Mover, speed float32, jitter time.Duration, seconds int, vehicleMax float32) (violations int) {
	rng := rand.New(rand.NewPCG(1, 2))
	t0 := time.Unix(1000, 0)
	pos := proto.Vec3{}
	prev := pos
	const hz = 30
	for i := 1; i <= seconds*hz; i++ {
		pos.X += speed / hz
		at := t0.Add(time.Duration(i) * time.Second / hz)
		if jitter > 0 {
			at = at.Add(time.Duration(rng.Int64N(int64(jitter))))
		}
		var r Result
		if vehicleMax > 0 {
			r = m.CheckVehicle(at, prev, pos, vehicleMax, lim)
		} else {
			r = m.CheckFoot(at, prev, pos, lim)
		}
		if !r.OK {
			violations++
		}
		prev = pos
	}
	return violations
}

func TestLegitSprintWithJitter(t *testing.T) {
	var m Mover
	if v := walk(&m, 7.5, 120*time.Millisecond, 30, 0); v != 0 {
		t.Fatalf("legit sprint flagged %d times", v)
	}
}

func TestSpeedHackDetected(t *testing.T) {
	var m Mover
	if v := walk(&m, 40, 0, 5, 0); v < 50 {
		t.Fatalf("speed hack flagged only %d times", v)
	}
}

func TestTeleportDetectedButResetAllows(t *testing.T) {
	var m Mover
	now := time.Unix(0, 0)
	if !m.CheckFoot(now, proto.Vec3{}, proto.Vec3{X: 1}, lim).OK {
		t.Fatal("first step")
	}
	r := m.CheckFoot(now.Add(33*time.Millisecond), proto.Vec3{X: 1}, proto.Vec3{X: 500}, lim)
	if r.OK || r.Limit != "horizontal speed" {
		t.Fatalf("teleport not detected: %+v", r)
	}
	m.Reset()
	if !m.CheckFoot(now.Add(66*time.Millisecond), proto.Vec3{X: 500}, proto.Vec3{X: 501}, lim).OK {
		t.Fatal("after reset")
	}
}

func TestFallingAllowedFlyingNot(t *testing.T) {
	var m Mover
	now := time.Unix(0, 0)
	z := float32(500)
	for i := range 60 { // 2 s of free fall at 50 m/s
		at := now.Add(time.Duration(i) * time.Second / 30)
		if r := m.CheckFoot(at, proto.Vec3{Z: z}, proto.Vec3{Z: z - 50.0/30}, lim); !r.OK {
			t.Fatalf("fall flagged at %d: %+v", i, r)
		}
		z -= 50.0 / 30
	}
	m.Reset()
	flagged := false
	for i := range 60 { // flying up at 30 m/s
		at := now.Add(time.Duration(i) * time.Second / 30)
		if !m.CheckFoot(at, proto.Vec3{Z: z}, proto.Vec3{Z: z + 1}, lim).OK {
			flagged = true
		}
		z++
	}
	if !flagged {
		t.Fatal("fly hack not detected")
	}
}

func TestVehicleSpeed(t *testing.T) {
	var m Mover
	if v := walk(&m, 85, 100*time.Millisecond, 20, 90); v != 0 {
		t.Fatalf("legit fast car flagged %d times", v)
	}
	m.Reset()
	if v := walk(&m, 300, 0, 5, 90); v == 0 {
		t.Fatal("vehicle speed hack not detected")
	}
	if (&Mover{}).CheckVehicle(time.Now(), proto.Vec3{}, proto.Vec3{X: float32(math.Inf(1))}, 90, lim).OK {
		t.Fatal("infinite position accepted")
	}
}
