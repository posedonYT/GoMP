import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  eulerToQuat, quatToEuler, quatToMatrix, quatAxis, quatMul, sameRotation, wrapAngle, snap, cellOf, cellsAround,
} from '../js/math/gta.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('yaw turns about the vertical axis, like a heading', () => {
  assert.ok(sameRotation(eulerToQuat(0, 0, 90), quatAxis(0, 0, 1, Math.PI / 2)));
  const m = quatToMatrix(eulerToQuat(0, 0, 90));
  close(m[0][1], -1);  // the front (+Y) looks west (-X)
});

test('the order is Y, then X, then Z: the matrix Rz * Rx * Ry', () => {
  const q = quatMul(quatMul(quatAxis(0, 0, 1, 0.1), quatAxis(1, 0, 0, 0.2)), quatAxis(0, 1, 0, 0.3));
  const D = 180 / Math.PI;
  assert.ok(sameRotation(q, eulerToQuat(0.2 * D, 0.3 * D, 0.1 * D)));
});

test('angles survive the trip through a quaternion', () => {
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i++) {
    const x = rnd() * 178 - 89;
    const y = rnd() * 358 - 179;
    const z = rnd() * 358 - 179;
    const [ax, ay, az] = quatToEuler(eulerToQuat(x, y, z));
    close(ax, x, 1e-5);
    close(ay, y, 1e-5);
    close(az, z, 1e-5);
  }
});

test('pitch of 90 degrees keeps the rotation', () => {
  const q = eulerToQuat(90, 30, 40);
  const e = quatToEuler(q);
  assert.equal(e[1], 0);
  assert.ok(sameRotation(q, eulerToQuat(...e)));
});

test('the same numbers as the C# side and as the game', () => {
  // tools/studio/testdata/rotations.json: matrices read in the game (probe "rotation").
  const file = fileURLToPath(new URL('../../testdata/rotations.json', import.meta.url));
  assert.ok(existsSync(file));
  for (const r of JSON.parse(readFileSync(file, 'utf8')).rotations) {
    const q = eulerToQuat(...r.angles);
    const m = quatToMatrix(q);
    // Columns of the matrix: where the entity's right, forward and up point.
    ['right', 'forward', 'up'].forEach((axis, c) => r[axis].forEach((v, row) => close(m[row][c], v, 1e-4)));
    assert.ok(sameRotation(q, r.quat, 1e-5), `${r.angles}: ${q} != ${r.quat}`);
    quatToEuler(q).forEach((v, i) => close(v, r.angles[i], 1e-4));
  }
});

test('wrapping, snapping and streaming cells', () => {
  assert.equal(wrapAngle(270), -90);
  assert.equal(wrapAngle(-180), 180);
  assert.equal(wrapAngle(540), 180);
  assert.equal(snap(12.3, 0.5), 12.5);
  assert.equal(snap(12.3, 0), 12.3);
  assert.deepEqual(cellOf(-1, 300, 256), [-1, 1]);
  const cells = cellsAround(10, 10, 300, 256);
  assert.deepEqual([cells[0].x, cells[0].y, cells[0].distance], [0, 0, 0]);
  assert.ok(cells.every((c, i) => i === 0 || c.distance >= cells[i - 1].distance));
  assert.ok(cells.every((c) => c.distance <= 300));
  assert.ok(cells.some((c) => c.x === -1 && c.y === -1));
});
