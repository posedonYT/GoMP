// Moving and turning the selection with the gizmo. The gizmo holds a pivot at
// the last selected object; while it is dragged, every selected object keeps
// its place relative to the pivot: moved by the same offset, or turned about
// the pivot by the same rotation. Pure math on [x, y, z] and quaternions, so it
// is tested without a browser (test/transform.test.mjs).
import { eulerToQuat, quatToEuler, quatMul, snap } from '../math/gta.js';

function quatConj(q) { return [-q[0], -q[1], -q[2], q[3]]; }

export function rotateVector(q, v) {
  const p = quatMul(quatMul(q, [v[0], v[1], v[2], 0]), quatConj(q));
  return [p[0], p[1], p[2]];
}

// start: { id: { pos, rot } } when the drag began; pivotStart/pivotNow: { pos, quat }.
// Returns patches for MapDocument.update.
export function dragPatches(start, pivotStart, pivotNow, mode) {
  const patches = {};
  if (mode === 'translate') {
    const d = [0, 1, 2].map((i) => pivotNow.pos[i] - pivotStart.pos[i]);
    for (const [id, s] of Object.entries(start)) patches[id] = { pos: s.pos.map((v, i) => v + d[i]) };
    return patches;
  }
  // The rotation done since the start: now * start^-1.
  const delta = quatMul(pivotNow.quat, quatConj(pivotStart.quat));
  for (const [id, s] of Object.entries(start)) {
    const rel = s.pos.map((v, i) => v - pivotStart.pos[i]);
    const moved = rotateVector(delta, rel);
    patches[id] = {
      pos: moved.map((v, i) => v + pivotStart.pos[i]),
      rot: quatToEuler(quatMul(delta, eulerToQuat(...s.rot))),
    };
  }
  return patches;
}

// An object put down on the ground: its lowest point (bbMin z) on the ground.
export function placeOnGround(point, info, step = 0) {
  const lift = info && info.bbMin ? -info.bbMin[2] : 0;
  return [snap(point[0], step), snap(point[1], step), point[2] + lift];
}

// Pasted objects: the copies keep their places relative to each other, the
// first one goes to the point.
export function pasteAt(objects, point) {
  if (!objects.length) return [];
  const base = objects[0].pos;
  return objects.map((o) => ({ ...o, id: undefined, pos: o.pos.map((v, i) => v - base[i] + point[i]) }));
}
