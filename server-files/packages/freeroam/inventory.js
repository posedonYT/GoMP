// Character inventory: 24 pockets, 9 hotbar slots (keys 1-9) and 3 equipment slots.
//
//   ch.inventory = { pockets: [24], hotbar: [9], equip: [top, legs, shoes] }
//   slot = null | { key, count, uid?, data? }        (see items.js)
//
// A weapon is held only while its hotbar slot is selected; the ped then owns
// just that weapon, loaded with every cartridge of its calibre in the
// inventory. The core counts shots, and the inventory is reconciled with it.
//
// Client protocol:
//   server -> client  gomp:inv:defs [defs]   gomp:inv:sync {inventory, held}
//   client -> server  gomp:inv:move from, fromIndex, to, toIndex, count
//                     gomp:inv:use container, index
//                     gomp:inv:usekey key               (G menu: repair kit, jerry can)
//                     gomp:inv:drop container, index, count?   (the item lands on the ground, drops.js)
//                     gomp:inv:hotkey n (1-9)
//                     gomp:inv:close                    the window with an open storage was closed
//
// A storage (an organization's warehouse, orgs.js) opens next to the pockets as the
// container "storage": gomp:inv:sync then carries {storage: {title, slots}}; items move
// between it and the pockets/hotbar with gomp:inv:move like between the player's own slots.

const { ITEMS, resolve } = require('./items');
const accounts = require('./accounts');
const vehicles = require('./vehicles');

const SIZES = { pockets: 24, hotbar: 9, equip: 3 };
const EQUIP_SLOTS = ['top', 'legs', 'shoes'];

// Clothes worn when an equipment slot is empty.
const BARE = {
  m: { top: { drawable: 15, texture: 0, torso: 15, undershirt: 15 }, legs: { drawable: 61, texture: 0 }, shoes: { drawable: 34, texture: 0 } },
  f: { top: { drawable: 15, texture: 0, torso: 15, undershirt: 14 }, legs: { drawable: 15, texture: 0 }, shoes: { drawable: 35, texture: 0 } },
};

const held = new Map(); // player.id -> hotbar index of the weapon in hand
// player.id -> the open storage: { title, slots, canTake(), canPut(), check(), onChange() }
const external = new Map();

function emptyInventory() {
  return { pockets: Array(SIZES.pockets).fill(null), hotbar: Array(SIZES.hotbar).fill(null), equip: Array(SIZES.equip).fill(null) };
}

function makeItem(key, count = 1, data) {
  const d = ITEMS[key];
  const item = { key, count: d.stack > 1 ? count : 1 };
  if (d.stack === 1) item.uid = accounts.nextUid();
  if (data) item.data = data;
  return item;
}

function clothesItem(gender, slot, c) {
  const names = { top: 'Верх', legs: 'Низ', shoes: 'Обувь' };
  return makeItem(`clothes_${slot}`, 1, { slot, gender, ...c, label: `${names[slot]} №${c.drawable + 1}` });
}

// Brings a stored inventory to the current slot counts; items of removed slots move to free ones.
function normalize(ch) {
  const inv = ch.inventory;
  const overflow = [];
  for (const [c, size] of Object.entries(SIZES)) {
    if (!Array.isArray(inv[c])) inv[c] = [];
    overflow.push(...inv[c].slice(size).filter(Boolean));
    inv[c] = inv[c].slice(0, size);
    while (inv[c].length < size) inv[c].push(null);
  }
  for (const item of overflow) {
    const c = ['pockets', 'hotbar'].find((name) => inv[name].includes(null));
    if (c) inv[c][inv[c].indexOf(null)] = item;
    else console.log(`[inventory] no room for ${item.key} x${item.count} of ${ch.first} ${ch.last}`);
  }
  accounts.save();
}

// Creates the inventory of a new character, or converts an old one (weapons map + appearance).
function ensure(ch) {
  if (ch.inventory) {
    const inv = ch.inventory;
    if (Object.entries(SIZES).some(([c, size]) => !Array.isArray(inv[c]) || inv[c].length !== size)) normalize(ch);
    return ch.inventory;
  }
  const inv = emptyInventory();
  ch.inventory = inv;
  for (const [weapon, rounds] of Object.entries(ch.weapons || {})) {
    if (!ITEMS[weapon]) continue;
    const free = inv.hotbar.indexOf(null);
    if (free >= 0) inv.hotbar[free] = makeItem(weapon);
    else add(ch, weapon, 1);
    const ammo = ITEMS[weapon].ammo;
    if (ammo && rounds > 0) add(ch, ammo, rounds);
  }
  delete ch.weapons;
  const a = ch.appearance || {};
  inv.equip[0] = clothesItem(ch.gender, 'top', { drawable: a.top || 0, texture: a.topTex || 0, torso: a.torso || 0, undershirt: a.undershirt ?? 15 });
  inv.equip[1] = clothesItem(ch.gender, 'legs', { drawable: a.legs || 0, texture: a.legsTex || 0 });
  inv.equip[2] = clothesItem(ch.gender, 'shoes', { drawable: a.shoes || 0, texture: a.shoesTex || 0 });
  add(ch, 'bandage', 3);
  add(ch, 'water', 2);
  add(ch, 'phone', 1);
  accounts.save();
  return inv;
}

// ------------------------------------------------------------------ queries and changes

function countOf(ch, key) {
  const inv = ensure(ch);
  let n = 0;
  for (const c of ['pockets', 'hotbar']) for (const s of inv[c]) if (s && s.key === key) n += s.count;
  return n;
}

// Adds items (stacks first, then empty pockets, then empty hotbar slots); returns what did not fit.
function add(ch, key, count = 1, data) {
  const d = ITEMS[key];
  if (!d) return count;
  const inv = ch.inventory;
  let left = count;
  if (d.stack > 1) {
    for (const c of ['pockets', 'hotbar'])
      for (const s of inv[c]) {
        if (left <= 0) break;
        if (s && s.key === key && s.count < d.stack) {
          const n = Math.min(left, d.stack - s.count);
          s.count += n;
          left -= n;
        }
      }
  }
  for (const c of ['pockets', 'hotbar'])
    for (let i = 0; i < inv[c].length && left > 0; i++) {
      if (inv[c][i]) continue;
      const n = d.stack > 1 ? Math.min(left, d.stack) : 1;
      inv[c][i] = makeItem(key, n, data);
      left -= n;
    }
  accounts.save();
  return left;
}

// How many of count items of a kind would not fit (nothing is changed).
function spaceShortage(ch, key, count) {
  const d = ITEMS[key];
  const inv = ensure(ch);
  let left = count;
  for (const c of ['pockets', 'hotbar'])
    for (const s of inv[c]) {
      if (left <= 0) return 0;
      if (!s) left -= d.stack > 1 ? d.stack : 1;
      else if (d.stack > 1 && s.key === key) left -= d.stack - s.count;
    }
  return Math.max(0, left);
}

// Adds an existing item (a picked-up drop): non-stackable ones keep their
// serial number and data. Returns how many did not fit.
function addItem(ch, item) {
  const d = ITEMS[item.key];
  if (!d) return item.count;
  if (d.stack > 1) return add(ch, item.key, item.count);
  const inv = ensure(ch);
  const c = ['pockets', 'hotbar'].find((name) => inv[name].includes(null));
  if (!c) return 1;
  inv[c][inv[c].indexOf(null)] = item;
  accounts.save();
  return 0;
}

// Removes up to count items of a kind (pockets first); returns how many were removed.
function remove(ch, key, count) {
  const inv = ensure(ch);
  let left = count;
  for (const c of ['pockets', 'hotbar'])
    for (let i = 0; i < inv[c].length && left > 0; i++) {
      const s = inv[c][i];
      if (!s || s.key !== key) continue;
      const n = Math.min(left, s.count);
      s.count -= n;
      left -= n;
      if (s.count <= 0) inv[c][i] = null;
    }
  accounts.save();
  return count - left;
}

// ------------------------------------------------------------------ client sync

function sendDefs(player) {
  const defs = Object.values(ITEMS).map((d) => ({ key: d.key, name: d.name, type: d.type, stack: d.stack, icon: d.icon, desc: d.desc }));
  player.call('gomp:inv:defs', [defs]);
}

function sync(player, ch) {
  const inv = ensure(ch);
  const pack = (s) => (s ? { key: s.key, count: s.count, uid: s.uid || 0, label: (s.data && s.data.label) || '' } : null);
  const ext = external.get(player.id);
  player.call('gomp:inv:sync', [{
    pockets: inv.pockets.map(pack), hotbar: inv.hotbar.map(pack), equip: inv.equip.map(pack),
    held: held.has(player.id) ? held.get(player.id) : -1,
    ...(ext ? { storage: { title: ext.title, slots: ext.slots.map(pack), take: !!ext.canTake(), put: !!ext.canPut() } } : {}),
  }]);
}

// ------------------------------------------------------------------ storages

// Opens a storage next to the player's inventory (the client opens the window).
function openExternal(player, ch, storage) {
  external.set(player.id, storage);
  sync(player, ch);
  player.call('gomp:inv:open', []);
}

function closeExternal(player) {
  external.delete(player.id);
}

// Everybody else looking into the same storage sees the change.
function syncViewers(slots, except) {
  external.forEach((e, pid) => {
    if (e.slots !== slots || pid === except) return;
    const p = mp.players.at(pid);
    const ch = p && accounts.characterByStatic(p.getVariable('static'));
    if (ch) sync(p, ch);
  });
}

mp.events.add('playerQuit', (player) => external.delete(player.id));

// ------------------------------------------------------------------ weapons in hand

function holster(player) {
  held.delete(player.id);
  player.removeAllWeapons();
}

function draw(player, ch, index) {
  const item = ch.inventory.hotbar[index];
  const d = item && ITEMS[item.key];
  if (!d || d.type !== 'weapon') return;
  player.removeAllWeapons();
  const hash = mp.joaat(d.weapon);
  player.giveWeapon(hash, d.infinite ? 9999 : d.ammo ? countOf(ch, d.ammo) : 1);
  player.weapon = hash;
  held.set(player.id, index);
}

// Brings the ped's ammo in line with the inventory after it changed.
function refreshAmmo(player, ch) {
  const i = held.get(player.id);
  if (i === undefined) return undefined;
  const item = ch.inventory.hotbar[i];
  const d = item && ITEMS[item.key];
  if (!d || d.type !== 'weapon') return holster(player);
  if (d.ammo) player.setWeaponAmmo(mp.joaat(d.weapon), countOf(ch, d.ammo));
  return undefined;
}

// Shots fired since the last check are taken from the ammo items.
function reconcileAmmo(player, ch) {
  const i = held.get(player.id);
  if (i === undefined) return;
  const item = ch.inventory.hotbar[i];
  const d = item && ITEMS[item.key];
  if (!d || !d.ammo) return;
  const inHand = player.getWeaponAmmo(mp.joaat(d.weapon));
  const owned = countOf(ch, d.ammo);
  if (inHand < owned) {
    remove(ch, d.ammo, owned - inHand);
    // The last grenade thrown empties its own hotbar slot.
    if (!ch.inventory.hotbar[i]) held.delete(player.id);
    sync(player, ch);
  } else if (inHand > owned) {
    player.setWeaponAmmo(mp.joaat(d.weapon), owned);
  }
}

// ------------------------------------------------------------------ clothes

function applyEquipment(player, ch) {
  const inv = ensure(ch);
  const bare = BARE[ch.gender] || BARE.m;
  EQUIP_SLOTS.forEach((slot, i) => {
    const c = (inv.equip[i] && inv.equip[i].data) || bare[slot];
    if (slot === 'top') {
      player.setClothes(11, c.drawable, c.texture, 0);
      player.setClothes(3, c.torso ?? 0, 0, 0);
      player.setClothes(8, c.undershirt ?? (ch.gender === 'f' ? 14 : 15), 0, 0);
    } else {
      player.setClothes(slot === 'legs' ? 4 : 6, c.drawable, c.texture, 0);
    }
  });
}

function fitsEquip(ch, item, index) {
  if (!item) return true;
  const d = ITEMS[item.key];
  return d.type === 'clothes' && d.slot === EQUIP_SLOTS[index] && item.data && item.data.gender === ch.gender;
}

// ------------------------------------------------------------------ actions

function move(player, ch, from, fi, to, ti, count) {
  const own = ensure(ch);
  const ext = external.get(player.id);
  if ((from === 'storage' || to === 'storage') && (!ext || !ext.check())) {
    external.delete(player.id);
    return sync(player, ch);
  }
  // The containers by name: the player's own slots, or the open storage.
  const inv = ext ? { ...own, storage: ext.slots } : own;
  const sizeOf = (c) => (c === 'storage' ? (ext ? ext.slots.length : 0) : SIZES[c]);
  if (!sizeOf(from) || !sizeOf(to) || !(fi >= 0 && fi < sizeOf(from)) || !(ti >= 0 && ti < sizeOf(to))) return undefined;
  if (from === to && fi === ti) return undefined;
  if ((from === 'storage' && to === 'equip') || (from === 'equip' && to === 'storage')) return player.notify('~r~Сначала переложите предмет в карманы');
  const taking = from === 'storage' && to !== 'storage';
  const putting = to === 'storage';  // also rearranging the storage itself
  if (taking && !ext.canTake()) return player.notify('~r~Нет доступа: брать со склада');
  if ((putting || (taking && inv[to][ti])) && !ext.canPut()) return player.notify('~r~Нет доступа: класть на склад');
  const src = inv[from][fi];
  if (!src) return undefined;
  const dst = inv[to][ti];
  const d = ITEMS[src.key];
  const n = Math.max(1, Math.min(src.count, Math.floor(Number(count)) || src.count));
  if (to === 'equip' && !fitsEquip(ch, src, ti)) return player.notify('~r~Этот предмет сюда не надевается');
  if (from === 'equip' && dst && !fitsEquip(ch, dst, fi)) return player.notify('~r~Сначала уберите предмет в пустой слот');
  const heldIndex = held.get(player.id);
  if (dst && dst.key === src.key && d.stack > 1) {
    const moved = Math.min(n, d.stack - dst.count);
    dst.count += moved;
    src.count -= moved;
    if (src.count <= 0) inv[from][fi] = null;
  } else if (!dst && n < src.count) {
    inv[to][ti] = { key: src.key, count: n };
    src.count -= n;
  } else {
    inv[to][ti] = src;
    inv[from][fi] = dst;
  }
  // A weapon that left its hotbar slot is put away.
  if (heldIndex !== undefined && ((from === 'hotbar' && fi === heldIndex) || (to === 'hotbar' && ti === heldIndex))) holster(player);
  if (from === 'equip' || to === 'equip') applyEquipment(player, ch);
  accounts.save();
  if (from === 'storage' || to === 'storage') {
    ext.onChange();
    syncViewers(ext.slots, player.id);
  }
  return sync(player, ch);
}

function use(player, ch, container, index) {
  const inv = ensure(ch);
  if (!SIZES[container]) return undefined;
  const item = inv[container][index];
  if (!item) return undefined;
  const d = ITEMS[item.key];
  if (d.type === 'weapon') {
    if (container !== 'hotbar') return player.notify('Переложите оружие в быстрый слот (1-9)');
    return hotkey(player, ch, index + 1);
  }
  if (d.type === 'clothes') {
    if (container === 'equip') return player.notify('Перетащите вещь в карманы, чтобы снять');
    const slot = EQUIP_SLOTS.indexOf(d.slot);
    return move(player, ch, container, index, 'equip', slot);
  }
  if (d.type === 'tool') return useTool(player, ch, container, index);
  if (d.heal || d.armour) {
    if (player.dead) return undefined;
    // Nothing is wasted: healing needs missing health, a vest needs missing armour.
    if (d.heal && !d.armour && player.health >= 100) return player.notify(d.type === 'food' ? 'Вы не голодны' : 'Здоровье уже полное');
    if (d.armour && player.armour >= d.armour) return player.notify('Броня уже полная');
    if (d.heal) player.health = Math.min(100, player.health + d.heal);
    if (d.armour) player.armour = Math.max(player.armour, d.armour);
    item.count -= 1;
    if (item.count <= 0) inv[container][index] = null;
    accounts.save();
    player.notify(`Использовано: ${d.name}`);
    return sync(player, ch);
  }
  if (d.type === 'ammo') return player.notify('Патроны заряжаются в оружие автоматически');
  if (item.key === 'phone') return player.call('gomp:phone:show', []);
  return player.notify(d.name);
}

// Takes an item out of a slot to throw it away (count: part of a stack); returns the item.
function take(player, ch, container, index, count) {
  const inv = ensure(ch);
  if (!SIZES[container] || !inv[container][index] || player.dead) return null;
  const src = inv[container][index];
  const n = Math.max(1, Math.min(src.count, Math.floor(Number(count)) || src.count));
  let item = src;
  if (n < src.count) {
    src.count -= n;
    item = { key: src.key, count: n };
  } else {
    inv[container][index] = null;
    if (container === 'hotbar' && held.get(player.id) === index) holster(player);
  }
  if (container === 'equip') applyEquipment(player, ch);
  refreshAmmo(player, ch);
  accounts.save();
  player.notify(`Выброшено: ${ITEMS[item.key].name}${item.count > 1 ? ` x${item.count}` : ''}`);
  sync(player, ch);
  return item;
}

// ------------------------------------------------------------------ tools (vehicles)

const repairing = new Set(); // player ids busy with a repair kit
const REPAIR_MS = 6000;
const TOOL_RANGE = 4.5;

function consumeOne(ch, container, index, key) {
  const item = ch.inventory[container][index];
  if (item && item.key === key) {
    item.count -= 1;
    if (item.count <= 0) ch.inventory[container][index] = null;
  } else {
    remove(ch, key, 1);
  }
  accounts.save();
}

function useTool(player, ch, container, index) {
  const item = ch.inventory[container][index];
  const d = ITEMS[item.key];
  if (item.key === 'jerrycan') {
    const veh = vehicles.nearest(player, TOOL_RANGE);
    if (!veh) return player.notify('~r~Подойдите к транспорту');
    const added = vehicles.refuel(veh, d.fuel);
    if (added < 0.1) return player.notify('Бак полный');
    consumeOne(ch, container, index, item.key);
    player.notify(`Залито из канистры: ~g~${added} л`);
    return sync(player, ch);
  }
  if (item.key === 'repairkit') {
    if (player.vehicle) return player.notify('~r~Выйдите из транспорта');
    if (repairing.has(player.id)) return undefined;
    const veh = vehicles.nearest(player, TOOL_RANGE);
    if (!veh) return player.notify('~r~Подойдите к транспорту');
    if (veh.bodyHealth >= 1000 && veh.engineHealth >= 1000 && !veh.dead) return player.notify('Транспорт не нуждается в ремонте');
    repairing.add(player.id);
    holster(player);
    sync(player, ch);  // the weapon left the hands
    player.playAnimation('mini@repair', 'fixing_a_player', 8, 1);
    player.notify('Ремонт...');
    return setTimeout(() => {
      repairing.delete(player.id);
      if (!mp.players.exists(player)) return;
      player.stopAnimation();
      if (!mp.vehicles.exists(veh) || player.dead || veh.position.subtract(player.position).length() > TOOL_RANGE + 1.5) {
        player.notify('~r~Ремонт прерван');
        return;
      }
      if (remove(ch, 'repairkit', 1) < 1) return;
      vehicles.repair(veh);
      player.notify('Транспорт ~g~отремонтирован');
      sync(player, ch);
    }, REPAIR_MS);
  }
  return player.notify(d.name);
}

// Uses the first item of a kind (G menu: repair kit, jerry can).
function useKey(player, ch, key) {
  const inv = ensure(ch);
  for (const c of ['hotbar', 'pockets']) {
    const i = inv[c].findIndex((s) => s && s.key === key);
    if (i >= 0) return use(player, ch, c, i);
  }
  return player.notify(`~r~Нет предмета: ${ITEMS[key].name}`);
}

// Keys 1-9: take the weapon of that hotbar slot (again: put it away) or use the item there.
function hotkey(player, ch, n) {
  const index = Number(n) - 1;
  if (!(index >= 0 && index < SIZES.hotbar) || player.dead) return undefined;
  const item = ch.inventory.hotbar[index];
  if (!item) {
    if (held.has(player.id)) holster(player);
    return sync(player, ch);
  }
  if (ITEMS[item.key].type !== 'weapon') return use(player, ch, 'hotbar', index);
  if (held.get(player.id) === index) holster(player);
  else draw(player, ch, index);
  return sync(player, ch);
}

// Admin: gives an item by name; returns a message. For a weapon the number is
// its ammunition: "carbinerifle 500" is the rifle and 500 rounds of 5.56.
function give(player, ch, name, count = 1, data) {
  const key = resolve(name);
  if (!key) return `Нет такого предмета: ${name}`;
  ensure(ch);
  const d = ITEMS[key];
  const n = Math.max(1, Math.floor(count));
  // A gun takes one slot (the number is its ammunition); grenades stack.
  const gun = d.type === 'weapon' && d.stack === 1;
  const items = gun ? 1 : n;
  const left = add(ch, key, items, data);
  let msg = d.name + (items > 1 ? ` x${items - left}` : '') + (left ? ` (не поместилось ${left})` : '');
  if (gun && d.ammo && n > 1) {
    const ammoLeft = add(ch, d.ammo, n);
    msg += ` + ${ITEMS[d.ammo].name} x${n - ammoLeft}${ammoLeft ? ` (не поместилось ${ammoLeft})` : ''}`;
  }
  refreshAmmo(player, ch);
  sync(player, ch);
  return msg;
}

function resolveItem(name) {
  return resolve(name);
}

mp.events.add('gomp:inv:close', (player) => closeExternal(player));

module.exports = {
  openExternal, closeExternal, external,
  ensure, resolveItem, add, addItem, spaceShortage, remove, countOf, sync, sendDefs, move, use, useKey, take, hotkey, give,
  holster, draw, refreshAmmo, reconcileAmmo, applyEquipment, clothesItem, held, ITEMS,
};
