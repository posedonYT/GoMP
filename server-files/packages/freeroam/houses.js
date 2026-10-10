// Real estate: houses of three classes, each with the interior of its class and
// a garage for the owner's vehicles (with an interior of its own, if the file has one).
//
// A house is bought at its door for cash or by card (one house per character)
// and sold back to the state for half its price. Inside, every house is its own
// dimension: the interiors are templates (a spawn point, an exit point near the
// door and decoration props), shared by all houses that use them. The garage keeps
// vehicles: the owner drives one up to the door and puts it in; taken out, it
// appears on the road nearest to the house (the client finds the spot) and goes
// back into the garage when the owner leaves the game or the vehicle is destroyed.
//
// A garage template (garageInterior, from the house or its class) turns the garage into a place:
// the owner walks in from the door or drives in at the house's garagePoint, and every stored
// vehicle stands frozen on its slot in a dimension of its own (200000 + house id) while he is
// there; leaving, they are synced into the records and destroyed. Nothing about it is stored.
// Without a template the garage is virtual, as it used to be.
//
// The definitions (interiors, classes, houses) live in server-files/houses.json,
// edited with GoMP Studio or by an admin in the game (/house, /interior; admin.js).
// The file is watched: a saved change applies at once, players inside included.
// Owners, locks and garages are kept in the database, per house id.
//
// Houses file (format gomp-houses, version 1):
//   { "format": "gomp-houses", "version": 1,
//     "interiors": [{ "id": "studio", "name": "...", "spawn": [x, y, z], "heading": 0, "exit": [x, y, z],
//                     "props": [{ "id": "p1", "model": "prop_couch_01" (or a hash), "pos": [x, y, z], "rot": [x, y, z] }] }],
//     "garages": [{ "id": "garage2", "name": "...", "spawn": [x, y, z], "heading": 0, "exit": [x, y, z],
//                    "slots": [{ "pos": [x, y, z], "heading": 0 }] }],   (up to 50 slots; points: ground + 1)
//     "classes": [{ "id": "econom", "name": "Эконом", "garage": 2, "interior": "studio", "garageInterior": "garage2" (optional) }],
//     "houses": [{ "id": 1, "name": "...", "cls": "econom", "price": 55000, "door": [x, y, z], "heading": 0,
//                  "interior": "studio" (optional: instead of the class's),
//                  "garageInterior": "garage6" (optional: instead of the class's),
//                  "garagePoint": { "pos": [x, y, z], "heading": 0 } (optional: where cars drive in and come out) }] }
//
// Client protocol:
//   server -> client  gomp:houses [house], {classes}, {interiors}, {garages}   every house (markers, blips)
//                       house: {id, name, cls, price, x, y, z, heading, owner, ownerName, locked, interiorName,
//                               hasGarage, garageName ('' if none), garagePoint: {x, y, z, heading} | null}
//                       garages: {id: {name, spawn: [x, y, z], heading, exit: [x, y, z], slots: [[x, y, z, heading]]}}
//                       classes: {id: {name, interiorName, garage, interior: [x, y, z]}}
//                       interiors: {id: {name, spawn: [x, y, z], heading, exit: [x, y, z]}}
//                     gomp:house:info {...house, mine, sellPrice, garage: [{model, fuel, plate, out}], cap}
//                     gomp:house:inside {id, name, x, y, z, heading, exit: [x, y, z], props: [{model, pos, rot}], refresh?} | null
//                       inside a house; refresh: the interior changed under the player, only the
//                       exit and the props are updated (no teleport)
//                     gomp:garage:inside {id (house), name, x, y, z, heading, exit: [x, y, z], drive, refresh?} | null [, out]
//                       inside the garage; x..heading: the template's spawn, or the slot when drive is true.
//                       null, {x, y, z, heading, drive}: left the garage to there (drive: by car);
//                       null alone: the state is just cleared (death, garage -> house)
//   client -> server  gomp:house:info id
//                     gomp:house:buy id, method ('cash'|'bank')
//                     gomp:house:sell id
//                     gomp:house:enter id
//                     gomp:house:exit
//                     gomp:house:lock id
//                     gomp:garage:enter id, how ('foot'|'drive')   the owner only
//                     gomp:garage:exit how ('street'|'house'|'drive'), x, y, z, heading   x..heading: a road spot (drive, no garagePoint)
//                     gomp:garage:store id                     the vehicle being driven
//                     gomp:garage:take id, slot, x, y, z, heading     x..heading: a spot on the road
//                     gomp:garage:release id, slot, x, y, z, heading  out of the garage for good

const fs = require('fs');
const path = require('path');
const accounts = require('./accounts');
const roleplay = require('./roleplay');
const vehicles = require('./vehicles');
const tuning = require('./tuning');

const HOUSES_FILE = process.env.GOMP_HOUSES_FILE || path.join(__dirname, '..', '..', 'houses.json');
const DIMENSION_BASE = 50000;  // a house's interior: DIMENSION_BASE + id
const DOOR_RANGE = 5;          // buying, entering (the client offers it within 2 m)
const GARAGE_RANGE = 14;       // putting a vehicle in, taking one out
const SPAWN_RANGE = 80;        // how far from the door the client may place a vehicle taken out
const SELL_SHARE = 0.5;
const FIRST_CUSTOM_ID = 1000;
const MAX_PROPS = 300;         // per interior
const MAX_GARAGE = 50;
const GARAGE_DIMENSION_BASE = 200000;  // a garage's interior: GARAGE_DIMENSION_BASE + house id
const GARAGE_POINT_RANGE = 8;  // driving in: how close to the garage point
const SPAWN_LIFT = 0.5;        // points are ground + 1; a vehicle is created this much below its point
const DEBOUNCE_MS = 300;

// Per house: { owner, ownerName, locked, garage: [{model, fuel, plate, cls, carId}], bought }
// carId: the record of a bought vehicle (cars.js), null for others.
// cls: the GTA vehicle class (vehicles.js: the tank size), once a driver reported it.
// (Older databases also had `def` and `deleted`: the definitions used to be kept here; see migrate.)
const db = accounts.table('houses');

const inside = new Map();       // player id -> { house, door: [x, y, z], heading, json }
const outVehicles = new Map();  // vehicle id -> { house, slot, owner }
const garageIn = new Map();     // player id -> { house, door: [x, y, z], heading, json, drive }
const parked = new Map();       // vehicle id -> { house, slot, owner }: frozen in a garage interior

// ------------------------------------------------------------------ the file

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isId = (v) => typeof v === 'string' && /^[a-z0-9_-]{1,32}$/.test(v);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const round = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n;

function modelHash(model) {
  return typeof model === 'number' ? model >>> 0 : mp.joaat(String(model).trim().toLowerCase());
}

// The definitions of a houses document that can be used (normalised, defaults filled)
// and what is wrong with the others. An interior that is not valid takes the classes
// using it with it, and their houses.
function validate(doc) {
  const out = { interiors: [], garages: [], classes: [], houses: [], skipped: [] };
  if (!isObj(doc)) return { ...out, error: 'не объект JSON' };
  if (doc.format !== 'gomp-houses') return { ...out, error: `формат ${doc.format}` };
  if (doc.version !== 1) return { ...out, error: `версия ${doc.version}` };
  const skip = (msg) => { out.skipped.push(msg); };
  const arr = (v) => (Array.isArray(v) ? v : []);

  const interiors = new Map();
  arr(doc.interiors).forEach((o, i) => {
    const where = `интерьер ${i}`;
    if (!isObj(o)) return skip(`${where}: не объект`);
    if (!isId(o.id)) return skip(`${where}: id — a-z, 0-9, _, - (до 32)`);
    if (interiors.has(o.id)) return skip(`${where}: повторяется id ${o.id}`);
    const w = `интерьер ${o.id}`;
    if (typeof o.name !== 'string' || !o.name.trim()) return skip(`${w}: нет названия`);
    if (!vec3(o.spawn)) return skip(`${w}: spawn — три числа`);
    if (!vec3(o.exit)) return skip(`${w}: exit — три числа`);
    if (o.heading !== undefined && !isNum(o.heading)) return skip(`${w}: heading — число`);
    if (o.props !== undefined && !Array.isArray(o.props)) return skip(`${w}: props — список`);
    const props = [];
    arr(o.props).forEach((p, j) => {
      const pw = `${w}, предмет ${j}`;
      if (props.length >= MAX_PROPS) {
        if (j === MAX_PROPS) skip(`${w}: больше ${MAX_PROPS} предметов, остальные пропущены`);
        return undefined;
      }
      if (!isObj(p)) return skip(`${pw}: не объект`);
      const m = p.model;
      if (!((typeof m === 'string' && m.trim()) || (Number.isInteger(m) && m >= 0 && m <= 0xffffffff))) return skip(`${pw}: нет модели`);
      if (!vec3(p.pos)) return skip(`${pw}: pos — три числа`);
      if (p.rot !== undefined && !vec3(p.rot)) return skip(`${pw}: rot — три числа`);
      props.push({ id: typeof p.id === 'string' ? p.id : `p${j + 1}`, model: modelHash(m), pos: p.pos.slice(), rot: p.rot ? p.rot.slice() : [0, 0, 0] });
      return undefined;
    });
    const it = { id: o.id, name: o.name.trim(), spawn: o.spawn.slice(), heading: o.heading === undefined ? 0 : o.heading, exit: o.exit.slice(), props };
    interiors.set(it.id, it);
    out.interiors.push(it);
    return undefined;
  });

  const garages = new Map();
  arr(doc.garages).forEach((o, i) => {
    const where = `гараж ${i}`;
    if (!isObj(o)) return skip(`${where}: не объект`);
    if (!isId(o.id)) return skip(`${where}: id — a-z, 0-9, _, - (до 32)`);
    if (garages.has(o.id)) return skip(`${where}: повторяется id ${o.id}`);
    const w = `гараж ${o.id}`;
    if (typeof o.name !== 'string' || !o.name.trim()) return skip(`${w}: нет названия`);
    if (!vec3(o.spawn)) return skip(`${w}: spawn — три числа`);
    if (!vec3(o.exit)) return skip(`${w}: exit — три числа`);
    if (o.heading !== undefined && !isNum(o.heading)) return skip(`${w}: heading — число`);
    const slots = [];
    let cut = false;
    arr(o.slots).forEach((p, j) => {
      const pw = `${w}, место ${j + 1}`;
      if (slots.length >= MAX_GARAGE) {
        if (!cut) skip(`${w}: больше ${MAX_GARAGE} мест, остальные пропущены`);
        cut = true;
        return undefined;
      }
      if (!isObj(p)) return skip(`${pw}: не объект`);
      if (!vec3(p.pos)) return skip(`${pw}: pos — три числа`);
      if (p.heading !== undefined && !isNum(p.heading)) return skip(`${pw}: heading — число`);
      slots.push({ pos: p.pos.slice(), heading: p.heading === undefined ? 0 : p.heading });
      return undefined;
    });
    if (!slots.length) return skip(`${w}: нет ни одного места для машины`);
    const g = { id: o.id, name: o.name.trim(), spawn: o.spawn.slice(), heading: o.heading === undefined ? 0 : o.heading, exit: o.exit.slice(), slots };
    garages.set(g.id, g);
    out.garages.push(g);
    return undefined;
  });

  const classes = new Map();
  arr(doc.classes).forEach((o, i) => {
    const where = `класс ${i}`;
    if (!isObj(o)) return skip(`${where}: не объект`);
    if (!isId(o.id)) return skip(`${where}: id — a-z, 0-9, _, - (до 32)`);
    if (classes.has(o.id)) return skip(`${where}: повторяется id ${o.id}`);
    const w = `класс ${o.id}`;
    if (typeof o.name !== 'string' || !o.name.trim()) return skip(`${w}: нет названия`);
    if (!(Number.isInteger(o.garage) && o.garage >= 0 && o.garage <= MAX_GARAGE)) return skip(`${w}: garage — целое 0-${MAX_GARAGE}`);
    if (!interiors.has(o.interior)) return skip(`${w}: нет интерьера ${o.interior}`);
    const c = { id: o.id, name: o.name.trim(), garage: o.garage, interior: o.interior };
    // An unknown garage template only costs the class its garage interior.
    if (o.garageInterior !== undefined && o.garageInterior !== null) {
      if (garages.has(o.garageInterior)) c.garageInterior = o.garageInterior;
      else skip(`${w}: нет гаража ${o.garageInterior}`);
    }
    classes.set(c.id, c);
    out.classes.push(c);
    return undefined;
  });

  const ids = new Set();
  arr(doc.houses).forEach((o, i) => {
    const where = `дом ${i}`;
    if (!isObj(o)) return skip(`${where}: не объект`);
    if (!(Number.isInteger(o.id) && o.id > 0)) return skip(`${where}: id — целое больше нуля`);
    if (ids.has(o.id)) return skip(`${where}: повторяется id ${o.id}`);
    const w = `дом ${o.id}`;
    if (typeof o.name !== 'string' || !o.name.trim()) return skip(`${w}: нет названия`);
    if (!classes.has(o.cls)) return skip(`${w}: нет класса ${o.cls}`);
    if (!(Number.isInteger(o.price) && o.price > 0)) return skip(`${w}: price — целое больше нуля`);
    if (!vec3(o.door)) return skip(`${w}: door — три числа`);
    if (o.heading !== undefined && !isNum(o.heading)) return skip(`${w}: heading — число`);
    if (o.interior !== undefined && !interiors.has(o.interior)) return skip(`${w}: нет интерьера ${o.interior}`);
    ids.add(o.id);
    const h = { id: o.id, name: o.name.trim(), cls: o.cls, price: o.price, door: o.door.slice(), heading: o.heading === undefined ? 0 : o.heading };
    if (o.interior !== undefined) h.interior = o.interior;
    if (o.garageInterior !== undefined && o.garageInterior !== null) {
      if (garages.has(o.garageInterior)) h.garageInterior = o.garageInterior;
      else skip(`${w}: нет гаража ${o.garageInterior}`);
    }
    // A broken garage point only costs the house its garage point (null: none, on purpose).
    const gp = o.garagePoint;
    if (gp !== undefined && gp !== null) {
      if (isObj(gp) && vec3(gp.pos) && (gp.heading === undefined || isNum(gp.heading))) h.garagePoint = { pos: gp.pos.slice(), heading: gp.heading === undefined ? 0 : gp.heading };
      else skip(`${w}: garagePoint — {pos: три числа, heading: число}`);
    }
    out.houses.push(h);
    return undefined;
  });
  return out;
}

const emptyDoc = () => ({ format: 'gomp-houses', version: 1, interiors: [], garages: [], classes: [], houses: [] });

// What is in use now: the last valid document and its definitions.
let rawDoc = emptyDoc();    // as written in the file (unknown fields included): the admin commands edit this
let lastText;               // the text of the file as last read or written by us
let fileOk = true;          // the file is missing or valid (a broken one is never overwritten)
let interiorsById = new Map();
let garagesById = new Map();
let classesById = new Map();
let houseDefs = [];

function build(v) {
  interiorsById = new Map(v.interiors.map((i) => [i.id, i]));
  garagesById = new Map(v.garages.map((g) => [g.id, g]));
  classesById = new Map(v.classes.map((c) => [c.id, c]));
  houseDefs = v.houses.map((h) => ({
    id: h.id, name: h.name, cls: h.cls, price: h.price, x: h.door[0], y: h.door[1], z: h.door[2], heading: h.heading,
    interiorId: h.interior || classesById.get(h.cls).interior,
    garageId: h.garageInterior || classesById.get(h.cls).garageInterior || null,
    garagePoint: h.garagePoint ? { pos: h.garagePoint.pos.slice(), heading: h.garagePoint.heading } : null,
  }));
}

function stateOf(id) {
  if (!db[id]) db[id] = { owner: null, ownerName: '', locked: true, garage: [] };
  return db[id];
}

// Every house with its state.
function list() {
  return houseDefs.map((h) => ({ ...h, state: stateOf(h.id) }));
}

function byId(id) {
  const h = houseDefs.find((x) => x.id === Number(id));
  return h ? { ...h, state: stateOf(h.id) } : null;
}

function ownedBy(statik) {
  return statik === null || statik === undefined ? null : list().find((h) => h.state.owner === statik) || null;
}

const interiorOf = (h) => interiorsById.get(h.interiorId);
// The garage template of a house (its own, else its class's), or null: a virtual garage.
const garageOf = (h) => garagesById.get(h.garageId) || null;
const garageDim = (h) => GARAGE_DIMENSION_BASE + h.id;

function publicView(h) {
  const g = garageOf(h);
  const p = h.garagePoint;
  return { id: h.id, name: h.name, cls: h.cls, price: h.price, x: h.x, y: h.y, z: h.z, heading: h.heading,
    owner: h.state.owner, ownerName: h.state.ownerName, locked: !!h.state.locked, interiorName: interiorOf(h).name,
    hasGarage: !!g, garageName: g ? g.name : '', garagePoint: p ? { x: p.pos[0], y: p.pos[1], z: p.pos[2], heading: p.heading } : null };
}

function classesView() {
  const out = {};
  for (const c of classesById.values()) {
    const it = interiorsById.get(c.interior);
    out[c.id] = { name: c.name, interiorName: it.name, garage: c.garage, interior: it.spawn.slice() };
  }
  return out;
}

function interiorsView() {
  const out = {};
  for (const i of interiorsById.values()) out[i.id] = { name: i.name, spawn: i.spawn.slice(), heading: i.heading, exit: i.exit.slice() };
  return out;
}

function garagesView() {
  const out = {};
  for (const g of garagesById.values()) {
    out[g.id] = { name: g.name, spawn: g.spawn.slice(), heading: g.heading, exit: g.exit.slice(), slots: g.slots.map((s) => [...s.pos, s.heading]) };
  }
  return out;
}

function send(player) {
  player.call('gomp:houses', [list().map(publicView), classesView(), interiorsView(), garagesView()]);
}

function broadcast() {
  mp.players.forEach((p) => {
    if (roleplay.isLogged(p)) send(p);
  });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const doorOf = (h) => new mp.Vector3(h.x, h.y, h.z);
const sellPrice = (h) => Math.round(h.price * SELL_SHARE);
// The class's size, or the template's number of slots if that is less.
function capOf(h) {
  const g = garageOf(h);
  const n = classesById.get(h.cls).garage;
  return g ? Math.min(n, g.slots.length) : n;
}

// What a player inside the house is told (the props go here, not with the list of houses).
function insidePayload(h) {
  const it = interiorOf(h);
  const [x, y, z] = it.spawn;
  return { id: h.id, name: h.name, x, y, z, heading: it.heading, exit: it.exit.slice(),
    props: it.props.map((p) => ({ model: p.model, pos: p.pos.slice(), rot: p.rot.slice() })) };
}

// Takes players out of a house gone, tells the others about a changed interior.
function syncInside() {
  inside.forEach((e, pid) => {
    const p = mp.players.at(pid);
    if (!p) {
      inside.delete(pid);
      return;
    }
    const h = byId(e.house);
    if (!h) {
      leave(p);
      return;
    }
    const payload = insidePayload(h);
    const json = JSON.stringify(payload);
    if (json === e.json) return;
    e.json = json;
    p.call('gomp:house:inside', [{ ...payload, refresh: true }]);
  });
  garageIn.forEach((e, pid) => {
    const p = mp.players.at(pid);
    if (!p) {
      garageIn.delete(pid);
      emptyGarage(e.house);
      return;
    }
    const h = byId(e.house);
    if (!h || !garageOf(h)) {
      // The house or its template is gone: out at the door.
      forceOutOfGarage(p, e);
      return;
    }
    // The slots are part of what is compared: the cars follow them.
    const json = garageJson(h);
    if (json === e.json) return;
    e.json = json;
    restockGarage(p, h);
    p.call('gomp:garage:inside', [{ ...garagePayload(h), drive: !!e.drive, refresh: true }]);
  });
}

function install(v, doc) {
  rawDoc = doc;
  build(v);
  syncInside();
  broadcast();
}

// Writes a file so that a reader never sees half of it.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// (Re)reads the file. A broken one keeps the houses that are there; a missing one means none.
function reload() {
  let text = null;
  try {
    text = fs.readFileSync(HOUSES_FILE, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.log(`[houses] ${HOUSES_FILE}: ${e.message} — оставлены прежние дома`);
      return { changed: false, error: e.message, skipped: [] };
    }
  }
  if (text === lastText) return { changed: false, skipped: [] };  // our own write, or nothing new
  lastText = text;
  if (text === null) {
    fileOk = true;
    console.log(`[houses] нет файла ${HOUSES_FILE} — домов нет`);
    install(validate(emptyDoc()), emptyDoc());
    return { changed: true, houses: 0, skipped: [] };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    fileOk = false;
    console.log(`[houses] ошибка JSON: ${e.message} — оставлены прежние дома`);
    return { changed: false, error: `ошибка JSON: ${e.message}`, skipped: [] };
  }
  const v = validate(doc);
  if (v.error) {
    fileOk = false;
    console.log(`[houses] ${v.error} — оставлены прежние дома`);
    return { changed: false, error: v.error, skipped: [] };
  }
  fileOk = true;
  install(v, doc);
  for (const s of v.skipped.slice(0, 10)) console.log(`[houses] пропущен ${s}`);
  if (v.skipped.length > 10) console.log(`[houses] пропущено ещё ${v.skipped.length - 10}`);
  console.log(`[houses] домов ${v.houses.length}, классов ${v.classes.length}, интерьеров ${v.interiors.length}`);
  return { changed: true, houses: v.houses.length, classes: v.classes.length, interiors: v.interiors.length, skipped: v.skipped };
}

// Saves a changed document and applies it at once (the watcher then finds the same text).
function commit(doc) {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  writeAtomic(HOUSES_FILE, text);
  lastText = text;
  fileOk = true;
  install(validate(doc), doc);
}

// fn changes a copy of the document; false if the file is broken (it is not overwritten).
function edit(fn) {
  if (!fileOk) return false;
  const doc = JSON.parse(JSON.stringify(rawDoc));
  for (const k of ['interiors', 'garages', 'classes', 'houses']) if (!Array.isArray(doc[k])) doc[k] = [];
  fn(doc);
  commit(doc);
  return true;
}

// The definitions used to be kept in the database (`def`: a house added or moved by an admin,
// `deleted`: a hidden one of the built-in list). They go into the file, once.
function migrate() {
  const old = Object.entries(db).filter(([, s]) => s && (s.def || s.deleted));
  if (!old.length) return false;
  if (!fileOk) {
    console.log('[houses] файл повреждён — перенос из базы отложен');
    return false;
  }
  const doc = JSON.parse(JSON.stringify(rawDoc));
  if (!Array.isArray(doc.houses)) doc.houses = [];
  for (const [key, s] of old) {
    const id = Number(key);
    const d = s.def;
    if (d) {
      const house = doc.houses.find((h) => h && h.id === id);
      if (!house) {
        if (typeof d.name === 'string' && d.cls && d.price) doc.houses.push({ id, name: d.name, cls: d.cls, price: d.price, door: [d.x, d.y, d.z], heading: 0 });
      } else if (id < FIRST_CUSTOM_ID && [d.x, d.y, d.z].every(isNum)) {
        house.door = [d.x, d.y, d.z];  // a moved door of the built-in list
      }
      delete s.def;
    }
    if (s.deleted) {
      doc.houses = doc.houses.filter((h) => !(h && h.id === id));
      delete s.deleted;
    }
  }
  commit(doc);
  accounts.save();
  console.log(`[houses] из базы в файл перенесено: ${old.length}`);
  return true;
}

// New ids go past every id in the file and every id with a state in the database,
// so that a house never inherits the owner and the garage of a deleted one.
function nextHouseId() {
  const ids = [...rawDoc.houses.map((h) => h && h.id), ...Object.keys(db)].map(Number).filter(Number.isInteger);
  return Math.max(FIRST_CUSTOM_ID - 1, ...ids) + 1;
}

let timer = null;
function watch() {
  const dir = path.dirname(HOUSES_FILE);
  const name = path.basename(HOUSES_FILE);
  try {
    const w = fs.watch(dir, (_, f) => {
      if (f && String(f) !== name) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          reload();
        } catch (e) {
          console.log(`[houses] ${e.message}`);
        }
      }, DEBOUNCE_MS);
      if (timer.unref) timer.unref();
    });
    if (w.unref) w.unref();
  } catch (e) {
    console.log(`[houses] не удалось следить за ${dir}: ${e.message}`);
  }
}

// Vehicles of this house standing outside: slot -> vehicle.
function vehiclesOut(h) {
  const out = new Map();
  outVehicles.forEach((o, id) => {
    if (o.house === h.id && mp.vehicles.exists(id)) out.set(o.slot, mp.vehicles.at(id));
  });
  return out;
}

function info(player, h) {
  const ch = roleplay.character(player);
  const mine = !!ch && h.state.owner === ch.static;
  const out = mine ? vehiclesOut(h) : new Map();
  return {
    ...publicView(h), mine, sellPrice: sellPrice(h), cap: capOf(h),
    garage: mine ? h.state.garage.map((v, i) => ({ model: v.model, fuel: Math.round(v.fuel * 10) / 10, plate: v.plate, out: out.has(i) })) : [],
  };
}

// The player is at the door (outside) or inside this house.
function atHouse(player, h, range = DOOR_RANGE) {
  const e = inside.get(player.id);
  return (e && e.house === h.id) || (player.dimension === 0 && dist(player.position, h) <= range);
}

function account(player) {
  const ch = roleplay.character(player);
  return ch && !ch.guest ? ch : null;
}

// ------------------------------------------------------------------ inside

function enter(player, h) {
  const ch = account(player);
  if (!ch || player.vehicle) return;
  const mine = h.state.owner === ch.static;
  if (h.state.owner !== null && !mine && h.state.locked) {
    player.notify('~r~Дверь закрыта');
    return;
  }
  const prev = inside.get(player.id);
  // Leaving the game inside, the player comes back at the door.
  if (!prev) {
    ch.pos = [h.x, h.y, h.z];
    ch.heading = player.heading;
  }
  putInHouse(player, h, prev ? prev.door : [h.x, h.y, h.z], prev ? prev.heading : h.heading);
}

// Puts the player into the house interior. door, heading: the way he came by,
// where he is put if the house is gone meanwhile.
function putInHouse(player, h, door, heading) {
  const payload = insidePayload(h);
  inside.set(player.id, { house: h.id, door, heading, json: JSON.stringify(payload) });
  player.dimension = DIMENSION_BASE + h.id;
  player.position = new mp.Vector3(payload.x, payload.y, payload.z);
  player.heading = payload.heading;
  player.call('gomp:house:inside', [payload]);
  if (h.state.owner === null) player.notify(`Осмотр: ~b~${h.name}~s~ — ${interiorOf(h).name}`);
}

function leave(player) {
  const e = inside.get(player.id);
  if (!e) return;
  inside.delete(player.id);
  const h = byId(e.house);
  player.dimension = 0;
  if (h) {
    player.position = doorOf(h);
    player.heading = h.heading;
  } else if (e.door) {
    // A house removed meanwhile: the door he came by.
    player.position = new mp.Vector3(...e.door);
    player.heading = e.heading;
  } else {
    player.position = roleplay.randomSpawn();
  }
  player.call('gomp:house:inside', [null]);
}

// ------------------------------------------------------------------ buying and selling

function buy(player, h, method) {
  const ch = account(player);
  if (!ch) return;
  if (!atHouse(player, h)) return player.notify('~r~Подойдите к двери дома');
  if (h.state.owner !== null) return player.notify('~r~Дом уже продан');
  if (ownedBy(ch.static)) return player.notify('~r~У вас уже есть дом. Сначала продайте его');
  if (!roleplay.pay(player, h.price, method === 'bank' ? 'bank' : 'cash', `Покупка дома: ${h.name}`)) {
    return player.notify('~r~Недостаточно денег');
  }
  Object.assign(stateOf(h.id), { owner: ch.static, ownerName: `${ch.first} ${ch.last}`, locked: true, garage: [], bought: Date.now() });
  accounts.save();
  broadcast();
  player.notify(`Поздравляем! Вы купили ~g~${h.name}~s~ за $${h.price}. Гараж: ${capOf(h)} места`);
  player.call('gomp:house:info', [info(player, h)]);
}

function sell(player, h) {
  const ch = account(player);
  if (!ch || h.state.owner !== ch.static) return;
  if (h.state.garage.length) return player.notify('~r~Сначала заберите транспорт из гаража');
  const sum = sellPrice(h);
  // Everybody inside goes out.
  inside.forEach((e, pid) => {
    const p = mp.players.at(pid);
    if (e.house === h.id && p) leave(p);
  });
  clearGarage(h.id);
  Object.assign(stateOf(h.id), { owner: null, ownerName: '', locked: true, garage: [] });
  roleplay.deposit(player, sum, `Продажа дома: ${h.name}`);
  accounts.save();
  broadcast();
  player.notify(`Дом продан государству: ~g~$${sum}~s~ зачислено на карту`);
}

function toggleLock(player, h) {
  const ch = account(player);
  if (!ch || h.state.owner !== ch.static) return;
  h.state.locked = !h.state.locked;
  accounts.save();
  broadcast();
  player.notify(h.state.locked ? 'Дверь ~r~закрыта' : 'Дверь ~g~открыта~s~: гости могут войти');
}

// ------------------------------------------------------------------ garage

function store(player, h) {
  const ch = account(player);
  const veh = player.vehicle;
  if (!ch || h.state.owner !== ch.static) return;
  if (!veh || player.seat !== 0) return player.notify('~r~Сядьте за руль');
  if (!vehicles.isOwner(player, veh)) return player.notify('~r~Это не ваш транспорт');
  if (player.dimension !== 0 || dist(veh.position, h) > GARAGE_RANGE) return player.notify('~r~Подъедьте к дому');
  const fuel = vehicles.fuelOf(veh);
  const cls = veh.getVariable('fuelClass');
  const from = outVehicles.get(veh.id);
  let slot;
  if (from) {
    // Out of this garage: back into its place.
    slot = from.slot;
    Object.assign(h.state.garage[slot], { fuel, cls, ...lookFor(veh) });
    outVehicles.delete(veh.id);
  } else {
    if (h.state.garage.length >= capOf(h)) return player.notify(`~r~В гараже нет места (${capOf(h)})`);
    slot = h.state.garage.push({ model: veh.model, fuel, plate: veh.numberPlate || '', cls, carId: veh.getVariable('carId') ?? null, ...lookFor(veh) }) - 1;
    // The vehicle of the starter kit lives in the garage from now on.
    if (player.getVariable('personalVehicle') === veh) {
      player.setVariable('personalVehicle', null);
      if (ch.vehicle && mp.joaat(ch.vehicle) === veh.model) ch.vehicle = null;
    }
  }
  player.removeFromVehicle();
  veh.destroy();
  accounts.save();
  player.notify(`Транспорт поставлен в гараж (место ${slot + 1} из ${capOf(h)})`);
}

function take(player, h, slot, spot) {
  const ch = account(player);
  if (!ch || h.state.owner !== ch.static) return;
  const rec = h.state.garage[slot];
  if (!rec) return;
  if (parkedOf(h.id).has(slot)) return player.notify('~r~Машина стоит в гараже');
  if (player.vehicle || player.dimension !== 0 || dist(player.position, h) > GARAGE_RANGE) return player.notify('~r~Подойдите к дому');
  if (vehiclesOut(h).has(slot)) return player.notify('~r~Этот транспорт уже на улице');
  let pos;
  let heading;
  if (garageOf(h) && h.garagePoint) {
    // A garage with a door of its own: cars come out there, wherever the client looked.
    const g = exitSpot(h, null);
    pos = new mp.Vector3(g.x, g.y, g.z - SPAWN_LIFT);
    heading = g.heading;
  } else {
    // The client's spot on the nearest road, or next to the door.
    const ok = spot && [spot.x, spot.y, spot.z].every(Number.isFinite) && dist(spot, h) <= SPAWN_RANGE;
    pos = ok ? new mp.Vector3(spot.x, spot.y, spot.z + 0.5) : new mp.Vector3(h.x + 3, h.y + 3, h.z + 0.5);
    heading = ok && Number.isFinite(spot.heading) ? spot.heading : player.heading;
  }
  spawnRecord(player, h, slot, pos, heading, 0, (v) => outVehicles.set(v.id, { house: h.id, slot, owner: ch.static }));
  player.notify('Транспорт выехал из гаража');
}

// The vehicle leaves the garage for good (to sell the house, to free a place):
// one standing outside stays there, one inside is driven out first.
function release(player, h, slot, spot) {
  const ch = account(player);
  if (!ch || h.state.owner !== ch.static || !h.state.garage[slot]) return;
  if (parkedOf(h.id).has(slot)) return player.notify('~r~Машина стоит в гараже');
  if (!vehiclesOut(h).has(slot)) {
    take(player, h, slot, spot);
    if (!vehiclesOut(h).has(slot)) return;  // not taken out (too far from the house)
  }
  h.state.garage.splice(slot, 1);
  // The places after it move up.
  outVehicles.forEach((o, id) => {
    if (o.house !== h.id) return;
    if (o.slot === slot) outVehicles.delete(id);
    else if (o.slot > slot) o.slot -= 1;
  });
  accounts.save();
  player.notify('Транспорт убран из гаража: место освободилось');
}

// A vehicle out of a garage is back in it: its fuel is kept.
// entity: the runtime has taken a destroyed vehicle out of its pool before it tells us.
function returnVehicle(vehId, entity) {
  const o = outVehicles.get(vehId);
  if (!o) return;
  outVehicles.delete(vehId);
  const s = db[o.house];
  const rec = s && s.garage && s.garage[o.slot];
  const veh = entity || mp.vehicles.at(vehId);
  if (rec && veh) {
    const fuel = veh.getVariable('fuel');
    if (typeof fuel === 'number') rec.fuel = fuel;
  }
  accounts.save();
}

mp.events.add('entityDestroyed', (entity) => {
  if (!entity || entity.type !== 'vehicle') return;
  const pk = parked.get(entity.id);
  if (pk) {
    // Destroyed from outside (an admin): the record keeps its fuel (the entity is already out of the pool).
    parked.delete(entity.id);
    const rec = db[pk.house] && db[pk.house].garage && db[pk.house].garage[pk.slot];
    const fuel = entity.getVariable('fuel');
    if (rec && typeof fuel === 'number') rec.fuel = fuel;
    accounts.save();
    return;
  }
  returnVehicle(entity.id, entity);
});

// ------------------------------------------------------------------ garage interiors

// Parked vehicles of a house: slot -> vehicle.
function parkedOf(houseId) {
  const out = new Map();
  parked.forEach((o, id) => {
    if (o.house === houseId && mp.vehicles.exists(id)) out.set(o.slot, mp.vehicles.at(id));
  });
  return out;
}

const isSpot = (s) => !!s && [s.x, s.y, s.z].every(Number.isFinite) && !(s.x === 0 && s.y === 0 && s.z === 0);

// Where a vehicle appears coming out of the garage ({x, y, z, heading}, ground + 1 like every point):
// the garage point; else the spot the client found on the road; else next to the door.
function exitSpot(h, clientSpot) {
  if (h.garagePoint) {
    const [x, y, z] = h.garagePoint.pos;
    return { x, y, z, heading: h.garagePoint.heading };
  }
  if (isSpot(clientSpot) && dist(clientSpot, h) <= SPAWN_RANGE) {
    return { x: clientSpot.x, y: clientSpot.y, z: clientSpot.z + 1, heading: Number.isFinite(clientSpot.heading) ? clientSpot.heading : h.heading };
  }
  return { x: h.x + 3, y: h.y + 3, z: h.z, heading: h.heading };
}

const garageSpot = (h) => exitSpot(h, null);

// What a player in the garage is told: the template's spawn, or the slot he has driven to.
function garagePayload(h, slot = null) {
  const g = garageOf(h);
  const s = slot === null ? null : g.slots[slot];
  const [x, y, z] = s ? s.pos : g.spawn;
  return { id: h.id, name: h.name, x, y, z, heading: s ? s.heading : g.heading, exit: g.exit.slice(), drive: !!s };
}

// What a player in the garage notices of the file changing (the slots too: the cars follow them).
const garageJson = (h) => JSON.stringify([garagePayload(h), garageOf(h).slots]);

// A new vehicle from a record of the garage, made like the one that was put away.
// Parked ones are frozen at once (still the same tick, so the create message carries it).
// onCreate runs before the tuning hooks.
function spawnRecord(player, h, slot, pos, heading, dimension, onCreate, frozen = false) {
  const rec = h.state.garage[slot];
  if (!rec) return null;
  const veh = mp.vehicles.new(rec.model, pos, {
    heading,
    numberPlate: rec.plate || `GO${String(h.state.owner).padStart(5, '0')}`,
    dimension,
  });
  if (frozen) veh.movable = false;
  // The class first: its tank holds the litres kept in the garage.
  vehicles.setup(veh, h.state.owner);
  // A bought vehicle (cars.js) stays the same car in and out of the garage.
  if (rec.carId !== null && rec.carId !== undefined) veh.setVariable('carId', rec.carId);
  if (rec.cls !== null && rec.cls !== undefined) vehicles.setClass(veh, rec.cls);
  vehicles.setFuel(veh, rec.fuel);
  if (rec.carId === null || rec.carId === undefined) {
    // Its own look; a record from before looks had a per-model tuning of its owner.
    if (rec.look === undefined) {
      const owner = accounts.characterByStatic(h.state.owner);
      rec.look = (owner && owner.tuning && owner.tuning[String(rec.model)]) || null;
    }
    if (rec.look) tuning.apply(veh, rec.look);
  }
  if (onCreate) onCreate(veh);
  for (const fn of vehicles.onSpawn) fn(veh, player, rec.model);  // a bought car (carId) gets its look there
  return veh;
}

// The look a garage record keeps: its own for a vehicle that is not a bought car
// (a bought car keeps its look in its record, cars.js).
function lookFor(veh) {
  const id = veh.getVariable('carId');
  return id === null || id === undefined ? { look: tuning.stateOf(veh) } : {};
}

// Tuning a vehicle out of a garage (not a bought car) changes its record.
tuning.records.push((player, veh) => {
  const o = outVehicles.get(veh.id) || parked.get(veh.id);
  const rec = o && db[o.house] && db[o.house].garage && db[o.house].garage[o.slot];
  return rec && (rec.carId === null || rec.carId === undefined) ? rec : null;
});

// The vehicle's fuel and class go back into its record. Before destroy(): afterwards it is gone.
function syncRecord(houseId, slot, veh) {
  const s = db[houseId];
  const rec = s && s.garage && s.garage[slot];
  if (!rec || !veh) return;
  rec.fuel = vehicles.fuelOf(veh);
  const cls = veh.getVariable('fuelClass');
  if (cls !== null && cls !== undefined) rec.cls = cls;
}

const slotPos = (slot) => new mp.Vector3(slot.pos[0], slot.pos[1], slot.pos[2] - SPAWN_LIFT);

// Every stored vehicle that is not outside and not here yet stands on its slot.
function fillGarage(player, h) {
  const g = garageOf(h);
  if (!g) return;
  const out = vehiclesOut(h);
  const here = parkedOf(h.id);
  h.state.garage.forEach((rec, i) => {
    if (i >= g.slots.length || out.has(i) || here.has(i)) return;
    const slot = g.slots[i];
    spawnRecord(player, h, i, slotPos(slot), slot.heading, garageDim(h),
      (v) => parked.set(v.id, { house: h.id, slot: i, owner: h.state.owner }), true);
  });
}

// The parked vehicles of a house go back into the records and disappear.
// sync = false when the records are going as well.
function emptyGarage(houseId, sync = true) {
  [...parked].forEach(([id, o]) => {
    if (o.house !== houseId) return;
    parked.delete(id);
    const veh = mp.vehicles.at(id);
    if (!veh) return;
    if (sync) syncRecord(houseId, o.slot, veh);
    veh.destroy();
  });
  accounts.save();
}

// The template changed under the owner: parked cars follow their slots, new ones appear, those without a slot go.
function restockGarage(player, h) {
  const g = garageOf(h);
  parked.forEach((o, id) => {
    if (o.house !== h.id) return;
    const veh = mp.vehicles.at(id);
    if (!veh || veh.getOccupants().length) return;
    const slot = g.slots[o.slot];
    if (!slot) {
      parked.delete(id);
      syncRecord(h.id, o.slot, veh);
      veh.destroy();
      return;
    }
    veh.position = slotPos(slot);
    veh.heading = slot.heading;
  });
  fillGarage(player, h);
  accounts.save();
}

// The player is put out of the garage at the door he came by; a driver is pulled out first.
function forceOutOfGarage(player, entry, sync = true) {
  garageIn.delete(player.id);
  if (player.vehicle) player.removeFromVehicle();
  emptyGarage(entry.house, sync);
  const h = byId(entry.house);
  const door = h ? [h.x, h.y, h.z] : entry.door;
  const heading = h ? h.heading : entry.heading;
  player.dimension = 0;
  player.position = new mp.Vector3(...door);
  player.heading = heading;
  player.call('gomp:garage:inside', [null, { x: door[0], y: door[1], z: door[2], heading, drive: false }]);
}

// Everybody in the garage of a house goes out, its vehicles disappear (sold, taken away, removed).
function clearGarage(houseId, sync = true) {
  [...garageIn].forEach(([pid, e]) => {
    if (e.house !== houseId) return;
    const p = mp.players.at(pid);
    if (p) forceOutOfGarage(p, e, sync);
    else garageIn.delete(pid);
  });
  emptyGarage(houseId, sync);
}

function enterGarage(player, h, how) {
  const ch = account(player);
  const g = garageOf(h);
  if (!ch || !g) return;
  if (h.state.owner !== ch.static) return player.notify('~r~Гараж — только для владельца');
  if (garageIn.has(player.id)) return;
  if (how === 'drive') return driveIn(player, ch, h, g);

  if (player.vehicle) return player.notify('~r~Выйдите из машины');
  const prev = inside.get(player.id);
  const fromHouse = !!prev && prev.house === h.id;
  if (!fromHouse && (player.dimension !== 0 || dist(player.position, h) > DOOR_RANGE)) return player.notify('~r~Подойдите к двери дома');
  let door = [h.x, h.y, h.z];
  let heading = h.heading;
  if (fromHouse) {
    // The way he came into the house stays the way out; the house hears nothing.
    door = prev.door;
    heading = prev.heading;
    inside.delete(player.id);
  } else {
    // Leaving the game inside, the player comes back at the door.
    ch.pos = door.slice();
    ch.heading = player.heading;
  }
  garageIn.set(player.id, { house: h.id, door, heading, json: garageJson(h), drive: false });
  const payload = garagePayload(h);
  player.dimension = garageDim(h);
  player.position = new mp.Vector3(payload.x, payload.y, payload.z);
  player.heading = payload.heading;
  fillGarage(player, h);
  player.call('gomp:garage:inside', [payload]);
}

// Driving in at the garage point: the vehicle itself goes to its slot, the player at the wheel.
function driveIn(player, ch, h, g) {
  const veh = player.vehicle;
  if (!veh || player.seat !== 0) return player.notify('~r~Сядьте за руль');
  if (!vehicles.isOwner(player, veh)) return player.notify('~r~Это не ваш транспорт');
  const pt = h.garagePoint;
  const near = pt ? dist(veh.position, { x: pt.pos[0], y: pt.pos[1], z: pt.pos[2] }) <= GARAGE_POINT_RANGE : dist(veh.position, h) <= GARAGE_RANGE;
  if (player.dimension !== 0 || !near) return player.notify('~r~Подъедьте к въезду в гараж');
  const from = outVehicles.get(veh.id);
  const reuse = !!from && from.house === h.id && !!h.state.garage[from.slot];
  if (!reuse && h.state.garage.length >= capOf(h)) return player.notify(`~r~В гараже нет места (${capOf(h)})`);
  const slot = reuse ? from.slot : h.state.garage.length;
  if (slot >= g.slots.length) return player.notify('~r~Для этой машины нет места в гараже');

  const fuel = vehicles.fuelOf(veh);
  const cls = veh.getVariable('fuelClass');
  outVehicles.delete(veh.id);
  if (reuse) {
    Object.assign(h.state.garage[slot], { fuel, cls, ...lookFor(veh) });
  } else {
    h.state.garage.push({ model: veh.model, fuel, plate: veh.numberPlate || '', cls, carId: veh.getVariable('carId') ?? null, ...lookFor(veh) });
    // The vehicle of the starter kit lives in the garage from now on.
    if (player.getVariable('personalVehicle') === veh) {
      player.setVariable('personalVehicle', null);
      if (ch.vehicle && mp.joaat(ch.vehicle) === veh.model) ch.vehicle = null;
    }
  }
  // The others stay outside, at the garage point.
  const out = exitSpot(h, null);
  veh.getOccupants().filter((p) => p !== player).forEach((p) => {
    p.removeFromVehicle();
    p.position = new mp.Vector3(out.x, out.y, out.z);
    p.notify('~o~Водитель заехал в гараж: вы остались снаружи');
  });
  const door = [h.x, h.y, h.z];
  ch.pos = door.slice();
  ch.heading = h.heading;
  garageIn.set(player.id, { house: h.id, door, heading: h.heading, json: garageJson(h), drive: true });
  // The driver's dimension first, the vehicle's next, the position last: he never loses his own vehicle.
  const s = g.slots[slot];
  player.dimension = garageDim(h);
  veh.dimension = garageDim(h);
  veh.position = slotPos(s);
  veh.heading = s.heading;
  parked.set(veh.id, { house: h.id, slot, owner: h.state.owner });
  fillGarage(player, h);
  accounts.save();
  player.call('gomp:garage:inside', [garagePayload(h, slot)]);
  player.notify(`Транспорт в гараже (место ${slot + 1} из ${capOf(h)})`);
  return undefined;
}

// how: 'street' and 'house' on foot, 'drive' at the wheel of a car of this garage.
// spot: the client's place on the road (used only when the house has no garage point).
function exitGarage(player, how, spot) {
  const e = garageIn.get(player.id);
  if (!e) return;
  const h = byId(e.house);
  if (!h || !garageOf(h)) {
    forceOutOfGarage(player, e);
    return;
  }
  if (how === 'drive') {
    const veh = player.vehicle;
    const pk = veh && parked.get(veh.id);
    if (!veh || player.seat !== 0 || !pk || pk.house !== h.id) {
      player.notify('~r~Сядьте за руль машины из гаража');
      return;
    }
    syncRecord(h.id, pk.slot, veh);
    parked.delete(veh.id);
    outVehicles.set(veh.id, { house: h.id, slot: pk.slot, owner: pk.owner });
    veh.movable = true;
    emptyGarage(h.id);
    garageIn.delete(player.id);
    const out = exitSpot(h, spot);
    player.dimension = 0;
    veh.dimension = 0;
    veh.position = new mp.Vector3(out.x, out.y, out.z - SPAWN_LIFT);
    veh.heading = out.heading;
    accounts.save();
    player.call('gomp:garage:inside', [null, { ...out, drive: true }]);
    return;
  }
  if (how !== 'street' && how !== 'house') return;
  if (player.vehicle) {
    player.notify('~r~Выйдите из машины');
    return;
  }
  emptyGarage(h.id);
  garageIn.delete(player.id);
  if (how === 'house') {
    putInHouse(player, h, e.door, e.heading);
    return;
  }
  player.dimension = 0;
  player.position = doorOf(h);
  player.heading = h.heading;
  player.call('gomp:garage:inside', [null, { x: h.x, y: h.y, z: h.z, heading: h.heading, drive: false }]);
}

// Appearing at home (the choice of where to appear): inside the house, as if he had walked in.
function spawnInside(player, h) {
  const ch = roleplay.character(player);
  if (!ch) return false;
  const payload = insidePayload(h);
  inside.set(player.id, { house: h.id, door: [h.x, h.y, h.z], heading: h.heading, json: JSON.stringify(payload) });
  ch.pos = [h.x, h.y, h.z];
  ch.heading = h.heading;
  player.dimension = DIMENSION_BASE + h.id;
  player.spawn(new mp.Vector3(payload.x, payload.y, payload.z), payload.heading);
  return true;
}

// The interior of the house the player is in, once his client is ready for it (after spawnInside).
function sendInside(player) {
  const e = inside.get(player.id);
  const h = e && byId(e.house);
  if (h) player.call('gomp:house:inside', [insidePayload(h)]);
}

// A garage taken away (admin): its vehicles outside stay ordinary vehicles of the owner.
function forgetVehicles(houseId) {
  [...outVehicles].forEach(([id, o]) => {
    if (o.house === houseId) outVehicles.delete(id);
  });
}

// ------------------------------------------------------------------ events

function withHouse(fn) {
  return (player, id, ...args) => {
    const h = byId(id);
    if (h && account(player)) fn(player, h, ...args);
  };
}

mp.events.add('gomp:house:info', withHouse((player, h) => player.call('gomp:house:info', [info(player, h)])));
mp.events.add('gomp:house:buy', withHouse((player, h, method) => buy(player, h, String(method))));
mp.events.add('gomp:house:sell', withHouse(sell));
mp.events.add('gomp:house:lock', withHouse(toggleLock));
mp.events.add('gomp:house:enter', withHouse((player, h) => {
  if (atHouse(player, h)) enter(player, h);
}));
mp.events.add('gomp:house:exit', (player) => leave(player));
mp.events.add('gomp:garage:enter', withHouse((player, h, how) => {
  if (how === 'foot' || how === 'drive') enterGarage(player, h, how);
}));
mp.events.add('gomp:garage:exit', (player, how, x, y, z, heading) => {
  exitGarage(player, String(how), { x: Number(x), y: Number(y), z: Number(z), heading: Number(heading) });
});
mp.events.add('gomp:garage:store', withHouse((player, h) => {
  store(player, h);
  player.call('gomp:house:info', [info(player, h)]);
}));
mp.events.add('gomp:garage:take', withHouse((player, h, slot, x, y, z, heading) => {
  take(player, h, Number(slot), { x: Number(x), y: Number(y), z: Number(z), heading: Number(heading) });
  player.call('gomp:house:info', [info(player, h)]);
}));
mp.events.add('gomp:garage:release', withHouse((player, h, slot, x, y, z, heading) => {
  release(player, h, Number(slot), { x: Number(x), y: Number(y), z: Number(z), heading: Number(heading) });
  player.call('gomp:house:info', [info(player, h)]);
}));

mp.events.add('playerDeath', (player) => {
  // Respawned outside.
  if (inside.delete(player.id)) {
    player.dimension = 0;
    player.call('gomp:house:inside', [null]);
  }
  const g = garageIn.get(player.id);
  if (g) {
    garageIn.delete(player.id);
    player.dimension = 0;
    emptyGarage(g.house);
    player.call('gomp:garage:inside', [null]);
  }
});

// A frozen parked car is let go as its owner starts to get in (the start is safer than the seat), and frozen again.
const toDrive = (player, veh, seat) => {
  if (veh && parked.has(veh.id) && Number(seat) === 0) veh.movable = true;
};
mp.events.add('playerStartEnterVehicle', toDrive);
mp.events.add('playerEnterVehicle', toDrive);
mp.events.add('playerExitVehicle', (player, veh) => {
  if (!veh || !parked.has(veh.id)) return;
  if (!veh.getOccupants().some((p) => p !== player && p.seat === 0)) veh.movable = false;
});

mp.events.add('playerQuit', (player) => {
  inside.delete(player.id);
  const g = garageIn.get(player.id);
  if (g) {
    // The cars go back into the records; he comes back at the door (his saved place).
    garageIn.delete(player.id);
    emptyGarage(g.house);
  }
  const statik = player.getVariable('static');
  // The owner's vehicles go back into the garage.
  [...outVehicles].forEach(([id, o]) => {
    if (o.owner !== statik) return;
    returnVehicle(id);
    const veh = mp.vehicles.at(id);
    if (veh) veh.destroy();
  });
});

// The server stops: what is outside or in a garage interior keeps its fuel (roleplay's handler has run, it flushes too).
mp.events.add('serverShutdown', () => {
  outVehicles.forEach((o, id) => syncRecord(o.house, o.slot, mp.vehicles.at(id)));
  parked.forEach((o, id) => syncRecord(o.house, o.slot, mp.vehicles.at(id)));
  accounts.save();  // written when roleplay.js closes the store, after every handler
});

// ------------------------------------------------------------------ admin (admin.js)

function addHouse(cls, price, name, pos, heading = 0) {
  if (!classesById.has(cls)) return { error: `Класс: ${[...classesById.keys()].join(', ')}` };
  const p = Math.round(Number(price));
  if (!(p > 0)) return { error: 'Цена должна быть больше нуля' };
  const id = nextHouseId();
  const ok = edit((doc) => doc.houses.push({ id, name: name || `Дом №${id}`, cls, price: p, door: [round(pos.x), round(pos.y), round(pos.z)], heading: round(heading || 0, 2) }));
  if (!ok) return { error: 'Файл houses.json повреждён: исправьте его' };
  return { house: byId(id) };
}

function moveHouse(id, pos, heading = 0) {
  const h = byId(id);
  if (!h) return false;
  return edit((doc) => {
    const d = doc.houses.find((x) => x && x.id === h.id);
    d.door = [round(pos.x), round(pos.y), round(pos.z)];
    d.heading = round(heading || 0, 2);
  });
}

function removeHouse(id) {
  const h = byId(id);
  if (!h || !fileOk) return false;
  inside.forEach((e, pid) => {
    const p = mp.players.at(pid);
    if (e.house === h.id && p) leave(p);
  });
  clearGarage(h.id, false);  // the records go with the house
  forgetVehicles(h.id);
  edit((doc) => { doc.houses = doc.houses.filter((x) => !(x && x.id === h.id)); });
  delete db[h.id];  // the owner and the garage go with it
  accounts.save();
  return true;
}

// An admin inside a house sets its interior's spawn point (with the heading) or exit point.
function setInteriorPoint(player, kind) {
  const e = inside.get(player.id);
  const h = e && byId(e.house);
  if (!h) return { error: 'Встаньте внутри дома' };
  const p = player.position;
  const at = [round(p.x), round(p.y), round(p.z)];
  const heading = round(player.heading || 0, 2);
  const ok = edit((doc) => {
    const it = doc.interiors.find((i) => i && i.id === h.interiorId);
    if (kind === 'spawn') Object.assign(it, { spawn: at, heading });
    else it.exit = at;
  });
  return ok ? { id: h.interiorId, name: interiorOf(h).name, pos: at, heading } : { error: 'Файл houses.json повреждён: исправьте его' };
}

// Where an admin stands (or what he drives): a point, ground + 1 like every point of the file.
function standPoint(player) {
  const veh = player.vehicle;
  const p = veh ? veh.position : player.position;
  return { x: round(p.x), y: round(p.y), z: round(p.z + (veh ? SPAWN_LIFT : 0)), heading: round((veh ? veh.heading : player.heading) || 0, 2) };
}

// The garage point of a house (pos: {x, y, z}, null to take it away).
function setGaragePoint(id, pos, heading = 0) {
  const h = byId(id);
  if (!h) return false;
  return edit((doc) => {
    const d = doc.houses.find((x) => x && x.id === h.id);
    if (!pos) delete d.garagePoint;
    else d.garagePoint = { pos: [round(pos.x), round(pos.y), round(pos.z)], heading: round(heading || 0, 2) };
  });
}

// An admin inside a garage sets its template's spawn point (with the heading), exit point or slot n (1-based; count + 1 adds one).
function setGarageTemplatePoint(player, kind, n) {
  const e = garageIn.get(player.id);
  const h = e && byId(e.house);
  const g = h && garageOf(h);
  if (!g) return { error: 'Встаньте внутри гаража' };
  const at = standPoint(player);
  const pos = [at.x, at.y, at.z];
  if (kind === 'slot' && !(Number.isInteger(n) && n >= 1 && n <= g.slots.length + 1 && n <= MAX_GARAGE)) {
    return { error: `Место: 1-${Math.min(g.slots.length + 1, MAX_GARAGE)}` };
  }
  const ok = edit((doc) => {
    const t = doc.garages.find((x) => x && x.id === g.id);
    if (kind === 'spawn') Object.assign(t, { spawn: pos, heading: at.heading });
    else if (kind === 'exit') t.exit = pos;
    else {
      if (!Array.isArray(t.slots)) t.slots = [];
      const prev = t.slots[n - 1];
      t.slots[n - 1] = Object.assign(isObj(prev) ? prev : {}, { pos, heading: at.heading });
    }
  });
  return ok ? { id: g.id, name: g.name, pos, heading: at.heading, slot: n } : { error: 'Файл houses.json повреждён: исправьте его' };
}

// Takes a house away from its owner (the garage is emptied).
function evict(id) {
  const h = byId(id);
  if (!h) return false;
  clearGarage(h.id, false);
  forgetVehicles(h.id);
  Object.assign(stateOf(h.id), { owner: null, ownerName: '', locked: true, garage: [] });
  accounts.save();
  broadcast();
  return true;
}

module.exports = {
  HOUSES_FILE, DIMENSION_BASE, GARAGE_DIMENSION_BASE, validate, reload, migrate, list, byId, ownedBy, send, broadcast, info, sellPrice, capOf,
  enter, leave, addHouse, moveHouse, removeHouse, evict, setInteriorPoint,
  spawnInside, sendInside, garageSpot, garageOf, setGaragePoint, setGarageTemplatePoint, standPoint,
  insideOf: (player) => (inside.get(player.id) || {}).house,
  // Whether a vehicle is looked after by a garage (out of it or parked in it): cars.js leaves it alone.
  managed: (vehId) => outVehicles.has(vehId) || parked.has(vehId),
  // The house whose garage keeps a bought vehicle, or null.
  garageWith: (carId) => list().find((h) => h.state.garage.some((r) => r && r.carId === carId)) || null,
  inGarageOf: (player) => (garageIn.get(player.id) || {}).house,
  // The classes and interiors as in use now (they change when the file does).
  get CLASSES() { return classesView(); },
  get INTERIORS() { return Object.fromEntries(interiorsById); },
  get GARAGES() { return Object.fromEntries(garagesById); },
};

reload();
migrate();
watch();
