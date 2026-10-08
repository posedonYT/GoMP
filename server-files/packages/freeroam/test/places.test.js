const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fakemp');
require('../index');
const roleplay = require('../roleplay');
const inventory = require('../inventory');
const vehicles = require('../vehicles');
const places = require('../places');

const at = (pl) => new mp.Vector3(pl.x, pl.y, pl.z);
const first = (type) => places.places.find((p) => p.type === type);

test('gas stations, 24/7 shops and tuning shops have map blips', () => {
  for (const type of ['fuel', 'shop', 'tune']) assert.ok(first(type), type);
  assert.strictEqual(fake.blips.length, places.places.length);
  assert.ok(fake.blips.toArray().some((b) => b.sprite === 361), 'gas station blip');
  assert.ok(fake.blips.toArray().some((b) => b.sprite === 52), '24/7 blip');
  assert.ok(fake.blips.toArray().some((b) => b.sprite === 72), 'LSC blip');
});

test('a 24/7 shop sells at the till, for cash or by card', () => {
  const p = fake.login(fake.join());
  const ch = roleplay.character(p);
  const shop = 0;
  fake.emit('gomp:shop:buy', p, shop, 'medkit', 2, 'cash');
  assert.strictEqual(inventory.countOf(ch, 'medkit'), 0, 'not at the till');
  p.position = at(places.places.filter((x) => x.type === 'shop')[shop]);
  const cash = ch.cash;
  fake.emit('gomp:shop:buy', p, shop, 'medkit', 2, 'cash');
  assert.strictEqual(inventory.countOf(ch, 'medkit'), 2);
  assert.strictEqual(ch.cash, cash - 2 * 350);
  const bank = ch.bank;
  fake.emit('gomp:shop:buy', p, shop, 'repairkit', 1, 'bank');
  assert.strictEqual(inventory.countOf(ch, 'repairkit'), 1);
  assert.strictEqual(ch.bank, bank - 500);
  fake.emit('gomp:shop:buy', p, shop, 'weapon_pistol', 1, 'cash');  // not sold here
  assert.strictEqual(inventory.countOf(ch, 'weapon_pistol'), 0);
});

test('a shop refuses when there is no money', () => {
  const p = fake.login(fake.join());
  const ch = roleplay.character(p);
  p.position = at(first('shop'));
  roleplay.setMoney(p, 10, 0);
  fake.emit('gomp:shop:buy', p, 0, 'medkit', 1, 'cash');
  assert.strictEqual(inventory.countOf(ch, 'medkit'), 0);
  assert.strictEqual(ch.cash, 10);
  assert.ok(p.notes.some((n) => /Недостаточно денег/.test(n)));
});

test('a gas station refuels a stopped vehicle and charges per litre', () => {
  const p = fake.login(fake.join());
  const ch = roleplay.character(p);
  p.position = at(first('fuel'));
  const veh = vehicles.spawnFor(p, 'blista');
  vehicles.setFuel(veh, 20);
  veh.engine = true;
  fake.emit('gomp:fuel:buy', p, veh.id, 30, 'cash');
  assert.strictEqual(vehicles.fuelOf(veh), 20, 'the engine must be off');
  veh.engine = false;
  const cash = ch.cash;
  fake.emit('gomp:fuel:buy', p, veh.id, 30, 'cash');
  assert.strictEqual(vehicles.fuelOf(veh), 50);
  assert.strictEqual(ch.cash, cash - 30 * places.FUEL_PRICE);
  fake.emit('gomp:fuel:buy', p, veh.id, 100, 'cash');  // only what fits
  assert.strictEqual(vehicles.fuelOf(veh), 60);
});

test('no refuelling away from a gas station', () => {
  const p = fake.login(fake.join());
  p.position = new mp.Vector3(5000, 5000, 0);
  const veh = vehicles.spawnFor(p, 'blista');
  vehicles.setFuel(veh, 10);
  veh.engine = false;
  fake.emit('gomp:fuel:buy', p, veh.id, 10, 'cash');
  assert.strictEqual(vehicles.fuelOf(veh), 10);
});

test('a jerry can adds 20 litres to a vehicle nearby', () => {
  const p = fake.login(fake.join());
  const ch = roleplay.character(p);
  const veh = vehicles.spawnFor(p, 'blista', { putIn: false });
  vehicles.setFuel(veh, 5);
  p.position = veh.position;
  inventory.give(p, ch, 'jerrycan', 1);
  fake.emit('gomp:inv:usekey', p, 'jerrycan');
  assert.strictEqual(vehicles.fuelOf(veh), 25);
  assert.strictEqual(inventory.countOf(ch, 'jerrycan'), 0);
});
