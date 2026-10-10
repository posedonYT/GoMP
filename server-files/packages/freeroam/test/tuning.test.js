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

test('a purchase in the shop charges and applies; it belongs to that vehicle only', () => {
  const { p, veh, ch } = inShop();
  roleplay.setMoney(p, 50000, 0);
  const cash = ch.cash;
  fake.emit('gomp:tune:buy', p, veh.id, { mods: { 11: 0, 22: 0 }, primary: 27 }, 'cash');
  assert.strictEqual(veh.getMod(11), 0);
  assert.strictEqual(veh.getMod(22), 0);
  assert.strictEqual(veh.getColor(0), 27);
  assert.strictEqual(ch.cash, cash - (6000 + 2500 + 1000));

  // Another vehicle of that model is stock (it used to come tuned: the tuning was per model).
  vehicles.spawnFor(p, 'sultan');
  const again = p.vehicle;
  assert.notStrictEqual(again, veh);
  assert.strictEqual(again.getMod(11), -1);
  assert.notStrictEqual(again.getColor(0), 27);
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

// ------------------------------------------------------------------ the look of one car

const cars = require('../cars');
const houses = require('../houses');

test('a bought car is the stock model even when the character tuned others of that model', () => {
  const { p, veh, ch } = inShop('m5');
  roleplay.setMoney(p, 5000000, 5000000);
  fake.emit('gomp:tune:buy', p, veh.id, { mods: { 11: 2, 0: 1 }, primary: 27, neon: [true, 255, 0, 0] }, 'cash');
  assert.strictEqual(veh.getMod(11), 2);
  // Two new BMWs of his own and one of somebody else: stock, in the colour bought.
  const a = cars.spawn(p, ch, cars.grant(ch, 'm5', { color: [111, 111] }).car, new mp.Vector3(10, 0, 0), 0);
  const b = cars.spawn(p, ch, cars.grant(ch, 'm5', { color: [0, 0] }).car, new mp.Vector3(20, 0, 0), 0);
  const other = fake.login(fake.join());
  const och = roleplay.character(other);
  const c = cars.spawn(other, och, cars.grant(och, 'm5', { color: [64, 64] }).car, new mp.Vector3(30, 0, 0), 0);
  for (const [v, color] of [[a, 111], [b, 0], [c, 64]]) {
    assert.strictEqual(v.getMod(11), -1, 'no parts');
    assert.strictEqual(v.getMod(0), -1);
    assert.strictEqual(v.neonEnabled, false, 'no neon');
    assert.strictEqual(v.getColor(0), color);
  }
});

test('a tuned bought car keeps its own look: parked and called again; the other cars stay as they are', () => {
  const p = fake.login(fake.join());
  const ch = roleplay.character(p);
  roleplay.setMoney(p, 5000000, 5000000);
  const first = cars.grant(ch, 'sultan', { color: [111, 111] }).car;
  const second = cars.grant(ch, 'sultan', { color: [0, 0] }).car;
  const veh = cars.spawn(p, ch, first, new mp.Vector3(shop.x, shop.y, shop.z), 0);
  p.position = new mp.Vector3(shop.x, shop.y, shop.z);
  p.putIntoVehicle(veh, 0);
  fake.emit('gomp:tune:buy', p, veh.id, { mods: { 11: 1 }, primary: 27, windowTint: 2 }, 'bank');
  assert.deepStrictEqual([first.look.primary, first.look.mods, first.look.windowTint], [27, { 11: 1 }, 2]);
  assert.deepStrictEqual(second.look, { primary: 0, secondary: 0 }, 'the other car is untouched');
  // Back to the parking and called again: the same look.
  p.removeFromVehicle();
  fake.emit('gomp:car:park', p, first.id);
  assert.strictEqual(cars.vehicleOf(first.id), null);
  const again = cars.spawn(p, ch, first, new mp.Vector3(0, 0, 0), 0);
  assert.deepStrictEqual([again.getMod(11), again.getColor(0), again.windowTint], [1, 27, 2]);
  const plain = cars.spawn(p, ch, second, new mp.Vector3(5, 0, 0), 0);
  assert.deepStrictEqual([plain.getMod(11), plain.getColor(0)], [-1, 0]);
});

test('the garage gives a car back in its own colour and tuning (bought cars and others)', () => {
  const h = houses.list().find((x) => x.state.owner === null && x.cls === 'econom');
  const p = fake.login(fake.join());
  const ch = roleplay.character(p);
  roleplay.setMoney(p, 5000000, 5000000);
  p.position = new mp.Vector3(h.x, h.y, h.z);
  fake.emit('gomp:house:buy', p, h.id, 'bank');
  // A bought car in white with a spoiler.
  const car = cars.grant(ch, 'm5', { color: [111, 111] }).car;
  car.look.mods = { 0: 2 };
  let veh = cars.spawn(p, ch, car, new mp.Vector3(h.x + 2, h.y, h.z), 0);
  assert.strictEqual(veh.getColor(0), 111);
  p.putIntoVehicle(veh, 0);
  fake.emit('gomp:garage:store', p, h.id);
  assert.ok(!mp.vehicles.exists(veh), 'in the garage');
  p.removeFromVehicle();
  // Taken out (a garage interior parks it; a virtual one sends it out): white, with the spoiler.
  const spawned = mp.vehicles.toArray().filter((v) => v.getVariable('carId') === car.id);
  fake.emit('gomp:garage:take', p, h.id, 0, h.x + 5, h.y, h.z, 0);
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  veh = mp.vehicles.toArray().find((v) => v.getVariable('carId') === car.id && !spawned.includes(v));
  assert.ok(veh, 'the car is there again');
  assert.deepStrictEqual([veh.getColor(0), veh.getMod(0)], [111, 2]);

  // A vehicle that is not a bought car keeps its colour through the garage too.
  fake.emit('gomp:garage:exit', p, 'street');
  p.position = new mp.Vector3(h.x, h.y, h.z);
  p.dimension = 0;
  const kit = vehicles.spawnFor(p, 'blista');
  kit.setColor(53, 53);
  kit.position = new mp.Vector3(h.x + 2, h.y, h.z);
  fake.emit('gomp:garage:store', p, h.id);
  const rec = houses.byId(h.id).state.garage.find((r) => r && r.carId === null);
  assert.ok(rec && rec.look && rec.look.primary === 53, 'its look is kept in the garage');

  // Clean up: the house goes back on sale.
  houses.byId(h.id).state.garage.length = 0;
  mp.vehicles.toArray().filter((v) => v.getVariable('carId') === car.id).forEach((v) => v.destroy());
  fake.emit('gomp:house:sell', p, h.id);
});
