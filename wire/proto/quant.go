package proto

import "math"

// Quantization used by the sync messages. Every helper pair is exact inverse
// up to the documented resolution; see quant_test.go for the error bounds.

const (
	// VelocityScale: linear velocity is sent as int16 in centimetres per second.
	VelocityScale = 100
	// AngVelocityScale: angular velocity is sent as int16 in milliradians per second.
	AngVelocityScale = 1000
)

func clampRound(v float64, lo, hi float64) float64 {
	if math.IsNaN(v) {
		return 0
	}
	v = math.Round(v)
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// QuantizeHeading maps degrees to a uint16 (resolution ~0.0055°).
func QuantizeHeading(deg float32) uint16 {
	d := math.Mod(float64(deg), 360)
	if d < 0 {
		d += 360
	}
	if math.IsNaN(d) {
		return 0
	}
	return uint16(uint32(math.Round(d/360*65536)) & 0xFFFF)
}

// DequantizeHeading is the inverse of QuantizeHeading, returning [0, 360).
func DequantizeHeading(q uint16) float32 {
	return float32(float64(q) * 360 / 65536)
}

// QuantizeSigned maps v*scale to int16 with saturation.
func QuantizeSigned(v float32, scale float64) int16 {
	return int16(clampRound(float64(v)*scale, -32767, 32767))
}

// DequantizeSigned is the inverse of QuantizeSigned.
func DequantizeSigned(q int16, scale float64) float32 {
	return float32(float64(q) / scale)
}

// QuantizeUnitS8 maps [-1, 1] to int8.
func QuantizeUnitS8(v float32) int8 {
	return int8(clampRound(float64(v)*127, -127, 127))
}

// DequantizeUnitS8 is the inverse of QuantizeUnitS8.
func DequantizeUnitS8(q int8) float32 { return float32(q) / 127 }

// QuantizeUnitU8 maps [0, 1] to uint8.
func QuantizeUnitU8(v float32) uint8 {
	return uint8(clampRound(float64(v)*255, 0, 255))
}

// DequantizeUnitU8 is the inverse of QuantizeUnitU8.
func DequantizeUnitU8(q uint8) float32 { return float32(q) / 255 }

// QuantizeHealth saturates a health-like value into int16.
func QuantizeHealth(v float32) int16 {
	return int16(clampRound(float64(v), -32767, 32767))
}

const (
	quatBits  = 10
	quatMax   = (1 << quatBits) - 1
	quatRange = 0.70710678118654752 // 1/sqrt(2)
)

// PackQuat encodes a unit quaternion with the "smallest three" method into 32
// bits: 2 bits for the index of the largest component and 10 bits for each of
// the three remaining components in [-1/√2, 1/√2].
func PackQuat(q Quat) uint32 {
	q = q.Normalize()
	c := [4]float64{float64(q.X), float64(q.Y), float64(q.Z), float64(q.W)}
	largest := 0
	for i := 1; i < 4; i++ {
		if math.Abs(c[i]) > math.Abs(c[largest]) {
			largest = i
		}
	}
	sign := 1.0
	if c[largest] < 0 {
		sign = -1
	}
	packed := uint32(largest) << 30
	shift := 20
	for i := 0; i < 4; i++ {
		if i == largest {
			continue
		}
		v := c[i] * sign
		n := (v + quatRange) / (2 * quatRange) * quatMax
		packed |= uint32(clampRound(n, 0, quatMax)) << shift
		shift -= quatBits
	}
	return packed
}

// UnpackQuat is the inverse of PackQuat.
func UnpackQuat(p uint32) Quat {
	largest := int(p >> 30)
	var c [4]float64
	shift := 20
	sum := 0.0
	for i := 0; i < 4; i++ {
		if i == largest {
			continue
		}
		n := float64((p >> shift) & quatMax)
		v := n/quatMax*(2*quatRange) - quatRange
		c[i] = v
		sum += v * v
		shift -= quatBits
	}
	rest := 1 - sum
	if rest < 0 {
		rest = 0
	}
	c[largest] = math.Sqrt(rest)
	return Quat{float32(c[0]), float32(c[1]), float32(c[2]), float32(c[3])}
}
