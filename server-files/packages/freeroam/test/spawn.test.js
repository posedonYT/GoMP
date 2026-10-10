const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fakemp');
require('../index');
const roleplay = require('../roleplay');
const houses = require('../houses');

const door = (h) => new mp.Vector3(h.x, h.y, h.z);
let used = 0;
// A different free house for every test (they share the database).
function freeHouse() {
  const h = houses.list().filter((x) => x.cls === 'econom' && x.state.owner === null)[used++ % 2];
  assert.ok(h, 'a free house');
  return h;
}

// A character who has played (kit 1: with a starter car), optionally owns a house, and has left the game.
// Returns the account login and the character, ready for a new session.
function veteran({ house = null, pos = [10, 20, 30] } = {}) {
  const p = fake.login(fake.join(), { kit: 1 });
  const ch = roleplay.character(p);
  assert.ok(ch.vehicle, 'the kit has a car');
  if (house) {
    roleplay.setMoney(p, 2000000, 2000000);
    p.position = door(house);
    fake.emit('gomp:house:buy', p, house.id, 'cash');
    assert.strictEqual(houses.ownedBy(ch.static).id, house.id);
  }
  p.position = new mp.Vector3(...pos);
  p.dimension = 0;
  const login = p.own.account;
  fake.emit('playerQuit', p);
  p.destroy();
  assert.deepStrictEqual(ch.pos, pos, 'position saved');
  return { login, ch };
}

// A new connection logs in and picks the character: the spawn screen is up.
function selecting({ login, ch }) {
  const p = fake.join();
  fake.emit('gomp:auth:login', p, login, 'password123');
  assert.ok(p.lastCall('gomp:chars:show'), 'character list shown');
  fake.emit('gomp:chars:select', p, ch.id);
  return p;
}

test('spawn: selecting a character shows the screen instead of spawning; the house option only for an owner', () => {
  const v = veteran();
  const p = selecting(v);
  const [options] = p.lastCall('gomp:spawn:show');
  assert.strictEqual(options.length, 1);
  assert.strictEqual(options[0].id, 'last');
  assert.strictEqual(options[0].title, 'Там, где вышел');
  assert.deepStrictEqual(options[0].pos, v.ch.pos);
  assert.ok(!roleplay.isLogged(p), 'not in the game yet');
  assert.strictEqual(p.lastCall('gomp:ui:close'), undefined);
  assert.notStrictEqual(p.dimension, 0, 'still in the lobby dimension');

  const h = freeHouse();
  const q = selecting(veteran({ house: h }));
  const opts = q.lastCall('gomp:spawn:show')[0];
  assert.deepStrictEqual(opts.map((o) => o.id), ['last', 'house']);
  assert.strictEqual(opts[1].title, 'Дом');
  assert.strictEqual(opts[1].sub, h.name);
  assert.deepStrictEqual(opts[1].pos, [h.x, h.y, h.z]);
});

test("spawn: 'last' puts the character at the saved position in dimension 0", () => {
  const p = selecting(veteran({ pos: [111, 222, 33] }));
  fake.emit('gomp:spawn:choose', p, 'last');
  assert.ok(roleplay.isLogged(p));
  assert.deepStrictEqual([p.position.x, p.position.y, p.position.z], [111, 222, 33]);
  assert.strictEqual(p.dimension, 0);
  assert.ok(p.lastCall('gomp:ui:close'));
  const car = p.getVariable('personalVehicle');
  assert.ok(car && car.position.x === 114, 'the starter car next to the player');
});

test("spawn: 'house' appears inside, the car waits at the garage point", () => {
  const h = freeHouse();
  const p = selecting(veteran({ house: h }));
  fake.emit('gomp:spawn:choose', p, 'house');
  assert.ok(roleplay.isLogged(p));
  assert.strictEqual(p.dimension, houses.DIMENSION_BASE + h.id);
  assert.strictEqual(houses.insideOf(p), h.id);
  const names = p.calls.map(([n]) => n);
  assert.ok(names.indexOf('gomp:ui:close') >= 0 && names.indexOf('gomp:ui:close') < names.lastIndexOf('gomp:house:inside'), 'ui:close, then house:inside');
  const payload = p.lastCall('gomp:house:inside')[0];
  assert.deepStrictEqual([p.position.x, p.position.y, p.position.z], [payload.x, payload.y, payload.z]);
  assert.deepStrictEqual(roleplay.character(p).pos, [h.x, h.y, h.z], 'the saved position is the door');
  const spot = houses.garageSpot(houses.byId(h.id));
  const car = p.getVariable('personalVehicle');
  assert.strictEqual(car.dimension, 0);
  assert.deepStrictEqual([car.position.x, car.position.y, car.position.z, car.heading], [spot.x, spot.y, spot.z - 0.5, spot.heading]);
});

test("spawn: a house taken away meanwhile means the last position", () => {
  const h = freeHouse();
  const v = veteran({ house: h, pos: [55, 66, 77] });
  const p = selecting(v);
  // Evicted while the screen was up.
  assert.ok(houses.evict(h.id));
  assert.strictEqual(houses.ownedBy(v.ch.static), null);
  fake.emit('gomp:spawn:choose', p, 'house');
  assert.ok(roleplay.isLogged(p));
  assert.strictEqual(p.dimension, 0);
  assert.strictEqual(houses.insideOf(p), undefined);
  assert.deepStrictEqual([p.position.x, p.position.y, p.position.z], [55, 66, 77]);
});

test('spawn: repeated select, choose without pending and a bad value are handled; creation spawns at once', () => {
  const v = veteran();
  const p = fake.join();
  fake.emit('gomp:auth:login', p, v.login, 'password123');
  fake.emit('gomp:spawn:choose', p, 'last');
  assert.ok(!roleplay.isLogged(p), 'choose without pending');
  fake.emit('gomp:chars:select', p, v.ch.id);
  const shown = p.calls.filter(([n]) => n === 'gomp:spawn:show').length;
  fake.emit('gomp:chars:select', p, v.ch.id);
  assert.strictEqual(p.calls.filter(([n]) => n === 'gomp:spawn:show').length, shown, 'a repeated select is ignored');
  fake.emit('gomp:chars:create', p, { first: 'Bad', last: 'Try', gender: 'm', kit: 0 });
  assert.ok(!roleplay.isLogged(p), 'no creation while a choice is pending');
  fake.emit('gomp:spawn:choose', p, 'garbage');
  assert.ok(roleplay.isLogged(p), 'anything else counts as last');
  assert.deepStrictEqual([p.position.x, p.position.y], [v.ch.pos[0], v.ch.pos[1]]);
  fake.emit('gomp:spawn:choose', p, 'house');  // already in the game
  assert.strictEqual(p.dimension, 0);

  const n = fake.login(fake.join());
  assert.ok(roleplay.isLogged(n), 'a new character spawns without the screen');
  assert.strictEqual(n.lastCall('gomp:spawn:show'), undefined);
});

test('spawn: quitting on the screen saves nothing', () => {
  const v = veteran({ pos: [7, 8, 9] });
  const p = selecting(v);
  fake.emit('playerQuit', p);
  assert.deepStrictEqual(v.ch.pos, [7, 8, 9]);
  // The next session still works and saves normally.
  const q = selecting(v);
  fake.emit('gomp:spawn:choose', q, 'last');
  q.position = new mp.Vector3(1, 2, 3);
  fake.emit('playerQuit', q);
  assert.deepStrictEqual(v.ch.pos, [1, 2, 3]);
});
