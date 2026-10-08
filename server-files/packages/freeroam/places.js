// Gas stations and 24/7 shops: map blips, the places list for the client
// (markers, "E" hints) and purchases.
//
// Client protocol:
//   server -> client  gomp:places [{type: 'fuel'|'shop'|'tune', x, y, z, r, name}], {fuelPrice, catalog, tuning}
//   client -> server  gomp:fuel:buy vehicleId, litres, method ('cash'|'bank')
//                     gomp:shop:buy shopIndex, itemKey, count, method

const roleplay = require('./roleplay');
const inventory = require('./inventory');
const vehicles = require('./vehicles');
const { ITEMS } = require('./items');
const tuning = require('./tuning');

const FUEL_PRICE = 2;       // $ per litre
const STATION_RADIUS = 22;  // the pump islands of the largest stations lie within this radius of the centre
const SHOP_RADIUS = 3;      // from the till

// Gas station centres (the forecourt with the pumps).
const STATIONS = [
  [49.42, 2778.79, 58.04], [263.89, 2606.46, 44.98], [1039.96, 2671.13, 39.55], [1207.26, 2660.18, 37.9],
  [2539.69, 2594.19, 37.94], [2679.86, 3263.95, 55.24], [2005.06, 3773.89, 32.4], [1687.16, 4929.39, 42.08],
  [1701.31, 6416.03, 32.76], [179.86, 6602.84, 31.87], [-94.46, 6419.59, 31.49], [-2554.99, 2334.4, 33.08],
  [-1800.38, 803.66, 138.65], [-1437.62, -276.75, 46.21], [-2096.24, -320.29, 13.17], [-724.62, -935.16, 19.21],
  [-526.02, -1211.0, 18.18], [-70.21, -1761.79, 29.53], [265.65, -1261.31, 29.29], [819.65, -1028.85, 26.4],
  [1208.95, -1402.57, 35.22], [1181.38, -330.85, 69.32], [620.84, 269.1, 103.09], [2581.32, 362.04, 108.47],
  [176.63, -1562.03, 29.26], [-319.29, -1471.72, 30.55], [1784.32, 3330.55, 41.25],
];

// 24/7 and LTD tills.
const SHOPS = [
  [25.74, -1345.6, 29.5], [373.88, 325.9, 103.57], [2557.46, 382.28, 108.62], [-3038.94, 585.95, 7.91],
  [-3241.93, 1001.46, 12.83], [547.43, 2671.71, 42.16], [1961.46, 3740.67, 32.34], [2678.92, 3280.67, 55.24],
  [1729.22, 6414.13, 35.04], [-48.52, -1757.51, 29.42], [1163.37, -323.8, 69.21], [-707.5, -914.26, 19.22],
  [-1820.52, 792.52, 138.12], [1698.39, 4924.4, 42.06],
];

// What the shops sell, $ per item.
const CATALOG = [
  ['medkit', 350], ['bandage', 60], ['repairkit', 500], ['jerrycan', 250], ['water', 8], ['soda', 10],
  ['coffee', 15], ['chips', 10], ['chocolate', 12], ['hotdog', 20], ['burger', 25], ['phone', 300],
];

const places = [
  ...STATIONS.map(([x, y, z]) => ({ type: 'fuel', x, y, z, r: STATION_RADIUS, name: 'АЗС' })),
  ...SHOPS.map(([x, y, z]) => ({ type: 'shop', x, y, z, r: SHOP_RADIUS, name: 'Магазин 24/7' })),
  // Tuning shops: offered at the door; the client moves the vehicle into the bay.
  ...tuning.SHOPS.map((s) => ({ type: 'tune', ...s.door, r: tuning.DOOR_RADIUS, name: s.name, bay: [s.x, s.y, s.z, tuning.bayHeading(s)] })),
];

// Map blips: sprite and colour by place type.
const BLIPS = { fuel: [361, 47], shop: [52, 2], tune: [72, 0] };

for (const p of places) {
  const [sprite, color] = BLIPS[p.type];
  mp.blips.new(sprite, new mp.Vector3(p.x, p.y, p.z), { name: p.name, color, scale: 0.8, shortRange: true, dimension: 0 });
}

function sendPlaces(player) {
  player.call('gomp:places', [places, {
    fuelPrice: FUEL_PRICE, catalog: CATALOG.map(([key, price]) => ({ key, price })), tuning: tuning.PRICES,
  }]);
}

function dist(a, p) {
  return Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z);
}

const payName = (method) => (method === 'bank' ? 'картой' : 'наличными');

// ------------------------------------------------------------------ fuel

mp.events.add('gomp:fuel:buy', (player, id, litres, method) => {
  const ch = roleplay.character(player);
  const veh = mp.vehicles.at(Number(id));
  if (!ch || ch.guest || !veh || veh.dimension !== player.dimension) return undefined;
  const station = places.find((p) => p.type === 'fuel' && dist(veh.position, p) <= p.r + 4);
  if (!station) return player.notify('~r~Транспорт не на заправке');
  if (player.vehicle !== veh && dist(veh.position, player.position) > 6) return player.notify('~r~Подойдите к транспорту');
  if (veh.engine) return player.notify('~r~Заглушите двигатель (меню G)');
  const space = vehicles.tankOf(veh) - vehicles.fuelOf(veh);
  const want = Math.min(space, Math.max(0, Number(litres) || 0));
  if (want < 0.1) return player.notify('Бак полный');
  const sum = Math.ceil(want * FUEL_PRICE);
  if (!roleplay.pay(player, sum, String(method), `АЗС: ${want.toFixed(1)} л`)) return player.notify('~r~Недостаточно денег');
  const added = vehicles.refuel(veh, want);
  return player.notify(`Заправлено ~g~${added} л~s~ за $${sum} (${payName(method)})`);
});

// ------------------------------------------------------------------ shops

mp.events.add('gomp:shop:buy', (player, index, key, count, method) => {
  const ch = roleplay.character(player);
  const shop = places.filter((p) => p.type === 'shop')[Number(index)];
  const entry = CATALOG.find(([k]) => k === String(key));
  const n = Math.floor(Number(count));
  if (!ch || ch.guest || !shop || !entry || !(n >= 1 && n <= 50)) return undefined;
  if (player.dimension !== 0 || dist(player.position, shop) > shop.r + 2) return player.notify('~r~Подойдите к кассе');
  inventory.ensure(ch);
  // Only what fits is sold.
  const fits = n - inventory.spaceShortage(ch, entry[0], n);
  if (fits <= 0) return player.notify('~r~Нет места в инвентаре');
  const price = entry[1] * fits;
  if (!roleplay.pay(player, price, String(method), `24/7: ${ITEMS[entry[0]].name}${fits > 1 ? ` x${fits}` : ''}`)) return player.notify('~r~Недостаточно денег');
  inventory.add(ch, entry[0], fits);
  inventory.refreshAmmo(player, ch);
  inventory.sync(player, ch);
  return player.notify(`Куплено: ${ITEMS[entry[0]].name}${fits > 1 ? ` x${fits}` : ''} за $${price} (${payName(method)})` +
    (fits < n ? ` — не поместилось ${n - fits}` : ''));
});

module.exports = { sendPlaces, places, FUEL_PRICE, CATALOG };
