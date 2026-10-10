const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
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
  const [list, classes, interiors, garages] = p.lastCall('gomp:houses');
  assert.strictEqual(list.length, houses.list().length);
  assert.deepStrictEqual(Object.keys(list[0]).sort(), ['cls', 'garageName', 'garagePoint', 'hasGarage', 'heading', 'id', 'interiorName', 'locked', 'name', 'owner', 'ownerName', 'price', 'x', 'y', 'z']);
  assert.strictEqual(classes.lux.garage, 10);
  assert.deepStrictEqual(Object.keys(classes.lux).sort(), ['garage', 'interior', 'interiorName', 'name']);
  assert.deepStrictEqual(Object.keys(interiors.studio).sort(), ['exit', 'heading', 'name', 'spawn']);
  assert.strictEqual(list[0].interiorName, interiors.studio.name);
  assert.deepStrictEqual(Object.keys(garages), ['garage2', 'garage6', 'garage10']);
  assert.deepStrictEqual(Object.keys(garages.garage2).sort(), ['exit', 'heading', 'name', 'slots', 'spawn']);
  assert.strictEqual(garages.garage10.slots.length, 10);
  assert.strictEqual(garages.garage2.slots[0].length, 4);
  assert.strictEqual(list[0].hasGarage, true);
  assert.strictEqual(list[0].garageName, garages.garage2.name);
  assert.deepStrictEqual(Object.keys(list[0].garagePoint).sort(), ['heading', 'x', 'y', 'z']);
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

// A house whose class has no garage template: the virtual garage of old (the real classes all have one now).
let virtualNo = 0;
function virtualHouse(t, cap = 2) {
  const n = ++virtualNo;
  t.after(() => editFile((d) => {
    d.houses = d.houses.filter((x) => x.id < 7000 || x.id > 7999);
    d.classes = d.classes.filter((c) => c.id !== 'virtual');
  }));
  editFile((d) => {
    if (!d.classes.some((c) => c.id === 'virtual')) d.classes.push({ id: 'virtual', name: 'Virtual', garage: cap, interior: 'studio' });
    d.houses.push({ id: 7000 + n, name: `Virtual ${n}`, cls: 'virtual', price: 1000, door: [500 + n * 20, 600, 30], heading: 0 });
  });
  return houses.byId(7000 + n);
}

test('garage: vehicles go in at the door, come out on the road and back in on quit', (t) => {
  const h = virtualHouse(t);
  const { p, ch } = buyer(h);
  fake.emit('gomp:house:buy', p, h.id, 'cash');
  const veh = vehicles.spawnFor(p, 'sultan');
  vehicles.setFuel(veh, 33.3);
  fake.emit('gomp:garage:store', p, h.id);
  assert.ok(!mp.vehicles.exists(veh), 'the vehicle is put away');
  assert.strictEqual(p.vehicle, null);
  const stored = houses.byId(h.id).state.garage;
  assert.deepStrictEqual(stored.map(({ look, ...r }) => r), [{ model: mp.joaat('sultan'), fuel: 33.3, plate: veh.numberPlate, cls: null, carId: null }]);
  assert.strictEqual(stored[0].look.primary, veh.getColor(0), 'its colour is kept');
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

test('garage: a big tank keeps its litres (the vehicle class is kept)', (t) => {
  const h = virtualHouse(t);
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

test('selling: the garage must be empty; half the price goes to the card', (t) => {
  const h = virtualHouse(t);
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
  // A house of the first list is simply removed from the file as well.
  const seeded = houses.list().at(-1);
  fake.command(admin, `/house del ${seeded.id}`);
  assert.strictEqual(houses.byId(seeded.id), null);
  assert.ok(!JSON.parse(fs.readFileSync(houses.HOUSES_FILE, 'utf8')).houses.some((h) => h.id === seeded.id));
});

// ------------------------------------------------------------------ the houses file

const readText = () => fs.readFileSync(houses.HOUSES_FILE, 'utf8');
const fileDoc = () => JSON.parse(readText());
// Changes the file the way an editor would, and lets the server read it.
function editFile(fn) {
  const doc = fileDoc();
  fn(doc);
  fs.writeFileSync(houses.HOUSES_FILE, JSON.stringify(doc, null, 2));
  return houses.reload();
}
const baseDoc = () => ({
  format: 'gomp-houses', version: 1,
  interiors: [{ id: 'a', name: 'A', spawn: [1, 2, 3], exit: [4, 5, 6] }],
  classes: [{ id: 'c', name: 'C', garage: 3, interior: 'a' }],
  houses: [{ id: 1, name: 'H', cls: 'c', price: 10, door: [7, 8, 9] }],
});

test('validate: a good document, with the defaults filled', () => {
  const v = houses.validate(baseDoc());
  assert.strictEqual(v.error, undefined);
  assert.deepStrictEqual(v.skipped, []);
  assert.deepStrictEqual(v.interiors, [{ id: 'a', name: 'A', spawn: [1, 2, 3], heading: 0, exit: [4, 5, 6], props: [] }]);
  assert.deepStrictEqual(v.classes, [{ id: 'c', name: 'C', garage: 3, interior: 'a' }]);
  assert.deepStrictEqual(v.houses, [{ id: 1, name: 'H', cls: 'c', price: 10, door: [7, 8, 9], heading: 0 }]);
  const d = baseDoc();
  d.extra = 1;
  d.interiors[0].props = [{ model: 'Prop_Couch_01', pos: [1, 2, 3], future: true }, { model: 5, pos: [0, 0, 0], rot: [1, 2, 3] }];
  d.houses[0].interior = 'a';
  const p = houses.validate(d).interiors[0].props;
  assert.deepStrictEqual(p[0], { id: 'p1', model: mp.joaat('prop_couch_01'), pos: [1, 2, 3], rot: [0, 0, 0] });
  assert.strictEqual(p[1].model, 5);
  assert.deepStrictEqual(p[1].rot, [1, 2, 3]);
});

test('validate: a wrong format or version is an error', () => {
  for (const bad of [null, [], 'x', { ...baseDoc(), format: 'gomp-map' }, { ...baseDoc(), format: undefined }, { ...baseDoc(), version: 2 }]) {
    assert.ok(houses.validate(bad).error, JSON.stringify(bad)?.slice(0, 30));
  }
});

test('validate: bad entries are skipped; a bad interior takes its classes and houses with it', () => {
  const d = baseDoc();
  d.interiors.push({ id: 'b', name: 'B', spawn: [1, 2], exit: [1, 2, 3] });           // spawn: two numbers
  d.interiors.push({ id: 'A', name: 'upper case id', spawn: [1, 2, 3], exit: [1, 2, 3] });
  d.interiors.push({ id: 'a', name: 'twice', spawn: [1, 2, 3], exit: [1, 2, 3] });
  d.interiors.push({ id: 'n', name: 'NaN', spawn: [1, null, 3], exit: [1, 2, 3] });
  d.interiors.push({ id: 'h', name: 'H', spawn: [1, 2, 3], exit: [1, 2, 3], heading: 'x' });
  d.classes.push({ id: 'cb', name: 'uses b', garage: 1, interior: 'b' });
  d.classes.push({ id: 'g', name: 'big', garage: 51, interior: 'a' });
  d.classes.push({ id: 'g2', name: 'fraction', garage: 1.5, interior: 'a' });
  d.classes.push({ id: 'c', name: 'twice', garage: 1, interior: 'a' });
  d.classes.push({ id: 'z', name: 'zero garage', garage: 0, interior: 'a' });
  d.houses.push({ id: 2, name: 'in cb', cls: 'cb', price: 1, door: [0, 0, 0] });
  d.houses.push({ id: 1, name: 'twice', cls: 'c', price: 1, door: [0, 0, 0] });
  d.houses.push({ id: 3, name: 'no price', cls: 'c', price: 0, door: [0, 0, 0] });
  d.houses.push({ id: 4, name: 'bad door', cls: 'c', price: 5, door: [0, 0, Infinity] });
  d.houses.push({ id: 5, name: 'no class', cls: 'nope', price: 5, door: [0, 0, 0] });
  d.houses.push({ id: 6, name: 'no interior', cls: 'c', price: 5, door: [0, 0, 0], interior: 'b' });
  d.houses.push({ id: -1, name: 'negative', cls: 'c', price: 5, door: [0, 0, 0] });
  d.houses.push({ id: 7, name: '  ', cls: 'c', price: 5, door: [0, 0, 0] });
  d.houses.push({ id: 8, name: 'bad heading', cls: 'c', price: 5, door: [0, 0, 0], heading: null });
  d.houses.push({ id: 9, name: 'fine', cls: 'z', price: 5, door: [0, 0, 0], heading: 90, interior: 'a' });
  const v = houses.validate(d);
  assert.deepStrictEqual(v.interiors.map((i) => i.id), ['a']);
  assert.deepStrictEqual(v.classes.map((c) => c.id), ['c', 'z']);
  assert.deepStrictEqual(v.houses.map((h) => h.id), [1, 9]);
  assert.strictEqual(v.houses[1].heading, 90);
  assert.strictEqual(v.skipped.length, 5 + 4 + 9, v.skipped.join('\n'));
  for (const id of ['интерьер b', 'класс cb', 'дом 2:']) assert.ok(v.skipped.some((m) => m.includes(id)), id);
});

test('validate: props are checked and limited', () => {
  const d = baseDoc();
  d.interiors[0].props = [
    { model: '', pos: [0, 0, 0] }, { model: -1, pos: [0, 0, 0] }, { model: 1.5, pos: [0, 0, 0] }, { model: 5e9, pos: [0, 0, 0] },
    { model: 'ok', pos: [0, 0] }, { model: 'ok', pos: [0, 0, 0], rot: [0, 0] }, null,
    { model: 0, pos: [0, 0, 0] }, { model: 4294967295, pos: [0, 0, 0] },
  ];
  let v = houses.validate(d);
  assert.deepStrictEqual(v.interiors[0].props.map((p) => p.model), [0, 4294967295]);
  assert.strictEqual(v.skipped.length, 7);
  d.interiors[0].props = Array.from({ length: 305 }, (_, i) => ({ id: `p${i}`, model: 'prop_bench_01a', pos: [i, 0, 0] }));
  v = houses.validate(d);
  assert.strictEqual(v.interiors[0].props.length, 300);
  assert.strictEqual(v.skipped.length, 1);
  assert.ok(v.skipped[0].includes('300'));
});

test('reload: a house added, a door moved and a house removed in the file', () => {
  const before = houses.list().length;
  const moved = houses.list()[0];
  const gone = houses.list().find((h) => h.id !== moved.id && h.state.owner === null && h.cls === 'lux');
  const watcher = fake.login(fake.join());
  const r = editFile((d) => {
    d.houses.push({ id: 5001, name: 'Studio house', cls: 'middle', price: 777, door: [1, 2, 3], heading: 45 });
    d.houses.find((h) => h.id === moved.id).door = [10, 20, 30];
    d.houses = d.houses.filter((h) => h.id !== gone.id);
    d.houses[0].future = 'ignored';
  });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(houses.list().length, before);
  assert.deepStrictEqual([houses.byId(5001).x, houses.byId(5001).heading, houses.byId(5001).price], [1, 45, 777]);
  assert.deepStrictEqual([houses.byId(moved.id).x, houses.byId(moved.id).z], [10, 30]);
  assert.strictEqual(houses.byId(gone.id), null);
  const sent = watcher.lastCall('gomp:houses');
  assert.strictEqual(sent.length, 4);
  assert.ok(sent[0].some((h) => h.id === 5001 && h.interiorName === 'Квартира с ремонтом'));
  assert.ok(!sent[0].some((h) => h.id === gone.id));
  assert.strictEqual(houses.reload().changed, false, 'the same text again: nothing to do');
  editFile((d) => { d.houses = d.houses.filter((h) => h.id !== 5001); });
});

test('reload: a broken file keeps the houses; a missing one does not throw', () => {
  const good = readText();
  const count = houses.list().length;
  for (const bad of ['{ not json', JSON.stringify({ format: 'gomp-houses', version: 9 }), '[]']) {
    fs.writeFileSync(houses.HOUSES_FILE, bad);
    const r = houses.reload();
    assert.ok(r.error, bad);
    assert.strictEqual(houses.list().length, count);
  }
  // The admin commands do not overwrite a broken file.
  const admin = fake.login(fake.join());
  fake.command(admin, '/house add econom 5 Broken');
  assert.ok(admin.chat.at(-1).includes('повреждён'));
  assert.strictEqual(readText(), '[]');
  fs.writeFileSync(houses.HOUSES_FILE, good);
  assert.strictEqual(houses.reload().changed, true);
  assert.strictEqual(houses.list().length, count);

  fs.unlinkSync(houses.HOUSES_FILE);
  assert.doesNotThrow(() => houses.reload());
  assert.strictEqual(houses.list().length, 0);
  fs.writeFileSync(houses.HOUSES_FILE, good);
  houses.reload();
  assert.strictEqual(houses.list().length, count);
});

// An interior of its own with an exit away from the spawn point, and a house using it.
function withInterior() {
  editFile((d) => {
    d.interiors = d.interiors.filter((i) => i.id !== 'test');
    d.interiors.push({
      id: 'test', name: 'Тест', spawn: [100, 200, 300], heading: 123, exit: [105, 205, 300],
      props: [{ id: 'p1', model: 'prop_couch_01', pos: [1, 2, 3], rot: [0, 0, 90] }, { model: 12345, pos: [4, 5, 6] }],
    });
    d.houses.push({ id: 5100, name: 'Test house', cls: 'econom', price: 1000, door: [50, 60, 70], heading: 270, interior: 'test' });
  });
  return houses.byId(5100);
}

test('inside: the spawn point and heading of the interior, its exit and props are sent', () => {
  const h = withInterior();
  const p = fake.login(fake.join());
  p.position = door(h);
  fake.emit('gomp:house:enter', p, h.id);
  assert.deepStrictEqual([p.position.x, p.position.y, p.position.z, p.heading], [100, 200, 300, 123]);
  assert.strictEqual(p.dimension, houses.DIMENSION_BASE + 5100);
  assert.deepStrictEqual(p.lastCall('gomp:house:inside')[0], {
    id: 5100, name: 'Test house', x: 100, y: 200, z: 300, heading: 123, exit: [105, 205, 300],
    props: [{ model: mp.joaat('prop_couch_01'), pos: [1, 2, 3], rot: [0, 0, 90] }, { model: 12345, pos: [4, 5, 6], rot: [0, 0, 0] }],
  });
  assert.strictEqual(houses.insideOf(p), 5100);
  fake.emit('gomp:house:exit', p);
  assert.deepStrictEqual([p.position.x, p.position.y, p.position.z, p.heading, p.dimension], [50, 60, 70, 270, 0]);
  editFile((d) => { d.houses = d.houses.filter((x) => x.id !== 5100); });
});

test('inside: a changed interior reaches the player at once, without moving him; a deleted house puts him out', () => {
  const h = withInterior();
  const p = fake.login(fake.join());
  p.position = door(h);
  fake.emit('gomp:house:enter', p, h.id);
  const at = { ...p.position };
  const insideCalls = () => p.calls.filter(([name]) => name === 'gomp:house:inside').length;
  const n = insideCalls();
  editFile((d) => { d.houses.find((x) => x.id === 5100).price = 2000; });
  assert.strictEqual(insideCalls(), n, 'nothing about the interior changed: the player is not bothered');
  editFile((d) => {
    const it = d.interiors.find((i) => i.id === 'test');
    it.exit = [111, 222, 333];
    it.props = [{ model: 'prop_chair_01a', pos: [9, 9, 9] }];
  });
  assert.strictEqual(insideCalls(), n + 1);
  const msg = p.lastCall('gomp:house:inside')[0];
  assert.strictEqual(msg.refresh, true);
  assert.deepStrictEqual(msg.exit, [111, 222, 333]);
  assert.deepStrictEqual(msg.props, [{ model: mp.joaat('prop_chair_01a'), pos: [9, 9, 9], rot: [0, 0, 0] }]);
  assert.deepStrictEqual({ ...p.position }, at);
  assert.strictEqual(p.dimension, houses.DIMENSION_BASE + 5100);

  // The house is gone: out by the door he came by.
  editFile((d) => { d.houses = d.houses.filter((x) => x.id !== 5100); });
  assert.strictEqual(p.dimension, 0);
  assert.deepStrictEqual([p.position.x, p.position.y, p.position.z, p.heading], [50, 60, 70, 270]);
  assert.strictEqual(p.lastCall('gomp:house:inside')[0], null);
  assert.strictEqual(houses.insideOf(p), undefined);
});

test('admin: /house add, move and del change the file; the watcher sees nothing new', () => {
  const admin = fake.login(fake.join());
  admin.position = new mp.Vector3(11.5, 22.25, 33);
  admin.heading = 135;
  fake.command(admin, '/house add middle 4242 Дом из игры');
  const added = fileDoc().houses.find((h) => h.name === 'Дом из игры');
  assert.deepStrictEqual({ ...added, id: 0 }, { id: 0, name: 'Дом из игры', cls: 'middle', price: 4242, door: [11.5, 22.25, 33], heading: 135 });
  assert.ok(added.id >= 1000);
  assert.strictEqual(houses.reload().changed, false);

  admin.position = new mp.Vector3(1, 2, 3);
  admin.heading = 10;
  fake.command(admin, `/house move ${added.id}`);
  const moved = fileDoc().houses.find((h) => h.id === added.id);
  assert.deepStrictEqual([moved.door, moved.heading], [[1, 2, 3], 10]);
  assert.strictEqual(houses.byId(added.id).heading, 10);

  fake.command(admin, `/house del ${added.id}`);
  assert.ok(!fileDoc().houses.some((h) => h.id === added.id));
  assert.strictEqual(houses.byId(added.id), null);
});

test('admin: /interior spawn and exit change the template in the file', () => {
  const h = withInterior();
  const admin = fake.login(fake.join());
  fake.command(admin, '/interior spawn');
  assert.ok(admin.chat.at(-1).includes('внутри'));
  admin.position = door(h);
  fake.emit('gomp:house:enter', admin, h.id);
  admin.position = new mp.Vector3(1.5, 2.5, 3.5);
  admin.heading = 77;
  fake.command(admin, '/interior spawn');
  assert.ok(admin.chat.at(-1).includes('test'));
  admin.position = new mp.Vector3(9, 8, 7);
  fake.command(admin, '/interior exit');
  const it = fileDoc().interiors.find((i) => i.id === 'test');
  assert.deepStrictEqual([it.spawn, it.heading, it.exit], [[1.5, 2.5, 3.5], 77, [9, 8, 7]]);
  assert.strictEqual(it.props.length, 2, 'the rest of the template stays');
  assert.deepStrictEqual(admin.lastCall('gomp:house:inside')[0].exit, [9, 8, 7]);
  assert.strictEqual(admin.lastCall('gomp:house:inside')[0].refresh, true);
  assert.notDeepStrictEqual(fileDoc().interiors.find((i) => i.id === 'studio').spawn, [1.5, 2.5, 3.5], 'the other templates are not touched');
  fake.emit('gomp:house:exit', admin);
  editFile((d) => { d.houses = d.houses.filter((x) => x.id !== 5100); });
});

test('migration: houses kept in the database move into the file, once', () => {
  const table = require('../accounts').table('houses');
  const keep = fileDoc().houses.find((h) => h.id === 1);
  const gone = fileDoc().houses.find((h) => h.id === 2);
  const moved = fileDoc().houses.find((h) => h.id === 3);
  table[5200] = { owner: null, ownerName: '', locked: true, garage: [], def: { name: 'Из базы', cls: 'lux', price: 99, x: 5, y: 6, z: 7 } };
  table[5201] = { owner: null, ownerName: '', locked: true, garage: [], def: { name: 'Already there', cls: 'lux', price: 1, x: 0, y: 0, z: 0 } };
  table[2] = { ...table[2], deleted: true };
  table[3] = { ...table[3], def: { x: 33, y: 44, z: 55 } };
  editFile((d) => d.houses.push({ id: 5201, name: 'In the file', cls: 'lux', price: 5, door: [1, 1, 1] }));
  assert.strictEqual(houses.migrate(), true);
  const doc = fileDoc();
  assert.deepStrictEqual(doc.houses.find((h) => h.id === 5200), { id: 5200, name: 'Из базы', cls: 'lux', price: 99, door: [5, 6, 7], heading: 0 });
  assert.strictEqual(doc.houses.find((h) => h.id === 5201).name, 'In the file', 'the file wins');
  assert.ok(!doc.houses.some((h) => h.id === gone.id));
  assert.deepStrictEqual(doc.houses.find((h) => h.id === 3).door, [33, 44, 55]);
  assert.deepStrictEqual(doc.houses.find((h) => h.id === 1), keep);
  for (const id of [5200, 5201, 2, 3]) assert.ok(!('def' in table[id]) && !('deleted' in table[id]), String(id));
  assert.strictEqual(houses.byId(5200).name, 'Из базы');
  assert.strictEqual(houses.migrate(), false, 'nothing left to move');
  editFile((d) => {
    d.houses = d.houses.filter((h) => ![5200, 5201].includes(h.id));
    d.houses.find((h) => h.id === 3).door = moved.door;
    d.houses.push(gone);
  });
  delete table[5200];
  delete table[5201];
});

test('new ids go past the ids that still have a state in the database', () => {
  const table = require('../accounts').table('houses');
  const admin = fake.login(fake.join());
  const top = Math.max(1000, ...Object.keys(table).map(Number), ...fileDoc().houses.map((h) => h.id));
  // A deleted house leaves its owner behind in the database: its id is not given again.
  table[top + 1] = { owner: 12345, ownerName: 'Old Owner', locked: true, garage: [{ model: 1, fuel: 1, plate: 'X', cls: null }] };
  fake.command(admin, '/house add econom 100 New');
  const added = houses.list().find((h) => h.name === 'New');
  assert.ok(added.id >= top + 2, `${added.id} > ${top + 1}`);
  assert.strictEqual(added.state.owner, null);
  fake.command(admin, `/house del ${added.id}`);
  delete table[top + 1];
});

test('the real houses file is a valid document', () => {
  const real = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', '..', '..', 'houses.json'), 'utf8'));
  const v = houses.validate(real);
  assert.deepStrictEqual(v.skipped, []);
  assert.strictEqual(v.houses.length, real.houses.length);
  assert.deepStrictEqual(v.classes.map((c) => c.garage), [2, 6, 10]);
  assert.deepStrictEqual(v.garages.map((g) => g.slots.length), [2, 6, 10]);
  assert.deepStrictEqual(v.classes.map((c) => c.garageInterior), ['garage2', 'garage6', 'garage10']);
  assert.ok(v.houses.every((h) => h.garagePoint), 'a garage point on every house');
});

// ------------------------------------------------------------------ garage interiors

const G = houses.GARAGE_DIMENSION_BASE;
const gd = (h) => G + h.id;
const xyz = (v) => [v.position.x, v.position.y, v.position.z];
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} ${a} ~ ${b}`);
const carsIn = (h) => mp.vehicles.toArray().filter((v) => v.dimension === gd(h));
const calls = (p, name) => p.calls.filter(([n]) => n === name).length;
const slotOf = (g, i) => [...g.slots[i].pos, g.slots[i].heading];
const pointOf = (h) => new mp.Vector3(...houses.byId(h.id).garagePoint.pos);

// Puts the file back as it was when the test is over.
function restoreFile(t) {
  const good = readText();
  t.after(() => {
    fs.writeFileSync(houses.HOUSES_FILE, good);
    houses.reload();
  });
}

// An owner of a free house of the class (the garage template comes with the class).
function owner(t, cls = 'econom') {
  const h = freeHouse(cls);
  t.after(() => houses.evict(h.id));  // free again for the next test
  const { p, ch } = buyer(h);
  fake.emit('gomp:house:buy', p, h.id, 'cash');
  assert.strictEqual(houses.byId(h.id).state.owner, ch.static);
  return { h: houses.byId(h.id), p, ch };
}

// Records in the garage of a house (nothing stands outside).
function store(h, n, fuel = 12.5) {
  for (let i = 0; i < n; i++) h.state.garage.push({ model: mp.joaat('sultan'), fuel: fuel + i, plate: `PL${i}`, cls: null });
}

const goodGarage = () => ({ id: 'g', name: 'G', spawn: [1, 2, 3], exit: [4, 5, 6], slots: [{ pos: [1, 1, 1] }] });

test('validate: garages, references to them and garage points', () => {
  const d = baseDoc();
  d.garages = [goodGarage()];
  d.classes[0].garageInterior = 'g';
  d.houses[0].garagePoint = { pos: [1, 2, 3] };
  let v = houses.validate(d);
  assert.deepStrictEqual(v.skipped, []);
  assert.deepStrictEqual(v.garages, [{ id: 'g', name: 'G', spawn: [1, 2, 3], heading: 0, exit: [4, 5, 6], slots: [{ pos: [1, 1, 1], heading: 0 }] }]);
  assert.strictEqual(v.classes[0].garageInterior, 'g');
  assert.deepStrictEqual(v.houses[0].garagePoint, { pos: [1, 2, 3], heading: 0 });
  d.houses[0].garageInterior = 'g';
  d.houses[0].garagePoint = { pos: [1, 2, 3], heading: 45, future: 1 };
  d.garages[0].heading = 30;
  d.garages[0].slots = [{ pos: [1, 1, 1], heading: 90, future: 1 }];
  v = houses.validate(d);
  assert.strictEqual(v.houses[0].garageInterior, 'g');
  assert.deepStrictEqual(v.houses[0].garagePoint, { pos: [1, 2, 3], heading: 45 });
  assert.deepStrictEqual([v.garages[0].heading, v.garages[0].slots[0].heading], [30, 90]);
  // Without garages everything is as it was.
  const plain = houses.validate(baseDoc());
  assert.deepStrictEqual(plain.garages, []);
  assert.ok(!('garageInterior' in plain.classes[0]) && !('garagePoint' in plain.houses[0]));
});

test('validate: a bad garage is skipped; a bad slot costs only itself', () => {
  const d = baseDoc();
  const g = (o) => ({ ...goodGarage(), ...o });
  d.garages = [
    goodGarage(), null, g({ id: 'BAD' }), g({ id: 'g' }), g({ id: 'noname', name: ' ' }), g({ id: 'nospawn', spawn: [1, 2] }),
    g({ id: 'noexit', exit: [1, 2, NaN] }), g({ id: 'badhead', heading: 'x' }), g({ id: 'noslots', slots: [] }),
    g({ id: 'allbad', slots: [{ pos: [1, 2] }, null, { pos: [1, 2, 3], heading: 'x' }] }),
    g({ id: 'someok', slots: [{ pos: [1, 2] }, { pos: [4, 5, 6], heading: 7 }, 5, { pos: [1, 1, 1] }] }),
  ];
  const v = houses.validate(d);
  assert.deepStrictEqual(v.garages.map((x) => x.id), ['g', 'someok']);
  assert.deepStrictEqual(v.garages[1].slots, [{ pos: [4, 5, 6], heading: 7 }, { pos: [1, 1, 1], heading: 0 }]);
  for (const text of ['гараж 1: не объект', 'гараж 2: id', 'повторяется id g', 'noname: нет названия', 'nospawn: spawn', 'noexit: exit', 'badhead: heading',
    'noslots: нет ни одного места', 'allbad: нет ни одного места', 'someok, место 1: pos', 'someok, место 3: не объект', 'allbad, место 3: heading']) {
    assert.ok(v.skipped.some((m) => m.includes(text)), `${text}\n${v.skipped.join('\n')}`);
  }
  // More than 50 places: the rest is dropped with one message.
  d.garages = [g({ id: 'many', slots: Array.from({ length: 55 }, (_, i) => ({ pos: [i, 0, 0] })) })];
  const m = houses.validate(d);
  assert.strictEqual(m.garages[0].slots.length, 50);
  assert.strictEqual(m.skipped.length, 1);
  assert.ok(m.skipped[0].includes('50'));
});

test('validate: an unknown garage costs the class or house only the reference; a bad garage point only the point', () => {
  const d = baseDoc();
  d.garages = [goodGarage()];
  d.classes[0].garageInterior = 'nope';
  d.houses[0].garageInterior = 'nope';
  d.houses.push({ id: 2, name: 'null point', cls: 'c', price: 1, door: [0, 0, 0], garagePoint: null });
  d.houses.push({ id: 3, name: 'short', cls: 'c', price: 1, door: [0, 0, 0], garagePoint: { pos: [1, 2] } });
  d.houses.push({ id: 4, name: 'text', cls: 'c', price: 1, door: [0, 0, 0], garagePoint: 'here' });
  d.houses.push({ id: 5, name: 'heading', cls: 'c', price: 1, door: [0, 0, 0], garagePoint: { pos: [1, 2, 3], heading: 'x' } });
  d.houses.push({ id: 6, name: 'null garage', cls: 'c', price: 1, door: [0, 0, 0], garageInterior: null });
  const v = houses.validate(d);
  assert.deepStrictEqual(v.classes.map((c) => c.id), ['c']);
  assert.ok(!('garageInterior' in v.classes[0]));
  assert.deepStrictEqual(v.houses.map((h) => h.id), [1, 2, 3, 4, 5, 6]);
  assert.ok(v.houses.every((h) => !('garagePoint' in h) && !('garageInterior' in h)));
  assert.strictEqual(v.skipped.filter((m) => m.includes('нет гаража nope')).length, 2);
  assert.strictEqual(v.skipped.filter((m) => m.includes('garagePoint')).length, 3, v.skipped.join('\n'));
  assert.strictEqual(v.skipped.length, 5, 'null means none, silently');
});

test('a file without garages works as before: the virtual garage, no way into a garage', (t) => {
  restoreFile(t);
  editFile((d) => { delete d.garages; });
  const { h, p } = owner(t);
  assert.strictEqual(houses.byId(h.id).garageId, null);
  fake.emit('gomp:house:info', p, h.id);
  assert.strictEqual(p.lastCall('gomp:house:info')[0].hasGarage, false);
  assert.strictEqual(p.lastCall('gomp:house:info')[0].garageName, '');
  assert.deepStrictEqual(p.lastCall('gomp:houses')[3], {});
  const veh = vehicles.spawnFor(p, 'sultan');
  fake.emit('gomp:garage:store', p, h.id);
  assert.ok(!mp.vehicles.exists(veh), 'put away at the door');
  assert.strictEqual(h.state.garage.length, 1);
  p.removeFromVehicle();
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  fake.emit('gomp:garage:enter', p, h.id, 'drive');
  assert.strictEqual(p.dimension, 0);
  assert.strictEqual(calls(p, 'gomp:garage:inside'), 0);
  assert.strictEqual(houses.inGarageOf(p), undefined);
});

test('capOf is the least of the class garage and the template places', (t) => {
  restoreFile(t);
  const econom = ofClass('econom')[0];
  const lux = ofClass('lux')[0];
  assert.deepStrictEqual([houses.capOf(econom), houses.capOf(lux)], [2, 10]);
  editFile((d) => {
    d.garages.find((g) => g.id === 'garage10').slots.length = 4;   // fewer places than the class
    d.classes.find((c) => c.id === 'econom').garage = 1;           // fewer in the class than the template
  });
  assert.strictEqual(houses.capOf(houses.byId(lux.id)), 4);
  assert.strictEqual(houses.capOf(houses.byId(econom.id)), 1);
  assert.strictEqual(houses.info(fake.login(fake.join()), houses.byId(lux.id)).cap, 4);
});

test('garage on foot: dimension of its own, the spawn, the cars frozen on their slots', (t) => {
  const { h, p, ch } = owner(t);
  store(h, 2);
  const g = houses.GARAGES.garage2;
  // Not from far away, not from a car, not for a stranger.
  p.position = new mp.Vector3(h.x + 40, h.y, h.z);
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  assert.strictEqual(p.dimension, 0);
  assert.ok(p.notes.at(-1).includes('двери'));
  p.position = door(h);
  const car = vehicles.spawnFor(p, 'blista');
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  assert.strictEqual(p.dimension, 0);
  assert.ok(p.notes.at(-1).includes('Выйдите'));
  p.removeFromVehicle();
  car.destroy();
  const stranger = fake.login(fake.join());
  stranger.position = door(h);
  fake.emit('gomp:garage:enter', stranger, h.id, 'foot');
  assert.strictEqual(stranger.dimension, 0);
  assert.ok(stranger.notes.at(-1).includes('только для владельца'));
  assert.strictEqual(carsIn(h).length, 0);

  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  assert.strictEqual(p.dimension, gd(h));
  assert.deepStrictEqual([p.position.x, p.position.y, p.position.z, p.heading], [...g.spawn, g.heading]);
  assert.deepStrictEqual(p.lastCall('gomp:garage:inside'), [{
    id: h.id, name: h.name, x: g.spawn[0], y: g.spawn[1], z: g.spawn[2], heading: g.heading, exit: g.exit, drive: false,
  }]);
  assert.strictEqual(houses.inGarageOf(p), h.id);
  assert.deepStrictEqual(ch.pos, [h.x, h.y, h.z], 'quitting inside, he comes back at the door');
  const cars = carsIn(h).sort((a, b) => a.numberPlate.localeCompare(b.numberPlate));
  assert.strictEqual(cars.length, 2);
  cars.forEach((v, i) => {
    const s = slotOf(g, i);
    assert.strictEqual(v.movable, false);
    assert.deepStrictEqual(xyz(v), [s[0], s[1], s[2] - 0.5]);
    assert.strictEqual(v.heading, s[3]);
    assert.strictEqual(v.numberPlate, `PL${i}`);
    assert.strictEqual(v.getVariable('owner'), ch.static);
    assert.strictEqual(vehicles.fuelOf(v), 12.5 + i);
    assert.strictEqual(v.model, mp.joaat('sultan'));
  });
  // A second request does nothing.
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  assert.strictEqual(carsIn(h).length, 2);
  assert.strictEqual(calls(p, 'gomp:garage:inside'), 1);
});

test('house to garage: the house hears nothing; garage to house puts him back', (t) => {
  const { h, p } = owner(t);
  store(h, 1);
  fake.emit('gomp:house:enter', p, h.id);
  const n = calls(p, 'gomp:house:inside');
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  assert.strictEqual(houses.insideOf(p), undefined);
  assert.strictEqual(houses.inGarageOf(p), h.id);
  assert.strictEqual(p.dimension, gd(h));
  assert.strictEqual(calls(p, 'gomp:house:inside'), n, 'no house:inside null');
  assert.strictEqual(carsIn(h).length, 1);
  fake.emit('gomp:garage:exit', p, 'house', 0, 0, 0, 0);
  assert.strictEqual(houses.inGarageOf(p), undefined);
  assert.strictEqual(houses.insideOf(p), h.id);
  assert.strictEqual(p.dimension, houses.DIMENSION_BASE + h.id);
  assert.strictEqual(p.lastCall('gomp:house:inside')[0].id, h.id);
  assert.strictEqual(calls(p, 'gomp:garage:inside'), 1, 'the garage hears nothing either');
  assert.strictEqual(carsIn(h).length, 0);
  fake.emit('gomp:house:exit', p);
  assert.deepStrictEqual(xyz(p), [h.x, h.y, h.z]);
  assert.strictEqual(p.dimension, 0);
});

test('drive in: the same vehicle goes to its slot with the driver; the record is made; the others stay outside', (t) => {
  const { h, p, ch } = owner(t);
  const g = houses.GARAGES.garage2;
  const pt = pointOf(h);
  p.position = pt;
  const veh = vehicles.spawnFor(p, 'sultan');
  vehicles.setFuel(veh, 40);
  const other = fake.login(fake.join());
  other.putIntoVehicle(veh, 1);
  assert.strictEqual(p.getVariable('personalVehicle'), veh);

  // Too far; not the driver; not his; then it works.
  veh.position = new mp.Vector3(pt.x + 30, pt.y, pt.z);
  fake.emit('gomp:garage:enter', p, h.id, 'drive');
  assert.strictEqual(p.dimension, 0);
  assert.ok(p.notes.at(-1).includes('Подъедьте'));
  veh.position = pt;
  p.seat = 1;
  fake.emit('gomp:garage:enter', p, h.id, 'drive');
  assert.ok(p.notes.at(-1).includes('Сядьте за руль'));
  p.seat = 0;
  veh.setVariable('owner', ch.static + 1000);
  fake.emit('gomp:garage:enter', p, h.id, 'drive');
  assert.ok(p.notes.at(-1).includes('не ваш'));
  assert.strictEqual(h.state.garage.length, 0);
  veh.setVariable('owner', ch.static);

  fake.emit('gomp:garage:enter', p, h.id, 'drive');
  assert.ok(mp.vehicles.exists(veh), 'the same vehicle');
  assert.strictEqual(p.vehicle, veh);
  assert.deepStrictEqual([p.dimension, veh.dimension], [gd(h), gd(h)]);
  const s = slotOf(g, 0);
  assert.deepStrictEqual(xyz(veh), [s[0], s[1], s[2] - 0.5]);
  assert.strictEqual(veh.heading, s[3]);
  assert.strictEqual(veh.movable, true, 'driven, not frozen');
  assert.strictEqual(other.vehicle, null);
  assert.deepStrictEqual(xyz(other), [pt.x, pt.y, pt.z]);
  assert.ok(other.notes.at(-1).includes('остались снаружи'));
  assert.deepStrictEqual(h.state.garage.map(({ look, ...r }) => r), [{ model: mp.joaat('sultan'), fuel: 40, plate: veh.numberPlate, cls: null, carId: null }]);
  assert.strictEqual(p.getVariable('personalVehicle'), null);
  assert.deepStrictEqual(p.lastCall('gomp:garage:inside'), [{
    id: h.id, name: h.name, x: s[0], y: s[1], z: s[2], heading: s[3], exit: g.exit, drive: true,
  }]);
  assert.ok(p.notes.at(-1).includes('место 1 из 2'));
  assert.deepStrictEqual(ch.pos, [h.x, h.y, h.z]);
  assert.strictEqual(houses.inGarageOf(p), h.id);
});

test('drive in and out again: the out record is reused; the other cars appear, then go with their fuel', (t) => {
  const { h, p } = owner(t);
  store(h, 1, 11);                                   // slot 0: parked when we come
  const pt = pointOf(h);
  const gp = houses.byId(h.id).garagePoint;
  p.position = pt;
  const veh = vehicles.spawnFor(p, 'adder');
  vehicles.setFuel(veh, 30);
  fake.emit('gomp:garage:enter', p, h.id, 'drive');
  assert.strictEqual(h.state.garage.length, 2);
  const parkedCar = carsIn(h).find((v) => v !== veh);
  assert.ok(parkedCar && parkedCar.movable === false);
  vehicles.setFuel(parkedCar, 7.5);
  vehicles.setFuel(veh, 28);
  fake.emit('gomp:garage:exit', p, 'drive', 0, 0, 0, 0);
  // The driven car is out: dimension 0, at the garage point, the way it faces.
  assert.deepStrictEqual([p.dimension, veh.dimension], [0, 0]);
  close(veh.position.x, pt.x); close(veh.position.y, pt.y); close(veh.position.z, pt.z - 0.5);
  assert.strictEqual(veh.heading, gp.heading);
  assert.strictEqual(veh.movable, true);
  assert.ok(!mp.vehicles.exists(parkedCar), 'the others are destroyed');
  assert.strictEqual(h.state.garage[0].fuel, 7.5, 'with their fuel kept');
  assert.strictEqual(h.state.garage[1].fuel, 28);
  assert.strictEqual(houses.inGarageOf(p), undefined);
  assert.strictEqual(houses.info(p, houses.byId(h.id)).garage[1].out, true);
  const m = p.lastCall('gomp:garage:inside');
  assert.strictEqual(m[0], null);
  assert.deepStrictEqual(m[1], { x: pt.x, y: pt.y, z: pt.z, heading: gp.heading, drive: true });
  // Back in: the same place, no new record.
  fake.emit('gomp:garage:enter', p, h.id, 'drive');
  assert.strictEqual(h.state.garage.length, 2);
  const s = slotOf(houses.GARAGES.garage2, 1);
  assert.deepStrictEqual(xyz(veh), [s[0], s[1], s[2] - 0.5]);
  assert.strictEqual(carsIn(h).length, 2);
  // Not on foot out of it with the car on.
  fake.emit('gomp:garage:exit', p, 'house', 0, 0, 0, 0);
  assert.strictEqual(houses.inGarageOf(p), h.id, 'not with the car on');
  assert.ok(p.notes.at(-1).includes('Выйдите'));
});

test('drive in is refused when the garage is full or has no template; without a garage point the door will do', (t) => {
  restoreFile(t);
  const { h, p } = owner(t);
  store(h, 2);
  p.position = pointOf(h);
  const veh = vehicles.spawnFor(p, 'blista');
  fake.emit('gomp:garage:enter', p, h.id, 'drive');
  assert.strictEqual(p.dimension, 0);
  assert.ok(p.notes.at(-1).includes('нет места (2)'));
  h.state.garage.length = 0;

  // No garage point: within 14 m of the door.
  editFile((d) => { delete d.houses.find((x) => x.id === h.id).garagePoint; });
  assert.strictEqual(houses.byId(h.id).garagePoint, null);
  veh.position = new mp.Vector3(h.x + 20, h.y, h.z);
  fake.emit('gomp:garage:enter', p, h.id, 'drive');
  assert.strictEqual(p.dimension, 0);
  veh.position = new mp.Vector3(h.x + 10, h.y, h.z);
  fake.emit('gomp:garage:enter', p, h.id, 'drive');
  assert.strictEqual(p.dimension, gd(h));
  fake.emit('gomp:garage:exit', p, 'drive', 0, 0, 0, 0);
  assert.strictEqual(p.dimension, 0);

  // No template at all: nothing happens.
  editFile((d) => { delete d.classes.find((c) => c.id === 'econom').garageInterior; });
  fake.emit('gomp:garage:enter', p, h.id, 'drive');
  assert.strictEqual(p.dimension, 0);
});

test('drive out without a garage point: the client spot (net +0.5 above it) or next to the door', (t) => {
  restoreFile(t);
  const { h, p } = owner(t);
  editFile((d) => { delete d.houses.find((x) => x.id === h.id).garagePoint; });
  const into = () => {
    p.position = new mp.Vector3(h.x + 1, h.y, h.z);
    const veh = p.vehicle || vehicles.spawnFor(p, 'sultan');
    veh.position = p.position;
    fake.emit('gomp:garage:enter', p, h.id, 'drive');
    return veh;
  };
  const veh = into();
  fake.emit('gomp:garage:exit', p, 'drive', h.x + 12, h.y, h.z - 1, 77);
  close(veh.position.x, h.x + 12); close(veh.position.y, h.y); close(veh.position.z, h.z - 1 + 0.5);
  assert.strictEqual(veh.heading, 77);
  assert.strictEqual(p.lastCall('gomp:garage:inside')[1].heading, 77);
  into();
  fake.emit('gomp:garage:exit', p, 'drive', 0, 0, 0, 0);
  close(veh.position.x, h.x + 3); close(veh.position.y, h.y + 3); close(veh.position.z, h.z - 0.5);
  assert.strictEqual(veh.heading, h.heading);
  into();
  fake.emit('gomp:garage:exit', p, 'drive', h.x + 500, h.y, h.z, 0);
  close(veh.position.x, h.x + 3, 'a spot far away is not taken');
  // Not the driver of a car of the garage: nothing.
  into();
  p.removeFromVehicle();
  fake.emit('gomp:garage:exit', p, 'drive', h.x + 12, h.y, h.z, 0);
  assert.strictEqual(houses.inGarageOf(p), h.id);
  assert.ok(p.notes.at(-1).includes('машины из гаража'));
});

test('exit on foot: to the street at the door, or into the house', (t) => {
  const { h, p } = owner(t);
  store(h, 2);
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  const [a] = carsIn(h);
  vehicles.setFuel(a, 3.5);
  fake.emit('gomp:garage:exit', p, 'street', 0, 0, 0, 0);
  assert.deepStrictEqual([p.dimension, ...xyz(p), p.heading], [0, h.x, h.y, h.z, h.heading]);
  assert.deepStrictEqual(p.lastCall('gomp:garage:inside'), [null, { x: h.x, y: h.y, z: h.z, heading: h.heading, drive: false }]);
  assert.strictEqual(houses.inGarageOf(p), undefined);
  assert.strictEqual(carsIn(h).length, 0);
  assert.ok(!mp.vehicles.exists(a));
  assert.strictEqual(h.state.garage.length, 2, 'the records stay');
  assert.strictEqual(h.state.garage[0].fuel, 3.5);
  fake.emit('gomp:garage:exit', p, 'street', 0, 0, 0, 0);   // not in a garage: nothing
  assert.strictEqual(p.dimension, 0);

  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  fake.emit('gomp:garage:exit', p, 'house', 0, 0, 0, 0);
  assert.deepStrictEqual([p.dimension, houses.insideOf(p)], [houses.DIMENSION_BASE + h.id, h.id]);
  assert.strictEqual(carsIn(h).length, 0);
  fake.emit('gomp:garage:exit', p, 'sideways', 0, 0, 0, 0);
  assert.strictEqual(p.dimension, houses.DIMENSION_BASE + h.id);
});

test('parked cars are frozen unless somebody is at the wheel', (t) => {
  const { h, p } = owner(t);
  store(h, 2);
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  const [a, b] = carsIn(h);
  assert.strictEqual(a.movable, false);
  fake.emit('playerStartEnterVehicle', p, a, 1);
  assert.strictEqual(a.movable, false, 'a seat of a passenger');
  fake.emit('playerStartEnterVehicle', p, a, 0);
  assert.strictEqual(a.movable, true);
  p.putIntoVehicle(a, 0);
  fake.emit('playerEnterVehicle', p, a, 0);
  assert.strictEqual(a.movable, true);
  p.removeFromVehicle();
  fake.emit('playerExitVehicle', p, a);
  assert.strictEqual(a.movable, false);
  // Somebody else still at the wheel: stays free.
  const q = fake.login(fake.join());
  b.movable = true;
  q.putIntoVehicle(b, 0);
  fake.emit('playerExitVehicle', p, b);
  assert.strictEqual(b.movable, true);
  // Other vehicles are not touched.
  const free = vehicles.spawnFor(fake.login(fake.join()), 'blista');
  fake.emit('playerExitVehicle', p, free);
  assert.strictEqual(free.movable, true);
});

test('quitting or dying in the garage: the cars go back into the records', (t) => {
  const { h, p, ch } = owner(t);
  store(h, 2);
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  const [a, b] = carsIn(h);
  vehicles.setFuel(a, 4);
  vehicles.setFuel(b, 5);
  fake.emit('playerDeath', p);
  assert.strictEqual(p.dimension, 0);
  assert.strictEqual(houses.inGarageOf(p), undefined);
  assert.deepStrictEqual(p.lastCall('gomp:garage:inside'), [null]);
  assert.strictEqual(carsIn(h).length, 0);
  assert.deepStrictEqual(h.state.garage.map((r) => r.fuel).sort(), [4, 5]);

  p.position = door(h);   // respawned
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  const [c] = carsIn(h);
  vehicles.setFuel(c, 9);
  fake.emit('playerQuit', p);
  assert.strictEqual(carsIn(h).length, 0);
  assert.strictEqual(houses.inGarageOf(p), undefined);
  assert.ok(h.state.garage.some((r) => r.fuel === 9));
  assert.deepStrictEqual(ch.pos, [h.x, h.y, h.z]);
});

test('selling, taking away or removing the house puts the owner out of the garage', (t) => {
  // Sold: the garage is empty by then.
  let { h, p } = owner(t, 'middle');
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  fake.emit('gomp:house:sell', p, h.id);
  assert.strictEqual(houses.byId(h.id).state.owner, null);
  assert.deepStrictEqual([p.dimension, houses.inGarageOf(p)], [0, undefined]);
  assert.deepStrictEqual(xyz(p), [h.x, h.y, h.z]);
  assert.strictEqual(p.lastCall('gomp:garage:inside')[0], null);

  // Taken away (admin): the cars disappear, nothing is written back.
  ({ h, p } = owner(t, 'middle'));
  store(h, 3);
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  assert.strictEqual(carsIn(h).length, 3);
  assert.strictEqual(houses.evict(h.id), true);
  assert.deepStrictEqual([p.dimension, houses.inGarageOf(p)], [0, undefined]);
  assert.strictEqual(carsIn(h).length, 0);
  assert.deepStrictEqual(houses.byId(h.id).state.garage, []);

  // Removed from the file (admin).
  ({ h, p } = owner(t, 'middle'));
  store(h, 2);
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  assert.strictEqual(houses.removeHouse(h.id), true);
  assert.deepStrictEqual([p.dimension, houses.inGarageOf(p)], [0, undefined]);
  assert.deepStrictEqual(xyz(p), [h.x, h.y, h.z]);
  assert.strictEqual(carsIn(h).length, 0);
  assert.strictEqual(houses.byId(h.id), null);
});

test('reload: a template taken away puts the owner out; changed places refresh him in place', (t) => {
  restoreFile(t);
  const { h, p } = owner(t);
  store(h, 2);
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  const at = xyz(p);
  const n = calls(p, 'gomp:garage:inside');
  editFile((d) => { d.houses.find((x) => x.id === h.id).price = 99999; });
  assert.strictEqual(calls(p, 'gomp:garage:inside'), n, 'nothing about the garage changed');
  editFile((d) => {
    const g = d.garages.find((x) => x.id === 'garage2');
    g.exit = [100, 101, -99];
    g.slots[0].pos = [172.4, -1004, -99];
  });
  assert.strictEqual(calls(p, 'gomp:garage:inside'), n + 1);
  const m = p.lastCall('gomp:garage:inside')[0];
  assert.strictEqual(m.refresh, true);
  assert.deepStrictEqual(m.exit, [100, 101, -99]);
  assert.deepStrictEqual(xyz(p), at, 'not moved');
  assert.strictEqual(p.dimension, gd(h));
  const first = carsIn(h).find((v) => v.numberPlate === 'PL0');
  close(first.position.x, 172.4, 'the car follows its place');

  editFile((d) => { delete d.classes.find((c) => c.id === 'econom').garageInterior; });
  assert.strictEqual(p.dimension, 0);
  assert.deepStrictEqual(xyz(p), [h.x, h.y, h.z]);
  assert.strictEqual(houses.inGarageOf(p), undefined);
  assert.strictEqual(p.lastCall('gomp:garage:inside')[0], null);
  assert.strictEqual(carsIn(h).length, 0);
  assert.strictEqual(h.state.garage.length, 2);
});

test('take uses the garage point; a parked car is not taken or released', (t) => {
  const { h, p, ch } = owner(t);
  store(h, 2);
  const pt = pointOf(h);
  const gp = houses.byId(h.id).garagePoint;
  p.position = door(h);
  fake.emit('gomp:garage:take', p, h.id, 0, h.x + 10, h.y, h.z, 33);
  const out = mp.vehicles.toArray().find((v) => v.numberPlate === 'PL0' && v.dimension === 0 && v.getVariable('owner') === ch.static);
  assert.ok(out);
  close(out.position.x, pt.x); close(out.position.y, pt.y); close(out.position.z, pt.z - 0.5);
  assert.strictEqual(out.heading, gp.heading);
  assert.strictEqual(vehicles.fuelOf(out), 12.5);

  // Inside, the other one stands parked: it is neither taken nor released.
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  const parkedCar = carsIn(h)[0];
  assert.strictEqual(parkedCar.numberPlate, 'PL1');
  fake.emit('gomp:garage:take', p, h.id, 1, 0, 0, 0, 0);
  assert.ok(p.notes.at(-1).includes('стоит в гараже'));
  fake.emit('gomp:garage:release', p, h.id, 1, 0, 0, 0, 0);
  assert.ok(p.notes.at(-1).includes('стоит в гараже'));
  assert.strictEqual(h.state.garage.length, 2);
  assert.ok(mp.vehicles.exists(parkedCar));
});

test('admin: /house garage and /garage change the file', (t) => {
  restoreFile(t);
  const { h, p } = owner(t);
  p.position = new mp.Vector3(10.5, 20.5, 30.5);
  p.heading = 45;
  fake.command(p, `/house garage ${h.id}`);
  assert.deepStrictEqual(fileDoc().houses.find((x) => x.id === h.id).garagePoint, { pos: [10.5, 20.5, 30.5], heading: 45 });
  assert.deepStrictEqual(houses.byId(h.id).garagePoint, { pos: [10.5, 20.5, 30.5], heading: 45 });
  const veh = vehicles.spawnFor(p, 'sultan');
  veh.position = new mp.Vector3(1, 2, 3);
  veh.heading = 200;
  fake.command(p, `/house garage ${h.id}`);
  assert.deepStrictEqual(fileDoc().houses.find((x) => x.id === h.id).garagePoint, { pos: [1, 2, 3.5], heading: 200 }, 'a driver: the vehicle, 0.5 higher');
  p.removeFromVehicle();
  fake.command(p, `/house garage ${h.id} off`);
  assert.ok(!('garagePoint' in fileDoc().houses.find((x) => x.id === h.id)));
  assert.strictEqual(houses.byId(h.id).garagePoint, null);
  assert.strictEqual(houses.reload().changed, false, 'our own write');

  fake.command(p, '/garage spawn');
  assert.ok(p.chat.at(-1).includes('внутри гаража'));
  p.position = door(h);
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  const before = fileDoc().garages.find((g) => g.id === 'garage6');
  p.position = new mp.Vector3(1.5, 2.5, 3.5);
  p.heading = 77;
  fake.command(p, '/garage spawn');
  p.position = new mp.Vector3(9, 8, 7);
  fake.command(p, '/garage exit');
  p.position = new mp.Vector3(4, 5, 6);
  p.heading = 10;
  fake.command(p, '/garage slot 2');
  fake.command(p, '/garage slot 3');
  fake.command(p, '/garage slot 5');
  assert.ok(p.chat.at(-1).includes('Место'));
  const g = fileDoc().garages.find((x) => x.id === 'garage2');
  assert.deepStrictEqual([g.spawn, g.heading, g.exit], [[1.5, 2.5, 3.5], 77, [9, 8, 7]]);
  assert.deepStrictEqual(g.slots.slice(1), [{ pos: [4, 5, 6], heading: 10 }, { pos: [4, 5, 6], heading: 10 }]);
  assert.deepStrictEqual(fileDoc().garages.find((x) => x.id === 'garage6'), before, 'the other templates are not touched');
  assert.strictEqual(p.lastCall('gomp:garage:inside')[0].refresh, true);
  assert.deepStrictEqual(p.lastCall('gomp:garage:inside')[0].exit, [9, 8, 7]);
  fake.emit('gomp:garage:exit', p, 'street', 0, 0, 0, 0);
});

test('spawnInside and sendInside: appearing at home', (t) => {
  const { h, p, ch } = owner(t);
  const it = houses.INTERIORS.studio;
  p.position = new mp.Vector3(5, 5, 5);
  assert.strictEqual(houses.spawnInside(p, h), true);
  assert.deepStrictEqual([p.dimension, ...xyz(p), p.heading], [houses.DIMENSION_BASE + h.id, ...it.spawn, it.heading]);
  assert.strictEqual(houses.insideOf(p), h.id);
  assert.deepStrictEqual(ch.pos, [h.x, h.y, h.z]);
  const n = calls(p, 'gomp:house:inside');
  houses.sendInside(p);
  assert.strictEqual(calls(p, 'gomp:house:inside'), n + 1);
  assert.strictEqual(p.lastCall('gomp:house:inside')[0].id, h.id);
  fake.emit('gomp:house:exit', p);
  assert.deepStrictEqual([p.dimension, ...xyz(p)], [0, h.x, h.y, h.z]);
  const m = calls(p, 'gomp:house:inside');
  houses.sendInside(p);
  assert.strictEqual(calls(p, 'gomp:house:inside'), m, 'nothing to send outside');
  assert.strictEqual(houses.spawnInside(fake.join(), h), false, 'no character, no spawn');
  // Where the starter vehicle is left.
  const spot = houses.garageSpot(h);
  assert.deepStrictEqual([spot.x, spot.y, spot.z, spot.heading], [...houses.byId(h.id).garagePoint.pos, houses.byId(h.id).garagePoint.heading]);
});

test('server shutdown keeps the fuel of vehicles outside and in garages', (t) => {
  const { h, p, ch } = owner(t);
  store(h, 2);
  fake.emit('gomp:garage:take', p, h.id, 0, h.x, h.y, h.z, 0);
  const out = mp.vehicles.toArray().find((v) => v.numberPlate === 'PL0' && v.dimension === 0 && v.getVariable('owner') === ch.static);
  vehicles.setFuel(out, 2.5);
  fake.emit('gomp:garage:enter', p, h.id, 'foot');
  const inCar = carsIn(h)[0];
  vehicles.setFuel(inCar, 3.5);
  fake.emit('serverShutdown');
  assert.deepStrictEqual(h.state.garage.map((r) => r.fuel), [2.5, 3.5]);
  fake.emit('gomp:garage:exit', p, 'street', 0, 0, 0, 0);
});
