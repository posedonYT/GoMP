// Custom maps: objects placed with GoMP Studio (tools/studio), kept in
// server-files/maps/<name>.json and created as server objects every player sees.
// Saving a map in the Studio changes the objects at once: the folder is watched
// and only what changed is touched (moved objects move, new ones appear).
//
// Map file (format gomp-map, version 1):
//   { "format": "gomp-map", "version": 1, "name": "Площадь", "enabled": true,
//     "objects": [{ "id": "a1", "model": "prop_bench_01a" (or a hash), "pos": [x, y, z],
//                   "rot": [x, y, z], "dimension": 0, "alpha": 255, "group": "..." }] }
//   rot: degrees, as SET_ENTITY_ROTATION with rotation order 2 (client/game/world_ui.cpp).
//
// maps/.cursor.json is written by /mapcursor (admin.js): the Studio moves its camera there.

const fs = require('fs');
const path = require('path');

const MAPS_DIR = process.env.GOMP_MAPS_DIR || path.join(__dirname, '..', '..', 'maps');
const CURSOR_FILE = '.cursor.json';
const MAX_OBJECTS = 5000;  // per map
const DEBOUNCE_MS = 300;

// name -> { enabled, error, objects: Map(id -> { def, entity }) }
const maps = new Map();
const timers = new Map();
let watcher = null;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);

function modelHash(model) {
  return typeof model === 'number' ? model >>> 0 : mp.joaat(String(model).trim().toLowerCase());
}

// The objects of a map document that can be created; what is wrong with the others.
function validate(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'не объект JSON', objects: [], skipped: [] };
  if (doc.format !== undefined && doc.format !== 'gomp-map') return { error: `формат ${doc.format}`, objects: [], skipped: [] };
  if (doc.version !== undefined && doc.version !== 1) return { error: `версия ${doc.version}`, objects: [], skipped: [] };
  const list = Array.isArray(doc.objects) ? doc.objects : [];
  const objects = [];
  const skipped = [];
  const ids = new Set();
  list.forEach((o, i) => {
    const where = `объект ${i}`;
    if (!o || typeof o !== 'object') return skipped.push(`${where}: не объект`);
    const id = typeof o.id === 'number' ? String(o.id) : o.id;
    if (typeof id !== 'string' || !id) return skipped.push(`${where}: нет id`);
    if (ids.has(id)) return skipped.push(`${where}: повторяется id ${id}`);
    const model = o.model;
    const modelOk = (typeof model === 'string' && model.trim()) || (Number.isInteger(model) && model >= 0 && model <= 0xffffffff);
    if (!modelOk) return skipped.push(`${id}: нет модели`);
    if (!vec3(o.pos)) return skipped.push(`${id}: pos — три числа`);
    if (o.rot !== undefined && !vec3(o.rot)) return skipped.push(`${id}: rot — три числа`);
    if (o.dimension !== undefined && !(Number.isInteger(o.dimension) && o.dimension >= 0)) return skipped.push(`${id}: dimension`);
    if (o.alpha !== undefined && !(Number.isInteger(o.alpha) && o.alpha >= 0 && o.alpha <= 255)) return skipped.push(`${id}: alpha 0-255`);
    if (objects.length >= MAX_OBJECTS) return skipped.push(`${id}: больше ${MAX_OBJECTS} объектов`);
    ids.add(id);
    objects.push({
      id, model: modelHash(model), pos: o.pos.slice(), rot: o.rot ? o.rot.slice() : [0, 0, 0],
      dimension: o.dimension || 0, alpha: o.alpha === undefined ? 255 : o.alpha,
    });
    return undefined;
  });
  return { objects, skipped, enabled: doc.enabled !== false };
}

const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const v3 = (a) => new mp.Vector3(a[0], a[1], a[2]);

function create(def) {
  return mp.objects.new(def.model, v3(def.pos), { rotation: v3(def.rot), dimension: def.dimension, alpha: def.alpha });
}

function destroy(entity) {
  if (entity && mp.objects.exists(entity)) entity.destroy();
}

function stateOf(name) {
  if (!maps.has(name)) maps.set(name, { enabled: true, error: null, objects: new Map() });
  return maps.get(name);
}

// Brings the objects of a map to these definitions; returns what was done.
function apply(name, defs) {
  const state = stateOf(name);
  const next = new Map(defs.map((d) => [d.id, d]));
  const done = { created: 0, updated: 0, removed: 0 };
  for (const [id, cur] of state.objects) {
    if (next.has(id)) continue;
    destroy(cur.entity);
    state.objects.delete(id);
    done.removed++;
  }
  for (const def of defs) {
    const cur = state.objects.get(def.id);
    if (!cur || !mp.objects.exists(cur.entity) || cur.def.model !== def.model) {
      if (cur) destroy(cur.entity);
      state.objects.set(def.id, { def, entity: create(def) });
      done.created++;
      continue;
    }
    const e = cur.entity;
    let changed = false;
    if (!same(cur.def.pos, def.pos)) { e.position = v3(def.pos); changed = true; }
    if (!same(cur.def.rot, def.rot)) { e.rotation = v3(def.rot); changed = true; }
    if (cur.def.alpha !== def.alpha) { e.alpha = def.alpha; changed = true; }
    if (cur.def.dimension !== def.dimension) { e.dimension = def.dimension; changed = true; }
    cur.def = def;
    if (changed) done.updated++;
  }
  return done;
}

const fileOf = (name) => path.join(MAPS_DIR, `${name}.json`);
const isMapFile = (f) => f.endsWith('.json') && !f.startsWith('.');

// (Re)reads a map file. A broken file keeps the objects that are there.
function load(name) {
  const file = fileOf(name);
  if (!fs.existsSync(file)) {
    if (!maps.has(name)) return null;
    const done = apply(name, []);
    maps.delete(name);
    console.log(`[maps] ${name}: файл удалён, убрано ${done.removed}`);
    return done;
  }
  const state = stateOf(name);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    state.error = `ошибка JSON: ${e.message}`;
    console.log(`[maps] ${name}: ${state.error} — оставлены прежние объекты`);
    return null;
  }
  const v = validate(doc);
  if (v.error) {
    state.error = v.error;
    console.log(`[maps] ${name}: ${v.error} — оставлены прежние объекты`);
    return null;
  }
  state.error = null;
  state.enabled = v.enabled;
  const done = apply(name, v.enabled ? v.objects : []);
  for (const s of v.skipped.slice(0, 10)) console.log(`[maps] ${name}: пропущен ${s}`);
  if (v.skipped.length > 10) console.log(`[maps] ${name}: пропущено ещё ${v.skipped.length - 10}`);
  console.log(`[maps] ${name}: +${done.created} ~${done.updated} -${done.removed}, всего ${state.objects.size}${v.enabled ? '' : ' (выключена)'}`);
  return { ...done, skipped: v.skipped };
}

function loadAll() {
  fs.mkdirSync(MAPS_DIR, { recursive: true });
  const names = fs.readdirSync(MAPS_DIR).filter(isMapFile).map((f) => f.slice(0, -5));
  for (const name of [...maps.keys()]) if (!names.includes(name)) load(name);
  names.forEach(load);
}

function list() {
  return [...maps].map(([name, s]) => ({ name, objects: s.objects.size, enabled: s.enabled, error: s.error }));
}

// Writes a file so that a reader never sees half of it.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Switches a map on or off (kept in its file, so it stays that way).
function setEnabled(name, on) {
  const file = fileOf(name);
  if (!fs.existsSync(file)) return false;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.enabled = !!on;
  writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  load(name);
  return true;
}

// Where an admin stands in the game: the Studio moves its camera there.
function writeCursor(player) {
  const p = player.position;
  const cursor = { x: p.x, y: p.y, z: p.z, heading: player.heading, dimension: player.dimension, name: player.name, at: Date.now() };
  fs.mkdirSync(MAPS_DIR, { recursive: true });
  writeAtomic(path.join(MAPS_DIR, CURSOR_FILE), `${JSON.stringify(cursor)}\n`);
  return cursor;
}

// Changes in the folder: each file is read once it has been quiet for a moment.
function schedule(file) {
  if (!file) {
    loadAll();
    return;
  }
  if (!isMapFile(file)) return;
  const name = file.slice(0, -5);
  clearTimeout(timers.get(name));
  const t = setTimeout(() => {
    timers.delete(name);
    load(name);
  }, DEBOUNCE_MS);
  if (t.unref) t.unref();
  timers.set(name, t);
}

function start() {
  loadAll();
  try {
    watcher = fs.watch(MAPS_DIR, (_, file) => schedule(file && String(file)));
    if (watcher.unref) watcher.unref();
  } catch (e) {
    console.log(`[maps] не удалось следить за ${MAPS_DIR}: ${e.message} — /maps reload вручную`);
  }
}

start();

module.exports = { MAPS_DIR, MAX_OBJECTS, validate, load, loadAll, list, setEnabled, writeCursor, objectsOf: (name) => maps.get(name)?.objects };
