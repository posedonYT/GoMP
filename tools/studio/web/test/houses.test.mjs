import test from 'node:test';
import assert from 'node:assert/strict';
import {
  headingToDir, dirToHeading, normHeading, interiorOf, usageOf, newHouse, newInterior,
  renameInterior, removeHouse, removeInterior, removeClass, check, serverIssues, canonical, Snapshots, clone,
  propsToObjects, objectsToProps, MAX_PROPS, exitAtDoor, spawnAtDoor, entranceChoices, pickEntrance,
  normalizeDoc, garageById, garageOf, garageUsageOf, newGarage, renameGarage, removeGarage, defaultGaragePoint,
  slotBeside, SLOT_SPACING, geoKey,
} from '../js/houses/model.js';

const doc = () => ({
  format: 'gomp-houses', version: 1,
  interiors: [
    { id: 'studio', name: 'Студия', spawn: [1, 2, 3], heading: 90, exit: [1, 2, 3], props: [{ id: 'a', model: 'prop_chair_01a', pos: [0, 0, 0], rot: [0, 0, 0] }] },
    { id: 'villa', name: 'Вилла', spawn: [5, 5, 5], heading: 0, exit: [5, 5, 5], props: [] },
  ],
  classes: [
    { id: 'econom', name: 'Эконом', garage: 2, interior: 'studio' },
    { id: 'rich', name: 'Элит', garage: 10, interior: 'villa' },
  ],
  houses: [
    { id: 1, name: 'A', cls: 'econom', price: 1000, door: [0, 0, 0], heading: 0 },
    { id: 2, name: 'B', cls: 'econom', price: 2000, door: [1, 1, 1], heading: 45, interior: 'villa' },
  ],
});

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('heading and direction convert both ways', () => {
  const north = headingToDir(0);
  near(north[0], 0); near(north[1], 1);
  const west = headingToDir(90);
  near(west[0], -1); near(west[1], 0);
  const south = headingToDir(180);
  near(south[1], -1);
  const east = headingToDir(270);
  near(east[0], 1);
  for (const h of [0, 90, 180, 270, 33]) near(dirToHeading(...headingToDir(h).slice(0, 2)), h);
  assert.equal(Object.is(dirToHeading(0, 1), 0), true, 'no negative zero');
});

test('headings are normalised to [0, 360)', () => {
  assert.equal(normHeading(-90), 270);
  assert.equal(normHeading(360), 0);
  assert.equal(normHeading(725), 5);
  assert.equal(normHeading(0), 0);
});

test('interiorOf uses the override, else the class', () => {
  const d = doc();
  assert.equal(interiorOf(d, d.houses[0]).id, 'studio');
  assert.equal(interiorOf(d, d.houses[1]).id, 'villa');
  assert.equal(interiorOf(d, { cls: 'nope' }), null);
});

test('usageOf lists classes and houses that refer to an interior', () => {
  const d = doc();
  const studio = usageOf(d, 'studio');
  assert.deepEqual(studio.classes.map((c) => c.id), ['econom']);
  assert.deepEqual(studio.houses, []);
  const villa = usageOf(d, 'villa');
  assert.deepEqual(villa.classes.map((c) => c.id), ['rich']);
  assert.deepEqual(villa.houses.map((x) => x.id), [2]);
});

test('newHouse takes nextId, defaults, and skips used ids', () => {
  const d = doc();
  const r = newHouse(d, { pos: [1, 2, 3], heading: -90, nextId: 3 });
  assert.equal(r.house.id, 3);
  assert.equal(r.nextId, 4);
  assert.equal(r.house.name, 'Новый дом 3');
  assert.equal(r.house.cls, 'econom');
  assert.equal(r.house.price, 100000);
  assert.equal(r.house.heading, 270);
  assert.deepEqual(r.house.door, [1, 2, 3]);
  assert.equal(newHouse(d, { pos: [0, 0, 0], nextId: 1 }).house.id, 3, 'ids 1 and 2 are taken');
});

test('newInterior gets a unique id and copies the source', () => {
  const d = doc();
  const empty = newInterior(d);
  assert.equal(empty.id, 'interior_1');
  assert.equal(empty.name, 'Новый интерьер');
  assert.deepEqual(empty.spawn, [0, 0, 0]);
  d.interiors.push(empty);
  const copy = newInterior(d, d.interiors[0]);
  assert.equal(copy.id, 'interior_2');
  assert.deepEqual(copy.spawn, [1, 2, 3]);
  assert.equal(copy.props.length, 1);
  copy.props[0].id = 'changed';
  assert.equal(d.interiors[0].props[0].id, 'a', 'a deep copy');
});

test('renameInterior updates classes and houses, and refuses bad ids', () => {
  const d = doc();
  assert.equal(renameInterior(d, 'villa', 'mansion'), null);
  assert.equal(d.interiors[1].id, 'mansion');
  assert.equal(d.classes[1].interior, 'mansion');
  assert.equal(d.houses[1].interior, 'mansion');
  assert.ok(renameInterior(d, 'mansion', 'studio'));
  assert.ok(renameInterior(d, 'mansion', 'Bad Id'));
  assert.equal(d.interiors[1].id, 'mansion', 'unchanged after refusals');
  assert.equal(renameInterior(d, 'mansion', 'mansion'), null);
});

test('removing refuses used entries and removes free ones', () => {
  const d = doc();
  assert.ok(removeInterior(d, 'studio'));
  assert.ok(removeClass(d, 'econom'));
  assert.equal(d.interiors.length, 2);
  assert.equal(removeHouse(d, 1), null);
  assert.equal(removeHouse(d, 1) !== null, true);
  d.classes[0].interior = 'villa';
  assert.equal(removeInterior(d, 'studio'), null);
  assert.equal(removeClass(d, 'econom') !== null, true, 'house 2 still uses it');
  removeHouse(d, 2);
  assert.equal(removeClass(d, 'econom'), null);
});

test('check passes a good document', () => {
  assert.deepEqual(check(doc()), []);
});

const errors = (d) => check(d).filter((i) => i.severity === 0);

test('check finds duplicate and malformed ids', () => {
  let d = doc();
  d.houses[1].id = 1;
  assert.match(errors(d)[0].message, /повторяется/);
  d = doc();
  d.interiors[1].id = 'studio';
  assert.ok(errors(d).some((i) => i.objectId === 'interior:studio'));
  d = doc();
  d.classes[0].id = 'Bad Id';
  assert.ok(errors(d).length >= 1);
  d = doc();
  d.interiors[0].id = 'x'.repeat(33);
  assert.ok(errors(d).length >= 1);
  d = doc();
  d.houses[0].id = 0;
  assert.ok(errors(d).some((i) => i.objectId === 'house:0'));
});

test('check finds unknown references', () => {
  let d = doc();
  d.houses[0].cls = 'nope';
  assert.ok(errors(d).some((i) => /класса/.test(i.message)));
  d = doc();
  d.houses[1].interior = 'nope';
  assert.ok(errors(d).some((i) => /интерьера/.test(i.message)));
  d = doc();
  d.classes[0].interior = 'nope';
  assert.ok(errors(d).some((i) => i.objectId === 'class:econom'));
});

test('check finds bad price, garage and coordinates', () => {
  let d = doc();
  d.houses[0].price = 0;
  assert.ok(errors(d).some((i) => /Цена/.test(i.message)));
  d = doc();
  d.houses[0].price = 10.5;
  assert.ok(errors(d).some((i) => /Цена/.test(i.message)));
  d = doc();
  d.classes[0].garage = 51;
  assert.ok(errors(d).some((i) => /Гараж/.test(i.message)));
  d = doc();
  d.classes[0].garage = -1;
  assert.ok(errors(d).some((i) => /Гараж/.test(i.message)));
  d = doc();
  d.houses[0].door = [0, NaN, 0];
  assert.ok(errors(d).some((i) => /Дверь/.test(i.message)));
  d = doc();
  d.interiors[0].spawn = [1, 2];
  assert.ok(errors(d).some((i) => /появления/.test(i.message)));
  d = doc();
  d.interiors[0].exit = null;
  assert.ok(errors(d).some((i) => /Выход/.test(i.message)));
});

test('an empty name is an error, like on the server', () => {
  const d = doc();
  d.houses[0].name = ' ';
  const issues = check(d);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].objectId, 'house:1');
});

test('server issues get the kind from the message', () => {
  const r = serverIssues([
    { severity: 1, objectId: '3', message: 'дом 3: дверь ниже z = -50 (под картой?)' },
    { severity: 1, objectId: 'villa', message: 'интерьер villa: не используется ни классом, ни домом' },
    { severity: 0, objectId: null, message: 'формат x, нужен gomp-houses' },
  ]);
  assert.deepEqual(r.map((i) => i.objectId), ['house:3', 'interior:villa', null]);
});

test('snapshots undo and redo whole documents', () => {
  const s = new Snapshots();
  let d = doc();
  s.push(d);
  d.houses[0].price = 5;
  assert.ok(s.canUndo && !s.canRedo);
  const back = s.undo(d);
  assert.equal(back.houses[0].price, 1000);
  assert.ok(s.canRedo);
  d = back;
  const fwd = s.redo(d);
  assert.equal(fwd.houses[0].price, 5);
  assert.equal(s.undo(clone(doc())) !== null, true);
  s.clear();
  assert.equal(s.undo(d), null);
});

test('canonical ignores the order of fields', () => {
  assert.equal(canonical({ a: 1, b: { y: [1, { q: 1, p: 2 }], x: 0 } }), canonical({ b: { x: 0, y: [1, { p: 2, q: 1 }] }, a: 1 }));
  assert.notEqual(canonical({ a: [1, 2] }), canonical({ a: [2, 1] }));
});

test('propsToObjects gives map objects with unique ids', () => {
  const objs = propsToObjects([
    { id: 'a', model: 'prop_chair_01a', pos: [1, 2, 3], rot: [0, 0, 90] },
    { id: 'a', model: 123456, pos: [0, 0, 0], rot: [0, 0, 0] },
    { model: 'x', pos: [0, 0, 0], rot: [0, 0, 0] },
  ]);
  assert.deepEqual(objs.map((o) => o.id), ['a', 'p1', 'p2']);
  assert.equal(objs[1].model, 123456);
  assert.deepEqual(propsToObjects(undefined), []);
});

test('objectsToProps keeps only id, model, pos, rot and rounds', () => {
  const props = objectsToProps([
    { id: 'k', model: ' Prop_Couch_01 ', pos: [1.123456, 2, 3], rot: [0, 0, 89.9999], dimension: 3, alpha: 100, group: 'g' },
    { id: 'k', model: 77, pos: [0, 0, 0], rot: [0, 0, 0] },
  ]);
  assert.deepEqual(props[0], { id: 'k', model: 'Prop_Couch_01', pos: [1.1235, 2, 3], rot: [0, 0, 90] });
  assert.deepEqual(Object.keys(props[1]).sort(), ['id', 'model', 'pos', 'rot']);
  assert.equal(props[1].id, 'p1');
  assert.equal(props[1].model, 77);
  assert.equal(MAX_PROPS, 300);
});

test('exit and spawn go along the door normal, a ped height above the floor', () => {
  // A door in the plane y = -10 facing north (+Y, into the room), floor at z = 5.
  const door = { center: [3, -10, 6.2], normal: [0, 1, 0], bottom: 5, outside: true };
  assert.deepEqual(exitAtDoor(door), [3, -9.2, 6]);
  const s = spawnAtDoor(door);
  assert.deepEqual(s.pos, [3, -7.4, 6]);
  assert.equal(s.heading, 0);
  // Facing west (-X): GTA heading 90 looks along (-1, 0).
  const west = { center: [0, 0, 1], normal: [-1, 0, 0], bottom: 0, outside: true };
  assert.deepEqual(exitAtDoor(west), [-0.8, 0, 1]);
  assert.equal(spawnAtDoor(west).heading, 90);
  assert.deepEqual(spawnAtDoor(west).pos, [-2.6, 0, 1]);
  // The heading looks the way the normal points, whatever the angle.
  const a = Math.PI / 5;
  const diag = { center: [0, 0, 0], normal: [Math.cos(a), Math.sin(a), 0], bottom: 0 };
  const dir = headingToDir(spawnAtDoor(diag).heading);
  near(Math.round(dir[0] * 1000) / 1000, Math.round(diag.normal[0] * 1000) / 1000);
  near(Math.round(dir[1] * 1000) / 1000, Math.round(diag.normal[1] * 1000) / 1000);
  // South: heading 180, and the south-facing normal is 0 degrees off the heading's direction.
  assert.equal(spawnAtDoor({ center: [0, 0, 0], normal: [0, -1, 0], bottom: 0 }).heading, 180);
});

test('the entrance is the pick if valid, else the server pick, else the first outside door', () => {
  const doors = [{ outside: false }, { outside: true }, { outside: true }, { outside: false }];
  assert.deepEqual(entranceChoices(doors), [1, 2]);
  assert.equal(pickEntrance(doors, 2, 1), 2);
  assert.equal(pickEntrance(doors, 3, 2), 2, 'an inner door is not a choice');
  assert.equal(pickEntrance(doors, undefined, -1), 1);
  assert.equal(pickEntrance([{ outside: false }], 0, 0), -1);
  assert.equal(pickEntrance([], 0, 0), -1);
  assert.equal(pickEntrance(undefined, 0, 0), -1);
});

// ------------------------------------------------------------------ garages

// The document above plus two garage templates: econom uses garage2, house 2 overrides with garage6.
const gdoc = () => {
  const d = doc();
  d.garages = [
    { id: 'garage2', name: 'Гараж на 2 места', spawn: [0, 0, 0], heading: 90, exit: [1, 0, 0], slots: [{ pos: [3, 0, 0], heading: 180 }, { pos: [6, 0, 0], heading: 180 }] },
    { id: 'garage6', name: 'Гараж на 6 мест', spawn: [0, 0, 0], heading: 90, exit: [1, 0, 0], slots: [{ pos: [3, 0, 0], heading: 0 }] },
  ];
  d.classes[0].garageInterior = 'garage2';
  d.houses[1].garageInterior = 'garage6';
  d.houses[0].garagePoint = { pos: [5, 5, 5], heading: 10 };
  return d;
};

test('normalizeDoc adds the missing lists, so canonical() sees no change', () => {
  const d = { format: 'gomp-houses', version: 1 };
  assert.equal(normalizeDoc(d), d);
  assert.deepEqual([d.interiors, d.garages, d.classes, d.houses], [[], [], [], []]);
  const before = canonical(d);
  normalizeDoc(d);
  assert.equal(canonical(d), before);
  // A file from before garages and the same file with an empty list are one document.
  const old = doc();
  const withList = { ...doc(), garages: [] };
  assert.equal(canonical(normalizeDoc(old)), canonical(normalizeDoc(withList)));
  // Existing lists are kept as they are.
  assert.equal(normalizeDoc(gdoc()).garages.length, 2);
});

test('garageOf uses the house override, else the class, else nothing', () => {
  const d = gdoc();
  assert.equal(garageOf(d, d.houses[0]).id, 'garage2', 'from the class');
  assert.equal(garageOf(d, d.houses[1]).id, 'garage6', 'the override wins');
  assert.equal(garageOf(doc(), doc().houses[0]), null, 'no garages at all');
  d.houses[0].garageInterior = 'nope';
  assert.equal(garageOf(d, d.houses[0]), null, 'an unknown override resolves to none');
  assert.equal(garageById(d, 'garage6').name, 'Гараж на 6 мест');
  assert.equal(garageById({}, 'x'), null);
  assert.equal(geoKey('garage', 'a'), 'garage:a');
});

test('garageUsageOf lists classes and houses', () => {
  const d = gdoc();
  assert.deepEqual(garageUsageOf(d, 'garage2').classes.map((c) => c.id), ['econom']);
  assert.deepEqual(garageUsageOf(d, 'garage6').houses.map((x) => x.id), [2]);
  assert.deepEqual(garageUsageOf(d, 'other'), { classes: [], houses: [] });
});

test('renameGarage updates references and refuses bad or duplicate ids', () => {
  const d = gdoc();
  assert.equal(renameGarage(d, 'garage6', 'big'), null);
  assert.equal(d.garages[1].id, 'big');
  assert.equal(d.houses[1].garageInterior, 'big');
  assert.equal(renameGarage(d, 'garage2', 'small'), null);
  assert.equal(d.classes[0].garageInterior, 'small');
  assert.ok(renameGarage(d, 'big', 'small'), 'duplicate');
  assert.ok(renameGarage(d, 'big', 'Bad Id'), 'bad characters');
  assert.ok(renameGarage(d, 'big', 'x'.repeat(33)), 'too long');
  assert.ok(renameGarage(d, 'nope', 'fine'), 'unknown');
  assert.equal(d.garages[1].id, 'big', 'unchanged after refusals');
  assert.equal(renameGarage(d, 'big', 'big'), null);
});

test('removeGarage refuses a used garage and removes a free one', () => {
  const d = gdoc();
  assert.match(removeGarage(d, 'garage2'), /класс Эконом/);
  assert.match(removeGarage(d, 'garage6'), /дом 2/);
  assert.equal(d.garages.length, 2);
  d.houses[1].garageInterior = 'garage2';
  assert.equal(removeGarage(d, 'garage6'), null);
  assert.deepEqual(d.garages.map((g) => g.id), ['garage2']);
  assert.ok(removeGarage(d, 'garage6'), 'already gone');
});

test('newGarage ids are unique and a copy is deep', () => {
  const d = gdoc();
  const a = newGarage(d);
  assert.equal(a.id, 'garage_1');
  assert.equal(a.name, 'Новый гараж');
  assert.equal(a.slots.length, 1, 'a garage needs at least one slot');
  d.garages.push(a);
  const copy = newGarage(d, d.garages[0]);
  assert.equal(copy.id, 'garage_2');
  assert.equal(copy.slots.length, 2);
  copy.slots[0].pos[0] = 99;
  assert.equal(d.garages[0].slots[0].pos[0], 3, 'a deep copy');
});

test('slotBeside puts a slot 3.2 m to the right of the car', () => {
  assert.equal(SLOT_SPACING, 3.2);
  // A car facing north has east on its right.
  let b = slotBeside({ pos: [10, 20, 5], heading: 0 });
  assert.deepEqual(b.pos, [13.2, 20, 5]);
  assert.equal(b.heading, 0);
  // Facing south (180) the right is west.
  b = slotBeside({ pos: [10, 20, 5], heading: 180 });
  near(b.pos[0], 6.8); near(b.pos[1], 20); assert.equal(b.pos[2], 5);
  // Facing west (90) the right is north.
  b = slotBeside({ pos: [0, 0, 1], heading: 90 });
  near(b.pos[0], 0); near(b.pos[1], 3.2);
  // Facing east (270) the right is south.
  b = slotBeside({ pos: [0, 0, 1], heading: 270 });
  near(b.pos[1], -3.2);
  const src = { pos: [0, 0, 0], heading: 0, extra: { a: 1 } };
  const c = slotBeside(src);
  c.extra.a = 2;
  assert.equal(src.extra.a, 1, 'the source is not touched');
});

test('defaultGaragePoint is 6 m along the house heading, ground + 1', () => {
  const house = { door: [100, 200, 30], heading: 90 };
  let p = defaultGaragePoint(house, 28.5);
  near(p.pos[0], 94); near(p.pos[1], 200); assert.equal(p.pos[2], 29.5);
  assert.equal(p.heading, 90);
  p = defaultGaragePoint({ door: [0, 0, 7], heading: 0 }, null);
  assert.deepEqual(p.pos, [0, 6, 7], 'without a ground the door z is kept');
  p = defaultGaragePoint({ door: [0, 0, 0], heading: -90 }, 0);
  near(p.pos[0], 6); assert.equal(p.heading, 270);
  assert.deepEqual(defaultGaragePoint({ door: [0, 0, 7], heading: 0 }).pos, [0, 6, 7]);
});

const gErrors = (d) => check(d).filter((i) => i.severity === 0);

test('a good document with garages passes check()', () => {
  assert.deepEqual(check(gdoc()), []);
});

test('check finds garage errors', () => {
  const only = (mutate, re, objectId) => {
    const d = gdoc();
    mutate(d);
    const e = gErrors(d);
    assert.ok(e.some((i) => re.test(i.message) && (!objectId || i.objectId === objectId)), `${re}: ${JSON.stringify(e)}`);
  };
  only((d) => { d.garages[0].id = 'Bad Id'; }, /^гараж: id/);
  only((d) => { d.garages[1].id = 'garage2'; }, /гараж garage2: повторяется id/, 'garage:garage2');
  only((d) => { d.garages[0].name = ' '; }, /гараж garage2: нет названия/, 'garage:garage2');
  only((d) => { d.garages[0].spawn = [1, 2]; }, /garage2: spawn — три числа/);
  only((d) => { d.garages[0].exit = null; }, /garage2: exit — три числа/);
  only((d) => { d.garages[0].heading = 'x'; }, /garage2: heading — число/);
  only((d) => { d.garages[0].slots = []; }, /garage2: нет ни одного места для машины/);
  only((d) => { delete d.garages[0].slots; }, /нет ни одного места/);
  only((d) => { d.garages[0].slots = Array.from({ length: 51 }, () => ({ pos: [0, 0, 0], heading: 0 })); }, /больше 50 мест/);
  only((d) => { d.garages[0].slots[1].pos = [1, NaN, 0]; }, /garage2, место 2: pos — три числа/);
  only((d) => { d.garages[0].slots[0].heading = null; }, /garage2, место 1: heading — число/);
  // The heading of a garage may be missing (the server defaults it to 0).
  const d = gdoc();
  delete d.garages[0].heading;
  assert.deepEqual(gErrors(d), []);
});

test('check finds unknown garage references and a bad garage point', () => {
  let d = gdoc();
  d.classes[0].garageInterior = 'nope';
  assert.ok(gErrors(d).some((i) => i.objectId === 'class:econom' && i.message === 'класс econom: нет гаража nope'));
  d = gdoc();
  d.houses[1].garageInterior = 'nope';
  assert.ok(gErrors(d).some((i) => i.objectId === 'house:2' && i.message === 'дом 2: нет гаража nope'));
  d = gdoc();
  d.houses[0].garagePoint = { pos: [1, 2], heading: 0 };
  assert.ok(gErrors(d).some((i) => i.objectId === 'house:1' && /^дом 1: garagePoint/.test(i.message)));
  d = gdoc();
  d.houses[0].garagePoint = { pos: [1, 2, 3] };
  assert.ok(gErrors(d).some((i) => /garagePoint/.test(i.message)), 'a missing heading');
  d = gdoc();
  d.houses[0].garagePoint = null;
  assert.deepEqual(gErrors(d), [], 'null means none');
  delete d.houses[0].garagePoint;
  assert.deepEqual(gErrors(d), []);
});

test('serverIssues maps the garage kind', () => {
  const r = serverIssues([
    { severity: 1, objectId: 'garage2', message: 'гараж garage2: выход далеко от точки появления' },
    { severity: 1, objectId: '12', message: 'дом 12: нет метки въезда в гараж — машины заезжают у двери' },
    { severity: 1, objectId: 'econom', message: 'класс econom: в гараже garage2 мест 2, меньше чем 4 — вместимость 2' },
    { severity: 0, objectId: null, message: 'гараж: id — a-z, 0-9, _, - (до 32)' },
  ]);
  assert.deepEqual(r.map((i) => i.objectId), ['garage:garage2', 'house:12', 'class:econom', null]);
});
