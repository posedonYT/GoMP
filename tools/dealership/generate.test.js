// node --test tools/dealership
const test = require('node:test');
const assert = require('node:assert');
const { buildCatalog, priceOf, sellable } = require('./generate');

const car = (model, cls, speed, extra = {}) => ({ model, make: 'X', gameName: model.toUpperCase(), class: cls, type: 'VEHICLE_TYPE_CAR', speed, flags: '', ...extra });

test('prices follow the class and the top speed, rounded to $500', () => {
  assert.strictEqual(priceOf(1, 135), 22000, 'a typical sedan');
  assert.ok(priceOf(7, 160) > priceOf(7, 150), 'faster costs more');
  assert.ok(priceOf(0, 120) < priceOf(1, 120), 'a compact is cheaper than a sedan');
  for (const p of [priceOf(6, 1), priceOf(6, 900), priceOf(8, 0)]) assert.strictEqual(p % 500, 0);
  assert.strictEqual(priceOf(6, 900), 110000 * 2.5, 'capped');
});

test('only cars and bikes of the sold classes, nothing armed or for Arena War', () => {
  assert.ok(sellable(car('sultan', 6, 150)));
  assert.ok(!sellable(car('police', 18, 150)), 'emergency');
  assert.ok(!sellable(car('buzzard', 15, 150)), 'helicopter');
  assert.ok(!sellable(car('trailer', 1, 0, { type: 'VEHICLE_TYPE_TRAILER' })));
  assert.ok(!sellable(car('insurgent', 9, 120, { flags: 'FLAG_X FLAG_HAS_TURRET_SEAT_ON_VEHICLE' })));
  assert.ok(!sellable(car('deathbike', 8, 120, { flags: 'FLAG_HAS_WEAPON_SPIKE_MODS' })));
  assert.ok(sellable(car('bati', 8, 140, { type: 'VEHICLE_TYPE_BIKE' })));
});

test('custom cars come from the packs; hand-made prices and moved points survive a new run', () => {
  const game = [car('sultan', 6, 150), car('m5', 6, 160), car('police', 18, 150)];
  const packs = [{ pack: 'm5', models: [{ model: 'm5', cls: 'VC_SPORT', gameName: 'M5' }] }, { pack: 'odd', models: [{ model: 'plane1', cls: 'VC_PLANE' }] }];
  const doc = buildCatalog(game, packs);
  assert.strictEqual(doc.format, 'gomp-dealership');
  assert.deepStrictEqual(doc.vehicles.map((v) => [v.model, v.custom]), [['m5', true], ['sultan', false]]);
  assert.strictEqual(doc.vehicles[0].name, 'BMW M5 F10');
  assert.ok(doc.spawns.length && doc.colors.length);
  // Edited by hand, then regenerated.
  doc.vehicles[1].price = 12345;
  doc.marker = [1, 2, 3];
  const again = buildCatalog(game, packs, doc);
  assert.strictEqual(again.vehicles.find((v) => v.model === 'sultan').price, 12345);
  assert.deepStrictEqual(again.marker, [1, 2, 3]);
});
