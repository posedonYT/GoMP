'use strict';
// The runtime under load: compact position updates, backpressure on the link,
// large frames arriving in pieces, entity state cleaned up after core removals.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Runtime } = require('../lib/runtime');
const { IpcLink } = require('../lib/ipc');
const { frame, decode } = require('../lib/codec');
const { Vector3 } = require('../lib/vector3');
const { EntityType } = require('../lib/constants');

const quietLog = { log() {}, warn() {}, error() {} };

function makeRuntime() {
  const sent = [];
  const rt = new Runtime({ send: (op) => sent.push(op), flush() {} }, { log: quietLog });
  rt.handle(['hello', 1, {}, { maxPlayers: 100, ranges: { 2: [0, 8000] } }]);
  return { rt, sent, mp: rt.mp };
}

test('compact updates move players and vehicles', () => {
  const { rt, mp } = makeRuntime();
  rt.handle(['create', EntityType.player, 3, 1, { name: 'A', pos: new Vector3(0, 0, 0), dim: 0 }]);
  rt.handle(['create', EntityType.vehicle, 7, 1, { model: 1, pos: new Vector3(0, 0, 0), rot: new Vector3(0, 0, 0), dim: 0 }]);
  rt.handle(['updates', [
    EntityType.player, 3, new Vector3(1, 2, 3), new Vector3(0.5, 0, 0), new Vector3(90, 0, 0), 4, 2, new Vector3(9, 9, 9),
    EntityType.vehicle, 7, new Vector3(10, 20, 30), new Vector3(1, 1, 0), new Vector3(0, 0, 45), 1, 0.25, null,
    EntityType.player, 99, new Vector3(5, 5, 5), new Vector3(0, 0, 0), new Vector3(0, 0, 0), 0, 0, null, // unknown: skipped
  ]]);
  const p = mp.players.at(3);
  assert.deepEqual([p.position.x, p.position.y, p.position.z], [1, 2, 3]);
  assert.equal(p.heading, 90);
  assert.equal(p.velocity.x, 0.5);
  const v = mp.vehicles.at(7);
  assert.deepEqual([v.position.x, v.position.y, v.position.z], [10, 20, 30]);
  assert.equal(v.rotation.z, 45);
  assert.equal(v.heading, 45);
});

test('a malformed updates op does not throw', () => {
  const { rt } = makeRuntime();
  rt.handle(['updates', [EntityType.player, 1, 2]]);  // shorter than one record
  rt.handle(['updates']);
});

test('entities removed by the core reach entityDestroyed', () => {
  const { rt, mp } = makeRuntime();
  const gone = [];
  mp.events.add('entityDestroyed', (e) => gone.push(e.id));
  rt.handle(['create', EntityType.vehicle, 5, 1, { model: 1, pos: new Vector3(0, 0, 0), dim: 0 }]);
  rt.handle(['destroy', EntityType.vehicle, 5, 1]);
  assert.deepEqual(gone, [5]);
  assert.equal(mp.vehicles.at(5), undefined);
});

test('range and dimension filters visit only matches, closest without sorting all', () => {
  const { rt, mp } = makeRuntime();
  for (let i = 0; i < 50; i++) {
    rt.handle(['create', EntityType.vehicle, i, 1, { model: 1, pos: new Vector3(i * 10, 0, 0), dim: i % 2 }]);
  }
  const near = [];
  mp.vehicles.forEachInRange(new Vector3(0, 0, 0), 55, (v) => near.push(v.id));
  assert.deepEqual(near.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  const odd = [];
  mp.vehicles.forEachInDimension(1, (v) => odd.push(v.id));
  assert.equal(odd.length, 25);
  assert.equal(mp.vehicles.getClosest(new Vector3(201, 0, 0)).id, 20);
  assert.deepEqual(mp.vehicles.getClosest(new Vector3(201, 0, 0), 3).map((v) => v.id), [20, 21, 19]);
  // A callback may destroy entities while a filter runs.
  mp.vehicles.forEachInRange(new Vector3(0, 0, 0), 1000, (v) => { if (v.id % 5 === 0) v.destroy(); });
  assert.equal(mp.vehicles.length, 40);
});

// A socket stand-in: write() reports a full buffer until drain is emitted.
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.frames = [];
    this.full = false;
  }
  write(buf) {
    this.frames.push(buf);
    return !this.full;
  }
  destroy(err) {
    this.destroyed = err;
  }
}

test('the link stops writing while the socket is full and sends the backlog as one frame on drain', async () => {
  const link = new IpcLink({ network: 'tcp', addr: '127.0.0.1:1', token: 't', name: 'n' });
  const sock = new FakeSocket();
  link.sock = sock;
  sock.on('drain', () => { link.blocked = false; link.flush(); });
  sock.full = true;
  link.send(['a']);
  link.flush();
  assert.equal(sock.frames.length, 1);
  assert.equal(link.blocked, true);
  for (let i = 0; i < 100; i++) link.send(['b', i]);
  link.flush();
  await new Promise((r) => setImmediate(r));
  assert.equal(sock.frames.length, 1, 'nothing written while full');
  assert.equal(link.queued, 100);
  sock.full = false;
  sock.emit('drain');
  assert.equal(sock.frames.length, 2);
  const ops = decode(sock.frames[1].subarray(4));
  assert.equal(ops.length, 100);
  assert.equal(link.queued, 0);
});

test('a large frame arriving in small pieces is decoded once, and frames split anywhere', () => {
  const link = new IpcLink({ network: 'tcp', addr: '127.0.0.1:1', token: 't', name: 'n' });
  link.sock = new FakeSocket();
  const got = [];
  link.onOps = (ops) => got.push(ops);
  const big = [['x', 'y'.repeat(2 * 1024 * 1024)]];
  const small = [['ping', 1]];
  const bytes = Buffer.concat([frame(big), frame(small), frame(small)]);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < bytes.length; i += 1000) link._onData(bytes.subarray(i, Math.min(i + 1000, bytes.length)));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(got.length, 3);
  assert.equal(got[0][0][1].length, 2 * 1024 * 1024);
  assert.deepEqual(got[1], small);
  // Joining on every piece took seconds for 2 MiB in 1 KB pieces; once per frame is fast.
  assert.ok(ms < 1000, `took ${ms} ms`);
  // A header split across pieces.
  const one = frame(small);
  link._onData(one.subarray(0, 2));
  link._onData(one.subarray(2));
  assert.equal(got.length, 4);
});

test('an oversized frame closes the link', () => {
  const link = new IpcLink({ network: 'tcp', addr: '127.0.0.1:1', token: 't', name: 'n' });
  link.sock = new FakeSocket();
  const head = Buffer.alloc(4);
  head.writeUInt32LE(100 * 1024 * 1024);
  link._onData(head);
  assert.ok(link.sock.destroyed);
});
