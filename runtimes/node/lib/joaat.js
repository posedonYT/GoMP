'use strict';

/** Jenkins one-at-a-time hash used by GTA V (mp.joaat). */
function joaat(input) {
  if (Array.isArray(input)) return input.map(joaat);
  const s = String(input).toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h + s.charCodeAt(i)) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  h = (h + (h << 15)) >>> 0;
  return h;
}

/** Accepts a hash number or a name. */
function hashOf(v) {
  if (typeof v === 'string') {
    if (/^-?\d+$/.test(v)) return Number(v) >>> 0;
    if (/^0x[0-9a-f]+$/i.test(v)) return Number.parseInt(v, 16) >>> 0;
    return joaat(v);
  }
  return Number(v) >>> 0;
}

module.exports = { joaat, hashOf };
