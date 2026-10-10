const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fakemp');
require('../index');
const roleplay = require('../roleplay');
const vehicles = require('../vehicles');
const cars = require('../cars');
const dealership = require('../dealership');
const houses = require('../houses');

const at = ([x, y, z]) => new mp.Vector3(x, y, z);

// A character with money at the dealership's counter.
function customer(cash = 5000000) {
  const p = fake.login(fake.join());
  roleplay.setMoney(p, cash, cash);
  p.position = at(dealership.catalog.marker);
  return { p, ch: roleplay.character(p) };
}

// ------------------------------------------------------------------ dealership

test('dealership: the catalog has custom and game cars, every one in a sold class', () => {
  const c = dealership.catalog;
  assert.ok(c, 'dealership.json loaded');
  const custom = c.vehicles.filter((v) => v.custom);
  const game = c.vehicles.filter((v) => !v.custom);
  assert.ok(custom.length >= 5, 'the add-on cars');
  assert.ok(game.length > 300, 'the game cars');
  assert.ok(custom.some((v) => v.model === 'lada2107' && v.name), 'custom cars have a name');
  const sold = new Set(dealership.CLASSES.map(([id]) => id));
  for (const v of c.vehicles) assert.ok(sold.has(v.cls) && v.price > 0, v.model);
  assert.ok(!c.byModel.has('oppressor') && !c.byModel.has('police'), 'nothing armed, no emergency vehicles');
  assert.ok(c.byModel.has('sultan') && c.byModel.has('adder'));
});

test('dealership: the catalog is sent to a character entering the game (without server-only parts)', () => {
  const p = fake.login(fake.join());
  const [d] = p.lastCall('gomp:dealer');
  assert.ok(d.vehicles.length > 300);
  assert.deepStrictEqual(d.sections.map((s) => s.id), ['custom', 'game']);
  assert.ok(d.classes.some((c) => c.name === 'Суперкары'));
  assert.strictEqual(d.byModel, undefined);
  assert.strictEqual(d.spawns, undefined);
  assert.ok(d.colors.length >= 6 && d.preview.length === 4);
});

test('dealership: a purchase at the counter charges the catalog price; the car waits on the parking lot', () => {
  const { p, ch } = customer();
  const v = dealership.catalog.byModel.get('sultan');
  const bank = ch.bank;
  fake.emit('gomp:dealer:buy', p, 'sultan', 27, 'bank');
  assert.strictEqual(ch.bank, bank - v.price);
  assert.strictEqual(ch.cars.length, 1);
  const car = ch.cars[0];
  assert.deepStrictEqual([car.model, car.color], ['sultan', [27, 27]]);
  assert.match(car.plate, /^[A-Z]{3}\d{3}GM$/);
  const veh = cars.vehicleOf(car.id);
  assert.ok(veh, 'the car is on the parking lot');
  assert.strictEqual(veh.getVariable('owner'), ch.static);
  assert.strictEqual(veh.numberPlate, car.plate);
  assert.strictEqual(veh.getColor(0), 27);
  assert.ok(dealership.catalog.spawns.some(([x, y]) => Math.hypot(veh.position.x - x, veh.position.y - y) < 0.01));
  assert.ok(p.lastCall('gomp:dealer:bought'));
  // The next car takes another spot.
  fake.emit('gomp:dealer:buy', p, 'blista', 0, 'cash');
  const second = cars.vehicleOf(ch.cars[1].id);
  assert.ok(second.position.subtract(veh.position).length() > 3, 'a free spot');
});

test('dealership: refused away from the counter, without money, for unknown models; a colour not offered falls back', () => {
  const { p, ch } = customer(1000);
  fake.emit('gomp:dealer:buy', p, 'adder', 0, 'cash');
  assert.strictEqual((ch.cars || []).length, 0);
  assert.ok(p.notes.some((n) => /Недостаточно денег/.test(n)));
  roleplay.setMoney(p, 5000000, 0);
  fake.emit('gomp:dealer:buy', p, 'oppressor2', 0, 'cash');
  assert.ok(p.notes.some((n) => /нет в продаже/.test(n)));
  p.position = new mp.Vector3(0, 0, 0);
  fake.emit('gomp:dealer:buy', p, 'adder', 0, 'cash');
  assert.strictEqual((ch.cars || []).length, 0);
  assert.ok(p.notes.some((n) => /Подойдите к стойке/.test(n)));
  p.position = at(dealership.catalog.marker);
  fake.emit('gomp:dealer:buy', p, 'adder', 9999, 'cash');
  assert.deepStrictEqual(ch.cars[0].color, [dealership.catalog.colors[0].id, dealership.catalog.colors[0].id]);
});

test('dealership: no more cars than the limit', () => {
  const { p, ch } = customer();
  for (let i = 0; i < cars.MAX_CARS + 2; i++) fake.emit('gomp:dealer:buy', p, 'blista', 0, 'bank');
  assert.strictEqual(ch.cars.length, cars.MAX_CARS);
  assert.ok(p.notes.some((n) => /Не больше/.test(n)));
});

test('dealership: a broken catalog document is refused', () => {
  assert.ok(dealership.validate({}).error);
  assert.ok(dealership.validate({ format: 'gomp-dealership', version: 1, marker: [0, 0, 0], preview: [0, 0, 0, 0], spawns: [], colors: [{ id: 0, name: 'x' }] }).error);
  const ok = dealership.validate({
    format: 'gomp-dealership', version: 1, marker: [0, 0, 0], preview: [0, 0, 0, 0], spawns: [[1, 2, 3, 4]], colors: [{ id: 0, name: 'Чёрный' }],
    vehicles: [{ model: 'Sultan', cls: 1, price: 100 }, { model: 'sultan', cls: 1, price: 5 }, { model: 'police', cls: 18, price: 5 }, { model: 'x', cls: 1, price: -1 }],
  });
  assert.deepStrictEqual(ok.catalog.vehicles.map((v) => v.model), ['sultan'], 'duplicates, unsold classes and bad prices dropped');
});

// ------------------------------------------------------------------ owned cars

test('cars: F2 shows them; a car out goes back to the parking when the owner leaves, with its fuel', () => {
  const { p, ch } = customer();
  fake.emit('gomp:dealer:buy', p, 'blista', 0, 'bank');
  const car = ch.cars[0];
  const veh = cars.vehicleOf(car.id);
  vehicles.setFuel(veh, 12.5);
  fake.emit('gomp:property:get', p);
  const [prop] = p.lastCall('gomp:property');
  assert.strictEqual(prop.cars[0].status, 'out');
  assert.strictEqual(prop.maxCars, cars.MAX_CARS);
  fake.emit('playerQuit', p);
  assert.ok(!mp.vehicles.exists(veh), 'gone from the street');
  assert.strictEqual(car.fuel, 12.5);
  assert.strictEqual(cars.statusOf(car).status, 'parked');
});

test('cars: called onto the road next to the owner, sent back to the parking from F2', () => {
  const { p, ch } = customer();
  const { car } = cars.grant(ch, 'futo', { color: [5, 5] });
  p.position = new mp.Vector3(1000, 1000, 20);
  fake.emit('gomp:car:call', p, car.id, 1500, 1000, 20, 90);
  assert.strictEqual(cars.vehicleOf(car.id), null, 'a spot far away is refused');
  fake.emit('gomp:car:call', p, car.id, 1010, 1004, 20, 90);
  const veh = cars.vehicleOf(car.id);
  assert.ok(veh, 'called');
  assert.deepStrictEqual([veh.position.x, veh.position.y, veh.heading], [1010, 1004, 90]);
  assert.strictEqual(veh.getColor(0), 5);
  fake.emit('gomp:car:call', p, car.id, 1010, 1004, 20, 90);
  assert.ok(p.notes.some((n) => /уже на улице/.test(n)));
  // Not with somebody inside.
  const other = fake.login(fake.join());
  other.putIntoVehicle(veh, 0);
  fake.emit('gomp:car:park', p, car.id);
  assert.ok(mp.vehicles.exists(veh));
  other.removeFromVehicle();
  fake.emit('gomp:car:park', p, car.id);
  assert.ok(!mp.vehicles.exists(veh));
  assert.strictEqual(p.lastCall('gomp:property')[0].cars[0].status, 'parked');
  // Another character cannot call it.
  const thief = fake.login(fake.join());
  fake.emit('gomp:car:call', thief, car.id, 1010, 1004, 20, 90);
  assert.strictEqual(cars.vehicleOf(car.id), null);
});

test('cars: kept in the garage of the owner\'s house, the same car comes out again', () => {
  const h = houses.list().find((x) => x.state.owner === null && x.cls === 'econom');
  const { p, ch } = customer();
  p.position = new mp.Vector3(h.x, h.y, h.z);
  fake.emit('gomp:house:buy', p, h.id, 'bank');
  assert.strictEqual(houses.ownedBy(ch.static).id, h.id);
  const { car } = cars.grant(ch, 'sultan');
  const veh = cars.spawn(p, ch, car, new mp.Vector3(h.x + 2, h.y, h.z), 0);
  p.putIntoVehicle(veh, 0);
  fake.emit('gomp:garage:store', p, h.id);
  assert.ok(!mp.vehicles.exists(veh));
  assert.strictEqual(houses.byId(h.id).state.garage[0].carId, car.id);
  assert.deepStrictEqual(cars.statusOf(car), { status: 'garage', house: h.name });
  fake.emit('gomp:car:call', p, car.id, h.x + 5, h.y, h.z, 0);
  assert.strictEqual(cars.vehicleOf(car.id), null, 'not called out of a garage');
  fake.emit('gomp:property:get', p);
  const [prop] = p.lastCall('gomp:property');
  assert.strictEqual(prop.houses[0].id, h.id);
  assert.strictEqual(prop.houses[0].garage, 1);
  // Clean up: the house goes back on sale.
  houses.byId(h.id).state.garage.length = 0;
  fake.emit('gomp:house:sell', p, h.id);
});
