// The car dealership (Premium Deluxe Motorsport): the catalog comes from
// server-files/dealership.json, the client shows it in two sections — the
// custom vehicles (add-on packs) and the game's own — each split by vehicle
// class, with a preview of the chosen car in the showroom. A bought car belongs
// to the character (cars.js) and waits on the dealership's parking lot.
//
// Catalog file (format gomp-dealership, version 1):
//   { "format": "gomp-dealership", "version": 1, "name": "...",
//     "marker": [x, y, z], "radius": 2.5,                  where the catalog opens ("E")
//     "preview": [x, y, z, heading],                       the showroom floor (client preview)
//     "spawns": [[x, y, z, heading]],                      the parking lot: a bought car appears on a free spot
//     "colors": [{ "id": 0, "name": "Чёрный", "rgb": "#0d1116" }],
//     "vehicles": [{ "model": "sultan", "cls": 1, "price": 32000, "custom": false, "name": "(optional)" }] }
//   cls: the GTA vehicle class (GET_VEHICLE_CLASS), it chooses the subsection.
//
// Client protocol:
//   server -> client  gomp:dealer {name, marker, radius, preview, colors, sections, classes, vehicles}
//                     gomp:dealer:bought {model, plate, x, y, z}
//   client -> server  gomp:dealer:buy model, color, method ('cash'|'bank')

const fs = require('fs');
const path = require('path');
const roleplay = require('./roleplay');
const cars = require('./cars');

const FILE = process.env.GOMP_DEALERSHIP_FILE || path.join(__dirname, '..', '..', 'dealership.json');
const SPOT_FREE = 3.5;  // a parking spot is taken when a vehicle stands this close

const SECTIONS = [
  { id: 'custom', name: 'Кастомные', desc: 'Реальные марки из модов сервера' },
  { id: 'game', name: 'Игровые', desc: 'Машины GTA V' },
];
// GTA vehicle classes the dealership sells, in the order of the subsections.
const CLASSES = [
  [0, 'Компакты'], [1, 'Седаны'], [2, 'Внедорожники'], [3, 'Купе'], [4, 'Маслкары'], [5, 'Спорт-классика'],
  [6, 'Спорткары'], [7, 'Суперкары'], [8, 'Мотоциклы'], [9, 'Бездорожье'], [12, 'Фургоны'],
];
const SOLD = new Set(CLASSES.map(([c]) => c));

let catalog = null;

// Checks a catalog document: {catalog} or {error}.
function validate(doc) {
  if (!doc || doc.format !== 'gomp-dealership' || doc.version !== 1) return { error: 'не каталог автосалона (format gomp-dealership, version 1)' };
  const point = (p, n) => Array.isArray(p) && p.length >= n && p.slice(0, n).every(Number.isFinite);
  if (!point(doc.marker, 3) || !point(doc.preview, 4)) return { error: 'marker или preview не заданы' };
  if (!Array.isArray(doc.spawns) || !doc.spawns.length || !doc.spawns.every((s) => point(s, 4))) return { error: 'нет мест парковки (spawns)' };
  const colors = (Array.isArray(doc.colors) ? doc.colors : []).filter((c) => c && Number.isInteger(c.id) && typeof c.name === 'string');
  if (!colors.length) return { error: 'нет цветов (colors)' };
  const seen = new Set();
  const vehicles = [];
  for (const v of Array.isArray(doc.vehicles) ? doc.vehicles : []) {
    const model = String((v && v.model) || '').toLowerCase();
    if (!model || seen.has(model) || !(Number.isInteger(v.price) && v.price > 0) || !SOLD.has(v.cls)) continue;
    seen.add(model);
    vehicles.push({ model, cls: v.cls, price: v.price, custom: !!v.custom, ...(v.name ? { name: String(v.name) } : {}) });
  }
  return {
    catalog: {
      name: String(doc.name || 'Автосалон'), marker: doc.marker.slice(0, 3), radius: Number(doc.radius) || 2.5,
      preview: doc.preview.slice(0, 4), spawns: doc.spawns.map((s) => s.slice(0, 4)), colors, vehicles,
      byModel: new Map(vehicles.map((v) => [v.model, v])),
    },
  };
}

function load() {
  try {
    const r = validate(JSON.parse(fs.readFileSync(FILE, 'utf8')));
    if (r.error) {
      console.log(`[dealership] ${FILE}: ${r.error}`);
      return;
    }
    catalog = r.catalog;
    console.log(`[dealership] ${catalog.vehicles.length} vehicles`);
  } catch (err) {
    console.log(`[dealership] ${FILE}: ${err.message}`);
  }
}

function send(player) {
  if (!catalog) return;
  const { byModel, spawns, ...view } = catalog;
  player.call('gomp:dealer', [{
    ...view,
    sections: SECTIONS,
    classes: CLASSES.map(([id, name]) => ({ id, name })),
  }]);
}

const dist = (p, [x, y, z]) => Math.hypot(p.x - x, p.y - y, p.z - z);

// A parking spot nobody stands on (else the first one).
function freeSpot() {
  const taken = (s) => {
    let busy = false;
    mp.vehicles.forEach((v) => {
      if (!busy && v.dimension === 0 && dist(v.position, s) < SPOT_FREE) busy = true;
    });
    return busy;
  };
  return catalog.spawns.find((s) => !taken(s)) || catalog.spawns[0];
}

// A purchase: null or an error text.
function buy(player, ch, model, color, method) {
  if (!catalog) return 'Автосалон закрыт';
  if (player.dimension !== 0 || dist(player.position, catalog.marker) > catalog.radius + 3) return 'Подойдите к стойке автосалона';
  const v = catalog.byModel.get(String(model || '').toLowerCase());
  if (!v) return 'Такой машины нет в продаже';
  const c = catalog.colors.find((x) => x.id === Number(color)) || catalog.colors[0];
  if (cars.carsOf(ch).length >= cars.MAX_CARS) return `Не больше ${cars.MAX_CARS} машин на персонажа`;
  if (!roleplay.pay(player, v.price, String(method), `Автосалон: ${v.name || v.model}`)) return 'Недостаточно денег';
  const { car, error } = cars.grant(ch, v.model, { color: [c.id, c.id] });
  if (error) return error;
  const [x, y, z, heading] = freeSpot();
  cars.spawn(player, ch, car, new mp.Vector3(x, y, z), heading);
  player.call('gomp:dealer:bought', [{ model: car.model, plate: car.plate, x, y, z }]);
  player.notify(`Поздравляем с покупкой! ~g~${v.name || v.model}~s~ (${car.plate}) ждёт на парковке салона`);
  return null;
}

mp.events.add('gomp:dealer:buy', (player, model, color, method) => {
  const ch = roleplay.character(player);
  if (!ch || ch.guest) return;
  const err = buy(player, ch, model, color, method);
  if (err) player.notify(`~r~${err}`);
});

if (catalog === null) load();
roleplay.onSpawn.push((player) => send(player));

if (catalog) {
  mp.blips.new(326, new mp.Vector3(...catalog.marker), { name: catalog.name, color: 3, scale: 0.85, shortRange: true, dimension: 0 });
}

module.exports = { FILE, SECTIONS, CLASSES, validate, load, send, buy, get catalog() { return catalog; } };
