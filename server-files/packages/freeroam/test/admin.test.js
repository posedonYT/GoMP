const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fakemp');
require('../index');
const roleplay = require('../roleplay');
const inventory = require('../inventory');
const vehicles = require('../vehicles');

test('/give without a static gives the item to the admin', () => {
  const admin = fake.login(fake.join());
  fake.command(admin, '/give heavysniper 40');
  const ch = roleplay.character(admin);
  assert.strictEqual(inventory.countOf(ch, 'weapon_heavysniper'), 1);
  assert.strictEqual(inventory.countOf(ch, 'ammo_heavysniper'), 40);
});

test('/give <vehicle> spawns an owned vehicle next to the player', () => {
  const admin = fake.login(fake.join());
  const player = fake.login(fake.join({ name: 'Other' }));
  fake.command(admin, `/give ${player.getVariable('static')} vaz2107`);
  const veh = player.getVariable('personalVehicle');
  assert.ok(veh && fake.vehicles.exists(veh), 'vehicle spawned');
  assert.strictEqual(veh.model, mp.joaat('lada2107'));
  assert.strictEqual(veh.getVariable('owner'), player.getVariable('static'));
  assert.strictEqual(player.vehicle, null, 'it stands next to the player');
  assert.ok(player.notes.some((n) => /lada2107/.test(n)));

  fake.command(admin, '/give agera');
  assert.strictEqual(admin.getVariable('personalVehicle').model, mp.joaat('agerars'));
  fake.command(admin, '/give veh:sultan');
  assert.strictEqual(admin.getVariable('personalVehicle').model, mp.joaat('sultan'));
});

test('/setfuel and /fixveh work on the vehicle next to the admin', () => {
  const admin = fake.login(fake.join());
  const veh = vehicles.spawnFor(admin, 'blista');
  fake.command(admin, '/setfuel 12');
  assert.strictEqual(vehicles.fuelOf(veh), 12);
  veh.engineHealth = 100;
  fake.command(admin, '/fixveh');
  assert.strictEqual(veh.engineHealth, 1000);
});

test('players who are not admins cannot use admin commands', () => {
  const p = fake.login(fake.join({ ip: '10.0.0.5' }));
  fake.command(p, '/give medkit 5');
  assert.strictEqual(inventory.countOf(roleplay.character(p), 'medkit'), 0);
  assert.ok(p.chat.some((m) => /Нет прав/.test(m)));
});
