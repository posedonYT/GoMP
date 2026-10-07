package proto

import (
	"fmt"
	"math"
	"sort"
)

// Value is a dynamically typed script value carried by script events, procs,
// shared data and entity properties. Allowed dynamic types after decoding:
//
//	nil, bool, int64, float64, string, []Value, map[string]Value, Vec3, EntityRef
//
// When encoding, any Go integer or float type is accepted as well.
type Value = any

// EntityRef references an entity inside a Value.
type EntityRef struct {
	Type EntityType
	ID   uint16
}

// Value type tags on the wire.
const (
	TagNil    = 0
	TagFalse  = 1
	TagTrue   = 2
	TagInt    = 3
	TagFloat  = 4
	TagString = 5
	TagArray  = 6
	TagMap    = 7
	TagVec3   = 8
	TagEntity = 9
)

// MaxValueDepth bounds nesting of arrays and maps.
const MaxValueDepth = 32

// WriteValue encodes v. It returns an error for unsupported types.
func (w *Writer) Value(v Value) error { return w.value(v, 0) }

func (w *Writer) value(v Value, depth int) error {
	if depth > MaxValueDepth {
		return fmt.Errorf("proto: value nesting exceeds %d", MaxValueDepth)
	}
	switch x := v.(type) {
	case nil:
		w.U8(TagNil)
	case bool:
		if x {
			w.U8(TagTrue)
		} else {
			w.U8(TagFalse)
		}
	case int:
		w.U8(TagInt)
		w.Varint(int64(x))
	case int8:
		w.U8(TagInt)
		w.Varint(int64(x))
	case int16:
		w.U8(TagInt)
		w.Varint(int64(x))
	case int32:
		w.U8(TagInt)
		w.Varint(int64(x))
	case int64:
		w.U8(TagInt)
		w.Varint(x)
	case uint8:
		w.U8(TagInt)
		w.Varint(int64(x))
	case uint16:
		w.U8(TagInt)
		w.Varint(int64(x))
	case uint32:
		w.U8(TagInt)
		w.Varint(int64(x))
	case uint64:
		if x > math.MaxInt64 {
			w.U8(TagFloat)
			w.F64(float64(x))
		} else {
			w.U8(TagInt)
			w.Varint(int64(x))
		}
	case float32:
		w.U8(TagFloat)
		w.F64(float64(x))
	case float64:
		w.U8(TagFloat)
		w.F64(x)
	case string:
		w.U8(TagString)
		w.String(x)
	case []Value:
		w.U8(TagArray)
		w.Uvarint(uint64(len(x)))
		for _, e := range x {
			if err := w.value(e, depth+1); err != nil {
				return err
			}
		}
	case map[string]Value:
		w.U8(TagMap)
		w.Uvarint(uint64(len(x)))
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			w.String(k)
			if err := w.value(x[k], depth+1); err != nil {
				return err
			}
		}
	case Vec3:
		w.U8(TagVec3)
		w.Vec3(x)
	case EntityRef:
		w.U8(TagEntity)
		w.U8(uint8(x.Type))
		w.U16(x.ID)
	default:
		return fmt.Errorf("proto: unsupported value type %T", v)
	}
	return nil
}

// Value decodes one value.
func (r *Reader) Value() Value { return r.value(0) }

func (r *Reader) value(depth int) Value {
	if depth > MaxValueDepth {
		r.Fail(fmt.Errorf("proto: value nesting exceeds %d", MaxValueDepth))
		return nil
	}
	tag := r.U8()
	if r.err != nil {
		return nil
	}
	switch tag {
	case TagNil:
		return nil
	case TagFalse:
		return false
	case TagTrue:
		return true
	case TagInt:
		return r.Varint()
	case TagFloat:
		return r.F64()
	case TagString:
		return r.String()
	case TagArray:
		// Every element takes at least one byte, which bounds n by Remaining.
		n := r.Len(r.Remaining())
		arr := make([]Value, 0, n)
		for i := 0; i < n && r.err == nil; i++ {
			arr = append(arr, r.value(depth+1))
		}
		return arr
	case TagMap:
		// Each entry takes at least two bytes (empty key + nil).
		n := r.Len(r.Remaining() / 2)
		m := make(map[string]Value, n)
		for i := 0; i < n && r.err == nil; i++ {
			k := r.String()
			m[k] = r.value(depth + 1)
		}
		return m
	case TagVec3:
		return r.Vec3()
	case TagEntity:
		t := EntityType(r.U8())
		return EntityRef{Type: t, ID: r.U16()}
	default:
		r.Fail(fmt.Errorf("proto: unknown value tag %d", tag))
		return nil
	}
}

// Values encodes a length-prefixed list of values.
func (w *Writer) Values(vs []Value) error {
	w.Uvarint(uint64(len(vs)))
	for _, v := range vs {
		if err := w.Value(v); err != nil {
			return err
		}
	}
	return nil
}

// Values decodes a length-prefixed list of values.
func (r *Reader) Values() []Value {
	n := r.Len(r.Remaining())
	if n == 0 {
		return nil
	}
	vs := make([]Value, 0, n)
	for i := 0; i < n && r.err == nil; i++ {
		vs = append(vs, r.Value())
	}
	return vs
}

// NormalizeValue converts any accepted Go numeric type into the canonical
// decoded representation (int64/float64) recursively, so that values compare
// equal before and after a round trip.
func NormalizeValue(v Value) Value {
	switch x := v.(type) {
	case int:
		return int64(x)
	case int8:
		return int64(x)
	case int16:
		return int64(x)
	case int32:
		return int64(x)
	case uint8:
		return int64(x)
	case uint16:
		return int64(x)
	case uint32:
		return int64(x)
	case uint64:
		if x > math.MaxInt64 {
			return float64(x)
		}
		return int64(x)
	case float32:
		return float64(x)
	case []Value:
		out := make([]Value, len(x))
		for i, e := range x {
			out[i] = NormalizeValue(e)
		}
		return out
	case map[string]Value:
		out := make(map[string]Value, len(x))
		for k, e := range x {
			out[k] = NormalizeValue(e)
		}
		return out
	}
	return v
}
