// An open map (format gomp-map, see server-files/packages/freeroam/maps.js) with
// undo/redo. Every change goes through these methods so that it can be undone,
// marks the map as changed and tells the listeners which objects changed.

import { History } from './history.js';
import { wrapAngle } from '../math/gta.js';

const FIELDS = ['model', 'pos', 'rot', 'dimension', 'alpha', 'group'];
const clone = (o) => JSON.parse(JSON.stringify(o));

export function newId(taken) {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8);
    if (!taken.has(id)) return id;
  }
}

// An object with every field filled in.
export function normalizeObject(o) {
  return {
    ...o,
    id: String(o.id),
    model: typeof o.model === 'number' ? o.model : String(o.model || '').trim().toLowerCase(),
    pos: (o.pos || [0, 0, 0]).map(Number),
    rot: (o.rot || [0, 0, 0]).map((v) => wrapAngle(Number(v))),
    dimension: o.dimension ? Number(o.dimension) : 0,
    alpha: o.alpha === undefined ? 255 : Number(o.alpha),
  };
}

export class MapDocument {
  constructor(name, json = {}) {
    this.name = name;
    this.meta = { ...json };
    delete this.meta.objects;
    this.meta.format = 'gomp-map';
    this.meta.version = 1;
    if (this.meta.enabled === undefined) this.meta.enabled = true;
    if (this.meta.name === undefined) this.meta.name = name;
    this.objects = new Map();
    for (const o of json.objects || []) {
      const n = normalizeObject(o);
      this.objects.set(n.id, n);
    }
    this.history = new History();
    this.dirty = false;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // changed: ids of objects that changed (added, moved, removed), or null for the map itself.
  emit(changed) {
    this.dirty = true;
    for (const fn of this.listeners) fn(changed);
  }

  get(id) { return this.objects.get(id); }
  list() { return [...this.objects.values()]; }

  toJSON() {
    return { ...this.meta, objects: this.list().map(clone) };
  }

  // --- raw operations (no history) ---

  _put(objs) {
    for (const o of objs) this.objects.set(o.id, clone(o));
    this.emit(objs.map((o) => o.id));
  }

  _delete(ids) {
    for (const id of ids) this.objects.delete(id);
    this.emit(ids);
  }

  // --- editing ---

  // Adds objects (id given or new); returns their ids.
  add(objs, label = 'добавить') {
    const added = objs.map((o) => normalizeObject({ ...o, id: o.id && !this.objects.has(String(o.id)) ? o.id : newId(this.objects) }));
    // Ids also have to differ among the new ones.
    const seen = new Set(this.objects.keys());
    for (const o of added) {
      if (seen.has(o.id)) o.id = newId(seen);
      seen.add(o.id);
    }
    this._put(added);
    const ids = added.map((o) => o.id);
    this.history.push({ label, undo: () => this._delete(ids), redo: () => this._put(added) });
    return ids;
  }

  remove(ids, label = 'удалить') {
    const gone = ids.map((id) => this.objects.get(id)).filter(Boolean).map(clone);
    if (!gone.length) return;
    this._delete(gone.map((o) => o.id));
    this.history.push({ label, undo: () => this._put(gone), redo: () => this._delete(gone.map((o) => o.id)) });
  }

  // patches: { id: { pos: [...], rot: [...], ... } }. mergeKey joins a drag into one undo step.
  update(patches, label = 'изменить', mergeKey = null) {
    const before = [];
    const after = [];
    for (const [id, patch] of Object.entries(patches)) {
      const cur = this.objects.get(id);
      if (!cur) continue;
      const next = normalizeObject({ ...cur, ...pick(patch) });
      before.push(clone(cur));
      after.push(next);
    }
    if (!after.length) return;
    this._put(after);
    this.history.push({ label, undo: () => this._put(before), redo: () => this._put(after) }, mergeKey);
  }

  // Copies of objects moved by an offset; returns the new ids.
  duplicate(ids, offset = [1, 1, 0]) {
    const copies = ids.map((id) => this.objects.get(id)).filter(Boolean).map((o) => ({
      ...clone(o), id: undefined, pos: o.pos.map((v, i) => v + offset[i]),
    }));
    return this.add(copies, 'дублировать');
  }

  setMeta(patch) {
    const before = { ...this.meta };
    const after = { ...this.meta, ...patch };
    const apply = (m) => { this.meta = { ...m }; this.emit(null); };
    apply(after);
    this.history.push({ label: 'свойства карты', undo: () => apply(before), redo: () => apply(after) });
  }

  undo() { return this.history.undo(); }
  redo() { return this.history.redo(); }

  markSaved() { this.dirty = false; }
}

function pick(patch) {
  const out = {};
  for (const k of FIELDS) if (patch[k] !== undefined) out[k] = patch[k];
  return out;
}
