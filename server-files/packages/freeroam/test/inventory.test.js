const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fakemp');
require('../index');
const roleplay = require('../roleplay');
const inventory = require('../inventory');

function newPlayer() {
  return fake.login(fake.join());
}

const slotsOf = (ch, key) => ['pockets', 'hotbar'].flatMap((c) => ch.inventory[c]).filter((s) => s && s.key === key);

test('a new character starts with an inventory and a synced client', () => {
  const p = newPlayer();
  const ch = roleplay.character(p);
  assert.ok(ch, 'character in the game');
  assert.strictEqual(ch.inventory.pockets.length, 24);
  assert.strictEqual(ch.inventory.hotbar.length, 9);
  assert.strictEqual(inventory.countOf(ch, 'bandage'), 3);
  assert.ok(p.lastCall('gomp:inv:sync'), 'inventory sent');
  assert.ok(p.lastCall('gomp:places'), 'places sent');
});

test('giving a gun with a number gives its ammunition', () => {
  const p = newPlayer();
  const ch = roleplay.character(p);
  const msg = inventory.give(p, ch, 'carbinerifle', 500);
  assert.match(msg, /Карабин/);
  assert.strictEqual(slotsOf(ch, 'weapon_carbinerifle').length, 1);
  assert.strictEqual(inventory.countOf(ch, 'ammo_rifle'), 500);
  assert.strictEqual(slotsOf(ch, 'ammo_rifle').length, 2, '300 + 200 in two stacks');
});

test('grenades stack and are their own ammunition', () => {
  const p = newPlayer();
  const ch = roleplay.character(p);
  inventory.give(p, ch, 'grenade', 5);
  assert.strictEqual(inventory.countOf(ch, 'weapon_grenade'), 5);
  assert.strictEqual(slotsOf(ch, 'weapon_grenade').length, 1);
});

test('a weapon is drawn from the hotbar with all its ammunition, and shots use it up', () => {
  const p = newPlayer();
  const ch = roleplay.character(p);
  inventory.give(p, ch, 'pistol', 100);
  const from = ch.inventory.pockets.findIndex((s) => s && s.key === 'weapon_pistol');
  fake.emit('gomp:inv:move', p, 'pockets', from, 'hotbar', 0, 1);
  fake.emit('gomp:inv:hotkey', p, 1);
  const hash = mp.joaat('weapon_pistol');
  assert.strictEqual(p.getWeaponAmmo(hash), 100);
  p.weapons.set(hash, 70);  // 30 shots
  inventory.reconcileAmmo(p, ch);
  assert.strictEqual(inventory.countOf(ch, 'ammo_pistol'), 70);
  fake.emit('gomp:inv:hotkey', p, 1);  // again: put away
  assert.strictEqual(p.weapons.size, 0);
});

test('a bandage is not wasted at full health but heals when hurt', () => {
  const p = newPlayer();
  const ch = roleplay.character(p);
  const i = ch.inventory.pockets.findIndex((s) => s && s.key === 'bandage');
  fake.emit('gomp:inv:use', p, 'pockets', i);
  assert.strictEqual(inventory.countOf(ch, 'bandage'), 3);
  p.health = 50;
  fake.emit('gomp:inv:use', p, 'pockets', i);
  assert.strictEqual(p.health, 70);
  assert.strictEqual(inventory.countOf(ch, 'bandage'), 2);
});

test('space checks count free slots and partial stacks', () => {
  const p = newPlayer();
  const ch = roleplay.character(p);
  const free = ['pockets', 'hotbar'].flatMap((c) => ch.inventory[c]).filter((s) => !s).length;
  assert.strictEqual(inventory.spaceShortage(ch, 'medkit', free * 5), 0);
  assert.strictEqual(inventory.spaceShortage(ch, 'medkit', free * 5 + 3), 3);
});

test('dropped items lie on the ground and can be picked up again', () => {
  const p = newPlayer();
  const ch = roleplay.character(p);
  inventory.give(p, ch, 'specialcarbine', 1);
  const i = ch.inventory.pockets.findIndex((s) => s && s.key === 'weapon_specialcarbine');
  const uid = ch.inventory.pockets[i].uid;
  fake.emit('gomp:inv:drop', p, 'pockets', i);
  assert.strictEqual(slotsOf(ch, 'weapon_specialcarbine').length, 0);
  const drop = fake.objects.toArray().find((o) => o.getVariable('drop') && o.getVariable('drop').key === 'weapon_specialcarbine');
  assert.ok(drop, 'an object on the ground');
  assert.strictEqual(drop.model, mp.joaat('w_ar_specialcarbine'));

  // Dead players and players in vehicles cannot pick it up.
  p.dead = true;
  fake.emit('gomp:drop:pickup', p, drop.id);
  assert.ok(fake.objects.exists(drop));
  p.dead = false;
  fake.emit('gomp:drop:pickup', p, drop.id);
  assert.ok(!fake.objects.exists(drop), 'picked up');
  assert.strictEqual(slotsOf(ch, 'weapon_specialcarbine')[0].uid, uid, 'the same weapon (serial number)');
});

test('part of a stack can be dropped; nothing is dropped from a vehicle', () => {
  const p = newPlayer();
  const ch = roleplay.character(p);
  inventory.give(p, ch, 'ammo_pistol', 100);
  const i = ch.inventory.pockets.findIndex((s) => s && s.key === 'ammo_pistol');
  fake.emit('gomp:inv:drop', p, 'pockets', i, 40);
  assert.strictEqual(inventory.countOf(ch, 'ammo_pistol'), 60);
  p.vehicle = fake.vehicles.new(mp.joaat('blista'), new mp.Vector3());
  fake.emit('gomp:inv:drop', p, 'pockets', i, 10);
  assert.strictEqual(inventory.countOf(ch, 'ammo_pistol'), 60);
});
