'use strict';
// mp.Vector3, API-compatible with RAGE.MP's server-side Vector3.

class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    if (Array.isArray(x)) {
      [x, y, z] = x;
    } else if (x !== null && typeof x === 'object') {
      ({ x, y, z } = x);
    }
    this.x = Number(x) || 0;
    this.y = Number(y) || 0;
    this.z = Number(z) || 0;
  }

  static _of(v) {
    return typeof v === 'number' ? new Vector3(v, v, v) : v;
  }

  add(v) {
    const o = Vector3._of(v);
    return new Vector3(this.x + o.x, this.y + o.y, this.z + o.z);
  }

  subtract(v) {
    const o = Vector3._of(v);
    return new Vector3(this.x - o.x, this.y - o.y, this.z - o.z);
  }

  multiply(v) {
    const o = Vector3._of(v);
    return new Vector3(this.x * o.x, this.y * o.y, this.z * o.z);
  }

  divide(v) {
    const o = Vector3._of(v);
    return new Vector3(this.x / o.x, this.y / o.y, this.z / o.z);
  }

  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v) {
    return new Vector3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x);
  }

  length() {
    return Math.sqrt(this.dot(this));
  }

  unit() {
    const l = this.length();
    return l === 0 ? new Vector3() : new Vector3(this.x / l, this.y / l, this.z / l);
  }

  negative() {
    return new Vector3(-this.x, -this.y, -this.z);
  }

  equals(v) {
    return this.x === v.x && this.y === v.y && this.z === v.z;
  }

  clone() {
    return new Vector3(this.x, this.y, this.z);
  }

  min() {
    return Math.min(this.x, this.y, this.z);
  }

  max() {
    return Math.max(this.x, this.y, this.z);
  }

  angleTo(v) {
    const d = this.length() * v.length();
    if (d === 0) return 0;
    return Math.acos(Math.max(-1, Math.min(1, this.dot(v) / d)));
  }

  // Returns [heading, pitch] of the direction in radians (RAGE toAngles).
  toAngles() {
    return [Math.atan2(this.x, this.z), Math.asin(this.y / (this.length() || 1))];
  }

  toArray() {
    return [this.x, this.y, this.z];
  }

  toString() {
    return `Vector3(${this.x}, ${this.y}, ${this.z})`;
  }

  toJSON() {
    return { x: this.x, y: this.y, z: this.z };
  }
}

function isVector3(v) {
  return v instanceof Vector3;
}

module.exports = { Vector3, isVector3 };
