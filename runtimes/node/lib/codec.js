'use strict';
// GoMP Value codec (see wire/proto/value.go). Shared by the IPC link with the
// core and, in phase 2, by the in-game client scripts.

const TAG_NIL = 0;
const TAG_FALSE = 1;
const TAG_TRUE = 2;
const TAG_INT = 3;
const TAG_FLOAT = 4;
const TAG_STRING = 5;
const TAG_ARRAY = 6;
const TAG_MAP = 7;
const TAG_VEC3 = 8;
const TAG_ENTITY = 9;

const MAX_DEPTH = 32;
const TWO32 = 4294967296;

class Writer {
  constructor(size = 1024) {
    this.buf = Buffer.allocUnsafe(size);
    this.off = 0;
  }

  ensure(n) {
    if (this.off + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.off + n) size *= 2;
    const nb = Buffer.allocUnsafe(size);
    this.buf.copy(nb, 0, 0, this.off);
    this.buf = nb;
  }

  u8(v) {
    this.ensure(1);
    this.buf[this.off++] = v;
  }

  u16(v) {
    this.ensure(2);
    this.buf.writeUInt16LE(v, this.off);
    this.off += 2;
  }

  u32(v) {
    this.ensure(4);
    this.buf.writeUInt32LE(v >>> 0, this.off);
    this.off += 4;
  }

  f32(v) {
    this.ensure(4);
    this.buf.writeFloatLE(v, this.off);
    this.off += 4;
  }

  f64(v) {
    this.ensure(8);
    this.buf.writeDoubleLE(v, this.off);
    this.off += 8;
  }

  // Unsigned LEB128 for non-negative safe integers or BigInt.
  uvarint(v) {
    if (typeof v === 'bigint') {
      this.ensure(10);
      do {
        let b = Number(v & 0x7fn);
        v >>= 7n;
        if (v !== 0n) b |= 0x80;
        this.buf[this.off++] = b;
      } while (v !== 0n);
      return;
    }
    this.ensure(10);
    while (v >= 0x80) {
      this.buf[this.off++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.off++] = v;
  }

  // Zigzag varint (int64 semantics, safe-integer range as numbers).
  varint(v) {
    if (typeof v === 'bigint') {
      const z = v >= 0n ? v << 1n : ((-v) << 1n) - 1n;
      this.uvarint(z);
      return;
    }
    this.uvarint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  string(s) {
    const len = Buffer.byteLength(s, 'utf8');
    this.uvarint(len);
    this.ensure(len);
    this.buf.write(s, this.off, len, 'utf8');
    this.off += len;
  }

  bytes() {
    return this.buf.subarray(0, this.off);
  }
}

/**
 * Encodes a JS value. hooks.entityRef(v) may return {type, id} for entity
 * objects; hooks.isVector3(v) recognises vectors.
 */
function encodeValue(w, v, hooks, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('value nesting too deep');
  if (v === null || v === undefined) return w.u8(TAG_NIL);
  switch (typeof v) {
    case 'boolean':
      return w.u8(v ? TAG_TRUE : TAG_FALSE);
    case 'number':
      if (Number.isSafeInteger(v)) {
        w.u8(TAG_INT);
        return w.varint(v);
      }
      w.u8(TAG_FLOAT);
      return w.f64(v);
    case 'bigint':
      w.u8(TAG_INT);
      return w.varint(v);
    case 'string':
      w.u8(TAG_STRING);
      return w.string(v);
    case 'function':
    case 'symbol':
      return w.u8(TAG_NIL);
    default:
      break;
  }
  if (Array.isArray(v)) {
    w.u8(TAG_ARRAY);
    w.uvarint(v.length);
    for (const e of v) encodeValue(w, e, hooks, depth + 1);
    return undefined;
  }
  if (hooks) {
    const ref = hooks.entityRef ? hooks.entityRef(v) : null;
    if (ref) {
      w.u8(TAG_ENTITY);
      w.u8(ref.type);
      return w.u16(ref.id);
    }
    if (hooks.isVector3 && hooks.isVector3(v)) {
      w.u8(TAG_VEC3);
      w.f32(v.x);
      w.f32(v.y);
      return w.f32(v.z);
    }
  }
  if (v instanceof Map) v = Object.fromEntries(v);
  if (Buffer.isBuffer(v) || ArrayBuffer.isView(v)) v = Array.from(v);
  if (v instanceof Date) {
    w.u8(TAG_FLOAT);
    return w.f64(v.getTime());
  }
  if (typeof v.toJSON === 'function') v = v.toJSON();
  if (v === null || typeof v !== 'object') return encodeValue(w, v, hooks, depth);
  const keys = Object.keys(v);
  w.u8(TAG_MAP);
  w.uvarint(keys.length);
  for (const k of keys) {
    w.string(k);
    encodeValue(w, v[k], hooks, depth + 1);
  }
  return undefined;
}

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.off = 0;
  }

  need(n) {
    if (this.off + n > this.buf.length) throw new Error('short buffer');
  }

  u8() {
    this.need(1);
    return this.buf[this.off++];
  }

  u16() {
    this.need(2);
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }

  f32() {
    this.need(4);
    const v = this.buf.readFloatLE(this.off);
    this.off += 4;
    return v;
  }

  f64() {
    this.need(8);
    const v = this.buf.readDoubleLE(this.off);
    this.off += 8;
    return v;
  }

  uvarint() {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      const b = this.u8();
      result += (b & 0x7f) * mul;
      if ((b & 0x80) === 0) return result;
      mul *= 128;
    }
    throw new Error('malformed varint');
  }

  varint() {
    const z = this.uvarint();
    // Zigzag decode for values within the safe-integer range.
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  string() {
    const n = this.uvarint();
    this.need(n);
    const s = this.buf.toString('utf8', this.off, this.off + n);
    this.off += n;
    return s;
  }
}

/**
 * Decodes a value. hooks.vector3(x, y, z) and hooks.entity(type, id) build
 * host objects for the special tags.
 */
function decodeValue(r, hooks, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('value nesting too deep');
  const tag = r.u8();
  switch (tag) {
    case TAG_NIL:
      return null;
    case TAG_FALSE:
      return false;
    case TAG_TRUE:
      return true;
    case TAG_INT:
      return r.varint();
    case TAG_FLOAT:
      return r.f64();
    case TAG_STRING:
      return r.string();
    case TAG_ARRAY: {
      const n = r.uvarint();
      if (n > r.buf.length - r.off) throw new Error('array length exceeds buffer');
      const arr = new Array(n);
      for (let i = 0; i < n; i++) arr[i] = decodeValue(r, hooks, depth + 1);
      return arr;
    }
    case TAG_MAP: {
      const n = r.uvarint();
      if (n > r.buf.length - r.off) throw new Error('map length exceeds buffer');
      const obj = {};
      for (let i = 0; i < n; i++) {
        const k = r.string();
        obj[k] = decodeValue(r, hooks, depth + 1);
      }
      return obj;
    }
    case TAG_VEC3: {
      const x = r.f32();
      const y = r.f32();
      const z = r.f32();
      return hooks && hooks.vector3 ? hooks.vector3(x, y, z) : { x, y, z };
    }
    case TAG_ENTITY: {
      const type = r.u8();
      const id = r.u16();
      return hooks && hooks.entity ? hooks.entity(type, id) : { type, id, __entity: true };
    }
    default:
      throw new Error(`unknown value tag ${tag}`);
  }
}

function encode(value, hooks) {
  const w = new Writer();
  encodeValue(w, value, hooks);
  return Buffer.from(w.bytes());
}

function decode(buf, hooks) {
  const r = new Reader(buf);
  const v = decodeValue(r, hooks);
  if (r.off !== buf.length) throw new Error(`${buf.length - r.off} trailing bytes`);
  return v;
}

/** Frames a value as uint32 length + payload. */
function frame(value, hooks) {
  const w = new Writer();
  w.u32(0);
  encodeValue(w, value, hooks);
  const b = w.bytes();
  b.writeUInt32LE(b.length - 4, 0);
  return Buffer.from(b);
}

module.exports = { encode, decode, frame, Writer, Reader, encodeValue, decodeValue, TWO32 };
