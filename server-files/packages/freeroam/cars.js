// Bought vehicles: they belong to the character (ch.cars) and live on his
// personal parking when nobody uses them. From the F2 menu (Недвижимость) the
// owner calls one onto the road next to him, marks it on the map or sends it
// back to the parking. A car that is out goes back to the parking when its owner
// leaves the game or it is destroyed. With a house the owner may keep cars in
// its garage too (houses.js keeps the record's carId).
//
//   ch.cars = [{ id, model, plate, color: [primary, secondary], look, fuel, bought }]
//   look: what this very car looks like (tuning.stateOf: colours, parts, neon); a new
//   car is the stock model in the colour bought. Tuning another car changes nothing here.
//
// Client protocol:
//   client -> server  gomp:property:get
//                     gomp:car:call id, x, y, z, heading     a spot on the road near the player (the client finds it)
//                     gomp:car:park id                       back to the parking (nobody inside)
//   server -> client  gomp:property {houses: [house], cars: [car], maxCars}
//                       house: {id, name, cls, price, x, y, z, garage, cap}
//                       car: {id, model, plate, status: 'parked'|'out'|'garage', house?, x?, y?, z?}

const accounts = require('./accounts');
const roleplay = require('./roleplay');
const vehicles = require('./vehicles');
const houses = require('./houses');
const tuning = require('./tuning');

const MAX_CARS = 10;
const CALL_RANGE = 80;  // the spot the client found must be this close to the player

// The bought vehicles of a character (the list is created on first use).
function carsOf(ch) {
  if (!Array.isArray(ch.cars)) ch.cars = [];
  return ch.cars;
}

function plateFor() {
  const letters = 'ABCEHKMOPTXY';
  let s = '';
  for (let i = 0; i < 3; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return `${s}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}GM`;
}

// A new car for a character: {car} or {error}.
function grant(ch, model, { color = [0, 0] } = {}) {
  const list = carsOf(ch);
  if (list.length >= MAX_CARS) return { error: `Не больше ${MAX_CARS} машин на персонажа` };
  const car = {
    id: accounts.nextUid(), model: String(model).toLowerCase(), plate: plateFor(),
    color: [Number(color[0]) || 0, Number(color[1] ?? color[0]) || 0], fuel: vehicles.DEFAULT_TANK, bought: Date.now(),
  };
  car.look = { primary: car.color[0], secondary: car.color[1] };
  list.push(car);
  accounts.save(ch);
  return { car };
}

// The world vehicle of a car, or null.
function vehicleOf(carId) {
  let found = null;
  mp.vehicles.forEach((v) => {
    if (!found && v.getVariable('carId') === carId) found = v;
  });
  return found;
}

// Puts a car into the world at pos/heading; returns the vehicle.
function spawn(player, ch, car, pos, heading) {
  const veh = mp.vehicles.new(mp.joaat(car.model), pos, { heading, numberPlate: car.plate, dimension: 0, engine: false });
  vehicles.setup(veh, ch.static, car.fuel);
  veh.setVariable('carId', car.id);
  for (const fn of vehicles.onSpawn) fn(veh, player, car.model);  // the look: the hook below
  return veh;
}

// The fuel (and, for a vehicle still there, the look) of a car goes back into its record.
function keep(ch, car, veh, live = true) {
  const f = veh.getVariable('fuel');
  if (typeof f === 'number') car.fuel = f;
  if (live) car.look = tuning.stateOf(veh);
  accounts.save(ch);
}

const lookOf = (car) => car.look || { primary: car.color[0], secondary: car.color[1] };

function carOfVehicle(veh) {
  const id = veh.getVariable('carId');
  if (id === null || id === undefined) return null;
  const ch = accounts.characterByStatic(veh.getVariable('owner'));
  return ch ? findCar(ch, id) : null;
}

// A bought car looks like itself whoever spawns it (the dealership, F2, a house garage).
vehicles.onSpawn.push((veh) => {
  const car = carOfVehicle(veh);
  if (car) tuning.apply(veh, lookOf(car));
});

// Tuning a bought car changes that car only.
tuning.records.push((player, veh) => carOfVehicle(veh));

function findCar(ch, id) {
  return carsOf(ch).find((c) => c.id === Number(id)) || null;
}

function statusOf(car) {
  const home = houses.garageWith(car.id);
  if (home) return { status: 'garage', house: home.name };
  const veh = vehicleOf(car.id);
  if (!veh) return { status: 'parked' };
  const p = veh.position;
  return { status: 'out', x: p.x, y: p.y, z: p.z };
}

function property(ch) {
  const home = houses.ownedBy(ch.static);
  const homes = home ? [{
    id: home.id, name: home.name, cls: (houses.CLASSES[home.cls] || {}).name || home.cls, price: home.price,
    x: home.x, y: home.y, z: home.z, garage: home.state.garage.length, cap: houses.capOf(home),
  }] : [];
  const cars = carsOf(ch).map((c) => ({ id: c.id, model: c.model, plate: c.plate, ...statusOf(c) }));
  return { houses: homes, cars, maxCars: MAX_CARS };
}

function sendProperty(player, ch) {
  player.call('gomp:property', [property(ch)]);
}

// Calls a parked car onto the road next to the player.
function call(player, ch, id, spot) {
  const car = findCar(ch, id);
  if (!car) return 'Нет такой машины';
  const st = statusOf(car);
  if (st.status === 'garage') return `Машина в гараже дома «${st.house}»: заберите её там`;
  if (st.status === 'out') return 'Машина уже на улице: она отмечена на карте';
  if (player.dimension !== 0 || player.vehicle) return 'Выйдите на улицу';
  const ok = spot && [spot.x, spot.y, spot.z].every(Number.isFinite) &&
    Math.hypot(spot.x - player.position.x, spot.y - player.position.y) <= CALL_RANGE;
  if (!ok) return 'Рядом нет дороги';
  spawn(player, ch, car, new mp.Vector3(spot.x, spot.y, spot.z + 0.5), Number.isFinite(spot.heading) ? spot.heading : player.heading);
  return null;
}

// Back to the parking (an empty car only).
function park(ch, id) {
  const car = findCar(ch, id);
  if (!car) return 'Нет такой машины';
  const veh = vehicleOf(car.id);
  if (!veh || houses.managed(veh.id)) return 'Машина не на улице';
  if (veh.getOccupants().length) return 'В машине кто-то есть';
  keep(ch, car, veh);
  veh.destroy();
  return null;
}

const withCharacter = (fn) => (player, ...args) => {
  const ch = roleplay.character(player);
  if (!ch || ch.guest) return undefined;
  return fn(player, ch, ...args);
};

mp.events.add('gomp:property:get', withCharacter((player, ch) => sendProperty(player, ch)));

mp.events.add('gomp:car:call', withCharacter((player, ch, id, x, y, z, heading) => {
  const err = call(player, ch, id, { x: Number(x), y: Number(y), z: Number(z), heading: Number(heading) });
  player.notify(err ? `~r~${err}` : 'Машина ждёт вас на дороге рядом');
  sendProperty(player, ch);
}));

mp.events.add('gomp:car:park', withCharacter((player, ch, id) => {
  const err = park(ch, id);
  player.notify(err ? `~r~${err}` : 'Машина отправлена на парковку');
  sendProperty(player, ch);
}));

// The owner left: his cars on the street go back to the parking (garages look after their own).
mp.events.add('playerQuit', (player) => {
  const ch = accounts.characterByStatic(player.getVariable('static'));
  if (!ch || !Array.isArray(ch.cars)) return;
  for (const car of ch.cars) {
    const veh = vehicleOf(car.id);
    if (!veh || houses.managed(veh.id)) continue;
    keep(ch, car, veh);
    veh.destroy();
  }
});

// Destroyed from outside (an admin, a cleanup): the record keeps the fuel; the car is parked.
mp.events.add('entityDestroyed', (entity) => {
  if (!entity || entity.type !== 'vehicle') return;
  const id = entity.getVariable('carId');
  if (id === null || id === undefined) return;
  const ch = accounts.characterByStatic(entity.getVariable('owner'));
  const car = ch && findCar(ch, id);
  if (car) keep(ch, car, entity, false);
});

module.exports = { MAX_CARS, carsOf, grant, spawn, vehicleOf, statusOf, property, sendProperty, call, park, findCar, lookOf };
