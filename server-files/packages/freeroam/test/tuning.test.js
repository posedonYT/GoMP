const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fakemp');
require('../index');
const roleplay = require('../roleplay');
const vehicles = require('../vehicles');
const tuning = require('../tuning');

const shop = tuning.SHOPS[0];

// A character in their own vehicle inside the first tuning shop.
function inShop(model = 'sultan') {
  const p = fake.login(fake.join());
  p.position = new mp.Vector3(shop.x, shop.y, shop.z);
  const veh = vehicles.spawnFor(p, model);
  return { p, veh, ch: roleplay.character(p) };
}

test('orders are validated', () => {
  assert.ok(tuning.validate(null).error);
  assert.ok(tuning.validate({ mods: { 99: 0 } }).error);
  assert.ok(tuning.validate({ mods: { 11: 999 } }).error);
  assert.ok(tuning.validate({ primary: 500 }).error);
  assert.ok(tuning.validate({ neon: [true, 300, 0, 0] }).error);
  const ok = tuning.validate({ mods: { 11: 3, 18: 5 }, primary: 27, neon: [1, 255, 0, 0] });
  assert.deepStrictEqual(ok.order, { mods: { 11: 3, 18: 0 }, primary: 27, neon: [true, 255, 0, 0] });
});

test('prices: levels cost more, stock is free, unchanged parts cost nothing', () => {
  assert.strictEqual(tuning.modPrice(11, 0), 6000);
  assert.strictEqual(tuning.modPrice(11, 2), 12000);
  assert.strictEqual(tuning.modPrice(30, 1), 1050);
  assert.strictEqual(tuning.modPrice(11, -1), 0);
  assert.strictEqual(tuning.modPrice(18, 0), 15000);
  const state = { mods: { 11: 2 }, primary: 27, secondary: 0, neon: [false, 255, 255, 255] };
  assert.strictEqual(tuning.priceOf(state, { mods: { 11: 2 }, primary: 27 }), 0);
  assert.strictEqual(tuning.priceOf(state, { mods: { 11: 3, 12: 0 }, primary: 28 }), 15000 + 3000 + 1000);
  assert.strictEqual(tuning.priceOf(state, { neon: [true, 255, 0, 0] }), 3500);
  assert.strictEqual(tuning.priceOf({ ...state, neon: [true, 255, 0, 0] }, { neon: [false, 255, 0, 0] }), 0);
});

test('a purchase in the shop charges, applies and is saved for the model', () => {
  const { p, veh, ch } = inShop();
  roleplay.setMoney(p, 50000, 0);
  const cash = ch.cash;
  fake.emit('gomp:tune:buy', p, veh.id, { mods: { 11: 0, 22: 0 }, primary: 27 }, 'cash');
  assert.strictEqual(veh.getMod(11), 0);
  assert.strictEqual(veh.getMod(22), 0);
  assert.strictEqual(veh.getColor(0), 27);
  assert.strictEqual(ch.cash, cash - (6000 + 2500 + 1000));
  assert.deepStrictEqual(ch.tuning[String(veh.model)].mods, { 11: 0, 22: 0 });

  // The next vehicle of that model comes tuned.
  fake.command(p, '/veh sultan');
  const again = p.vehicle;
  assert.notStrictEqual(again, veh);
  assert.strictEqual(again.getMod(11), 0);
  assert.strictEqual(again.getColor(0), 27);
});

test('no tuning outside a shop, of strangers\' vehicles or without money', () => {
  const { p, veh, ch } = inShop('adder');
  veh.position = new mp.Vector3(0, 0, 0);
  fake.emit('gomp:tune:buy', p, veh.id, { mods: { 11: 0 } }, 'cash');
  assert.strictEqual(veh.getMod(11), -1, 'outside the shop');
  veh.position = new mp.Vector3(shop.x, shop.y, shop.z);

  veh.setVariable('owner', 99999);
  fake.emit('gomp:tune:buy', p, veh.id, { mods: { 11: 0 } }, 'cash');
  assert.strictEqual(veh.getMod(11), -1, 'not the owner');
  veh.setVariable('owner', p.getVariable('static'));

  roleplay.setMoney(p, 100, 0);
  fake.emit('gomp:tune:buy', p, veh.id, { mods: { 11: 0 } }, 'cash');
  assert.strictEqual(veh.getMod(11), -1, 'no money');
  assert.strictEqual(ch.cash, 100);

  p.vehicle = null;
  roleplay.setMoney(p, 100000, 0);
  fake.emit('gomp:tune:buy', p, veh.id, { mods: { 11: 0 } }, 'cash');
  assert.strictEqual(veh.getMod(11), -1, 'not the driver');
});

test('going back to stock parts is free', () => {
  const { p, veh, ch } = inShop('banshee');
  roleplay.setMoney(p, 50000, 0);
  fake.emit('gomp:tune:buy', p, veh.id, { mods: { 0: 1 } }, 'cash');
  const cash = ch.cash;
  fake.emit('gomp:tune:buy', p, veh.id, { mods: { 0: -1 } }, 'cash');
  assert.strictEqual(veh.getMod(0), -1);
  assert.strictEqual(ch.cash, cash);
});

test('workshops: tuning is offered at the door and done in the bay facing it', () => {
  const places = require('../places').places.filter((p) => p.type === 'tune');
  assert.strictEqual(places.length, tuning.SHOPS.length);
  for (const [i, s] of tuning.SHOPS.entries()) {
    const pl = places[i];
    assert.deepStrictEqual([pl.x, pl.y, pl.z], [s.door.x, s.door.y, s.door.z], 'offered at the door');
    assert.deepStrictEqual(pl.bay.slice(0, 3), [s.x, s.y, s.z], 'the bay goes to the client');
    const doorDist = Math.hypot(s.door.x - s.x, s.door.y - s.y);
    assert.ok(doorDist > 2 && doorDist < 25, `${s.name}: the door is ${doorDist} m from the bay`);
    // The heading points from the bay to the door (GTA: 0 north, 90 west).
    const h = (tuning.bayHeading(s) * Math.PI) / 180;
    const dir = [-Math.sin(h), Math.cos(h)];
    const toDoor = [(s.door.x - s.x) / doorDist, (s.door.y - s.y) / doorDist];
    assert.ok(dir[0] * toDoor[0] + dir[1] * toDoor[1] > 0.99, `${s.name} faces the door`);
  }
  assert.strictEqual(tuning.bayHeading({ x: 0, y: 0, door: { x: 0, y: 10 } }), 0);
  assert.strictEqual(tuning.bayHeading({ x: 0, y: 0, door: { x: -10, y: 0 } }), 90);
});
