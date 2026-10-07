'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { encode, decode, Reader, decodeValue, frame } = require('../lib/codec');
const { Vector3, isVector3 } = require('../lib/vector3');

const hooks = {
  vector3: (x, y, z) => new Vector3(x, y, z),
  entity: (type, id) => ({ ref: true, type, id }),
};

test('round trips JS values', () => {
  const values = [
    null, true, false, 0, -1, 1, 127, 128, -129, 2 ** 40, -(2 ** 52), Number.MAX_SAFE_INTEGER, 1.5, -0.25,
    '', 'строка', 'a'.repeat(1000), [], [1, [2, [3]]], {}, { a: 1, b: { c: 'x' }, d: [true, null] },
  ];
  for (const v of values) {
    assert.deepEqual(decode(encode(v), hooks), v, `value ${JSON.stringify(v)}`);
  }
});

test('vectors and entity refs use the special tags', () => {
  const ent = { _t: 2, _id: 17 };
  const enc = encode([new Vector3(1.5, -2, 3), ent], {
    isVector3,
    entityRef: (v) => (v === ent ? { type: v._t, id: v._id } : null),
  });
  const [v, r] = decode(enc, hooks);
  assert.ok(v instanceof Vector3);
  assert.deepEqual(v.toArray(), [1.5, -2, 3]);
  assert.deepEqual(r, { ref: true, type: 2, id: 17 });
});

test('bigint, undefined, functions and Maps', () => {
  assert.equal(decode(encode(10n ** 15n)), 10 ** 15);
  assert.equal(decode(encode(undefined)), null);
  assert.equal(decode(encode(() => 1)), null);
  assert.deepEqual(decode(encode(new Map([['k', 1]]))), { k: 1 });
});

test('rejects malformed input', () => {
  assert.throws(() => decode(Buffer.from([99])));
  assert.throws(() => decode(Buffer.from([6, 200, 1])));
  assert.throws(() => decode(Buffer.from([5, 10, 65])));
  assert.throws(() => decode(Buffer.concat([encode(1), Buffer.from([0])])));
  const deep = Buffer.concat([Buffer.alloc(80, 0), Buffer.from([0])]);
  for (let i = 0; i < 80; i += 2) {
    deep[i] = 6;
    deep[i + 1] = 1;
  }
  assert.throws(() => decode(deep));
});

test('frames carry a little-endian length prefix', () => {
  const f = frame([['ping', 1]]);
  assert.equal(f.readUInt32LE(0), f.length - 4);
  assert.deepEqual(decode(f.subarray(4)), [['ping', 1]]);
});

// Cross-language check against fixtures produced by the Go encoder
// (go test ./wire/proto -update).
const golden = path.join(__dirname, '..', '..', '..', 'wire', 'proto', 'testdata', 'golden');

test('decodes Go-encoded script event values', { skip: !fs.existsSync(golden) }, () => {
  const buf = fs.readFileSync(path.join(golden, 'script_event.bin'));
  const r = new Reader(buf);
  assert.equal(r.u8(), 0x21); // MsgScriptEvent
  assert.equal(r.string(), 'client:notify');
  const n = r.uvarint();
  const args = [];
  for (let i = 0; i < n; i++) args.push(decodeValue(r, hooks));
  assert.deepEqual(args, ['hi', 42, 1.5, true, false, null]);
  assert.equal(r.off, buf.length);
});

test('decodes Go-encoded shared data with nested values', { skip: !fs.existsSync(golden) }, () => {
  const buf = fs.readFileSync(path.join(golden, 'entity_create.bin'));
  const r = new Reader(buf);
  assert.equal(r.u8(), 0x81); // MsgEntityCreate
  assert.equal(r.u8(), 2); // vehicle
  assert.equal(r.u16(), 17);
  r.off += 4 + 12 + 12; // model, pos, rot
  const nProps = r.uvarint();
  const props = {};
  for (let i = 0; i < nProps; i++) {
    const id = r.u8();
    props[id] = decodeValue(r, hooks);
  }
  assert.deepEqual(props, { 30: [5, 12], 32: 'GOMP', 33: true, 35: 1000 });
  const nShared = r.uvarint();
  const shared = {};
  for (let i = 0; i < nShared; i++) shared[r.string()] = decodeValue(r, hooks);
  assert.equal(shared.owner, 'Alice');
  assert.equal(shared.fuel, 63.5);
  assert.deepEqual(shared.tags, ['rent', 3]);
  assert.ok(shared.meta.pos instanceof Vector3);
  assert.deepEqual(shared.meta.who, { ref: true, type: 1, id: 2 });
  assert.equal(shared.meta.none, null);
});
