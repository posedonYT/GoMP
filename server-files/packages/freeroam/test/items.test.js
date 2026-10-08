const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
require('./fakemp');
const { ITEMS, resolve } = require('../items');

const ICONS = path.join(__dirname, '..', '..', '..', '..', 'client-dist', 'gomp', 'icons');

test('item names resolve to keys', () => {
  assert.strictEqual(resolve('pistol'), 'weapon_pistol');
  assert.strictEqual(resolve('weapon_pistol'), 'weapon_pistol');
  assert.strictEqual(resolve('pistol_mk2'), 'weapon_pistol_mk2');
  assert.strictEqual(resolve('pistolmk2'), 'weapon_pistol_mk2');
  assert.strictEqual(resolve('HEAVYSNIPER_MK2'), 'weapon_heavysniper_mk2');
  assert.strictEqual(resolve('ammo_pistol'), 'ammo_pistol');
  assert.strictEqual(resolve('аптечка'), 'medkit');
  assert.strictEqual(resolve('Канистра'), 'jerrycan');
  assert.strictEqual(resolve('no-such-item'), null);
  assert.strictEqual(resolve(''), null);
});

test('every item has an icon file', () => {
  const missing = [...new Set(Object.values(ITEMS).map((d) => d.icon))].filter((icon) => !fs.existsSync(path.join(ICONS, `${icon}.png`)));
  assert.deepStrictEqual(missing, []);
});

test('weapons fire existing ammunition; guns do not stack, throwables do', () => {
  for (const d of Object.values(ITEMS).filter((i) => i.type === 'weapon')) {
    if (d.ammo) assert.ok(ITEMS[d.ammo], `${d.key}: no ammunition item ${d.ammo}`);
    if (d.group === 'thrown') {
      assert.strictEqual(d.ammo, d.key, `${d.key} is its own ammunition`);
      assert.ok(d.stack > 1, `${d.key} stacks`);
    } else {
      assert.strictEqual(d.stack, 1, `${d.key} does not stack`);
    }
  }
});

test('the standard weapons asked for are there, with Mk II versions', () => {
  for (const key of ['weapon_pistol', 'weapon_pistol_mk2', 'weapon_specialcarbine', 'weapon_specialcarbine_mk2',
    'weapon_heavysniper', 'weapon_heavysniper_mk2', 'weapon_carbinerifle_mk2', 'weapon_combatmg_mk2'])
    assert.ok(ITEMS[key], key);
});

test('every ammunition item is used by a weapon', () => {
  const used = new Set(Object.values(ITEMS).map((d) => d.ammo).filter(Boolean));
  for (const d of Object.values(ITEMS).filter((i) => i.type === 'ammo')) assert.ok(used.has(d.key), `${d.key} is not used`);
});

test('consumables stack and do something', () => {
  for (const key of ['bandage', 'medkit', 'water', 'burger', 'repairkit', 'jerrycan']) {
    const d = ITEMS[key];
    assert.ok(d.stack > 1, `${key} stacks`);
    assert.ok(d.heal || d.armour || d.type === 'tool', `${key} has an effect`);
  }
});
