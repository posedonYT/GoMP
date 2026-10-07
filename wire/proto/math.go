package proto

import "math"

// Vec3 is a GTA world-space vector (metres) or Euler rotation (degrees).
type Vec3 struct {
	X, Y, Z float32
}

func (a Vec3) Add(b Vec3) Vec3      { return Vec3{a.X + b.X, a.Y + b.Y, a.Z + b.Z} }
func (a Vec3) Sub(b Vec3) Vec3      { return Vec3{a.X - b.X, a.Y - b.Y, a.Z - b.Z} }
func (a Vec3) Scale(s float32) Vec3 { return Vec3{a.X * s, a.Y * s, a.Z * s} }
func (a Vec3) Dot(b Vec3) float32   { return a.X*b.X + a.Y*b.Y + a.Z*b.Z }
func (a Vec3) LenSq() float32       { return a.Dot(a) }
func (a Vec3) Len() float32         { return float32(math.Sqrt(float64(a.LenSq()))) }

// DistSq returns the squared distance between a and b.
func (a Vec3) DistSq(b Vec3) float32 { return a.Sub(b).LenSq() }

// Dist returns the distance between a and b.
func (a Vec3) Dist(b Vec3) float32 { return a.Sub(b).Len() }

// Dist2DSq returns the squared horizontal distance between a and b.
func (a Vec3) Dist2DSq(b Vec3) float32 {
	dx, dy := a.X-b.X, a.Y-b.Y
	return dx*dx + dy*dy
}

// IsFinite reports whether all components are finite numbers.
func (a Vec3) IsFinite() bool {
	return isFinite(a.X) && isFinite(a.Y) && isFinite(a.Z)
}

func isFinite(f float32) bool {
	return !math.IsNaN(float64(f)) && !math.IsInf(float64(f), 0)
}

// Quat is a unit rotation quaternion.
type Quat struct {
	X, Y, Z, W float32
}

// IdentityQuat is the zero rotation.
var IdentityQuat = Quat{0, 0, 0, 1}

func (q Quat) mul(r Quat) Quat {
	return Quat{
		X: q.W*r.X + q.X*r.W + q.Y*r.Z - q.Z*r.Y,
		Y: q.W*r.Y - q.X*r.Z + q.Y*r.W + q.Z*r.X,
		Z: q.W*r.Z + q.X*r.Y - q.Y*r.X + q.Z*r.W,
		W: q.W*r.W - q.X*r.X - q.Y*r.Y - q.Z*r.Z,
	}
}

// Normalize returns q scaled to unit length (identity for a zero quaternion).
func (q Quat) Normalize() Quat {
	l := math.Sqrt(float64(q.X*q.X + q.Y*q.Y + q.Z*q.Z + q.W*q.W))
	if l < 1e-9 || math.IsNaN(l) {
		return IdentityQuat
	}
	s := float32(1 / l)
	return Quat{q.X * s, q.Y * s, q.Z * s, q.W * s}
}

func axisQuat(x, y, z float32, deg float32) Quat {
	h := float64(deg) * math.Pi / 360
	s := float32(math.Sin(h))
	return Quat{x * s, y * s, z * s, float32(math.Cos(h))}
}

// QuatFromEuler converts GTA Euler angles in degrees (X = pitch, Y = roll,
// Z = yaw, game rotation order 2) to a quaternion: R = Rz(yaw)·Rx(pitch)·Ry(roll).
func QuatFromEuler(rot Vec3) Quat {
	qz := axisQuat(0, 0, 1, rot.Z)
	qx := axisQuat(1, 0, 0, rot.X)
	qy := axisQuat(0, 1, 0, rot.Y)
	return qz.mul(qx).mul(qy).Normalize()
}

// Euler converts q back to GTA Euler angles in degrees (see QuatFromEuler).
func (q Quat) Euler() Vec3 {
	q = q.Normalize()
	x, y, z, w := float64(q.X), float64(q.Y), float64(q.Z), float64(q.W)
	// Rotation matrix elements used by the Rz·Rx·Ry decomposition.
	r01 := 2 * (x*y - z*w)
	r11 := 1 - 2*(x*x+z*z)
	r20 := 2 * (x*z - y*w)
	r21 := 2 * (y*z + x*w)
	r22 := 1 - 2*(x*x+y*y)
	if r21 > 1 {
		r21 = 1
	} else if r21 < -1 {
		r21 = -1
	}
	const deg = 180 / math.Pi
	pitch := math.Asin(r21) * deg
	roll := math.Atan2(-r20, r22) * deg
	yaw := math.Atan2(-r01, r11) * deg
	return Vec3{float32(pitch), float32(roll), float32(yaw)}
}
