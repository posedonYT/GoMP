// Los Santos Customs: tuning of the player's own vehicle in a tuning shop.
// Works for the game's vehicles and add-on ones alike: the client lists the
// parts the vehicle model has (mod kit 0) and sends the order; the server
// checks it, charges it and applies it as vehicle properties.
//
// The tuning is saved per character and model (ch.tuning[model]) and applied
// again whenever the character gets that model (/veh, /give, the kit vehicle).
//
// Client protocol:
//   server -> client  gomp:places [..., {type: 'tune', ...}], {tuning: PRICES}   (places.js)
//   client -> server  gomp:tune:buy vehicleId, order, method ('cash' | 'bank')
//     order = { mods: {type: index}, primary, secondary, pearl, wheelColor, wheelType,
//               windowTint, neon: [on, r, g, b], plateType, livery }   (every field optional)

const roleplay = require('./roleplay');
const vehicles = require('./vehicles');
const accounts = require('./accounts');

// The workshops: x, y, z is the bay inside where the vehicle stands during tuning,
// door the workshop door (the client offers tuning in front of it and moves the
// vehicle into the bay, behind closed doors). Benny's has no interior in story mode.
const SHOPS = [
  { x: -337.38, y: -136.92, z: 38.6, door: { x: -356.09, y: -134.77, z: 38.2 }, name: 'Los Santos Customs' },
  { x: 731.81, y: -1088.81, z: 21.8, door: { x: 723.12, y: -1088.83, z: 21.6 }, name: 'Los Santos Customs' },
  { x: -1155.53, y: -2007.18, z: 12.8, door: { x: -1145.9, y: -1991.14, z: 12.4 }, name: 'Los Santos Customs' },
  { x: 1175.04, y: 2640.21, z: 37.4, door: { x: 1174.66, y: 2644.16, z: 37.6 }, name: 'Los Santos Customs' },
  { x: 110.99, y: 6626.39, z: 30.9, door: { x: 108.85, y: 6617.88, z: 31.0 }, name: "Beeker's Garage" },
];
const SHOP_RADIUS = 8;   // around the bay: the vehicle is in the workshop
const DOOR_RADIUS = 9;   // around the door: tuning is offered

// The heading (degrees, GTA: 0 north, 90 west) of a vehicle in the bay facing the door.
function bayHeading(shop) {
  const dx = shop.door.x - shop.x, dy = shop.door.y - shop.y;
  return ((Math.atan2(-dx, dy) * 180) / Math.PI + 360) % 360;
}

// Prices in $. A part of level i (index 0 = the first one) costs base * (1 + i * levelStep);
// going back to the stock part (index -1) is free.
const PRICES = {
  levelStep: 0.5,
  mods: {
    0: 1500, 1: 1200, 2: 1200, 3: 1000, 4: 900, 5: 1500, 6: 800, 7: 1500, 8: 1000, 9: 1000, 10: 1200,
    11: 6000, 12: 3000, 13: 4000, 14: 300, 15: 2500, 16: 5000, 23: 2000, 24: 2000,
  },
  otherMod: 700,                       // types 25..48 (interior, plate holders, ...)
  toggles: { 18: 15000, 20: 1000, 22: 2500 },  // turbo, tyre smoke, xenon
  primary: 1000, secondary: 800, pearl: 1200, wheelColor: 600, wheelType: 500,
  windowTint: 700, neon: 3500, plateType: 400, livery: 1500,
};
const TOGGLES = [18, 20, 22];

const int = (v) => (Number.isInteger(Number(v)) ? Number(v) : NaN);
const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// A clean copy of an order with only valid fields, or an error text.
function validate(order) {
  if (!order || typeof order !== 'object') return { error: 'Пустой заказ' };
  const out = {};
  if (order.mods !== undefined) {
    if (typeof order.mods !== 'object' || order.mods === null) return { error: 'Неверные детали' };
    out.mods = {};
    for (const [k, v] of Object.entries(order.mods)) {
      const type = int(k), index = int(v);
      if (!inRange(type, 0, 49) || !inRange(index, -1, 254)) return { error: `Неверная деталь ${k}` };
      out.mods[type] = TOGGLES.includes(type) ? (index >= 0 ? 0 : -1) : index;
    }
  }
  const fields = { primary: [0, 160], secondary: [0, 160], pearl: [0, 160], wheelColor: [0, 160], wheelType: [0, 12],
    windowTint: [0, 6], plateType: [0, 5], livery: [0, 63] };
  for (const [f, [lo, hi]] of Object.entries(fields)) {
    if (order[f] === undefined) continue;
    const v = int(order[f]);
    if (!inRange(v, lo, hi)) return { error: `Неверное значение ${f}` };
    out[f] = v;
  }
  if (order.neon !== undefined) {
    const n = order.neon;
    if (!Array.isArray(n) || n.length !== 4 || ![1, 2, 3].every((i) => inRange(int(n[i]), 0, 255))) return { error: 'Неверный неон' };
    out.neon = [!!n[0], int(n[1]), int(n[2]), int(n[3])];
  }
  return { order: out };
}

function modPrice(type, index) {
  if (index < 0) return 0;
  if (TOGGLES.includes(type)) return PRICES.toggles[type];
  const base = PRICES.mods[type] ?? PRICES.otherMod;
  return Math.round((base * (1 + index * PRICES.levelStep)) / 10) * 10;
}

// What the vehicle has now (the server's view of its properties).
function stateOf(veh) {
  const mods = {};
  veh.mods.forEach((index, type) => {
    if (index >= 0) mods[type] = index;
  });
  return {
    mods, primary: veh.getColor(0), secondary: veh.getColor(1), pearl: veh.pearlescentColor, wheelColor: veh.wheelColor,
    wheelType: veh.wheelType, windowTint: veh.windowTint, plateType: veh.numberPlateType, livery: veh.livery,
    neon: [veh.neonEnabled, ...veh.getNeonColor()],
  };
}

// The price of the parts of the order that differ from the current state.
function priceOf(state, order) {
  let sum = 0;
  for (const [k, index] of Object.entries(order.mods || {})) {
    const type = Number(k);
    if ((state.mods[type] ?? -1) !== index) sum += modPrice(type, index);
  }
  for (const f of ['primary', 'secondary', 'pearl', 'wheelColor', 'wheelType', 'windowTint', 'plateType', 'livery'])
    if (order[f] !== undefined && order[f] !== state[f]) sum += PRICES[f];
  if (order.neon) {
    const [on, r, g, b] = order.neon;
    const [was, wr, wg, wb] = state.neon;
    if (on !== !!was || (on && (r !== wr || g !== wg || b !== wb))) sum += on ? PRICES.neon : 0;
  }
  return sum;
}

// Applies an order (or a saved tuning) to the vehicle.
function apply(veh, order) {
  if (order.wheelType !== undefined) veh.wheelType = order.wheelType;  // before the wheels
  for (const [type, index] of Object.entries(order.mods || {})) veh.setMod(Number(type), index);
  if (order.primary !== undefined || order.secondary !== undefined)
    veh.setColor(order.primary ?? veh.getColor(0), order.secondary ?? veh.getColor(1));
  if (order.pearl !== undefined) veh.pearlescentColor = order.pearl;
  if (order.wheelColor !== undefined) veh.wheelColor = order.wheelColor;
  if (order.windowTint !== undefined) veh.windowTint = order.windowTint;
  if (order.plateType !== undefined) veh.numberPlateType = order.plateType;
  if (order.livery !== undefined) veh.livery = order.livery;
  if (order.neon) {
    veh.setNeonColor(order.neon[1], order.neon[2], order.neon[3]);
    veh.neonEnabled = order.neon[0];
  }
}

// Merges an order into a saved tuning.
function merge(saved, order) {
  return { ...saved, ...order, mods: { ...(saved && saved.mods), ...order.mods } };
}

function shopAt(pos) {
  return SHOPS.find((s) => Math.hypot(pos.x - s.x, pos.y - s.y, pos.z - s.z) <= SHOP_RADIUS + 2) || null;
}

mp.events.add('gomp:tune:buy', (player, id, order, method) => {
  const ch = roleplay.character(player);
  const veh = mp.vehicles.at(Number(id));
  if (!ch || ch.guest || !veh) return undefined;
  if (player.vehicle !== veh || player.seat !== 0) return player.notify('~r~Сядьте за руль');
  if (!vehicles.isOwner(player, veh)) return player.notify('~r~Тюнинг доступен только для личного транспорта');
  if (veh.dimension !== 0 || !shopAt(veh.position)) return player.notify('~r~Заедьте в тюнинг-центр');
  const v = validate(order);
  if (v.error) return player.notify(`~r~${v.error}`);
  const price = priceOf(stateOf(veh), v.order);
  if (price <= 0 && JSON.stringify(v.order) === '{}') return player.notify('Ничего не изменено');
  if (!roleplay.pay(player, price, String(method), 'Los Santos Customs')) return player.notify('~r~Недостаточно денег');
  apply(veh, v.order);
  const model = String(veh.model);
  ch.tuning = ch.tuning || {};
  ch.tuning[model] = merge(ch.tuning[model], v.order);
  accounts.save();
  return player.notify(price > 0 ? `Тюнинг установлен за ~g~$${price}` : 'Тюнинг установлен');
});

// Saved tuning goes onto every vehicle of that model spawned for the character.
vehicles.onSpawn.push((veh, player) => {
  const ch = roleplay.character(player);
  const saved = ch && ch.tuning && ch.tuning[String(veh.model)];
  if (saved) apply(veh, saved);
});

module.exports = { SHOPS, SHOP_RADIUS, DOOR_RADIUS, bayHeading, PRICES, validate, modPrice, priceOf, stateOf, apply, merge, shopAt };
