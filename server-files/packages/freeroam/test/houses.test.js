const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fakemp');
require('../index');
const roleplay = require('../roleplay');
const vehicles = require('../vehicles');
const houses = require('../houses');

const door = (h) => new mp.Vector3(h.x, h.y, h.z);
const ofClass = (cls) => houses.list().filter((h) => h.cls === cls);
let used = 0;
// A different free house for every test (they share the database).
function freeHouse(cls = 'econom') {
  const h = ofClass(cls).filter((x) => x.state.owner === null)[used++ % 2];
  assert.ok(h, `a free ${cls} house`);
  return h;
}

// A character with money enough for any house, standing at the door.
function buyer(h, cash = 2000000) {
  const p = fake.login(fake.join());
  roleplay.setMoney(p, cash, cash);
  p.position = door(h);
  return { p, ch: roleplay.character(p) };
}

test('houses: three classes with their own interior and garage size', () => {
  assert.deepStrictEqual(Object.keys(houses.CLASSES), ['econom', 'middle', 'lux']);
  assert.deepStrictEqual(Object.values(houses.CLASSES).map((c) => c.garage), [2, 6, 10]);
  const interiors = new Set(Object.values(houses.CLASSES).map((c) => c.interior.join()));
  assert.strictEqual(interiors.size, 3, 'a different interior per class');
  const ids = houses.list().map((h) => h.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'unique ids');
  for (const cls of Object.keys(houses.CLASSES)) assert.ok(ofClass(cls).length >= 2, cls);
  for (const h of houses.list()) assert.ok(h.price > 0 && Number.isFinite(h.x + h.y + h.z), h.name);
});

test('the houses are sent to a character entering the game', () => {
  const p = fake.login(fake.join());
  const [list, classes] = p.lastCall('gomp:houses');
  assert.strictEqual(list.length, houses.list().length);
  assert.deepStrictEqual(Object.keys(list[0]).sort(), ['cls', 'id', 'locked', 'name', 'owner', 'ownerName', 'price', 'x', 'y', 'z']);
  assert.strictEqual(classes.lux.garage, 10);
});

test('a house is bought at its door, once, one per character', () => {
  const h = freeHouse();
  const { p, ch } = buyer(h);
  p.position = new mp.Vector3(h.x + 30, h.y, h.z);
  fake.emit('gomp:house:buy', p, h.id, 'cash');
  assert.strictEqual(houses.byId(h.id).state.owner, null, 'not at the door');
  p.position = door(h);
  const cash = ch.cash;
  const other = fake.login(fake.join());
  fake.emit('gomp:house:buy', p, h.id, 'cash');
  assert.strictEqual(houses.byId(h.id).state.owner, ch.static);
  assert.strictEqual(houses.byId(h.id).state.ownerName, `${ch.first} ${ch.last}`);
  assert.strictEqual(ch.cash, cash - h.price);
  assert.strictEqual(houses.ownedBy(ch.static).id, h.id);
  assert.strictEqual(other.lastCall('gomp:houses')[0].find((x) => x.id === h.id).owner, ch.static, 'everybody sees the new owner');
  assert.strictEqual(p.lastCall('gomp:house:info')[0].mine, true);

  // A second house is refused, and so is a house that is sold.
  const h2 = freeHouse();
  p.position = door(h2);
  fake.emit('gomp:house:buy', p, h2.id, 'bank');
  assert.strictEqual(houses.byId(h2.id).state.owner, null);
  const { p: late } = buyer(h);
  fake.emit('gomp:house:buy', late, h.id, 'cash');
  assert.strictEqual(houses.byId(h.id).state.owner, ch.static);
});

test('buying by card shows in the card statement; no money, no house', () => {
  const h = freeHouse('middle');
  const { p, ch } = buyer(h, 1000);
  fake.emit('gomp:house:buy', p, h.id, 'bank');
  assert.strictEqual(houses.byId(h.id).state.owner, null);
  assert.ok(p.notes.at(-1).includes('Недостаточно'));
  roleplay.setMoney(p, 0, h.price);
  fake.emit('gomp:house:buy', p, h.id, 'bank');
  assert.strictEqual(houses.byId(h.id).state.owner, ch.static);
  assert.strictEqual(ch.bank, 0);
  assert.deepStrictEqual(ch.bankLog.at(-1).sum, -h.price);
  assert.ok(ch.bankLog.at(-1).text.includes(h.name));
});

test('inside: the class interior in a dimension of its own; locks keep guests out', () => {
  const h = freeHouse('lux');
  const { p, ch } = buyer(h);
  const guest = fake.login(fake.join());
  guest.position = door(h);
  // A house for sale can be looked at.
  fake.emit('gomp:house:enter', guest, h.id);
  assert.strictEqual(guest.dimension, houses.DIMENSION_BASE + h.id);
  assert.deepStrictEqual([guest.position.x, guest.position.y, guest.position.z], houses.CLASSES.lux.interior);
  assert.deepStrictEqual(guest.lastCall('gomp:house:inside')[0].id, h.id);
  fake.emit('gomp:house:exit', guest);
  assert.strictEqual(guest.dimension, 0);
  assert.deepStrictEqual(guest.position, door(h));
  assert.strictEqual(guest.lastCall('gomp:house:inside')[0], null);

  fake.emit('gomp:house:buy', p, h.id, 'cash');
  fake.emit('gomp:house:enter', guest, h.id);
  assert.strictEqual(guest.dimension, 0, 'locked');
  fake.emit('gomp:house:lock', guest, h.id);
  assert.strictEqual(houses.byId(h.id).state.locked, true, 'only the owner unlocks');
  fake.emit('gomp:house:lock', p, h.id);
  assert.strictEqual(houses.byId(h.id).state.locked, false);
  fake.emit('gomp:house:enter', guest, h.id);
  assert.strictEqual(guest.dimension, houses.DIMENSION_BASE + h.id);
  // From far away nobody enters; leaving the game inside, the owner comes back at the door.
  p.position = new mp.Vector3(0, 0, 0);
  fake.emit('gomp:house:enter', p, h.id);
  assert.strictEqual(p.dimension, 0);
  p.position = door(h);
  fake.emit('gomp:house:enter', p, h.id);
  assert.deepStrictEqual(ch.pos, [h.x, h.y, h.z]);
  // Dying inside, one respawns outside.
  fake.emit('playerDeath', guest);
  assert.strictEqual(guest.dimension, 0);
});

test('garage: vehicles go in at the door, come out on the road and back in on quit', () => {
  const h = freeHouse();
  const { p, ch } = buyer(h);
  fake.emit('gomp:house:buy', p, h.id, 'cash');
  const veh = vehicles.spawnFor(p, 'sultan');
  vehicles.setFuel(veh, 33.3);
  fake.emit('gomp:garage:store', p, h.id);
  assert.ok(!mp.vehicles.exists(veh), 'the vehicle is put away');
  assert.strictEqual(p.vehicle, null);
  assert.deepStrictEqual(houses.byId(h.id).state.garage, [{ model: mp.joaat('sultan'), fuel: 33.3, plate: veh.numberPlate, cls: null }]);
  assert.strictEqual(p.lastCall('gomp:house:info')[0].garage.length, 1);

  // Somebody else's vehicle does not go in; an econom garage has two places.
  const stranger = fake.login(fake.join());
  stranger.position = door(h);
  const foreign = vehicles.spawnFor(stranger, 'adder');
  stranger.removeFromVehicle();
  p.putIntoVehicle(foreign, 0);
  fake.emit('gomp:garage:store', p, h.id);
  assert.ok(mp.vehicles.exists(foreign));
  p.removeFromVehicle();
  vehicles.spawnFor(p, 'blista');
  fake.emit('gomp:garage:store', p, h.id);
  vehicles.spawnFor(p, 'futo');
  fake.emit('gomp:garage:store', p, h.id);
  assert.strictEqual(houses.byId(h.id).state.garage.length, 2);
  assert.ok(p.notes.at(-1).includes('нет места'));
  p.removeFromVehicle();

  // Out on the spot the client found; a spot far away is not taken.
  fake.emit('gomp:garage:take', p, h.id, 0, h.x + 10, h.y, h.z, 90);
  const out = mp.vehicles.toArray().find((v) => v.model === mp.joaat('sultan') && v.getVariable('owner') === ch.static);
  assert.ok(out, 'taken out');
  assert.strictEqual(out.position.x, h.x + 10);
  assert.strictEqual(out.heading, 90);
  assert.strictEqual(vehicles.fuelOf(out), 33.3);
  assert.deepStrictEqual(p.lastCall('gomp:house:info')[0].garage.map((g) => g.out), [true, false]);
  fake.emit('gomp:garage:take', p, h.id, 0, h.x, h.y, h.z, 0);
  assert.strictEqual(mp.vehicles.toArray().filter((v) => v.model === mp.joaat('sultan') && v.getVariable('owner') === ch.static).length, 1, 'not twice');
  fake.emit('gomp:garage:take', p, h.id, 1, h.x + 500, h.y, h.z, 0);
  const second = mp.vehicles.toArray().find((v) => v.model === mp.joaat('blista') && v.getVariable('owner') === ch.static);
  assert.ok(second.position.subtract(door(h)).length() < 10, 'next to the door instead');

  // Driven back in, it takes its old place.
  p.putIntoVehicle(out, 0);
  vehicles.setFuel(out, 20);
  fake.emit('gomp:garage:store', p, h.id);
  assert.strictEqual(houses.byId(h.id).state.garage.length, 2);
  assert.strictEqual(houses.byId(h.id).state.garage[0].fuel, 20);

  // Leaving the game puts the vehicles outside back.
  fake.emit('playerQuit', p);
  assert.ok(!mp.vehicles.exists(second));
  assert.deepStrictEqual(houses.info(p, houses.byId(h.id)).garage, []);  // the player is gone: not the owner any more
});

test('garage: a big tank keeps its litres (the vehicle class is kept)', () => {
  const h = freeHouse('lux');
  const { p, ch } = buyer(h);
  fake.emit('gomp:house:buy', p, h.id, 'cash');
  const truck = vehicles.spawnFor(p, 'mule');
  fake.emit('gomp:veh:class', p, truck.id, 20);
  vehicles.setFuel(truck, 130);
  fake.emit('gomp:garage:store', p, h.id);
  assert.ok(!mp.vehicles.exists(truck));
  assert.strictEqual(houses.byId(h.id).state.garage[0].cls, 20);
  fake.emit('gomp:garage:take', p, h.id, 0, h.x + 6, h.y, h.z, 0);
  const out = mp.vehicles.toArray().find((v) => v.model === mp.joaat('mule') && v.getVariable('owner') === ch.static);
  assert.ok(out && out !== truck);
  assert.strictEqual(vehicles.tankOf(out), 150);
  assert.strictEqual(vehicles.fuelOf(out), 130);
  fake.emit('gomp:veh:class', p, out.id, 20);
  assert.strictEqual(vehicles.fuelOf(out), 130, 'the client reporting the class changes nothing');
});

test('selling: the garage must be empty; half the price goes to the card', () => {
  const h = freeHouse('middle');
  const { p, ch } = buyer(h);
  fake.emit('gomp:house:buy', p, h.id, 'cash');
  vehicles.spawnFor(p, 'sultan');
  fake.emit('gomp:garage:store', p, h.id);
  fake.emit('gomp:house:sell', p, h.id);
  assert.strictEqual(houses.byId(h.id).state.owner, ch.static, 'not with a vehicle inside');
  fake.emit('gomp:garage:release', p, h.id, 0, h.x + 5, h.y, h.z, 0);
  assert.strictEqual(houses.byId(h.id).state.garage.length, 0);
  assert.ok(mp.vehicles.toArray().some((v) => v.model === mp.joaat('sultan') && v.getVariable('owner') === ch.static), 'the vehicle stays outside');
  const bank = ch.bank;
  fake.emit('gomp:house:sell', p, h.id);
  assert.strictEqual(houses.byId(h.id).state.owner, null);
  assert.strictEqual(ch.bank, bank + houses.sellPrice(h));
  assert.strictEqual(houses.sellPrice(h), Math.round(h.price / 2));
  assert.strictEqual(ch.bankLog.at(-1).sum, houses.sellPrice(h));
});

test('admin: houses are added at the door, moved, freed and removed', () => {
  const admin = fake.login(fake.join());
  admin.position = new mp.Vector3(100, 200, 30);
  fake.command(admin, '/house add lux 123456 Вилла у моря');
  const added = houses.list().find((h) => h.name === 'Вилла у моря');
  assert.ok(added && added.id >= 1000 && added.cls === 'lux' && added.price === 123456 && added.x === 100);
  fake.command(admin, '/house add castle 1');
  assert.ok(admin.chat.at(-1).includes('Класс'));
  admin.position = new mp.Vector3(110, 210, 31);
  fake.command(admin, `/house move ${added.id}`);
  assert.strictEqual(houses.byId(added.id).x, 110);
  const { p, ch } = buyer(houses.byId(added.id));
  fake.emit('gomp:house:buy', p, added.id, 'cash');
  assert.strictEqual(houses.byId(added.id).state.owner, ch.static);
  fake.command(admin, `/house free ${added.id}`);
  assert.strictEqual(houses.byId(added.id).state.owner, null);
  fake.command(admin, `/house del ${added.id}`);
  assert.strictEqual(houses.byId(added.id), null);
  // A house of the list is hidden, not forgotten.
  const seeded = houses.HOUSES[houses.HOUSES.length - 1];
  fake.command(admin, `/house del ${seeded.id}`);
  assert.strictEqual(houses.byId(seeded.id), null);
});
