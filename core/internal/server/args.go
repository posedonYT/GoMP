package server

import (
	"fmt"
	"math"

	"gomp/wire/proto"
)

// args reads typed arguments from a host operation. The first conversion
// error is kept and reported once; accessors return zero values afterwards.
type args struct {
	a   []proto.Value
	err error
}

func (x *args) fail(i int, want string) {
	if x.err == nil {
		var got proto.Value
		if i < len(x.a) {
			got = x.a[i]
		}
		x.err = fmt.Errorf("argument %d: want %s, got %T", i, want, got)
	}
}

func (x *args) has(i int) bool { return i < len(x.a) && x.a[i] != nil }

func (x *args) val(i int) proto.Value {
	if i < len(x.a) {
		return x.a[i]
	}
	return nil
}

func asFloat(v proto.Value) (float64, bool) {
	switch n := v.(type) {
	case int64:
		return float64(n), true
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	case bool:
		if n {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

func (x *args) float(i int) float64 {
	f, ok := asFloat(x.val(i))
	if !ok {
		x.fail(i, "number")
	}
	return f
}

func (x *args) int(i int) int64 {
	switch n := x.val(i).(type) {
	case int64:
		return n
	case float64:
		if n == math.Trunc(n) && math.Abs(n) < 1<<53 {
			return int64(n)
		}
	case bool:
		if n {
			return 1
		}
		return 0
	}
	x.fail(i, "integer")
	return 0
}

// u32 accepts hashes given as signed or unsigned 32-bit numbers.
func (x *args) u32(i int) uint32 { return uint32(x.int(i)) }

func (x *args) bool(i int) bool {
	switch b := x.val(i).(type) {
	case bool:
		return b
	case int64:
		return b != 0
	case float64:
		return b != 0
	case nil:
		return false
	}
	x.fail(i, "boolean")
	return false
}

func (x *args) str(i int) string {
	if s, ok := x.val(i).(string); ok {
		return s
	}
	x.fail(i, "string")
	return ""
}

func (x *args) vec(i int) proto.Vec3 {
	switch v := x.val(i).(type) {
	case proto.Vec3:
		return v
	case []proto.Value:
		if len(v) >= 3 {
			a, ok1 := asFloat(v[0])
			b, ok2 := asFloat(v[1])
			c, ok3 := asFloat(v[2])
			if ok1 && ok2 && ok3 {
				return proto.Vec3{X: float32(a), Y: float32(b), Z: float32(c)}
			}
		}
	case map[string]proto.Value:
		a, ok1 := asFloat(v["x"])
		b, ok2 := asFloat(v["y"])
		c, ok3 := asFloat(v["z"])
		if ok1 && ok2 && ok3 {
			return proto.Vec3{X: float32(a), Y: float32(b), Z: float32(c)}
		}
	}
	x.fail(i, "vector3")
	return proto.Vec3{}
}

func (x *args) list(i int) []proto.Value {
	switch v := x.val(i).(type) {
	case []proto.Value:
		return v
	case nil:
		return nil
	}
	x.fail(i, "array")
	return nil
}

func (x *args) kv(i int) map[string]proto.Value {
	switch v := x.val(i).(type) {
	case map[string]proto.Value:
		return v
	case nil:
		return nil
	}
	x.fail(i, "object")
	return nil
}

func (x *args) ref(i int) (proto.EntityRef, bool) {
	r, ok := x.val(i).(proto.EntityRef)
	if !ok {
		x.fail(i, "entity")
	}
	return r, ok
}

func clampInt(v int64, lo, hi int64) int64 {
	return max(lo, min(hi, v))
}
