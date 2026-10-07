// Package proto describes the GoMP wire protocol: message layouts, the binary
// codec and quantization helpers. It is shared by the server core, the Go bot
// client and serves as the reference for the C++ game client
// (see docs/protocol.md).
//
// All multi-byte integers are little-endian. Variable-length integers use
// unsigned LEB128 (Uvarint) and zigzag for signed values (Varint).
package proto

import (
	"encoding/binary"
	"errors"
	"math"
)

// MaxStringLen bounds every length-prefixed string or byte field.
const MaxStringLen = 1 << 16

var (
	// ErrShortBuffer is returned when a message is truncated.
	ErrShortBuffer = errors.New("proto: short buffer")
	// ErrTooLong is returned when a length prefix exceeds limits.
	ErrTooLong = errors.New("proto: length exceeds limit")
	// ErrBadVarint is returned for malformed varints.
	ErrBadVarint = errors.New("proto: malformed varint")
)

// Writer appends little-endian encoded values to a byte slice.
type Writer struct {
	buf []byte
}

// NewWriter returns a writer that appends to buf[:0].
func NewWriter(buf []byte) *Writer { return &Writer{buf: buf[:0]} }

// Bytes returns the encoded bytes. The slice is reused by subsequent writes.
func (w *Writer) Bytes() []byte { return w.buf }

// Len returns the number of bytes written.
func (w *Writer) Len() int { return len(w.buf) }

// Reset truncates the writer, keeping its capacity.
func (w *Writer) Reset() { w.buf = w.buf[:0] }

func (w *Writer) U8(v uint8)   { w.buf = append(w.buf, v) }
func (w *Writer) I8(v int8)    { w.buf = append(w.buf, uint8(v)) }
func (w *Writer) U16(v uint16) { w.buf = binary.LittleEndian.AppendUint16(w.buf, v) }
func (w *Writer) I16(v int16)  { w.U16(uint16(v)) }
func (w *Writer) U32(v uint32) { w.buf = binary.LittleEndian.AppendUint32(w.buf, v) }
func (w *Writer) I32(v int32)  { w.U32(uint32(v)) }
func (w *Writer) U64(v uint64) { w.buf = binary.LittleEndian.AppendUint64(w.buf, v) }
func (w *Writer) F32(v float32) {
	w.U32(math.Float32bits(v))
}
func (w *Writer) F64(v float64) { w.U64(math.Float64bits(v)) }

func (w *Writer) Bool(v bool) {
	if v {
		w.U8(1)
	} else {
		w.U8(0)
	}
}

// Uvarint writes an unsigned LEB128 integer.
func (w *Writer) Uvarint(v uint64) { w.buf = binary.AppendUvarint(w.buf, v) }

// Varint writes a zigzag-encoded signed integer.
func (w *Writer) Varint(v int64) { w.buf = binary.AppendVarint(w.buf, v) }

// String writes a length-prefixed UTF-8 string.
func (w *Writer) String(s string) {
	w.Uvarint(uint64(len(s)))
	w.buf = append(w.buf, s...)
}

// Blob writes a length-prefixed byte slice.
func (w *Writer) Blob(b []byte) {
	w.Uvarint(uint64(len(b)))
	w.buf = append(w.buf, b...)
}

// Raw appends bytes without a length prefix.
func (w *Writer) Raw(b []byte) { w.buf = append(w.buf, b...) }

// Vec3 writes three float32 components.
func (w *Writer) Vec3(v Vec3) {
	w.F32(v.X)
	w.F32(v.Y)
	w.F32(v.Z)
}

// Reader decodes values written by Writer. Errors are sticky: after the first
// failure every read returns a zero value and Err reports the cause.
type Reader struct {
	buf []byte
	off int
	err error
}

// NewReader returns a reader over b.
func NewReader(b []byte) *Reader { return &Reader{buf: b} }

// Reset points the reader at a new buffer and clears the error.
func (r *Reader) Reset(b []byte) {
	r.buf, r.off, r.err = b, 0, nil
}

// Err returns the first decoding error.
func (r *Reader) Err() error { return r.err }

// Remaining returns the number of unread bytes.
func (r *Reader) Remaining() int { return len(r.buf) - r.off }

// Fail records err if no error has been recorded yet.
func (r *Reader) Fail(err error) {
	if r.err == nil {
		r.err = err
	}
}

func (r *Reader) take(n int) []byte {
	if r.err != nil {
		return nil
	}
	if n < 0 || r.off+n > len(r.buf) {
		r.err = ErrShortBuffer
		return nil
	}
	b := r.buf[r.off : r.off+n]
	r.off += n
	return b
}

func (r *Reader) U8() uint8 {
	b := r.take(1)
	if b == nil {
		return 0
	}
	return b[0]
}

func (r *Reader) I8() int8 { return int8(r.U8()) }

func (r *Reader) U16() uint16 {
	b := r.take(2)
	if b == nil {
		return 0
	}
	return binary.LittleEndian.Uint16(b)
}

func (r *Reader) I16() int16 { return int16(r.U16()) }

func (r *Reader) U32() uint32 {
	b := r.take(4)
	if b == nil {
		return 0
	}
	return binary.LittleEndian.Uint32(b)
}

func (r *Reader) I32() int32 { return int32(r.U32()) }

func (r *Reader) U64() uint64 {
	b := r.take(8)
	if b == nil {
		return 0
	}
	return binary.LittleEndian.Uint64(b)
}

func (r *Reader) F32() float32 { return math.Float32frombits(r.U32()) }
func (r *Reader) F64() float64 { return math.Float64frombits(r.U64()) }

func (r *Reader) Bool() bool { return r.U8() != 0 }

func (r *Reader) Uvarint() uint64 {
	if r.err != nil {
		return 0
	}
	v, n := binary.Uvarint(r.buf[r.off:])
	if n <= 0 {
		r.err = ErrBadVarint
		return 0
	}
	r.off += n
	return v
}

func (r *Reader) Varint() int64 {
	if r.err != nil {
		return 0
	}
	v, n := binary.Varint(r.buf[r.off:])
	if n <= 0 {
		r.err = ErrBadVarint
		return 0
	}
	r.off += n
	return v
}

// Len reads a length prefix and validates it against max and the remaining bytes.
func (r *Reader) Len(max int) int {
	n := r.Uvarint()
	if r.err != nil {
		return 0
	}
	if n > uint64(max) {
		r.err = ErrTooLong
		return 0
	}
	if n > uint64(r.Remaining()) {
		r.err = ErrShortBuffer
		return 0
	}
	return int(n)
}

func (r *Reader) String() string {
	n := r.Len(MaxStringLen)
	b := r.take(n)
	if b == nil {
		return ""
	}
	return string(b)
}

// Blob reads a length-prefixed byte slice. The result aliases the input buffer.
func (r *Reader) Blob() []byte {
	n := r.Len(MaxStringLen)
	return r.take(n)
}

// Rest returns all unread bytes, aliasing the input buffer.
func (r *Reader) Rest() []byte {
	if r.err != nil {
		return nil
	}
	b := r.buf[r.off:]
	r.off = len(r.buf)
	return b
}

func (r *Reader) Vec3() Vec3 {
	return Vec3{r.F32(), r.F32(), r.F32()}
}
