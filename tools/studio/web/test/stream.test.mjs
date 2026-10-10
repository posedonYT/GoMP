import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_CONNECTIONS, WORLD_REQUESTS, CELLS_AT_ONCE, modelSlots, modelUrl, nextModels, streaming } from '../js/scene/stream.js';

test('world models ask for the streaming lane with a value the server binds', () => {
  assert.equal(modelUrl('prop_bench_01a', 'high', 128, true), '/api/models/prop_bench_01a.glb?lod=high&tex=128&low=true');
  // The user's own models carry no flag: they go first.
  assert.equal(modelUrl(123456, 'high', 512), '/api/models/123456.glb?lod=high&tex=512');
  assert.equal(modelUrl('a b'), '/api/models/a%20b.glb?lod=high&tex=512');
});

test('the world leaves a browser connection for the user', () => {
  assert.ok(WORLD_REQUESTS < BROWSER_CONNECTIONS);
  assert.ok(CELLS_AT_ONCE >= 1 && CELLS_AT_ONCE < WORLD_REQUESTS);
  // Whatever runs, cells and models together never take more than the world's share.
  for (let cells = 0; cells <= CELLS_AT_ONCE; cells++)
    for (let models = 0; models <= WORLD_REQUESTS; models++)
      assert.ok(cells + models + modelSlots(cells, models) <= Math.max(WORLD_REQUESTS, cells + models));
  assert.equal(modelSlots(0, 0), WORLD_REQUESTS);  // cells in: all of it to models
  assert.equal(modelSlots(2, 0), WORLD_REQUESTS - 2);
  assert.equal(modelSlots(2, 3), 0);
});

const arch = (hash, state, nearest) => [hash, { hash, state, nearest }];

test('visible models load nearest first, within the free requests', () => {
  const archetypes = new Map([arch(1, 'queued', 50), arch(2, 'queued', 5), arch(3, 'queued', 20), arch(4, 'ready', 1), arch(5, 'loading', 2)]);
  const visible = new Set([1, 2, 3, 4, 5]);
  assert.deepEqual(nextModels(archetypes, visible, 2).map((a) => a.hash), [2, 3]);
  assert.deepEqual(nextModels(archetypes, visible, 0), []);
  assert.deepEqual(nextModels(archetypes, visible, -1), []);
});

test('after a jump the new place loads before what was queued at the old one', () => {
  // Queued near the old place (small distances), not visible from the new one.
  const archetypes = new Map([arch(10, 'queued', 3), arch(11, 'queued', 4), arch(20, 'queued', 40)]);
  const visibleNow = new Set([20]);
  assert.deepEqual(nextModels(archetypes, visibleNow, 3).map((a) => a.hash), [20]);
  // Coming back: the old ones are visible again and load.
  assert.deepEqual(nextModels(archetypes, new Set([10, 11, 20]), 3).map((a) => a.hash), [10, 11, 20]);
});

test('the world does not stream while off, before the game is loaded, or behind the showroom', () => {
  assert.equal(streaming({ enabled: true, ready: true, otherScene: null }), true);
  assert.equal(streaming({ enabled: false, ready: true, otherScene: null }), false);
  assert.equal(streaming({ enabled: true, ready: false, otherScene: null }), false);
  assert.equal(streaming({ enabled: true, ready: true, otherScene: {} }), false);
});
