const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fakemp');
require('../index');
const vehicles = require('../vehicles');

// Every test drives somewhere else, so 'the nearest vehicle' is its own.
let spot = 0;
function driverIn(model = 'blista') {
  const p = fake.login(fake.join());
  spot += 1;
  p.position = new mp.Vector3(spot * 100, 0, 0);
  const veh = vehicles.spawnFor(p, model);
  return { p, veh };
}

test('/veh spawns an owned vehicle with a full tank and puts the player in', () => {
  const p = fake.login(fake.join());
  fake.command(p, '/veh vaz2107');
  const veh = p.vehicle;
  assert.ok(veh, 'in a vehicle');
  assert.strictEqual(veh.model, mp.joaat('lada2107'));
  assert.strictEqual(veh.getVariable('owner'), p.getVariable('static'));
  assert.strictEqual(veh.getVariable('fuel'), vehicles.DEFAULT_TANK);
  assert.match(veh.numberPlate, /^GO\d{5}$/);
  assert.strictEqual(p.getVariable('personalVehicle'), veh);
  // A second /veh replaces the first vehicle.
  fake.command(p, '/veh jesko');
  assert.ok(!fake.vehicles.exists(veh));
  assert.strictEqual(p.vehicle.model, mp.joaat('jesko'));
});

test('vehicle names: aliases, veh: prefix, and what /give takes as a vehicle', () => {
  assert.strictEqual(vehicles.modelOf('Agera'), 'agerars');
  assert.strictEqual(vehicles.modelOf('regera'), 'krga');
  assert.strictEqual(vehicles.modelOf('ВАЗ2107'), 'lada2107');
  assert.strictEqual(vehicles.modelOf('BMW'), 'm5');
  assert.strictEqual(vehicles.modelOf('m5'), 'm5');
  assert.strictEqual(vehicles.modelOf('rs7'), '20rs7c8');
  assert.strictEqual(vehicles.modelOf('Audi'), '20rs7c8');
  assert.strictEqual(vehicles.modelOf('Infinity'), 'g37s');
  assert.strictEqual(vehicles.modelOf('g37'), 'g37s');
  assert.ok(vehicles.isVehicleName('g37s'));
  assert.strictEqual(vehicles.modelOf('veh:sultan'), 'sultan');
  assert.strictEqual(vehicles.modelOf('sultan'), 'sultan');
  assert.ok(vehicles.isVehicleName('vaz2107'));
  assert.ok(vehicles.isVehicleName('veh:adder'));
  assert.ok(!vehicles.isVehicleName('pistol'));
  assert.ok(!vehicles.isVehicleName('12'), 'a static is never a vehicle');
});

test('fuel burns faster at speed and the engine stops on an empty tank', () => {
  assert.ok(vehicles.consumption(100) > vehicles.consumption(0));
  assert.ok(vehicles.consumption(100, 1.4) > vehicles.consumption(100, 1));
  const { p, veh } = driverIn();
  veh.engine = true;
  fake.tick();  // first sample: no distance yet
  const before = vehicles.fuelOf(veh);
  veh.position = veh.position.add(new mp.Vector3(30, 0, 0));  // 30 m in a second: 108 km/h
  fake.tick();
  const burnt = before - vehicles.fuelOf(veh);
  assert.ok(Math.abs(burnt - vehicles.consumption(108)) < 1e-9, `burnt ${burnt}`);
  // Idle consumption adds up although clients see one decimal.
  const idle = vehicles.fuelOf(veh);
  for (let i = 0; i < 20; i++) fake.tick();
  assert.ok(Math.abs(idle - vehicles.fuelOf(veh) - 20 * vehicles.consumption(0)) < 1e-9);
  assert.strictEqual(veh.getVariable('fuel'), Math.round(vehicles.fuelOf(veh) * 10) / 10);

  vehicles.setFuel(veh, 0.005);
  fake.tick();
  assert.strictEqual(vehicles.fuelOf(veh), 0);
  assert.strictEqual(veh.engine, false);
  assert.ok(p.notes.some((n) => /Закончилось топливо/.test(n)));
});

test('the driver reports the class: tank size and the fuel ratio are kept', () => {
  const { p, veh } = driverIn('bati');
  vehicles.setFuel(veh, 30);  // half of 60 l
  fake.emit('gomp:veh:class', p, veh.id, 8);  // motorcycle: 15 l
  assert.strictEqual(vehicles.tankOf(veh), 15);
  assert.strictEqual(vehicles.fuelOf(veh), 7.5);
  fake.emit('gomp:veh:class', p, veh.id, 7);  // only once
  assert.strictEqual(vehicles.tankOf(veh), 15);
});

test('refuelling never overfills the tank', () => {
  const { veh } = driverIn();
  vehicles.setFuel(veh, 50);
  assert.strictEqual(vehicles.refuel(veh, 20), 10);
  assert.strictEqual(vehicles.fuelOf(veh), 60);
});

test('only the owner locks a vehicle (L), with lights and a beep for players nearby', () => {
  const { p, veh } = driverIn();
  p.vehicle = null;
  p.position = veh.position.add(new mp.Vector3(2, 0, 0));
  const stranger = fake.login(fake.join());
  stranger.position = p.position;
  fake.emit('gomp:veh:lock', stranger);
  assert.strictEqual(veh.locked, false);
  assert.ok(stranger.notes.some((n) => /нет вашего транспорта/.test(n)));
  fake.emit('gomp:veh:lock', p, veh.id);
  assert.strictEqual(veh.locked, true);
  assert.ok(stranger.lastCall('gomp:veh:lockfx'), 'others see the lights');
  fake.emit('gomp:veh:lock', p);
  assert.strictEqual(veh.locked, false);
});

test('doors open and shut, but not on a locked vehicle from outside', () => {
  const { p, veh } = driverIn();
  fake.emit('gomp:veh:door', p, veh.id, 4);
  assert.strictEqual(veh.getVariable('doors'), 1 << 4);
  fake.emit('gomp:veh:door', p, veh.id, 4);
  assert.strictEqual(veh.getVariable('doors'), 0);
  veh.locked = true;
  p.vehicle = null;
  p.position = veh.position;
  fake.emit('gomp:veh:door', p, veh.id, 5);
  assert.strictEqual(veh.getVariable('doors'), 0);
  fake.emit('gomp:veh:door', p, veh.id, 9);  // no such door
  assert.strictEqual(veh.getVariable('doors'), 0);
});

test('a repair kit fixes a nearby vehicle after the repair time', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, veh } = driverIn();
  const inventory = require('../inventory');
  const ch = require('../roleplay').character(p);
  inventory.give(p, ch, 'repairkit', 1);
  p.vehicle = null;
  p.position = veh.position.add(new mp.Vector3(1, 0, 0));
  veh.engineHealth = 300;
  fake.emit('gomp:inv:usekey', p, 'repairkit');
  assert.ok(p.anims.some((a) => /repair/.test(a)), `repair animation: ${p.notes.join(' / ')}`);
  t.mock.timers.tick(6000);
  assert.strictEqual(veh.engineHealth, 1000);
  assert.strictEqual(inventory.countOf(ch, 'repairkit'), 0);
});
