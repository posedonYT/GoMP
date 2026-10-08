import test from 'node:test';
import assert from 'node:assert/strict';
import { MapDocument, normalizeObject } from '../js/editor/document.js';
import { History } from '../js/editor/history.js';
import { Selection } from '../js/editor/selection.js';

const bench = (id, x = 0) => ({ id, model: 'Prop_Bench_01a', pos: [x, 0, 30], rot: [0, 0, 90] });

test('a map from the server keeps its fields and fills in defaults', () => {
  const doc = new MapDocument('square', { format: 'gomp-map', version: 1, name: 'Площадь', author: 'admin', objects: [bench('a'), { id: 7, model: 123, pos: [1, 2, 3] }] });
  assert.equal(doc.get('a').model, 'prop_bench_01a');
  assert.deepEqual(doc.get('7'), { id: '7', model: 123, pos: [1, 2, 3], rot: [0, 0, 0], dimension: 0, alpha: 255 });
  const json = doc.toJSON();
  assert.equal(json.author, 'admin');
  assert.equal(json.enabled, true);
  assert.equal(json.objects.length, 2);
  assert.equal(doc.dirty, false);
});

test('adding, moving and removing can be undone and redone', () => {
  const doc = new MapDocument('m', { objects: [] });
  const changes = [];
  doc.onChange((ids) => changes.push(ids));
  const [id] = doc.add([bench('a')]);
  assert.equal(id, 'a');
  assert.equal(doc.dirty, true);
  doc.update({ a: { pos: [5, 0, 30] } });
  doc.remove(['a']);
  assert.equal(doc.get('a'), undefined);
  doc.undo();
  assert.deepEqual(doc.get('a').pos, [5, 0, 30]);
  doc.undo();
  assert.deepEqual(doc.get('a').pos, [0, 0, 30]);
  doc.undo();
  assert.equal(doc.list().length, 0);
  doc.redo();
  doc.redo();
  assert.deepEqual(doc.get('a').pos, [5, 0, 30]);
  assert.ok(changes.every((c) => c.includes('a')));
});

test('a drag is one undo step; a new drag is another', () => {
  const doc = new MapDocument('m', { objects: [bench('a')] });
  for (let x = 1; x <= 10; x++) doc.update({ a: { pos: [x, 0, 30] } }, 'переместить', 'drag');
  doc.history.seal();
  for (let x = 11; x <= 15; x++) doc.update({ a: { pos: [x, 0, 30] } }, 'переместить', 'drag');
  assert.equal(doc.history.done.length, 2);
  doc.undo();
  assert.deepEqual(doc.get('a').pos, [10, 0, 30]);
  doc.undo();
  assert.deepEqual(doc.get('a').pos, [0, 0, 30]);
  doc.redo();
  assert.deepEqual(doc.get('a').pos, [10, 0, 30]);
});

test('ids stay unique: taken ids and copies get new ones', () => {
  const doc = new MapDocument('m', { objects: [bench('a')] });
  const ids = doc.add([bench('a'), bench('b'), bench('b')]);
  assert.equal(new Set([...doc.objects.keys()]).size, 4);
  assert.notEqual(ids[0], 'a');
  assert.equal(ids[1], 'b');
  assert.notEqual(ids[2], 'b');
  const copies = doc.duplicate(['a'], [2, 0, 0]);
  assert.deepEqual(doc.get(copies[0]).pos, [2, 0, 30]);
  assert.equal(doc.get(copies[0]).model, 'prop_bench_01a');
});

test('rotations are kept in the game range', () => {
  assert.deepEqual(normalizeObject({ id: 'x', model: 'a', pos: [0, 0, 0], rot: [0, 270, -190] }).rot, [0, -90, 170]);
});

test('updates only take known fields', () => {
  const doc = new MapDocument('m', { objects: [bench('a')] });
  doc.update({ a: { id: 'hack', pos: [1, 1, 1], alpha: 100, nope: 1 }, missing: { pos: [0, 0, 0] } });
  assert.equal(doc.get('a').id, 'a');
  assert.equal(doc.get('a').alpha, 100);
  assert.equal(doc.get('a').nope, undefined);
  assert.equal(doc.get('missing'), undefined);
});

test('map properties are undoable too', () => {
  const doc = new MapDocument('m', { name: 'Old', objects: [] });
  doc.setMeta({ name: 'New', enabled: false });
  assert.equal(doc.toJSON().name, 'New');
  doc.undo();
  assert.equal(doc.toJSON().name, 'Old');
  assert.equal(doc.toJSON().enabled, true);
});

test('history has a limit and tells about changes', () => {
  const h = new History(3);
  let calls = 0;
  h.onChange(() => calls++);
  for (let i = 0; i < 5; i++) h.push({ label: String(i), undo() {}, redo() {} });
  assert.equal(h.done.length, 3);
  assert.equal(h.undo(), '4');
  assert.equal(h.canRedo, true);
  h.push({ label: 'x', undo() {}, redo() {} });
  assert.equal(h.canRedo, false, 'a new step drops the redo list');
  assert.ok(calls >= 7);
});

test('selection: set, toggle, primary, dropping removed objects', () => {
  const s = new Selection();
  let events = 0;
  s.onChange(() => events++);
  s.set(['a', 'b', 'a']);
  assert.deepEqual(s.ids, ['a', 'b']);
  s.set(['a', 'b']);
  assert.equal(events, 1, 'the same selection is no change');
  s.toggle('a');
  assert.deepEqual(s.ids, ['b']);
  s.toggle('c');
  assert.equal(s.primary, 'c');
  const doc = new MapDocument('m', { objects: [bench('c')] });
  s.keepExisting(doc);
  assert.deepEqual(s.ids, ['c']);
});
