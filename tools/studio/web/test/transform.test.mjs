import test from 'node:test';
import assert from 'node:assert/strict';
import { dragPatches, rotateVector, placeOnGround, pasteAt } from '../js/editor/transform.js';
import { eulerToQuat } from '../js/math/gta.js';

const close = (a, b, eps = 1e-6) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${a} != ${b}`));

test('moving the gizmo moves every selected object by the same offset', () => {
  const start = { a: { pos: [0, 0, 0], rot: [0, 0, 0] }, b: { pos: [5, 1, 2], rot: [0, 0, 90] } };
  const p = dragPatches(start, { pos: [5, 1, 2] }, { pos: [6, 3, 2] }, 'translate');
  assert.deepEqual(p.a, { pos: [1, 2, 0] });
  assert.deepEqual(p.b, { pos: [6, 3, 2] });
});

test('turning the gizmo turns the selection about the pivot', () => {
  const start = { a: { pos: [10, 0, 0], rot: [0, 0, 0] }, pivot: { pos: [0, 0, 0], rot: [0, 0, 0] } };
  const p = dragPatches(start, { pos: [0, 0, 0], quat: eulerToQuat(0, 0, 0) }, { pos: [0, 0, 0], quat: eulerToQuat(0, 0, 90) }, 'rotate');
  close(p.a.pos, [0, 10, 0]);
  close(p.a.rot, [0, 0, 90]);
  close(p.pivot.pos, [0, 0, 0]);
});

test('turning keeps an object\'s own tilt', () => {
  const start = { a: { pos: [0, 0, 0], rot: [20, 0, 30] } };
  const p = dragPatches(start, { pos: [0, 0, 0], quat: eulerToQuat(0, 0, 30) }, { pos: [0, 0, 0], quat: eulerToQuat(0, 0, 75) }, 'rotate');
  close(p.a.rot, [20, 0, 75], 1e-5);
});

test('vectors, ground and paste', () => {
  close(rotateVector(eulerToQuat(0, 0, 90), [1, 0, 0]), [0, 1, 0]);
  assert.deepEqual(placeOnGround([10.26, 3.04, 30], { bbMin: [-1, -0.5, -0.25] }, 0.1).map((v) => Math.round(v * 100) / 100), [10.3, 3, 30.25]);
  assert.deepEqual(placeOnGround([1, 2, 3], null), [1, 2, 3]);
  const pasted = pasteAt([{ id: 'a', pos: [1, 1, 1] }, { id: 'b', pos: [3, 1, 2] }], [10, 10, 10]);
  assert.deepEqual(pasted.map((o) => o.pos), [[10, 10, 10], [12, 10, 11]]);
  assert.ok(pasted.every((o) => o.id === undefined));
});
