// Real estate: houses of three classes, each with the interior of its class and
// a garage for the owner's vehicles.
//
// A house is bought at its door for cash or by card (one house per character)
// and sold back to the state for half its price. Inside, every house is its own
// dimension: the interiors are the GTA Online apartment shells, shared by all
// houses of a class. The garage keeps vehicles: the owner drives one up to the
// door and puts it in; taken out, it appears on the road nearest to the house
// (the client finds the spot) and goes back into the garage when the owner
// leaves the game or the vehicle is destroyed.
//
// Houses are the HOUSES below plus those an admin adds in the game (/house,
// admin.js); owners, locks, garages and admin changes are kept in the database.
//
// Client protocol:
//   server -> client  gomp:houses [house], {classes}           every house (markers, blips)
//                       house: {id, name, cls, price, x, y, z, owner, ownerName, locked}
//                     gomp:house:info {...house, mine, sellPrice, garage: [{model, fuel, plate, out}], cap}
//                     gomp:house:inside {id, name, x, y, z} | null   inside a house: its exit
//   client -> server  gomp:house:info id
//                     gomp:house:buy id, method ('cash'|'bank')
//                     gomp:house:sell id
//                     gomp:house:enter id
//                     gomp:house:exit
//                     gomp:house:lock id
//                     gomp:garage:store id                     the vehicle being driven
//                     gomp:garage:take id, slot, x, y, z, heading     x..heading: a spot on the road
//                     gomp:garage:release id, slot, x, y, z, heading  out of the garage for good

const accounts = require('./accounts');
const roleplay = require('./roleplay');
const vehicles = require('./vehicles');

// Interiors (GTA Online apartments; always loaded) and garage sizes by class.
const CLASSES = {
  econom: { name: 'Эконом', interiorName: 'Квартира-студия', interior: [261.4586, -998.8196, -99.00863], garage: 2 },
  middle: { name: 'Комфорт', interiorName: 'Квартира с ремонтом', interior: [347.2686, -999.2955, -99.19622], garage: 6 },
  lux: { name: 'Люкс', interiorName: 'Апартаменты класса люкс', interior: [-35.31277, -580.4199, 88.71221], garage: 10 },
};

// [id, name, class, price, door x, y, z]: the doors were checked in the game
// (GOMP_PROBE=houses, client/game/probe.cpp): outside, on the ground. Ids are kept.
const HOUSES = [
  [1, 'Grove Street, 1', 'econom', 55000, 126.79, -1929.97, 21.38],
  [2, 'Grove Street, 2', 'econom', 55000, 114.42, -1961.06, 21.33],
  [3, 'Grove Street, 3', 'econom', 50000, 85.86, -1959.53, 21.12],
  [4, 'Grove Street, 4', 'econom', 50000, 72.08, -1938.97, 21.37],
  [5, 'Grove Street, 5', 'econom', 60000, 100.91, -1912.27, 21.41],
  [7, 'Strawberry Avenue, 12', 'econom', 45000, 292.53, -1078.74, 29.4],
  [8, 'Richards Majestic, кв. 2', 'middle', 180000, -936.36, -379.17, 38.96],
  [9, 'Tinsel Towers, кв. 42', 'middle', 220000, -618.3, 37.03, 43.58],
  [11, 'Eclipse Towers, кв. 3', 'middle', 260000, -775.17, 312.01, 85.66],
  [12, '3655 Wild Oats Drive', 'lux', 650000, -176.0, 502.7, 137.42],
  [13, '2044 North Conker Avenue', 'lux', 700000, 346.96, 440.8, 147.7],
  [14, '2045 North Conker Avenue', 'lux', 700000, 372.8, 428.33, 145.69],
  [15, '2862 Hillcrest Avenue', 'lux', 800000, -686.55, 596.58, 143.64],
  [16, '2868 Hillcrest Avenue', 'lux', 800000, -752.82, 620.49, 142.59],
  [17, '2874 Hillcrest Avenue', 'lux', 850000, -853.35, 696.68, 148.78],
  [18, '2677 Whispymound Drive', 'lux', 900000, 119.38, 564.89, 183.96],
  [19, '2133 Mad Wayne Thunder', 'lux', 750000, -1294.43, 454.96, 97.46],
].map(([id, name, cls, price, x, y, z]) => ({ id, name, cls, price, x, y, z }));

const DIMENSION_BASE = 50000;  // a house's interior: DIMENSION_BASE + id
const DOOR_RANGE = 5;          // buying, entering (the client offers it within 2 m)
const GARAGE_RANGE = 14;       // putting a vehicle in, taking one out
const SPAWN_RANGE = 80;        // how far from the door the client may place a vehicle taken out
const SELL_SHARE = 0.5;
const FIRST_CUSTOM_ID = 1000;

// Per house: { owner, ownerName, locked, garage: [{model, fuel, plate, cls}], def?, deleted? }
// cls: the GTA vehicle class (vehicles.js: the tank size), once a driver reported it.
// def: a house added or moved by an admin.
const db = accounts.table('houses');

const inside = new Map();       // player id -> house id
const outVehicles = new Map();  // vehicle id -> { house, slot, owner }

function stateOf(id) {
  if (!db[id]) db[id] = { owner: null, ownerName: '', locked: true, garage: [] };
  return db[id];
}

// Every house with its state.
function list() {
  const seeded = HOUSES.map((h) => ({ ...h, ...((db[h.id] && db[h.id].def) || {}) }));
  const custom = Object.entries(db).filter(([id, s]) => Number(id) >= FIRST_CUSTOM_ID && s.def).map(([id, s]) => ({ ...s.def, id: Number(id) }));
  return [...seeded, ...custom].filter((h) => !(db[h.id] && db[h.id].deleted)).map((h) => ({ ...h, state: stateOf(h.id) }));
}

function byId(id) {
  return list().find((h) => h.id === Number(id)) || null;
}

function ownedBy(statik) {
  return statik === null || statik === undefined ? null : list().find((h) => h.state.owner === statik) || null;
}

function publicView(h) {
  return { id: h.id, name: h.name, cls: h.cls, price: h.price, x: h.x, y: h.y, z: h.z,
    owner: h.state.owner, ownerName: h.state.ownerName, locked: !!h.state.locked };
}

function classesView() {
  const out = {};
  for (const [k, c] of Object.entries(CLASSES)) out[k] = { name: c.name, interiorName: c.interiorName, garage: c.garage, interior: c.interior };
  return out;
}

function send(player) {
  player.call('gomp:houses', [list().map(publicView), classesView()]);
}

function broadcast() {
  mp.players.forEach((p) => {
    if (roleplay.isLogged(p)) send(p);
  });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const doorOf = (h) => new mp.Vector3(h.x, h.y, h.z);
const sellPrice = (h) => Math.round(h.price * SELL_SHARE);
const capOf = (h) => (CLASSES[h.cls] || CLASSES.econom).garage;

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
  return inside.get(player.id) === h.id || (player.dimension === 0 && dist(player.position, h) <= range);
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
  const [x, y, z] = (CLASSES[h.cls] || CLASSES.econom).interior;
  // Leaving the game inside, the player comes back at the door.
  if (!inside.has(player.id)) {
    ch.pos = [h.x, h.y, h.z];
    ch.heading = player.heading;
  }
  inside.set(player.id, h.id);
  player.dimension = DIMENSION_BASE + h.id;
  player.position = new mp.Vector3(x, y, z);
  player.call('gomp:house:inside', [{ id: h.id, name: h.name, x, y, z }]);
  if (h.state.owner === null) player.notify(`Осмотр: ~b~${h.name}~s~ — ${CLASSES[h.cls].interiorName}`);
}

function leave(player) {
  const id = inside.get(player.id);
  if (id === undefined) return;
  inside.delete(player.id);
  const h = byId(id);
  player.dimension = 0;
  player.position = h ? doorOf(h) : roleplay.randomSpawn();  // a house removed meanwhile
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
  inside.forEach((id, pid) => {
    const p = mp.players.at(pid);
    if (id === h.id && p) leave(p);
  });
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
    Object.assign(h.state.garage[slot], { fuel, cls });
    outVehicles.delete(veh.id);
  } else {
    if (h.state.garage.length >= capOf(h)) return player.notify(`~r~В гараже нет места (${capOf(h)})`);
    slot = h.state.garage.push({ model: veh.model, fuel, plate: veh.numberPlate || '', cls }) - 1;
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
  if (player.vehicle || player.dimension !== 0 || dist(player.position, h) > GARAGE_RANGE) return player.notify('~r~Подойдите к дому');
  if (vehiclesOut(h).has(slot)) return player.notify('~r~Этот транспорт уже на улице');
  // The client's spot on the nearest road, or next to the door.
  const ok = spot && [spot.x, spot.y, spot.z].every(Number.isFinite) && dist(spot, h) <= SPAWN_RANGE;
  const pos = ok ? new mp.Vector3(spot.x, spot.y, spot.z + 0.5) : new mp.Vector3(h.x + 3, h.y + 3, h.z + 0.5);
  const veh = mp.vehicles.new(rec.model, pos, {
    heading: ok && Number.isFinite(spot.heading) ? spot.heading : player.heading,
    numberPlate: rec.plate || `GO${String(ch.static).padStart(5, '0')}`,
    dimension: 0,
  });
  // The class first: its tank holds the litres kept in the garage.
  vehicles.setup(veh, ch.static);
  if (rec.cls !== null && rec.cls !== undefined) vehicles.setClass(veh, rec.cls);
  vehicles.setFuel(veh, rec.fuel);
  outVehicles.set(veh.id, { house: h.id, slot, owner: ch.static });
  for (const fn of vehicles.onSpawn) fn(veh, player, rec.model);
  player.notify('Транспорт выехал из гаража');
}

// The vehicle leaves the garage for good (to sell the house, to free a place):
// one standing outside stays there, one inside is driven out first.
function release(player, h, slot, spot) {
  const ch = account(player);
  if (!ch || h.state.owner !== ch.static || !h.state.garage[slot]) return;
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
function returnVehicle(vehId) {
  const o = outVehicles.get(vehId);
  if (!o) return;
  outVehicles.delete(vehId);
  const s = db[o.house];
  const rec = s && s.garage && s.garage[o.slot];
  const veh = mp.vehicles.at(vehId);
  if (rec && veh) {
    const fuel = veh.getVariable('fuel');
    if (typeof fuel === 'number') rec.fuel = fuel;
  }
  accounts.save();
}

mp.events.add('entityDestroyed', (entity) => {
  if (entity && entity.type === 'vehicle') returnVehicle(entity.id);
});

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
});

mp.events.add('playerQuit', (player) => {
  inside.delete(player.id);
  const statik = player.getVariable('static');
  // The owner's vehicles go back into the garage.
  [...outVehicles].forEach(([id, o]) => {
    if (o.owner !== statik) return;
    returnVehicle(id);
    const veh = mp.vehicles.at(id);
    if (veh) veh.destroy();
  });
});

// ------------------------------------------------------------------ admin (admin.js)

function addHouse(cls, price, name, pos) {
  if (!CLASSES[cls]) return { error: `Класс: ${Object.keys(CLASSES).join(', ')}` };
  const p = Math.round(Number(price));
  if (!(p > 0)) return { error: 'Цена должна быть больше нуля' };
  const ids = Object.keys(db).map(Number).filter((id) => id >= FIRST_CUSTOM_ID);
  const id = ids.length ? Math.max(...ids) + 1 : FIRST_CUSTOM_ID;
  stateOf(id).def = { name: name || `Дом №${id}`, cls, price: p, x: pos.x, y: pos.y, z: pos.z };
  accounts.save();
  broadcast();
  return { house: byId(id) };
}

function moveHouse(id, pos) {
  const h = byId(id);
  if (!h) return false;
  const s = stateOf(h.id);
  s.def = { ...(s.def || {}), x: pos.x, y: pos.y, z: pos.z };
  if (h.id >= FIRST_CUSTOM_ID) s.def = { ...s.def, name: h.name, cls: h.cls, price: h.price };
  accounts.save();
  broadcast();
  return true;
}

function removeHouse(id) {
  const h = byId(id);
  if (!h) return false;
  inside.forEach((hid, pid) => {
    const p = mp.players.at(pid);
    if (hid === h.id && p) leave(p);
  });
  forgetVehicles(h.id);
  if (h.id >= FIRST_CUSTOM_ID) delete db[h.id];
  else Object.assign(stateOf(h.id), { deleted: true, owner: null, ownerName: '', garage: [] });
  accounts.save();
  broadcast();
  return true;
}

// Takes a house away from its owner (the garage is emptied).
function evict(id) {
  const h = byId(id);
  if (!h) return false;
  forgetVehicles(h.id);
  Object.assign(stateOf(h.id), { owner: null, ownerName: '', locked: true, garage: [] });
  accounts.save();
  broadcast();
  return true;
}

module.exports = {
  CLASSES, HOUSES, DIMENSION_BASE, list, byId, ownedBy, send, broadcast, info, sellPrice, capOf,
  enter, leave, addHouse, moveHouse, removeHouse, evict, insideOf: (player) => inside.get(player.id),
};
