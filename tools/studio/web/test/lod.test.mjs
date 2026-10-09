import test from 'node:test';
import assert from 'node:assert/strict';
import { isVisible, visibleByArchetype } from '../js/scene/lod.js';

const hd = (a, x, d = 100) => ({ a, p: [x, 0, 0], l: 0, d, c: 0 });
const lod = (a, x, d = 1000, c = 100) => ({ a, p: [x, 0, 0], l: 1, d, c });

test('a detailed entity is drawn within its lod distance', () => {
  assert.equal(isVisible(hd(1, 0), 50), true);
  assert.equal(isVisible(hd(1, 0), 100), true);
  assert.equal(isVisible(hd(1, 0), 101), false);
  assert.equal(isVisible({ ...hd(1, 0), l: 5 }, 50), true, 'orphan HD too');
});

test('a low-detail stand-in takes over where its children stop', () => {
  assert.equal(isVisible(lod(2, 0), 50), false, 'the detailed ones are there');
  assert.equal(isVisible(lod(2, 0), 150), true);
  assert.equal(isVisible(lod(2, 0), 1001), false);
});

test('the parent hands over at its child distance: no gap between levels', () => {
  // An LOD (lod 275) under an SLOD that switches to its children at 300.
  const lodE = { a: 2, p: [0, 0, 0], l: 1, d: 275, c: 120, u: 300, k: true };
  const slod = { a: 3, p: [0, 0, 0], l: 2, d: 400, c: 300, u: 400, k: true };
  for (let d = 0; d <= 400; d += 5) {
    const shown = [lodE, slod].filter((e) => isVisible(e, d)).length;
    assert.ok(d <= 120 || shown >= 1, `a gap at ${d} m`);
  }
  assert.equal(isVisible(lodE, 290), true, 'beyond its own lod distance, until the parent takes over');
  assert.equal(isVisible({ a: 1, p: [0, 0, 0], l: 0, d: 150, c: 0, u: 120, k: false }, 130), false, 'an HD switches at the parent');
});

test('visible entities are grouped by archetype with the nearest distance', () => {
  const g = visibleByArchetype([hd(1, 10), hd(1, 50), hd(1, 500), lod(2, 300), hd(3, 1000)], 0, 0, 0);
  assert.deepEqual([...g.keys()], [1, 2]);
  assert.equal(g.get(1).entities.length, 2);
  assert.equal(g.get(1).nearest, 10);
  assert.equal(g.get(2).nearest, 300);
});
