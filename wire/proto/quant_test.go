package proto

import (
	"math"
	"math/rand/v2"
	"testing"
)

func TestHeadingQuantization(t *testing.T) {
	for _, h := range []float32{0, 0.001, 45, 90, 179.99, 180, 270.5, 359.999, 360, -90, 725} {
		got := DequantizeHeading(QuantizeHeading(h))
		want := float32(math.Mod(float64(h), 360))
		if want < 0 {
			want += 360
		}
		diff := math.Abs(float64(got - want))
		if diff > 180 {
			diff = 360 - diff
		}
		if diff > 360.0/65536 {
			t.Errorf("heading %v -> %v (diff %v)", h, got, diff)
		}
	}
}

func TestSignedQuantizationSaturates(t *testing.T) {
	if q := QuantizeSigned(1e9, VelocityScale); q != 32767 {
		t.Fatalf("saturation: %d", q)
	}
	if q := QuantizeSigned(-1e9, VelocityScale); q != -32767 {
		t.Fatalf("saturation: %d", q)
	}
	if q := QuantizeSigned(float32(math.NaN()), VelocityScale); q != 0 {
		t.Fatalf("NaN: %d", q)
	}
	for _, v := range []float32{0, 0.004, -12.345, 300} {
		got := DequantizeSigned(QuantizeSigned(v, VelocityScale), VelocityScale)
		if math.Abs(float64(got-v)) > 0.5/VelocityScale+1e-6 {
			t.Errorf("velocity %v -> %v", v, got)
		}
	}
}

func TestUnitQuantization(t *testing.T) {
	for _, v := range []float32{-1, -0.5, 0, 0.3, 1, 2, -2} {
		got := DequantizeUnitS8(QuantizeUnitS8(v))
		c := float32(math.Max(-1, math.Min(1, float64(v))))
		if math.Abs(float64(got-c)) > 0.5/127+1e-6 {
			t.Errorf("s8 %v -> %v", v, got)
		}
	}
	for _, v := range []float32{0, 0.2, 1, 1.5, -1} {
		got := DequantizeUnitU8(QuantizeUnitU8(v))
		c := float32(math.Max(0, math.Min(1, float64(v))))
		if math.Abs(float64(got-c)) > 0.5/255+1e-6 {
			t.Errorf("u8 %v -> %v", v, got)
		}
	}
}

// quatAngle returns the rotation angle between two unit quaternions in degrees.
func quatAngle(a, b Quat) float64 {
	d := math.Abs(float64(a.X)*float64(b.X) + float64(a.Y)*float64(b.Y) + float64(a.Z)*float64(b.Z) + float64(a.W)*float64(b.W))
	if d > 1 {
		d = 1
	}
	return 2 * math.Acos(d) * 180 / math.Pi
}

func TestQuatPackPrecision(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	worst := 0.0
	for i := 0; i < 100000; i++ {
		q := randUnitQuat(rng)
		got := UnpackQuat(PackQuat(q))
		if a := quatAngle(q, got); a > worst {
			worst = a
		}
	}
	// 10 bits per component over [-1/√2, 1/√2] gives well under half a degree.
	if worst > 0.35 {
		t.Fatalf("worst angular error %.4f°", worst)
	}
}

func TestQuatPackIdempotent(t *testing.T) {
	rng := rand.New(rand.NewPCG(3, 4))
	changed, worst := 0, 0.0
	for range 100000 {
		p := PackQuat(randUnitQuat(rng))
		p2 := PackQuat(UnpackQuat(p))
		if p2 != p {
			changed++
			if a := quatAngle(UnpackQuat(p), UnpackQuat(p2)); a > worst {
				worst = a
			}
		}
	}
	// The server re-packs relayed rotations once; that must not add visible error.
	// Only near-ties between the two largest components may flip the index.
	if changed > 500 || worst > 0.35 {
		t.Fatalf("%d/100000 changed after a second pack, worst %.4f°", changed, worst)
	}
}

func TestEulerRoundTrip(t *testing.T) {
	cases := []Vec3{{0, 0, 0}, {0, 0, 90}, {0, 0, -135}, {10, 0, 45}, {0, 20, 300}, {-30, 15, 10}, {45, -60, 170}}
	for _, e := range cases {
		got := QuatFromEuler(e).Euler()
		// Compare via quaternions to avoid angle wrapping issues.
		if a := quatAngle(QuatFromEuler(e), QuatFromEuler(got)); a > 0.05 {
			t.Errorf("euler %v -> %v (%.5f°)", e, got, a)
		}
		if math.Abs(float64(got.X-e.X)) > 1e-3 || math.Abs(float64(got.Y-e.Y)) > 1e-3 {
			t.Errorf("pitch/roll %v -> %v", e, got)
		}
	}
	// Pure yaw maps to heading.
	if y := QuatFromEuler(Vec3{0, 0, 90}).Euler().Z; math.Abs(float64(y-90)) > 1e-3 {
		t.Fatalf("yaw %v", y)
	}
}

func TestVec3(t *testing.T) {
	a, b := Vec3{1, 2, 2}, Vec3{4, 6, 2}
	if a.Dist(b) != 5 {
		t.Fatal(a.Dist(b))
	}
	if a.Dist2DSq(b) != 25 {
		t.Fatal(a.Dist2DSq(b))
	}
	if !a.IsFinite() || (Vec3{float32(math.NaN()), 0, 0}).IsFinite() {
		t.Fatal("IsFinite")
	}
}
