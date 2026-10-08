// Vehicle ownership, fuel, locks and doors.
//
// Shared vehicle variables (every client sees them):
//   owner    – static of the character that owns the vehicle (null: nobody)
//   fuel     – litres in the tank (one decimal), fuelMax – tank size
//   doors    – bit mask of open doors: 0-3 doors, 4 bonnet, 5 boot
//
// Fuel is burnt every second while the engine runs: a little at idle and more
// the faster the vehicle goes. An empty tank stops the engine; the driver's
// client keeps it off until the vehicle is refuelled.
//
// Client protocol:
//   client -> server  gomp:veh:class vehicleId, class   tank size by GTA vehicle class (driver)
//                     gomp:veh:lock vehicleId?          lock/unlock that own vehicle, or the nearest (L)
//                     gomp:veh:door vehicleId, door     open/close a door (G menu)
//   server -> client  gomp:veh:lockfx vehicle, locked, ownerStatic   lights and beep
//                     gomp:veh:fixed vehicle            repaired: reset visual damage

const DEFAULT_TANK = 60;
// Tank size and consumption factor by GTA vehicle class (GET_VEHICLE_CLASS).
const CLASSES = {
  0: [45, 0.8], 1: [60, 1], 2: [80, 1.2], 3: [55, 1], 4: [65, 1.2], 5: [60, 1.1], 6: [65, 1.2], 7: [70, 1.4],
  8: [15, 0.4], 9: [70, 1.2], 10: [120, 1.5], 11: [90, 1.2], 12: [80, 1.2], 13: [0, 0], 14: [100, 1.5],
  15: [300, 3], 16: [400, 3], 17: [90, 1.2], 18: [80, 1.1], 19: [150, 1.8], 20: [150, 1.6], 21: [0, 0], 22: [60, 1],
};
const IDLE_PER_SECOND = 0.008;        // litres per second with the engine running
const PER_KMH_PER_SECOND = 0.00025;   // plus this much per km/h of speed
const LOCK_RANGE = 8;
const DOOR_RANGE = 5;

const state = new Map(); // vehicle id -> { factor, last, fuel (exact litres), warned }

function info(veh) {
  if (!state.has(veh.id)) state.set(veh.id, { factor: 1, last: null, warned: false });
  return state.get(veh.id);
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// The exact litres are kept here: the shared variable has one decimal, and
// rounding every second would swallow consumption below 0.05 l/s (idle and
// normal driving) — the tank would never empty.
function fuelOf(veh) {
  const s = info(veh);
  if (typeof s.fuel === 'number') return s.fuel;
  const f = veh.getVariable('fuel');
  return typeof f === 'number' ? f : DEFAULT_TANK;
}

function tankOf(veh) {
  const m = veh.getVariable('fuelMax');
  return typeof m === 'number' ? m : DEFAULT_TANK;
}

// Sets the litres in the tank (clamped to it); returns them. Clients see one decimal.
function setFuel(veh, litres) {
  const s = info(veh);
  const f = Math.max(0, Math.min(tankOf(veh), Number(litres) || 0));
  s.fuel = f;
  const shown = round1(f);
  if (veh.getVariable('fuel') !== shown) veh.setVariable('fuel', shown);
  if (f > 0) s.warned = false;
  return f;
}

// A vehicle spawned for a player: owned, full (or the given fuel), doors shut.
function setup(veh, ownerStatic, fuel) {
  veh.setVariables({ owner: ownerStatic ?? null, fuelMax: DEFAULT_TANK, doors: 0 });
  setFuel(veh, typeof fuel === 'number' ? fuel : DEFAULT_TANK);
}

function isOwner(player, veh) {
  const owner = veh.getVariable('owner');
  return owner !== null && owner !== undefined && owner === player.getVariable('static');
}

// The vehicle the player sits in, or the nearest one within range (same dimension).
function nearest(player, range, filter = () => true) {
  if (player.vehicle && filter(player.vehicle)) return player.vehicle;
  const pos = player.position;
  let best = null;
  let bestDist = range;
  mp.vehicles.forEach((v) => {
    if (v.dimension !== player.dimension || !filter(v)) return;
    const d = v.position.subtract(pos).length();
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  });
  return best;
}

function near(veh, range, fn) {
  mp.players.forEachInRange(veh.position, range, veh.dimension, fn);
}

// ------------------------------------------------------------------ fuel

// Litres burnt in one second at this speed (km/h), for a vehicle class factor.
function consumption(kmh, factor = 1) {
  return (IDLE_PER_SECOND + kmh * PER_KMH_PER_SECOND) * factor;
}

// One second of driving for every vehicle (every second from the interval below).
function tick() {
  mp.vehicles.forEach((veh) => {
    const s = info(veh);
    const pos = veh.position;
    const moved = s.last ? Math.min(120, pos.subtract(s.last).length()) : 0;
    s.last = pos;
    if (!veh.engine || veh.dead || tankOf(veh) <= 0) return;
    const fuel = fuelOf(veh);
    if (fuel <= 0) {
      veh.engine = false;
      return;
    }
    const kmh = moved * 3.6;
    const left = setFuel(veh, fuel - consumption(kmh, s.factor));
    const driver = veh.getOccupant(0);
    if (left <= 0) {
      veh.engine = false;
      if (driver) driver.notify('~r~Закончилось топливо~s~. Заправьтесь на АЗС или канистрой.');
    } else if (left < tankOf(veh) * 0.1 && !s.warned) {
      s.warned = true;
      if (driver) driver.notify(`~o~Мало топлива~s~: ${round1(left)} л`);
    }
  });
}

setInterval(tick, 1000);

mp.events.add('entityDestroyed', (entity) => {
  if (entity && entity.type === 'vehicle') state.delete(entity.id);
});

// The tank size and consumption of a GTA vehicle class; the tank stays as full as it was.
function setClass(veh, cls) {
  const [tank, factor] = CLASSES[Number(cls)] || [DEFAULT_TANK, 1];
  const ratio = fuelOf(veh) / Math.max(1, tankOf(veh));
  info(veh).factor = factor;
  veh.setVariables({ fuelClass: Number(cls), fuelMax: tank });
  setFuel(veh, tank * Math.min(1, ratio));
}

// The driver's client knows the class of the vehicle: it sets the tank size once.
// The client sends it as it gets in, possibly before its seat reaches this
// mirror, so being at the vehicle is enough.
mp.events.add('gomp:veh:class', (player, id, cls) => {
  const veh = mp.vehicles.at(Number(id));
  if (!veh || veh.hasVariable('fuelClass') || veh.dimension !== player.dimension) return;
  if (player.vehicle !== veh && veh.position.subtract(player.position).length() > 6) return;
  setClass(veh, cls);
});

// Adds fuel; returns the litres actually added.
function refuel(veh, litres) {
  const before = fuelOf(veh);
  return round1(setFuel(veh, before + litres) - before);
}

// ------------------------------------------------------------------ locks

function lockFx(veh, locked, owner) {
  near(veh, 60, (p) => p.call('gomp:veh:lockfx', [veh, locked, owner]));
}

function toggleLock(player, id) {
  // The vehicle the client named (G menu), else the nearest own one.
  const named = id === undefined || id === null ? null : mp.vehicles.at(Number(id));
  const inRange = (v) => player.vehicle === v || (v.dimension === player.dimension && v.position.subtract(player.position).length() <= LOCK_RANGE);
  const veh = named && isOwner(player, named) && inRange(named) ? named : nearest(player, LOCK_RANGE, (v) => isOwner(player, v));
  if (!veh) return player.notify('~r~Рядом нет вашего транспорта');
  veh.locked = !veh.locked;
  lockFx(veh, veh.locked, player.getVariable('static'));
  return player.notify(veh.locked ? 'Транспорт ~r~закрыт' : 'Транспорт ~g~открыт');
}

mp.events.add('gomp:veh:lock', (player, id) => {
  if (!player.hasVariable('static')) return;
  toggleLock(player, id);
});

// ------------------------------------------------------------------ doors

mp.events.add('gomp:veh:door', (player, id, door) => {
  const veh = mp.vehicles.at(Number(id));
  const d = Number(door);
  if (!veh || !(d >= 0 && d <= 5) || veh.dimension !== player.dimension) return;
  const inside = player.vehicle === veh;
  if (!inside && veh.position.subtract(player.position).length() > DOOR_RANGE) return;
  if (veh.locked && !inside) {
    player.notify('~r~Транспорт закрыт');
    return;
  }
  const mask = Number(veh.getVariable('doors')) || 0;
  veh.setVariable('doors', mask ^ (1 << d));
});

// ------------------------------------------------------------------ repair

function repair(veh) {
  veh.repair();
  veh.setVariable('doors', 0);
  near(veh, 300, (p) => p.call('gomp:veh:fixed', [veh]));
}

// ------------------------------------------------------------------ spawning

// Add-on vehicles (client-dist/addons) and friendly names for /veh and /give.
const ALIASES = {
  agera: 'agerars', 'agera-rs': 'agerars', agerars: 'agerars', regera: 'krga', krga: 'krga',
  jesko: 'jesko', koenigsegg: 'jesko', veyron: 'bvss', bugatti: 'bvss', bvss: 'bvss',
  cullinan: 'cullinan', rolls: 'cullinan', 'rolls-royce': 'cullinan',
  m5: 'm5', bmw: 'm5', 'bmw-m5': 'm5', m5f10: 'm5', 'm5-f10': 'm5',
  g37s: 'g37s', g37: 'g37s', infiniti: 'g37s', infinity: 'g37s', 'infiniti-g37': 'g37s', 'инфинити': 'g37s',
  rs7: '20rs7c8', audi: '20rs7c8', 'audi-rs7': '20rs7c8', audirs7: '20rs7c8', rs7c8: '20rs7c8', '20rs7c8': '20rs7c8',
  vaz: 'lada2107', vaz2107: 'lada2107', 'vaz-2107': 'lada2107', lada: 'lada2107', lada2107: 'lada2107',
  'ваз': 'lada2107', 'ваз2107': 'lada2107', 'жигули': 'lada2107', 'семерка': 'lada2107', 'семёрка': 'lada2107',
};

// The model of a name typed in /veh or /give ('veh:<model>' is any model of the game).
function modelOf(name) {
  const n = String(name || '').toLowerCase().replace(/^veh:/, '');
  return ALIASES[n] || n;
}

// Whether /give means a vehicle: an alias or an explicit 'veh:' prefix.
function isVehicleName(name) {
  const n = String(name || '').toLowerCase();
  return n.startsWith('veh:') || Object.prototype.hasOwnProperty.call(ALIASES, n);
}

// Called with every vehicle spawned for a player (tuning.js applies saved tuning).
const onSpawn = [];

// Spawns the player's vehicle (it replaces the previous one), owned by the
// player's character. putIn: the player sits in it (/veh), else it stands in front (/give).
function spawnFor(player, name, { putIn = true } = {}) {
  const model = modelOf(name);
  const old = player.getVariable('personalVehicle');
  if (old && mp.vehicles.exists(old)) old.destroy();
  const p = player.position;
  const h = (player.heading * Math.PI) / 180;
  const pos = putIn ? new mp.Vector3(p.x, p.y, p.z + 0.5) : new mp.Vector3(p.x - Math.sin(h) * 4, p.y + Math.cos(h) * 4, p.z + 0.5);
  const statik = player.getVariable('static');
  const veh = mp.vehicles.new(mp.joaat(model), pos, {
    heading: player.heading,
    numberPlate: statik === null || statik === undefined ? 'GOMP' : `GO${String(statik).padStart(5, '0')}`,
    dimension: player.dimension,
    engine: putIn,
  });
  setup(veh, statik);
  player.setVariable('personalVehicle', veh);
  for (const fn of onSpawn) fn(veh, player, model);
  if (putIn) player.putIntoVehicle(veh, 0);
  return veh;
}

module.exports = {
  setup, setClass, setFuel, fuelOf, tankOf, refuel, nearest, isOwner, repair, toggleLock, consumption, tick,
  modelOf, isVehicleName, spawnFor, onSpawn, ALIASES, CLASSES, DEFAULT_TANK,
};
