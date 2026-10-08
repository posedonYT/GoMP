// GTA V conventions in the browser. The 3D scene uses the game's own axes
// (Z up, metres), so positions need no conversion. Rotations are
// SET_ENTITY_ROTATION(x, y, z, 2) in degrees: the matrix Rz(z) * Rx(x) * Ry(y),
// i.e. about Y first, then X, then Z — three.js Euler order 'ZXY'. Measured in
// the game (tools/studio/testdata/rotations.json); the same math is in
// tools/studio/GoMP.Studio.Core/Geometry/GtaRotation.cs.

export const DEG = Math.PI / 180;
export const EULER_ORDER = 'ZXY';

// Quaternions are [x, y, z, w].
export function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function quatAxis(x, y, z, rad) {
  const s = Math.sin(rad / 2);
  return [x * s, y * s, z * s, Math.cos(rad / 2)];
}

export function quatNormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n === 0 ? [0, 0, 0, 1] : q.map((v) => v / n);
}

// The same rotation (q and -q are).
export function sameRotation(a, b, eps = 1e-6) {
  return Math.abs(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) - 1) < eps;
}

// SET_ENTITY_ROTATION angles (degrees) -> quaternion.
export function eulerToQuat(x, y, z) {
  return quatNormalize(quatMul(quatMul(quatAxis(0, 0, 1, z * DEG), quatAxis(1, 0, 0, x * DEG)), quatAxis(0, 1, 0, y * DEG)));
}

// Row-major 3x3.
export function quatToMatrix(q) {
  const [x, y, z, w] = quatNormalize(q);
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

function tidy(deg) {
  const r = Math.round(deg * 1e6) / 1e6;
  if (Object.is(r, -0) || r === 0) return 0;
  return r === -180 ? 180 : r;
}

// Quaternion -> GET_ENTITY_ROTATION(…, 2) angles: x in [-90, 90], y and z in (-180, 180].
export function quatToEuler(q) {
  const m = quatToMatrix(q);
  const sx = Math.max(-1, Math.min(1, m[2][1]));
  const x = Math.asin(sx);
  let y;
  let z;
  if (Math.abs(sx) < 0.9999999) {
    y = Math.atan2(-m[2][0], m[2][2]);
    z = Math.atan2(-m[0][1], m[1][1]);
  } else {
    y = 0;  // pitch ±90: only y ± z is defined
    z = Math.atan2(m[1][0], m[0][0]);
  }
  return [tidy(x / DEG), tidy(y / DEG), tidy(z / DEG)];
}

// An angle in degrees brought to (-180, 180].
export function wrapAngle(deg) {
  let a = deg % 360;
  if (a <= -180) a += 360;
  if (a > 180) a -= 360;
  return tidy(a);
}

export function snap(value, step) {
  return step > 0 ? Math.round(value / step) * step : value;
}

// The streaming cells of the world (cell size in metres): which cell holds a point
// and which cells lie within a radius of it, nearest first.
export function cellOf(x, y, size) {
  return [Math.floor(x / size), Math.floor(y / size)];
}

export function cellsAround(x, y, radius, size) {
  const [cx, cy] = cellOf(x, y, size);
  const r = Math.ceil(radius / size);
  const out = [];
  for (let i = cx - r; i <= cx + r; i++) {
    for (let j = cy - r; j <= cy + r; j++) {
      // Distance from the point to the nearest edge of the cell.
      const dx = Math.max(i * size - x, 0, x - (i + 1) * size);
      const dy = Math.max(j * size - y, 0, y - (j + 1) * size);
      const d = Math.hypot(dx, dy);
      if (d <= radius) out.push({ x: i, y: j, distance: d });
    }
  }
  return out.sort((a, b) => a.distance - b.distance);
}
