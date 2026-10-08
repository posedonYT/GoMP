const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fake = require('./fakemp');
require('../index');
const maps = require('../maps');

const write = (name, doc) => fs.writeFileSync(path.join(maps.MAPS_DIR, `${name}.json`), typeof doc === 'string' ? doc : JSON.stringify(doc));
const objectsOf = (name) => [...(maps.objectsOf(name) || new Map()).values()].map((o) => o.entity);
const bench = (id, x = 215, extra = {}) => ({ id, model: 'prop_bench_01a', pos: [x, -810, 30.7], rot: [0, 0, 90], ...extra });

test('a map file becomes server objects with model, place, rotation, dimension and alpha', () => {
  write('square', { format: 'gomp-map', version: 1, name: 'Площадь', objects: [bench('a'), bench('b', 220, { dimension: 7, alpha: 120, model: 12345 })] });
  maps.load('square');
  const [a, b] = objectsOf('square');
  assert.strictEqual(a.model, mp.joaat('prop_bench_01a'));
  assert.deepStrictEqual([a.position.x, a.position.y, a.position.z], [215, -810, 30.7]);
  assert.deepStrictEqual([a.rotation.x, a.rotation.y, a.rotation.z], [0, 0, 90]);
  assert.strictEqual(a.dimension, 0);
  assert.strictEqual(b.model, 12345, 'a hash is taken as it is');
  assert.strictEqual(b.dimension, 7);
  assert.strictEqual(b.alpha, 120);
  assert.deepStrictEqual(maps.list().find((m) => m.name === 'square'), { name: 'square', objects: 2, enabled: true, error: null });
});

test('saving again touches only what changed', () => {
  write('diff', { objects: [bench('keep'), bench('move'), bench('gone'), bench('swap')] });
  maps.load('diff');
  const before = new Map([...maps.objectsOf('diff')].map(([id, o]) => [id, o.entity]));
  const done = maps.load('diff');
  assert.deepStrictEqual([done.created, done.updated, done.removed], [0, 0, 0], 'the same file changes nothing');

  write('diff', { objects: [bench('keep'), bench('move', 300, { rot: [10, 0, 45] }), { ...bench('swap'), model: 'prop_bin_01a' }, bench('new')] });
  const r = maps.load('diff');
  assert.deepStrictEqual([r.created, r.updated, r.removed], [2, 1, 1]);
  const now = maps.objectsOf('diff');
  assert.strictEqual(now.get('keep').entity, before.get('keep'), 'untouched');
  assert.strictEqual(now.get('move').entity, before.get('move'), 'moved, not recreated');
  assert.strictEqual(now.get('move').entity.position.x, 300);
  assert.deepStrictEqual([now.get('move').entity.rotation.x, now.get('move').entity.rotation.z], [10, 45]);
  assert.notStrictEqual(now.get('swap').entity, before.get('swap'), 'another model: recreated');
  assert.ok(!mp.objects.exists(before.get('swap')) && !mp.objects.exists(before.get('gone')));
  assert.strictEqual(now.get('swap').entity.model, mp.joaat('prop_bin_01a'));
});

test('broken entries are skipped; a broken file keeps the objects that are there', () => {
  write('broken', { objects: [bench('ok'), { id: 'nomodel', pos: [0, 0, 0] }, { id: 'badpos', model: 'x', pos: [0, 'a', 0] },
    bench('ok'), { id: 'alpha', model: 'x', pos: [0, 0, 0], alpha: 300 }, 'text'] });
  const r = maps.load('broken');
  assert.strictEqual(maps.objectsOf('broken').size, 1);
  assert.strictEqual(r.skipped.length, 5);
  assert.ok(r.skipped.some((s) => s.includes('повторяется id ok')));

  write('broken', '{ "objects": [ {"id": "half"');
  assert.strictEqual(maps.load('broken'), null);
  assert.strictEqual(maps.objectsOf('broken').size, 1, 'still there');
  assert.match(maps.list().find((m) => m.name === 'broken').error, /JSON/);
  write('broken', { format: 'menyoo', objects: [] });
  assert.strictEqual(maps.load('broken'), null);
  assert.strictEqual(maps.objectsOf('broken').size, 1);
  assert.ok(maps.validate({ version: 2 }).error);
});

test('a map can be switched off and on; deleting the file removes its objects', () => {
  write('toggle', { objects: [bench('a'), bench('b')] });
  maps.load('toggle');
  const admin = fake.login(fake.join());
  fake.command(admin, '/maps off toggle');
  assert.strictEqual(maps.objectsOf('toggle').size, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(maps.MAPS_DIR, 'toggle.json'), 'utf8')).enabled, false, 'kept in the file');
  fake.command(admin, '/maps on toggle');
  assert.strictEqual(maps.objectsOf('toggle').size, 2);
  fake.command(admin, '/maps');
  assert.ok(admin.chat.some((l) => l.includes('toggle: 2 объектов')));
  const ents = objectsOf('toggle');
  fs.unlinkSync(path.join(maps.MAPS_DIR, 'toggle.json'));
  maps.load('toggle');
  assert.strictEqual(maps.objectsOf('toggle'), undefined);
  assert.ok(ents.every((e) => !mp.objects.exists(e)));
});

test('/mapcursor tells the Studio where the admin stands', () => {
  const admin = fake.login(fake.join());
  admin.position = new mp.Vector3(100.5, -200.25, 31);
  admin.heading = 45;
  fake.command(admin, '/mapcursor');
  const c = JSON.parse(fs.readFileSync(path.join(maps.MAPS_DIR, '.cursor.json'), 'utf8'));
  assert.deepStrictEqual([c.x, c.y, c.z, c.heading, c.dimension], [100.5, -200.25, 31, 45, 0]);
  maps.loadAll();
  assert.ok(!maps.list().some((m) => m.name.startsWith('.')), 'the cursor is not a map');
});

test('the folder is watched: a saved file appears in the game by itself', async () => {
  write('live', { objects: [bench('a')] });
  for (let i = 0; i < 40 && !(maps.objectsOf('live') && maps.objectsOf('live').size === 1); i++) await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(maps.objectsOf('live').size, 1);
  write('live', { objects: [bench('a', 400)] });
  for (let i = 0; i < 40 && maps.objectsOf('live').get('a').entity.position.x !== 400; i++) await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(maps.objectsOf('live').get('a').entity.position.x, 400);
});
