'use strict';
// RAGE.MP entity pools (mp.players, mp.vehicles, ...).

const { Vector3 } = require('./vector3');
const { hashOf } = require('./joaat');
const { EntityType, Prop, GLOBAL_DIMENSION } = require('./constants');

function vec(v) {
  return v instanceof Vector3 ? v.clone() : new Vector3(v.x, v.y, v.z);
}

function inDim(e, dim) {
  const d = e.dimension;
  return d === dim || d === GLOBAL_DIMENSION || dim === GLOBAL_DIMENSION;
}

class EntityMpPool {
  constructor(rt, type, capacity) {
    Object.defineProperty(this, '_rt', { value: rt, enumerable: false });
    this._type = type;
    this._items = new Map(); // id -> entity
    this._capacity = capacity;
  }

  get length() {
    return this._items.size;
  }

  get size() {
    return this._capacity;
  }

  at(id) {
    return this._items.get(Number(id));
  }

  exists(entity) {
    if (entity === null || entity === undefined) return false;
    if (typeof entity === 'number') return this._items.has(entity);
    return this._items.get(entity.id) === entity && entity._valid;
  }

  toArray() {
    return [...this._items.values()];
  }

  toArrayFast() {
    return this.toArray();
  }

  forEach(fn) {
    for (const e of this.toArray()) fn(e, e.id);
  }

  forEachFast(fn) {
    this.forEach(fn);
  }

  apply(fn, ...args) {
    for (const e of this.toArray()) fn(e, ...args);
  }

  // The filters walk the pool once and copy only the matches (the callback may
  // still create or destroy entities safely).
  forEachInDimension(dimension, fn) {
    const hits = [];
    for (const e of this._items.values()) if (inDim(e, dimension)) hits.push(e);
    for (const e of hits) fn(e, e.id);
  }

  forEachInRange(position, range, dimension, fn) {
    if (typeof dimension === 'function') {
      fn = dimension;
      dimension = undefined;
    }
    const r2 = range * range;
    const hits = [];
    for (const e of this._items.values()) {
      if (dimension !== undefined && !inDim(e, dimension)) continue;
      if (e.distSquared(position) <= r2) hits.push(e);
    }
    for (const e of hits) fn(e, e.id);
  }

  getClosest(position, limit) {
    return this._closest(position, undefined, limit);
  }

  getClosestInDimension(position, dimension, limit) {
    return this._closest(position, dimension, limit);
  }

  _closest(position, dimension, limit) {
    if (limit === undefined) {
      // One pass, no sort: the nearest only.
      let best;
      let bestD = Infinity;
      for (const e of this._items.values()) {
        if (dimension !== undefined && !inDim(e, dimension)) continue;
        const d = e.distSquared(position);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
      return best;
    }
    const list = [];
    for (const e of this._items.values()) {
      if (dimension === undefined || inDim(e, dimension)) list.push([e, e.distSquared(position)]);
    }
    list.sort((a, b) => a[1] - b[1]);
    return list.slice(0, limit).map((p) => p[0]);
  }

  [Symbol.iterator]() {
    return this.toArray()[Symbol.iterator]();
  }

  _add(entity) {
    this._items.set(entity.id, entity);
  }

  _remove(id) {
    const e = this._items.get(id);
    if (e) {
      e._valid = false;
      this._items.delete(id);
    }
    return e;
  }
}

class PlayerMpPool extends EntityMpPool {
  broadcast(text) {
    this._rt._global('broadcast', [String(text)]);
  }

  broadcastInRange(position, range, dimension, text) {
    if (text === undefined) {
      text = dimension;
      dimension = -1;
    }
    this._rt._global('broadcastInRange', [vec(position), Number(range), Number(dimension), String(text)]);
  }

  broadcastInDimension(dimension, text) {
    this.forEachInDimension(dimension, (p) => p.outputChatBox(text));
  }

  _callTargets(targets, name, args, unreliable) {
    const ids = targets === null ? null : targets.map((p) => (typeof p === 'number' ? p : p.id));
    this._rt._global('callClients', [ids, String(name), Array.isArray(args) ? args : [args], !!unreliable]);
  }

  call(a, b, c) {
    if (Array.isArray(a)) return this._callTargets(a, b, c || [], false);
    return this._callTargets(null, a, b || [], false);
  }

  callUnreliable(a, b, c) {
    if (Array.isArray(a)) return this._callTargets(a, b, c || [], true);
    return this._callTargets(null, a, b || [], true);
  }

  callInDimension(dimension, name, args = []) {
    const t = this.toArray().filter((p) => inDim(p, dimension));
    this._callTargets(t, name, args, false);
  }

  callInDimensionUnreliable(dimension, name, args = []) {
    const t = this.toArray().filter((p) => inDim(p, dimension));
    this._callTargets(t, name, args, true);
  }

  _inRange(position, range, dimension) {
    const r2 = range * range;
    return this.toArray().filter((p) => (dimension === undefined || inDim(p, dimension)) && p.distSquared(position) <= r2);
  }

  callInRange(position, range, dimension, name, args) {
    if (typeof dimension === 'string') {
      args = name;
      name = dimension;
      dimension = undefined;
    }
    this._callTargets(this._inRange(position, range, dimension), name, args || [], false);
  }

  callInRangeUnreliable(position, range, dimension, name, args) {
    if (typeof dimension === 'string') {
      args = name;
      name = dimension;
      dimension = undefined;
    }
    this._callTargets(this._inRange(position, range, dimension), name, args || [], true);
  }
}

function colorProps(color) {
  // RAGE accepts [[r,g,b],[r,g,b]] or [primary, secondary] palette indices.
  if (!Array.isArray(color) || color.length < 2) return {};
  if (Array.isArray(color[0])) {
    const [a, b] = color;
    return { [Prop.colorRGB]: [a[0] | 0, a[1] | 0, a[2] | 0, b[0] | 0, b[1] | 0, b[2] | 0] };
  }
  return { [Prop.colors]: [color[0] | 0, color[1] | 0] };
}

class VehicleMpPool extends EntityMpPool {
  new(model, position, options = {}) {
    const props = { ...colorProps(options.color) };
    if (options.numberPlate !== undefined) props[Prop.numberPlate] = String(options.numberPlate).slice(0, 8);
    return this._rt._create(EntityType.vehicle, {
      model: hashOf(model),
      pos: vec(position),
      heading: Number(options.heading) || 0,
      dim: options.dimension === undefined ? 0 : Number(options.dimension) >>> 0,
      alpha: options.alpha === undefined ? 255 : options.alpha | 0,
      engine: options.engine === undefined ? false : !!options.engine,
      locked: !!options.locked,
      props,
    });
  }
}

class ObjectMpPool extends EntityMpPool {
  new(model, position, options = {}) {
    return this._rt._create(EntityType.object, {
      model: hashOf(model),
      pos: vec(position),
      rot: options.rotation ? vec(options.rotation) : new Vector3(),
      dim: Number(options.dimension || 0) >>> 0,
      alpha: options.alpha === undefined ? 255 : options.alpha | 0,
    });
  }
}

class PedMpPool extends EntityMpPool {
  new(model, position, options = {}, dimension) {
    // Older RAGE signature: new(model, position, heading, dimension).
    if (typeof options === 'number') options = { heading: options, dimension };
    const props = {};
    if (options.invincible !== undefined) props[Prop.invincible] = !!options.invincible;
    if (options.dynamic !== undefined) props[Prop.dynamic] = !!options.dynamic;
    if (options.frozen !== undefined) props[Prop.frozen] = !!options.frozen;
    return this._rt._create(EntityType.ped, {
      model: hashOf(model),
      pos: vec(position),
      heading: Number(options.heading) || 0,
      dim: Number(options.dimension || 0) >>> 0,
      props,
    });
  }
}

class BlipMpPool extends EntityMpPool {
  new(sprite, position, options = {}) {
    const props = { [Prop.blipSprite]: sprite | 0 };
    if (options.name !== undefined) props[Prop.blipName] = String(options.name);
    if (options.scale !== undefined) props[Prop.blipScale] = Number(options.scale);
    if (options.color !== undefined) props[Prop.blipColor] = options.color | 0;
    if (options.shortRange !== undefined) props[Prop.blipShortRange] = !!options.shortRange;
    if (options.drawDistance !== undefined) props[Prop.blipDrawDistance] = Number(options.drawDistance);
    if (options.rotation !== undefined) props[Prop.blipRotation] = Number(options.rotation);
    return this._rt._create(EntityType.blip, {
      pos: vec(position),
      dim: Number(options.dimension || 0) >>> 0,
      alpha: options.alpha === undefined ? 255 : options.alpha | 0,
      props,
    });
  }
}

function rgba(c, def) {
  if (!Array.isArray(c)) return def;
  return [c[0] | 0, c[1] | 0, c[2] | 0, c[3] === undefined ? 255 : c[3] | 0];
}

class MarkerMpPool extends EntityMpPool {
  new(type, position, scale, options = {}) {
    const props = {
      [Prop.markerType]: type | 0,
      [Prop.markerScale]: Number(scale),
      [Prop.markerColor]: rgba(options.color, [255, 255, 255, 255]),
      [Prop.visible]: options.visible === undefined ? true : !!options.visible,
    };
    if (options.direction) props[Prop.markerDirection] = vec(options.direction);
    return this._rt._create(EntityType.marker, {
      pos: vec(position),
      rot: options.rotation ? vec(options.rotation) : new Vector3(),
      dim: Number(options.dimension || 0) >>> 0,
      props,
    });
  }
}

class CheckpointMpPool extends EntityMpPool {
  new(type, position, radius, options = {}) {
    const props = {
      [Prop.checkpointType]: type | 0,
      [Prop.checkpointColor]: rgba(options.color, [255, 255, 255, 255]),
      [Prop.visible]: options.visible === undefined ? true : !!options.visible,
    };
    if (options.direction) props[Prop.destination] = vec(options.direction);
    return this._rt._create(EntityType.checkpoint, {
      pos: vec(position),
      radius: Number(radius),
      dim: Number(options.dimension || 0) >>> 0,
      props,
    });
  }
}

class TextLabelMpPool extends EntityMpPool {
  new(text, position, options = {}) {
    const props = { [Prop.labelText]: String(text) };
    if (options.los !== undefined) props[Prop.labelLOS] = !!options.los;
    if (options.font !== undefined) props[Prop.labelFont] = options.font | 0;
    if (options.drawDistance !== undefined) props[Prop.labelDrawDistance] = Number(options.drawDistance);
    if (options.color !== undefined) props[Prop.labelColor] = rgba(options.color, [255, 255, 255, 255]);
    return this._rt._create(EntityType.textlabel, { pos: vec(position), dim: Number(options.dimension || 0) >>> 0, props });
  }
}

const SHAPE = { circle: 0, sphere: 1, tube: 2, rectangle: 3, cuboid: 4, polygon: 5 };

class ColshapeMpPool extends EntityMpPool {
  _shape(kind, pos, fields, dimension) {
    return this._rt._create(EntityType.colshape, {
      shape: SHAPE[kind],
      pos,
      dim: Number(dimension || 0) >>> 0,
      ...fields,
    });
  }

  newCircle(x, y, range, dimension) {
    return this._shape('circle', new Vector3(x, y, 0), { radius: Number(range) }, dimension);
  }

  newSphere(x, y, z, range, dimension) {
    return this._shape('sphere', new Vector3(x, y, z), { radius: Number(range) }, dimension);
  }

  newTube(x, y, z, height, range, dimension) {
    return this._shape('tube', new Vector3(x, y, z), { radius: Number(range), height: Number(height) }, dimension);
  }

  newRectangle(x, y, width, height, dimension) {
    return this._shape('rectangle', new Vector3(x, y, 0), { width: Number(width), depth: Number(height) }, dimension);
  }

  newCuboid(x, y, z, width, depth, height, dimension) {
    return this._shape('cuboid', new Vector3(x, y, z), { width: Number(width), depth: Number(depth), height: Number(height) }, dimension);
  }

  newPolygon(points, minZ, maxZ, dimension) {
    const pts = points.map((p) => (Array.isArray(p) ? new Vector3(p[0], p[1], 0) : vec(p)));
    const c = pts.reduce((a, p) => a.add(p), new Vector3()).divide(pts.length || 1);
    return this._shape('polygon', c, { points: pts, minZ: Number(minZ), maxZ: Number(maxZ) }, dimension);
  }
}

class DummyMpPool extends EntityMpPool {
  new(dummyEntityType, sharedVariables = {}) {
    return this._rt._create(EntityType.dummy, {
      pos: new Vector3(),
      dummyType: dummyEntityType | 0,
      shared: { ...sharedVariables },
    });
  }

  forEachByType(dummyEntityType, fn) {
    for (const d of this.toArray()) if (d.dummyType === dummyEntityType) fn(d);
  }
}

module.exports = {
  EntityMpPool, PlayerMpPool, VehicleMpPool, ObjectMpPool, PedMpPool, BlipMpPool, MarkerMpPool, CheckpointMpPool,
  TextLabelMpPool, ColshapeMpPool, DummyMpPool,
};
