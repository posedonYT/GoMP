'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Runtime, Ref } = require('../lib/runtime');
const { Vector3 } = require('../lib/vector3');
const { joaat } = require('../lib/joaat');
const { EntityType, Prop } = require('../lib/constants');

const quietLog = { log() {}, warn() {}, error() {} };

function makeRuntime(packagesDir, log = quietLog) {
  const sent = [];
  const link = { send: (op) => sent.push(op), flush() {} };
  const rt = new Runtime(link, { packagesDir, log });
  rt.handle(['hello', 1, { maxplayers: 100, name: 'Test' }, {
    maxPlayers: 100, streamDistance: 300, ranges: { 2: [0, 8000], 3: [0, 32000], 4: [0, 2000], 5: [0, 4000], 6: [0, 2000], 7: [0, 4000], 8: [0, 16000], 9: [0, 8000], 10: [0, 8000] },
    weather: 'CLEAR', time: [10, 30, 0],
  }]);
  return { rt, sent, mp: rt.mp };
}

function addPlayer(rt, id, name, extra = {}) {
  rt.handle(['create', EntityType.player, id, 3, {
    name, pos: new Vector3(id * 10, 0, 70), dim: 0, health: 100, armour: 0, weapon: joaat('weapon_unarmed'),
    weapons: {}, veh: -1, seat: 0, ip: '127.0.0.1', serial: `s${id}`, sc: name, spawned: true, ...extra,
  }]);
  return rt.mp.players.at(id);
}

function lastOf(sent, name) {
  for (let i = sent.length - 1; i >= 0; i--) if (sent[i][0] === name) return sent[i];
  return undefined;
}

test('hello populates mp.config and world', () => {
  const { mp } = makeRuntime();
  assert.equal(mp.config.maxplayers, 100);
  assert.equal(mp.config.name, 'Test');
  assert.equal(mp.world.weather, 'CLEAR');
  assert.equal(mp.world.time.hour, 10);
  assert.equal(mp.players.size, 100);
});

test('events subscribe once and dispatch with entity objects', () => {
  const { rt, sent, mp } = makeRuntime();
  const joins = [];
  mp.events.add('playerJoin', (p) => joins.push(p));
  mp.events.add('playerJoin', () => joins.push('second'));
  assert.deepEqual(sent.filter((o) => o[0] === 'sub'), [['sub', ['playerJoin']]]);
  const p = addPlayer(rt, 4, 'Alice');
  rt.handle(['event', 'playerJoin', [new Ref(EntityType.player, 4)]]);
  assert.equal(joins[0], p);
  assert.equal(joins[1], 'second');
  assert.ok(p instanceof mp.Player);
  assert.equal(p.type, 'player');
});

test('a throwing handler does not stop the others', () => {
  const errors = [];
  const { rt, mp } = makeRuntime(undefined, { ...quietLog, error: (...a) => errors.push(a) });
  let ran = false;
  mp.events.add('playerReady', () => {
    throw new Error('boom');
  });
  mp.events.add('playerReady', () => {
    ran = true;
  });
  addPlayer(rt, 0, 'A');
  rt.handle(['event', 'playerReady', [new Ref(1, 0)]]);
  assert.ok(ran);
  assert.equal(errors.length, 1);
});

test('commands parse arguments; unknown commands reach playerCommand', () => {
  const { rt, sent, mp } = makeRuntime();
  const calls = [];
  mp.events.addCommand('veh', (player, fullText, model, color) => calls.push([player.name, fullText, model, color]));
  mp.events.addCommand({ hp: (player) => calls.push(['hp', player.name]) });
  const unknown = [];
  mp.events.add('playerCommand', (player, cmd) => unknown.push(cmd));
  assert.ok(sent.some((o) => o[0] === 'sub' && o[1].includes('playerCommand')));
  addPlayer(rt, 1, 'Bob');
  rt.handle(['event', 'playerCommand', [new Ref(1, 1), 'veh  adder   12']]);
  rt.handle(['event', 'playerCommand', [new Ref(1, 1), 'hp']]);
  rt.handle(['event', 'playerCommand', [new Ref(1, 1), 'fly high']]);
  assert.deepEqual(calls, [['Bob', 'adder   12', 'adder', '12'], ['hp', 'Bob']]);
  assert.deepEqual(unknown, ['fly high']);
});

test('player getters read the mirror; setters queue commands', () => {
  const { rt, sent, mp } = makeRuntime();
  const p = addPlayer(rt, 2, 'Carl');
  assert.equal(p.name, 'Carl');
  assert.equal(p.health, 100);
  assert.equal(p.vehicle, null);
  assert.equal(p.seat, -1);
  const pos = p.position;
  assert.ok(pos instanceof Vector3);
  pos.z = 1000; // a copy: mutating it must not move the player
  assert.equal(p.position.z, 70);

  p.health = 55.4;
  assert.equal(p.health, 55);
  assert.deepEqual(lastOf(sent, 'set'), ['set', 1, 2, 3, 'health', 55]);
  p.position = new mp.Vector3(1, 2, 3);
  assert.deepEqual(p.position.toArray(), [1, 2, 3]);
  p.dimension = 5;
  assert.equal(lastOf(sent, 'set')[4], 'dim');

  // Core updates (sync) are merged into the mirror.
  rt.handle(['update', 1, 2, { pos: new Vector3(9, 9, 9), flags: 1, props: { 22: 4 }, shared: { job: 'cop' } }]);
  assert.deepEqual(p.position.toArray(), [9, 9, 9]);
  assert.equal(p.isAiming, true);
  assert.equal(p.eyeColor, 4);
  assert.equal(p.getVariable('job'), 'cop');
  rt.handle(['update', 1, 2, { shared: { job: null } }]);
  assert.equal(p.getVariable('job'), null);
});

test('methods send calls with RAGE argument handling', () => {
  const { rt, sent, mp } = makeRuntime();
  const p = addPlayer(rt, 3, 'Dan');
  p.giveWeapon('weapon_pistol', 100);
  assert.deepEqual(lastOf(sent, 'call'), ['call', 1, 3, 3, 'giveWeapon', [joaat('weapon_pistol'), 100]]);
  assert.equal(p.getWeaponAmmo('WEAPON_PISTOL'), 100);
  assert.equal(p.weapon, joaat('weapon_pistol'));
  p.giveWeapon([joaat('weapon_knife'), 'weapon_bat'], 1);
  assert.deepEqual(lastOf(sent, 'call')[5][0], [joaat('weapon_knife'), joaat('weapon_bat')]);
  p.call('client:hello', [1, 'x', new mp.Vector3(1, 2, 3)]);
  assert.equal(lastOf(sent, 'call')[4], 'call');
  p.outputChatBox('hi');
  p.spawn(new mp.Vector3(1, 1, 1), 90);
  assert.deepEqual(lastOf(sent, 'call').slice(4), ['spawn', [new Vector3(1, 1, 1), 90]]);
  p.setClothes(11, 15, 0, 2);
  assert.deepEqual(p.getClothes(11), { drawable: 15, texture: 0, palette: 2 });
  p.setHeadBlend(1, 2, 3, 4, 5, 6, 0.5, 0.5, 0);
  assert.deepEqual(p.getHeadBlend().shapes, [1, 2, 3]);
  p.kick('bye');
  assert.deepEqual(lastOf(sent, 'call').slice(4), ['kick', ['bye']]);
});

test('setVariable, data proxy and own variables', () => {
  const { rt, sent, mp } = makeRuntime();
  const p = addPlayer(rt, 5, 'Eve');
  p.setVariable('money', 500);
  assert.equal(p.getVariable('money'), 500);
  assert.deepEqual(lastOf(sent, 'call').slice(4), ['setVariables', [{ money: 500 }]]);
  p.data.level = 3;
  assert.equal(p.data.level, 3);
  assert.equal(p.getVariable('level'), 3);
  assert.ok('level' in p.data);
  assert.deepEqual(Object.keys(p.data).sort(), ['level', 'money']);
  delete p.data.level;
  assert.equal(p.getVariable('level'), null);
  p.setOwnVariable('secret', 'x');
  assert.equal(p.getOwnVariable('secret'), 'x');
  assert.deepEqual(lastOf(sent, 'call').slice(4), ['setOwnVariables', [{ secret: 'x' }]]);
  assert.equal(mp.players.at(5).getVariable('missing'), null);
});

test('mp.vehicles.new allocates ids, sends create and fires entityCreated', () => {
  const { rt, sent, mp } = makeRuntime();
  const created = [];
  mp.events.add('entityCreated', (e) => created.push(e));
  const v = mp.vehicles.new('adder', new mp.Vector3(10, 20, 30), {
    heading: 90, numberPlate: 'GOMP-RP-LONG', color: [[255, 0, 0], [0, 0, 255]], locked: true, dimension: 2,
  });
  assert.equal(v.id, 0);
  assert.equal(v.model, joaat('adder'));
  assert.equal(v.numberPlate, 'GOMP-RP-');
  assert.equal(v.locked, true);
  assert.equal(v.dimension, 2);
  assert.deepEqual(v.getColorRGB(1), [0, 0, 255]);
  assert.deepEqual(created, [v]);
  const op = lastOf(sent, 'create');
  assert.equal(op[1], EntityType.vehicle);
  assert.equal(op[2], 0);
  assert.equal(op[3].model, joaat('adder'));
  assert.equal(op[3].props[Prop.numberPlate], 'GOMP-RP-');
  assert.ok(mp.vehicles.exists(v));
  assert.ok(v instanceof mp.Vehicle);

  const v2 = mp.vehicles.new(joaat('sultan'), new mp.Vector3(0, 0, 0));
  assert.equal(v2.id, 1);
  v.destroy();
  assert.ok(!mp.vehicles.exists(v));
  assert.deepEqual(lastOf(sent, 'destroy'), ['destroy', 2, 0, 0]);
  const v3 = mp.vehicles.new('banshee', new mp.Vector3(0, 0, 0));
  assert.equal(v3.id, 0, 'freed id is reused');
  // The core echoes our destroy; it must not remove the new vehicle with the same id.
  rt.handle(['destroy', 2, 0, 0]);
  assert.ok(mp.vehicles.exists(v3));
  assert.throws(() => {
    v.engine = true;
  }, /does not exist/);
});

test('vehicle occupants and pools', () => {
  const { rt, mp } = makeRuntime();
  const v = mp.vehicles.new('kuruma', new mp.Vector3(0, 0, 0));
  const a = addPlayer(rt, 0, 'A');
  const b = addPlayer(rt, 1, 'B');
  rt.handle(['update', 1, 0, { veh: v.id, seat: 0 }]);
  rt.handle(['update', 1, 1, { veh: v.id, seat: 2 }]);
  assert.equal(a.vehicle, v);
  assert.deepEqual(v.getOccupants(), [a, b]);
  assert.equal(v.getOccupant(2), b);
  assert.equal(mp.players.length, 2);
  const near = [];
  mp.players.forEachInRange(new mp.Vector3(0, 0, 70), 5, (p) => near.push(p.name));
  assert.deepEqual(near, ['A']);
  assert.equal(mp.players.getClosest(new mp.Vector3(9, 0, 70)), b);
  assert.deepEqual(mp.players.getClosest(new mp.Vector3(0, 0, 70), 2), [a, b]);
  assert.deepEqual([...mp.players].map((p) => p.name), ['A', 'B']);
  assert.deepEqual(a.streamedPlayers, [b]);
});

test('players broadcast and targeted calls', () => {
  const { rt, sent, mp } = makeRuntime();
  addPlayer(rt, 0, 'A');
  addPlayer(rt, 1, 'B');
  mp.players.broadcast('hello');
  assert.deepEqual(lastOf(sent, 'global'), ['global', 'broadcast', ['hello']]);
  mp.players.call('ev', [1]);
  assert.deepEqual(lastOf(sent, 'global'), ['global', 'callClients', [null, 'ev', [1], false]]);
  mp.players.call([mp.players.at(1)], 'ev2', []);
  assert.deepEqual(lastOf(sent, 'global')[2][0], [1]);
  mp.players.callInRange(new mp.Vector3(0, 0, 70), 5, 'near', []);
  assert.deepEqual(lastOf(sent, 'global')[2][0], [0]);
});

test('colshapes compute isPointWithin locally', () => {
  const { mp } = makeRuntime();
  const c = mp.colshapes.newSphere(0, 0, 0, 5);
  assert.equal(c.shapeType, 'sphere');
  assert.ok(c.isPointWithin(new mp.Vector3(3, 4, 0)));
  assert.ok(!c.isPointWithin(new mp.Vector3(3, 4, 1)));
  const r = mp.colshapes.newRectangle(10, 10, 4, 2);
  assert.ok(r.isPointWithin(new mp.Vector3(12, 11, 500)));
  const tube = mp.colshapes.newTube(0, 0, 10, 3, 2);
  assert.ok(tube.isPointWithin(new mp.Vector3(1, 1, 12)));
  assert.ok(!tube.isPointWithin(new mp.Vector3(1, 1, 9)));
});

test('blips, markers, labels and checkpoints map options to props', () => {
  const { sent, mp } = makeRuntime();
  const b = mp.blips.new(1, new mp.Vector3(1, 2, 3), { name: 'Shop', color: 2, shortRange: true });
  assert.equal(b.name, 'Shop');
  b.color = 5;
  assert.deepEqual(lastOf(sent, 'set').slice(4), ['props', { [Prop.blipColor]: 5 }]);
  assert.equal(b.color, 5);
  const m = mp.markers.new(1, new mp.Vector3(0, 0, 0), 2, { color: [255, 0, 0, 100] });
  assert.deepEqual(m.getColor(), [255, 0, 0, 100]);
  const l = mp.labels.new('Hello', new mp.Vector3(0, 0, 0), { los: true, drawDistance: 15 });
  assert.equal(l.text, 'Hello');
  assert.equal(l.los, true);
  const cp = mp.checkpoints.new(1, new mp.Vector3(0, 0, 0), 4, { color: [0, 255, 0, 255] });
  assert.equal(cp.radius, 4);
});

test('procedures: addProc answers, callProc resolves', async () => {
  const { rt, sent, mp } = makeRuntime();
  const p = addPlayer(rt, 0, 'A');
  mp.events.addProc('getMoney', async (player, extra) => player.name.length * 100 + extra);
  assert.ok(sent.some((o) => o[0] === 'sub' && o[1].includes('proc:getMoney')));
  rt.handle(['procReq', 9, new Ref(1, 0), 'getMoney', [5]]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lastOf(sent, 'procRes'), ['procRes', 9, true, 105]);
  rt.handle(['procReq', 10, new Ref(1, 0), 'nope', []]);
  assert.equal(lastOf(sent, 'procRes')[2], false);

  const pr = p.callProc('client:getFps', [1]);
  assert.ok(p.hasPendingProc('client:getFps'));
  const op = lastOf(sent, 'procCall');
  assert.deepEqual(op.slice(2), [0, 3, 'client:getFps', [1]]);
  rt.handle(['procRes', op[1], true, 60]);
  assert.equal(await pr, 60);
  const failing = p.callProc('x');
  rt.handle(['procRes', lastOf(sent, 'procCall')[1], false, 'timeout']);
  await assert.rejects(failing, /timeout/);
});

test('ping is answered immediately', () => {
  const { rt, sent } = makeRuntime();
  rt.handle(['ping', 7]);
  assert.deepEqual(lastOf(sent, 'pong'), ['pong', 7]);
});

test('prototype extensions work on mirrored entities', () => {
  const { rt, mp } = makeRuntime();
  mp.Player.prototype.greet = function greet() {
    return `hi ${this.name}`;
  };
  try {
    assert.equal(addPlayer(rt, 0, 'Zed').greet(), 'hi Zed');
  } finally {
    delete mp.Player.prototype.greet;
  }
});

test('mp.Vector3 math matches RAGE semantics', () => {
  const { mp } = makeRuntime();
  const a = new mp.Vector3(1, 2, 3);
  const b = new mp.Vector3([4, 5, 6]);
  assert.deepEqual(a.add(b).toArray(), [5, 7, 9]);
  assert.deepEqual(a.add(1).toArray(), [2, 3, 4]);
  assert.deepEqual(b.subtract(a).toArray(), [3, 3, 3]);
  assert.deepEqual(a.multiply(2).toArray(), [2, 4, 6]);
  assert.deepEqual(b.divide(2).toArray(), [2, 2.5, 3]);
  assert.equal(a.dot(b), 32);
  assert.deepEqual(a.cross(b).toArray(), [-3, 6, -3]);
  assert.equal(new mp.Vector3(3, 4, 0).length(), 5);
  assert.deepEqual(new mp.Vector3(0, 0, 2).unit().toArray(), [0, 0, 1]);
  assert.ok(a.equals(a.clone()));
  assert.equal(a.max(), 3);
  assert.equal(a.min(), 1);
  assert.deepEqual(a.negative().toArray(), [-1, -2, -3]);
  assert.equal(mp.joaat('adder'), 0xb779a091);
  assert.deepEqual(mp.joaat(['adder', 'ADDER']), [0xb779a091, 0xb779a091]);
});

test('packages load in order; delayInitialization defers "loaded"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gomp-pkgs-'));
  for (const [name, code] of Object.entries({
    b_second: "global.__order.push('b'); mp.events.add('packagesLoaded', () => global.__order.push('loaded'));",
    a_first: "global.__order.push('a'); mp.events.delayInitialization = true; setTimeout(() => { mp.events.delayInitialization = false; }, 30);",
    c_broken: "throw new Error('broken package');",
  })) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'index.js'), code);
  }
  global.__order = [];
  const { rt, sent } = makeRuntime(dir);
  rt.handle(['ready']);
  assert.deepEqual(global.__order, ['a', 'b']);
  assert.ok(!sent.some((o) => o[0] === 'loaded'), 'loaded must wait for delayInitialization');
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(global.__order, ['a', 'b', 'loaded']);
  assert.deepEqual(lastOf(sent, 'loaded'), ['loaded', 2]);
  delete global.__order;
});

test('serverShutdown honours delayShutdown', async () => {
  const { rt, sent, mp } = makeRuntime();
  mp.events.add('serverShutdown', () => {
    mp.events.delayShutdown = true;
    setTimeout(() => {
      mp.events.delayShutdown = false;
    }, 30);
  });
  rt.handle(['shutdown']);
  assert.ok(!sent.some((o) => o[0] === 'shutdownReady'));
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(sent.some((o) => o[0] === 'shutdownReady'));
});
