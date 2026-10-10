// Builds server-files/dealership.json, the catalog of the car dealership, from
// the vehicles of the game and of the add-on packs, as GoMP Studio reads them:
//
//   node tools/dealership/generate.js [http://127.0.0.1:22100] [server-files/dealership.json]
//
// The game's cars: classes the dealership sells, cars and bikes only, nothing
// armed or made for Arena War; the price comes from the class and the top speed
// of the handling. The add-on packs make the "custom" section (prices below).
// A price changed in the file by hand stays: models already in the catalog keep
// their price and name.

const fs = require('fs');
const path = require('path');

// The showroom: Premium Deluxe Motorsport.
const SHOWROOM = {
  name: 'Premium Deluxe Motorsport',
  marker: [-33.7, -1102.0, 26.42],
  radius: 2.5,
  preview: [-47.5, -1097.2, 25.9, 340],
  spawns: [[-28.6, -1085.6, 26.0, 330], [-26.0, -1082.3, 26.1, 67], [-19.3, -1084.5, 26.1, 70], [-16.0, -1085.5, 26.2, 70], [-28.8, -1088.8, 26.1, 337]],
};

const COLORS = [
  { id: 0, name: 'Чёрный', rgb: '#0d1116' }, { id: 111, name: 'Белый', rgb: '#f0f0f0' }, { id: 4, name: 'Серебристый', rgb: '#b5b8bc' },
  { id: 5, name: 'Графит', rgb: '#4a4c51' }, { id: 27, name: 'Красный', rgb: '#c00e1a' }, { id: 38, name: 'Оранжевый', rgb: '#e8611b' },
  { id: 88, name: 'Жёлтый', rgb: '#f5c710' }, { id: 53, name: 'Зелёный', rgb: '#155c2d' }, { id: 64, name: 'Синий', rgb: '#14398c' },
  { id: 70, name: 'Голубой', rgb: '#3b8fd6' }, { id: 145, name: 'Фиолетовый', rgb: '#621276' }, { id: 96, name: 'Коричневый', rgb: '#5b3a21' },
];

const SOLD = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12];
const TYPES = new Set(['VEHICLE_TYPE_CAR', 'VEHICLE_TYPE_BIKE', 'VEHICLE_TYPE_QUADBIKE']);
// Armed, boosted, jumping or Arena War vehicles are not sold.
const BANNED_FLAGS = [
  'FLAG_HAS_TURRET_SEAT_ON_VEHICLE', 'FLAG_HAS_REAR_MOUNTED_TURRET', 'FLAG_HAS_ROCKET_BOOST', 'FLAG_HAS_VERTICAL_ROCKET_BOOST',
  'FLAG_HAS_JATO_BOOST_MOD', 'FLAG_HAS_GLIDER', 'FLAG_HAS_JUMP_MOD', 'FLAG_JUMPING_CAR', 'FLAG_RAMP',
  'FLAG_HAS_WEAPON_SPIKE_MODS', 'FLAG_HAS_WEAPON_BLADE_MODS',
];

// Price of a car of the class with the typical top speed, and that speed.
const BASE = { 0: [12000, 125], 1: [22000, 135], 2: [38000, 130], 3: [34000, 140], 4: [30000, 140], 5: [70000, 140], 6: [110000, 150], 7: [420000, 155], 8: [14000, 135], 9: [28000, 130], 12: [20000, 120] };

// The add-on cars: price and the name shown.
const CUSTOM = {
  lada2107: [7000, 'ВАЗ-2107'], g37s: [45000, 'Infiniti G37S'], m5: [140000, 'BMW M5 F10'], '20rs7c8': [160000, 'Audi RS7 C8'],
  cullinan: [450000, 'Rolls-Royce Cullinan'], bvss: [1500000, 'Bugatti Veyron'], agerars: [1800000, 'Koenigsegg Agera RS'],
  krga: [2200000, 'Koenigsegg Regera'], jesko: [2800000, 'Koenigsegg Jesko'],
};

const CLASS_NAMES = ['VC_COMPACT', 'VC_SEDAN', 'VC_SUV', 'VC_COUPE', 'VC_MUSCLE', 'VC_SPORT_CLASSIC', 'VC_SPORT', 'VC_SUPER', 'VC_MOTORCYCLE', 'VC_OFF_ROAD', 'VC_INDUSTRIAL', 'VC_UTILITY', 'VC_VAN'];

function priceOf(cls, speed) {
  const [base, ref] = BASE[cls];
  const f = speed > 0 ? Math.min(2.5, Math.max(0.5, (speed / ref) ** 2.5)) : 1;
  return Math.max(1000, Math.round((base * f) / 500) * 500);
}

function sellable(v) {
  return SOLD.includes(v.class) && TYPES.has(v.type) && !BANNED_FLAGS.some((f) => v.flags.split(' ').includes(f));
}

// game: [{model, make, gameName, class, type, speed, flags}]; packs: [{pack, models: [{model, cls, make}]}];
// previous: the catalog document so far (or null).
function buildCatalog(game, packs, previous = null) {
  const kept = new Map(((previous && previous.vehicles) || []).map((v) => [v.model, v]));
  const customModels = new Map();
  for (const p of packs || []) for (const m of p.models || []) customModels.set(String(m.model).toLowerCase(), m);

  const vehicles = [];
  for (const [model, m] of customModels) {
    const cls = CLASS_NAMES.indexOf(String(m.cls || '').toUpperCase());
    if (!SOLD.includes(cls)) continue;
    const [price, name] = CUSTOM[model] || [priceOf(cls, 0), m.gameName || model];
    const old = kept.get(model);
    vehicles.push({ model, cls, price: old ? old.price : price, custom: true, name: old && old.name ? old.name : name });
  }
  for (const v of game) {
    if (customModels.has(v.model) || !sellable(v)) continue;
    const old = kept.get(v.model);
    vehicles.push({ model: v.model, cls: v.class, price: old && !old.custom ? old.price : priceOf(v.class, v.speed), custom: false });
  }
  vehicles.sort((a, b) => Number(b.custom) - Number(a.custom) || a.cls - b.cls || a.price - b.price || a.model.localeCompare(b.model));
  return { format: 'gomp-dealership', version: 1, ...SHOWROOM, ...(previous ? pick(previous) : {}), colors: (previous && previous.colors) || COLORS, vehicles };
}

// The showroom points of an existing file win over the defaults (they may have been moved).
function pick(doc) {
  const out = {};
  for (const k of ['name', 'marker', 'radius', 'preview', 'spawns']) if (doc[k] !== undefined) out[k] = doc[k];
  return out;
}

async function main() {
  const studio = process.argv[2] || 'http://127.0.0.1:22100';
  const file = process.argv[3] || path.join(__dirname, '..', '..', 'server-files', 'dealership.json');
  const get = async (p) => {
    const r = await fetch(`${studio}/api/${p}`);
    if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  const [game, packs] = await Promise.all([get('vehicles/game'), get('vehicles')]);
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const doc = buildCatalog(game, packs, previous);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 1)}\n`);
  const custom = doc.vehicles.filter((v) => v.custom).length;
  console.log(`${file}: ${doc.vehicles.length} vehicles (${custom} custom, ${doc.vehicles.length - custom} of the game)`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { buildCatalog, priceOf, sellable, SHOWROOM, COLORS, CUSTOM };
