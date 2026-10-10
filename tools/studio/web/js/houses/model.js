// The houses document (server-files/houses.json) as plain data: headings,
// lookups, creating and removing entries, and a quick check that mirrors the
// server's rules so the editor can flag mistakes at once (the server's check
// on save is the authoritative one). No DOM, no three.js.

const DEG = Math.PI / 180;
const ID_RE = /^[a-z0-9_-]{1,32}$/;
const SEVERITY_ERROR = 0;

// GTA heading: degrees, 0 faces north (+Y), counter-clockwise (90 = west).
export function headingToDir(h) {
  const r = h * DEG;
  return [-Math.sin(r), Math.cos(r), 0];
}

export function normHeading(h) {
  const v = h % 360;
  return v < 0 ? v + 360 : v;
}

export function dirToHeading(x, y) {
  // + 0 turns -0 into 0, which would print as "-0" in a number field.
  return normHeading(Math.atan2(-x, y) / DEG) + 0;
}

export function clone(doc) {
  return JSON.parse(JSON.stringify(doc));
}

// JSON with sorted keys: two documents with the same content compare equal
// whatever order the server or the editor wrote their fields in.
export function canonical(doc) {
  return JSON.stringify(doc, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
}

// Fills the lists a document may lack (houses.json written before garages has no
// "garages"). Without it canonical() would see the missing list as a change every time a
// document is received and the undo history would be cleared. Returns the same object.
export function normalizeDoc(doc) {
  doc.interiors ||= [];
  doc.garages ||= [];
  doc.classes ||= [];
  doc.houses ||= [];
  return doc;
}

// ------------------------------------------------------------------ lookups

export function interiorById(doc, id) {
  return (doc.interiors || []).find((i) => i.id === id) || null;
}

export function classById(doc, id) {
  return (doc.classes || []).find((c) => c.id === id) || null;
}

// The interior a house uses: its own choice, else the one of its class.
export function interiorOf(doc, house) {
  if (house.interior) return interiorById(doc, house.interior);
  const cls = classById(doc, house.cls);
  return cls ? interiorById(doc, cls.interior) : null;
}

export function garageById(doc, id) {
  return (doc.garages || []).find((g) => g.id === id) || null;
}

// The garage template of a house: its own choice, else the one of its class, else none
// (then the game keeps the old virtual garage).
export function garageOf(doc, house) {
  if (house.garageInterior) return garageById(doc, house.garageInterior);
  const cls = classById(doc, house.cls);
  return cls && cls.garageInterior ? garageById(doc, cls.garageInterior) : null;
}

// The key of the game geometry drawn on screen: an interior and a garage may share an id.
export const geoKey = (kind, id) => `${kind}:${id}`;

// Who refers to a garage template: a class, or a house with its own override.
export function garageUsageOf(doc, garageId) {
  return {
    classes: (doc.classes || []).filter((c) => c.garageInterior === garageId),
    houses: (doc.houses || []).filter((x) => x.garageInterior === garageId),
  };
}

// Who refers to an interior: a class, or a house with its own override.
export function usageOf(doc, interiorId) {
  return {
    classes: (doc.classes || []).filter((c) => c.interior === interiorId),
    houses: (doc.houses || []).filter((x) => x.interior === interiorId),
  };
}

// ------------------------------------------------------------------ creating

export function newHouse(doc, { pos, heading = 0, nextId }) {
  const used = new Set((doc.houses || []).map((x) => x.id));
  let id = Math.max(1, nextId || 1);
  while (used.has(id)) id++;
  const cls = (doc.classes || [])[0];
  const house = {
    id,
    name: `Новый дом ${id}`,
    cls: cls ? cls.id : '',
    price: 100000,
    door: pos.slice(),
    heading: normHeading(heading),
  };
  return { house, nextId: id + 1 };
}

export function newInterior(doc, from = null) {
  const ids = new Set((doc.interiors || []).map((i) => i.id));
  let n = 1;
  while (ids.has(`interior_${n}`)) n++;
  const base = from ? clone(from) : { spawn: [0, 0, 0], heading: 0, exit: [0, 0, 0], props: [] };
  return { ...base, id: `interior_${n}`, name: 'Новый интерьер' };
}

export const SLOT_SPACING = 3.2;  // m between neighbouring slots (a car is 2 m wide)
export const MAX_SLOTS = 50;       // the server's limit per garage
export const GARAGE_POINT_DISTANCE = 6;  // m in front of the door for a new garage point

const round3m = (v) => Math.round(v * 1000) / 1000;

export function newGarage(doc, from = null) {
  const ids = new Set((doc.garages || []).map((g) => g.id));
  let n = 1;
  while (ids.has(`garage_${n}`)) n++;
  const base = from ? clone(from) : { spawn: [0, 0, 0], heading: 0, exit: [0, 0, 0], slots: [{ pos: [SLOT_SPACING, 0, 0], heading: 0 }] };
  return { ...base, id: `garage_${n}`, name: from ? base.name : 'Новый гараж' };
}

// A slot next to `slot`, on the car's right-hand side, same heading and z.
export function slotBeside(slot) {
  const d = headingToDir(slot.heading || 0);
  // The right of a car facing (dx, dy) is (dy, -dx).
  return {
    ...clone(slot),
    pos: [round3m(slot.pos[0] + d[1] * SLOT_SPACING), round3m(slot.pos[1] - d[0] * SLOT_SPACING), slot.pos[2]],
    heading: slot.heading,
  };
}

// The garage point a house gets when it has none: GARAGE_POINT_DISTANCE m along the house's
// heading (the way a player faces on coming out), ground + 1 high (the door's own z when
// the ground is unknown), facing the same way.
export function defaultGaragePoint(house, groundZ = null) {
  const d = headingToDir(house.heading || 0);
  return {
    pos: [round3m(house.door[0] + d[0] * GARAGE_POINT_DISTANCE), round3m(house.door[1] + d[1] * GARAGE_POINT_DISTANCE),
      groundZ === null || groundZ === undefined ? house.door[2] : round3m(groundZ + 1)],
    heading: normHeading(house.heading || 0),
  };
}

// Returns an error text (nothing changed) or null. Classes and houses that use the garage follow.
export function renameGarage(doc, oldId, newId) {
  if (!ID_RE.test(newId)) return 'Идентификатор: латиница, цифры, _ и -, до 32 символов';
  if (oldId !== newId && garageById(doc, newId)) return `Гараж «${newId}» уже есть`;
  const garage = garageById(doc, oldId);
  if (!garage) return `Нет гаража «${oldId}»`;
  garage.id = newId;
  for (const c of doc.classes || []) if (c.garageInterior === oldId) c.garageInterior = newId;
  for (const x of doc.houses || []) if (x.garageInterior === oldId) x.garageInterior = newId;
  return null;
}

// Returns an error text (nothing changed) or null. Refused while a class or a house uses it.
export function removeGarage(doc, id) {
  const i = (doc.garages || []).findIndex((x) => x.id === id);
  if (i < 0) return `Нет гаража «${id}»`;
  const use = garageUsageOf(doc, id);
  if (use.classes.length || use.houses.length) {
    const who = [...use.classes.map((c) => `класс ${c.name || c.id}`), ...use.houses.map((x) => `дом ${x.id}`)];
    return `Гараж используют: ${who.join(', ')}`;
  }
  doc.garages.splice(i, 1);
  return null;
}

// Returns an error text (nothing changed) or null.
export function renameInterior(doc, oldId, newId) {
  if (!ID_RE.test(newId)) return 'Идентификатор: латиница, цифры, _ и -, до 32 символов';
  if (oldId !== newId && interiorById(doc, newId)) return `Интерьер «${newId}» уже есть`;
  const interior = interiorById(doc, oldId);
  if (!interior) return `Нет интерьера «${oldId}»`;
  interior.id = newId;
  for (const c of doc.classes || []) if (c.interior === oldId) c.interior = newId;
  for (const x of doc.houses || []) if (x.interior === oldId) x.interior = newId;
  return null;
}

// ------------------------------------------------------------------ removing

// All three return an error text (nothing changed) or null (removed).
export function removeHouse(doc, id) {
  const i = (doc.houses || []).findIndex((x) => x.id === id);
  if (i < 0) return `Нет дома ${id}`;
  doc.houses.splice(i, 1);
  return null;
}

export function removeInterior(doc, id) {
  const i = (doc.interiors || []).findIndex((x) => x.id === id);
  if (i < 0) return `Нет интерьера «${id}»`;
  const use = usageOf(doc, id);
  if (use.classes.length || use.houses.length) {
    const who = [...use.classes.map((c) => `класс ${c.name || c.id}`), ...use.houses.map((x) => `дом ${x.id}`)];
    return `Интерьер используют: ${who.join(', ')}`;
  }
  doc.interiors.splice(i, 1);
  return null;
}

export function removeClass(doc, id) {
  const i = (doc.classes || []).findIndex((x) => x.id === id);
  if (i < 0) return `Нет класса «${id}»`;
  const used = (doc.houses || []).filter((x) => x.cls === id);
  if (used.length) return `Класс используют дома: ${used.map((x) => x.id).join(', ')}`;
  doc.classes.splice(i, 1);
  return null;
}

// ------------------------------------------------------------------ checking

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const isInt = (n) => typeof n === 'number' && Number.isInteger(n);
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

// [{ severity, objectId, message }]; objectId is "house:3", "interior:studio", "class:econom".
export function check(doc) {
  const out = [];
  const err = (objectId, message) => out.push({ severity: SEVERITY_ERROR, objectId, message });

  const interiors = doc.interiors || [];
  const garages = doc.garages || [];
  const classes = doc.classes || [];
  const houses = doc.houses || [];

  const uniqueIds = (list, kind, label) => {
    const ids = new Set();
    for (const e of list) {
      const key = `${kind}:${e.id}`;
      if (typeof e.id !== 'string' || !ID_RE.test(e.id)) err(key, `${label}: идентификатор «${e.id}» должен быть из a-z, 0-9, _ и -, до 32 символов`);
      else if (ids.has(e.id)) err(key, `${label}: идентификатор «${e.id}» повторяется`);
      ids.add(e.id);
    }
  };
  uniqueIds(interiors, 'interior', 'Интерьер');
  uniqueIds(classes, 'class', 'Класс');

  for (const i of interiors) {
    const key = `interior:${i.id}`;
    if (!isVec3(i.spawn)) err(key, 'Точка появления: нужны три числа');
    if (!isVec3(i.exit)) err(key, 'Выход: нужны три числа');
    if (!isNum(i.heading)) err(key, 'Направление при появлении: нужно число');
    if (!i.name || !String(i.name).trim()) err(key, 'У интерьера нет названия');
  }

  // Garages use the server's own wording (houses.js skips these entries).
  const garageIds = new Set();
  for (const g of garages) {
    const key = `garage:${g.id}`;
    if (typeof g.id !== 'string' || !ID_RE.test(g.id)) err(key, 'гараж: id — a-z, 0-9, _, - (до 32)');
    else if (garageIds.has(g.id)) err(key, `гараж ${g.id}: повторяется id`);
    garageIds.add(g.id);
    if (!g.name || !String(g.name).trim()) err(key, `гараж ${g.id}: нет названия`);
    if (!isVec3(g.spawn)) err(key, `гараж ${g.id}: spawn — три числа`);
    if (!isVec3(g.exit)) err(key, `гараж ${g.id}: exit — три числа`);
    if (g.heading !== undefined && !isNum(g.heading)) err(key, `гараж ${g.id}: heading — число`);
    const slots = Array.isArray(g.slots) ? g.slots : [];
    if (!slots.length) err(key, `гараж ${g.id}: нет ни одного места для машины`);
    if (slots.length > MAX_SLOTS) err(key, `гараж ${g.id}: больше ${MAX_SLOTS} мест`);
    slots.forEach((sl, j) => {
      if (!sl || !isVec3(sl.pos)) err(key, `гараж ${g.id}, место ${j + 1}: pos — три числа`);
      if (!sl || (sl.heading !== undefined && !isNum(sl.heading))) err(key, `гараж ${g.id}, место ${j + 1}: heading — число`);
    });
  }

  const interiorIds = new Set(interiors.map((i) => i.id));
  const classIds = new Set(classes.map((c) => c.id));
  for (const c of classes) {
    const key = `class:${c.id}`;
    if (!isInt(c.garage) || c.garage < 0 || c.garage > 50) err(key, 'Гараж: целое число от 0 до 50');
    if (!interiorIds.has(c.interior)) err(key, `Нет интерьера «${c.interior}»`);
    if (!c.name || !String(c.name).trim()) err(key, 'У класса нет названия');
    if (c.garageInterior && !garageIds.has(c.garageInterior)) err(key, `класс ${c.id}: нет гаража ${c.garageInterior}`);
  }

  const ids = new Set();
  for (const x of houses) {
    const key = `house:${x.id}`;
    if (!isInt(x.id) || x.id <= 0) err(key, 'Номер дома: положительное целое');
    else if (ids.has(x.id)) err(key, `Номер дома ${x.id} повторяется`);
    ids.add(x.id);
    if (!classIds.has(x.cls)) err(key, `Нет класса «${x.cls}»`);
    if (x.interior && !interiorIds.has(x.interior)) err(key, `Нет интерьера «${x.interior}»`);
    if (!isInt(x.price) || x.price <= 0) err(key, 'Цена: положительное целое');
    if (!isVec3(x.door)) err(key, 'Дверь: нужны три числа');
    if (!isNum(x.heading)) err(key, 'Направление: нужно число');
    if (!x.name || !String(x.name).trim()) err(key, 'У дома нет названия');
    if (x.garageInterior && !garageIds.has(x.garageInterior)) err(key, `дом ${x.id}: нет гаража ${x.garageInterior}`);
    const gp = x.garagePoint;
    if (gp !== undefined && gp !== null && (!gp || !isVec3(gp.pos) || !isNum(gp.heading))) {
      err(key, `дом ${x.id}: garagePoint — {pos: три числа, heading: число}`);
    }
  }
  return out;
}

// The server names objects by a bare id; the kind is in the message ("дом 3: …",
// "интерьер studio: …", "класс lux: …"). Turns them into the "kind:id" form of check().
export function serverIssues(issues) {
  const kinds = { 'дом': 'house', 'интерьер': 'interior', 'класс': 'class', 'гараж': 'garage' };
  return (issues || []).map((i) => {
    const m = /^(дом|интерьер|класс|гараж)(?=[\s:])/.exec(i.message || '');
    return { ...i, objectId: i.objectId != null && m ? `${kinds[m[1]]}:${i.objectId}` : null };
  });
}

// ------------------------------------------------------------------ undo

// Undo works on snapshots: the document is small, so a whole copy per step is simpler than patches.
export class Snapshots {
  constructor(limit = 100) {
    this.limit = limit;
    this.done = [];
    this.undone = [];
  }

  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }

  // Call before a change: remembers the state to go back to.
  push(doc) {
    this.done.push(clone(doc));
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
  }

  // Both return the document to show now (a copy of the other state), or null.
  undo(current) {
    const prev = this.done.pop();
    if (!prev) return null;
    this.undone.push(clone(current));
    return prev;
  }

  redo(current) {
    const next = this.undone.pop();
    if (!next) return null;
    this.done.push(clone(current));
    return next;
  }

  clear() {
    this.done = [];
    this.undone = [];
  }
}

// ------------------------------------------------------------------ decor (interior props)

export const MAX_PROPS = 300;  // the server's limit per interior

const round4 = (v) => Math.round(Number(v) * 10000) / 10000;
const round2 = (v) => Math.round(Number(v) * 100) / 100;

// Ids must be unique inside an interior: a missing or repeated one gets the next free "p<n>".
function uniqueIds(list) {
  const taken = new Set();
  let n = 1;
  return list.map((o) => {
    let id = o.id === undefined || o.id === null ? '' : String(o.id);
    if (!id || taken.has(id)) {
      do { id = `p${n++}`; } while (taken.has(id));
    }
    taken.add(id);
    return id;
  });
}

// Interior props -> the objects of a map document (the map editor's own shape).
export function propsToObjects(props) {
  const list = props || [];
  const ids = uniqueIds(list);
  return list.map((p, i) => ({
    id: ids[i],
    model: p.model,
    pos: (p.pos || [0, 0, 0]).map(Number),
    rot: (p.rot || [0, 0, 0]).map(Number),
  }));
}

// Map objects -> interior props: only {id, model, pos, rot}; what a map has
// beyond that (dimension, alpha, group…) means nothing inside an interior.
export function objectsToProps(objects) {
  const list = [...(objects || [])];
  const ids = uniqueIds(list);
  return list.map((o, i) => ({
    id: ids[i],
    model: typeof o.model === 'number' ? o.model : String(o.model || '').trim(),
    pos: (o.pos || [0, 0, 0]).map(round4),
    rot: (o.rot || [0, 0, 0]).map(round2),
  }));
}

// ------------------------------------------------------------------ entrance doors

// How far from the door the points go (m, along the door's normal that points into the
// room) and how high above the floor the ped is: the server and client place a point at
// floor + 1, the client draws the marker at z - 0.98.
export const EXIT_DISTANCE = 0.8;
export const SPAWN_DISTANCE = 2.6;
export const PED_HEIGHT = 1;

const round3 = (v) => Math.round(v * 1000) / 1000;

// door: an entry of /api/interiors/geometry doors: center [3], normal [3] (unit, horizontal,
// into the room), bottom (floor at the door).
function beyondDoor(door, distance) {
  return [
    round3(door.center[0] + door.normal[0] * distance),
    round3(door.center[1] + door.normal[1] * distance),
    round3(door.bottom + PED_HEIGHT),
  ];
}

// The exit marker just inside the door.
export function exitAtDoor(door) {
  return beyondDoor(door, EXIT_DISTANCE);
}

// The spawn a little further in, facing along the normal (away from the door).
export function spawnAtDoor(door) {
  return {
    pos: beyondDoor(door, SPAWN_DISTANCE),
    heading: round3(dirToHeading(door.normal[0], door.normal[1])),
  };
}

// The doors that lead in from outside, as indexes into the list (the form's choices).
export function entranceChoices(doors) {
  const out = [];
  (doors || []).forEach((d, i) => { if (d.outside) out.push(i); });
  return out;
}

// The index to use: the user's pick if it is still a choice, else the server's, else the first choice, else -1.
export function pickEntrance(doors, preferred, serverPick) {
  const choices = entranceChoices(doors);
  if (choices.includes(preferred)) return preferred;
  if (choices.includes(serverPick)) return serverPick;
  return choices.length ? choices[0] : -1;
}
