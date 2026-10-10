// Admin commands for the GoMP admin console (the "\" key in the game client
// sends console lines as /commands). Written only against the RAGE.MP API.
//
// admin.json next to this file:
//   { "password": "...", "trustLocalhost": true }
// trustLocalhost makes players connecting from 127.0.0.1 admins automatically
// (handy for local testing; turn it off on a public server).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const roleplay = require('./roleplay');
const inventory = require('./inventory');
const vehicles = require('./vehicles');
const houses = require('./houses');
const maps = require('./maps');
const orgs = require('./orgs');
const cars = require('./cars');

const configPath = path.join(__dirname, 'admin.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    const cfg = { password: crypto.randomBytes(6).toString('hex'), trustLocalhost: true };
    fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
    console.log(`[admin] created ${configPath}; admin password: ${cfg.password}`);
    return cfg;
  }
}

const config = loadConfig();

function isLocal(player) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(player.ip);
}

function isAdmin(player) {
  return player.getVariable('admin') === true || (config.trustLocalhost && isLocal(player));
}

// Finds a player by the static of the character or by a (case-insensitive) part of the name.
function findPlayer(query) {
  if (query === undefined) return null;
  const byStatic = roleplay.findByStatic(query);
  if (byStatic) return byStatic;
  const q = String(query).toLowerCase();
  const matches = mp.players.toArray().filter((p) => p.name.toLowerCase().includes(q));
  return matches.length === 1 ? matches[0] : null;
}

// Registers an admin-only command whose first argument is a target player.
function adminCommand(name, usage, fn, { needsTarget = true } = {}) {
  mp.events.addCommand(name, (player, fullText, ...args) => {
    if (!isAdmin(player)) return player.outputChatBox('!{#f66}Нет прав. Войдите: /alogin <пароль>');
    if (needsTarget) {
      const target = findPlayer(args[0]);
      if (!target) return player.outputChatBox(`!{#f66}Игрок не найден. Использование: /${name} ${usage}`);
      return fn(player, target, args.slice(1), fullText);
    }
    return fn(player, args, fullText);
  });
}

function reply(player, text) {
  player.outputChatBox(`!{#9cf}[admin] ${text}`);
}

function restOf(fullText, skip) {
  return (fullText || '').split(' ').slice(skip).join(' ').trim();
}

mp.events.addCommand('alogin', (player, _, password) => {
  if (isAdmin(player)) return reply(player, 'Вы уже администратор');
  if (password && password === config.password) {
    player.setVariable('admin', true);
    console.log(`[admin] ${player.name} logged in as admin`);
    return reply(player, 'Вход выполнен');
  }
  console.log(`[admin] failed admin login by ${player.name} (${player.ip})`);
  return player.outputChatBox('!{#f66}Неверный пароль');
});

adminCommand('ahelp', '', (player) => {
  reply(player, 'players, kick <статик> [причина], ban <статик> [причина], goto <статик>, bring <статик>');
  reply(player, 'sethp <статик> <hp>, setarmour <статик> <n>, give [статик] <предмет|машина> [кол-во], giveclothes [статик] <top|legs|shoes> <номер> [цвет], items');
  reply(player, 'slay <статик>, respawn <статик>');
  reply(player, 'setdim <статик> <n>, setmoney <статик> <нал> [карта], delveh [all], setfuel [литры], fixveh, announce <текст>');
  reply(player, 'house add <класс> <цена> [название], house move|del|free|tp <id>, house list, house garage <id> [off] (въезд в гараж здесь), interior spawn|exit (внутри дома), garage spawn|exit|slot <n> (внутри гаража)');
  reply(player, 'maps, maps reload [имя], maps on|off <имя>, mapcursor (камера GoMP Studio сюда)');
  reply(player, 'invis (невидимость), fly (полёт), tpm (телепорт к метке на карте), makeleader <статик> <lspd|army|ems|gov|none>, setorg <статик> <орг|none> [ранг]');
}, { needsTarget: false });

adminCommand('players', '', (player) => {
  reply(player, `Игроков: ${mp.players.length}`);
  mp.players.forEach((p) => {
    const pos = p.position;
    reply(player, `#${p.id} ${p.name} [static ${p.getVariable('static') ?? '-'}]  hp ${p.health}  dim ${p.dimension}  ping ${p.ping}  ` +
      `${pos.x.toFixed(0)} ${pos.y.toFixed(0)} ${pos.z.toFixed(0)}${isAdmin(p) ? '  [admin]' : ''}`);
  });
}, { needsTarget: false });

adminCommand('kick', '<статик> [причина]', (player, target, _, fullText) => {
  const reason = restOf(fullText, 1) || 'kicked by admin';
  mp.players.broadcast(`!{#f96}${target.name} кикнут: ${reason}`);
  target.kick(reason);
});

adminCommand('ban', '<статик> [причина]', (player, target, _, fullText) => {
  const reason = restOf(fullText, 1) || 'banned by admin';
  mp.players.broadcast(`!{#f66}${target.name} забанен: ${reason}`);
  target.ban(reason);
});

adminCommand('goto', '<статик>', (player, target) => {
  const p = target.position;
  player.dimension = target.dimension;
  player.position = new mp.Vector3(p.x + 1, p.y, p.z);
  reply(player, `Телепорт к ${target.name}`);
});

adminCommand('bring', '<статик>', (player, target) => {
  const p = player.position;
  target.dimension = player.dimension;
  target.position = new mp.Vector3(p.x + 1, p.y, p.z);
  reply(player, `${target.name} перемещён к вам`);
});

adminCommand('sethp', '<статик> <hp>', (player, target, [hp]) => {
  const v = Math.max(0, Math.min(100, Number(hp)));
  if (Number.isNaN(v)) return reply(player, 'Использование: /sethp <статик> <0..100>');
  target.health = v;
  return reply(player, `${target.name}: здоровье ${v}`);
});

adminCommand('setarmour', '<статик> <n>', (player, target, [n]) => {
  const v = Math.max(0, Math.min(100, Number(n)));
  if (Number.isNaN(v)) return reply(player, 'Использование: /setarmour <статик> <0..100>');
  target.armour = v;
  return reply(player, `${target.name}: броня ${v}`);
});

// Items go into the inventory: weapons and clothes one per slot, the rest stacks.
adminCommand('give', '[статик] <предмет> [количество]', (player, args) => {
  // Without a static (the first word is an item or a vehicle) it goes to the admin.
  const self = inventory.resolveItem(args[0]) || vehicles.isVehicleName(args[0]);
  const target = self ? player : findPlayer(args[0]);
  const [name, count = '1'] = self ? args : args.slice(1);
  if (!target) return reply(player, 'Игрок не найден. Использование: /give [статик] <предмет> [количество]; список: /items');
  const ch = roleplay.character(target);
  if (!ch || ch.guest) return reply(player, `${target.name} ещё не выбрал персонажа`);
  if (!name) return reply(player, 'Использование: /give [статик] <предмет> [количество]; список: /items');
  // A vehicle (vaz2107, agera... or veh:<model>) becomes a car of the player (cars.js), next to them.
  if (!inventory.resolveItem(name) && vehicles.isVehicleName(name)) {
    const { car, error } = cars.grant(ch, vehicles.modelOf(name));
    if (error) return reply(player, `${target.name}: ${error}`);
    const p = target.position;
    const h = (target.heading * Math.PI) / 180;
    cars.spawn(target, ch, car, new mp.Vector3(p.x - Math.sin(h) * 4, p.y + Math.cos(h) * 4, p.z + 0.5), target.heading);
    if (target !== player) target.notify(`Вам выдан транспорт: ${vehicles.modelOf(name)}`);
    return reply(player, `${target.name}: транспорт ${vehicles.modelOf(name)}`);
  }
  return reply(player, `${target.name}: ${inventory.give(target, ch, name, Number(count) || 1)}`);
}, { needsTarget: false });

adminCommand('giveclothes', '[статик] <top|legs|shoes> <номер> [цвет]', (player, args) => {
  const self = ['top', 'legs', 'shoes'].includes(args[0]);
  const target = self ? player : findPlayer(args[0]);
  const [slot, drawable, texture = '0'] = self ? args : args.slice(1);
  if (!target) return reply(player, 'Игрок не найден. Использование: /giveclothes [статик] <top|legs|shoes> <номер> [цвет]');
  const ch = roleplay.character(target);
  if (!ch || ch.guest) return reply(player, `${target.name} ещё не выбрал персонажа`);
  if (!['top', 'legs', 'shoes'].includes(slot) || !(Number(drawable) >= 0)) {
    return reply(player, 'Использование: /giveclothes [статик] <top|legs|shoes> <номер> [цвет]');
  }
  const c = { drawable: Number(drawable) | 0, texture: Number(texture) | 0 };
  if (slot === 'top') Object.assign(c, { torso: 0, undershirt: ch.gender === 'f' ? 14 : 15 });
  inventory.ensure(ch);
  const item = inventory.clothesItem(ch.gender, slot, c);
  const free = ch.inventory.pockets.indexOf(null);
  if (free < 0) return reply(player, 'Карманы заполнены');
  ch.inventory.pockets[free] = item;
  inventory.sync(target, ch);
  return reply(player, `${target.name}: выдана одежда ${item.data.label}`);
}, { needsTarget: false });

adminCommand('items', '', (player) => {
  const byType = {};
  for (const d of Object.values(inventory.ITEMS)) (byType[d.type] = byType[d.type] || []).push(d.key.replace(/^weapon_/, ''));
  for (const [type, keys] of Object.entries(byType))
    for (let i = 0; i < keys.length; i += 14) reply(player, `${i ? '  ' : `${type}: `}${keys.slice(i, i + 14).join(', ')}`);
}, { needsTarget: false });

adminCommand('slay', '<статик>', (player, target) => {
  target.health = 0;
  reply(player, `${target.name} убит`);
});

adminCommand('respawn', '<статик>', (player, target) => {
  target.spawn(target.position, target.heading);
  reply(player, `${target.name} возрождён`);
});

adminCommand('setdim', '<статик> <n>', (player, target, [dim = '0']) => {
  target.dimension = Number(dim) >>> 0;
  reply(player, `${target.name}: измерение ${target.dimension}`);
});

adminCommand('delveh', '[all]', (player, [mode]) => {
  let removed = 0;
  if (mode === 'all') {
    mp.vehicles.forEach((v) => { v.destroy(); removed++; });
  } else {
    const pos = player.position;
    let best = null;
    let bestDist = 15;
    mp.vehicles.forEach((v) => {
      if (v.dimension !== player.dimension) return;
      const d = v.position.subtract(pos).length();
      if (d < bestDist) { bestDist = d; best = v; }
    });
    if (best) { best.destroy(); removed = 1; }
  }
  reply(player, `Удалено машин: ${removed}`);
}, { needsTarget: false });

adminCommand('setmoney', '<статик> <наличные> [карта]', (player, target, [cash, bank]) => {
  const ch = roleplay.character(target);
  if (!ch) return reply(player, `${target.name} ещё не выбрал персонажа`);
  const c = Number(cash);
  const b = bank === undefined ? ch.bank : Number(bank);
  if (!Number.isFinite(c) || !Number.isFinite(b)) return reply(player, 'Использование: /setmoney <статик> <наличные> [карта]');
  roleplay.setMoney(target, c, b);
  return reply(player, `${target.name}: наличные $${ch.cash}, карта $${ch.bank}`);
});

// Fuel of the vehicle the admin sits in or stands next to (default: a full tank).
adminCommand('setfuel', '[литры]', (player, [litres]) => {
  const veh = vehicles.nearest(player, 6);
  if (!veh) return reply(player, 'Рядом нет транспорта');
  const f = vehicles.setFuel(veh, litres === undefined ? vehicles.tankOf(veh) : Number(litres) || 0);
  return reply(player, `Топливо: ${f} / ${vehicles.tankOf(veh)} л`);
}, { needsTarget: false });

adminCommand('fixveh', '', (player) => {
  const veh = vehicles.nearest(player, 6);
  if (!veh) return reply(player, 'Рядом нет транспорта');
  vehicles.repair(veh);
  return reply(player, 'Транспорт отремонтирован');
}, { needsTarget: false });

adminCommand('announce', '<текст>', (player, args, fullText) => {
  const text = (fullText || '').trim();
  if (!text) return reply(player, 'Использование: /announce <текст>');
  mp.players.broadcast(`!{#fc6}[Объявление] ${text}`);
  mp.players.forEach((p) => p.notify(`~y~Объявление~s~: ${text}`));
  return undefined;
}, { needsTarget: false });

// Houses: added at the admin's position and heading (the door), moved there, removed, taken from the owner.
// The definitions are kept in houses.json (houses.js).
adminCommand('house', 'add|move|del|free|tp|list ...', (player, [action, ...rest], fullText) => {
  const pos = player.position;
  if (action === 'add') {
    const [cls, price] = rest;
    const name = (fullText || '').split(' ').slice(3).join(' ').trim();
    const r = houses.addHouse(cls, price, name, { x: pos.x, y: pos.y, z: pos.z }, player.heading);
    return reply(player, r.error ? `!{#f66}${r.error}` : `Дом #${r.house.id} «${r.house.name}» добавлен (${r.house.cls}, ${r.house.price})`);
  }
  if (action === 'list') {
    const near = houses.list().map((h) => ({ h, d: Math.hypot(h.x - pos.x, h.y - pos.y) })).sort((a, b) => a.d - b.d).slice(0, 8);
    near.forEach(({ h, d }) => reply(player, `#${h.id} ${h.name} [${h.cls}] ${h.price} ${h.state.owner === null ? 'свободен' : `владелец ${h.state.ownerName} [${h.state.owner}]`} — ${Math.round(d)} м`));
    return undefined;
  }
  const h = houses.byId(rest[0]);
  if (!h) return reply(player, 'Использование: /house add <класс> <цена> [название] | move|del|free|tp <id> | list');
  if (action === 'move') return reply(player, houses.moveHouse(h.id, { x: pos.x, y: pos.y, z: pos.z }, player.heading) ? `Дверь дома #${h.id} перенесена сюда` : 'Ошибка');
  if (action === 'del') return reply(player, houses.removeHouse(h.id) ? `Дом #${h.id} удалён` : 'Ошибка');
  if (action === 'free') return reply(player, houses.evict(h.id) ? `Дом #${h.id} освобождён` : 'Ошибка');
  if (action === 'garage') {
    if (rest[1] === 'off') return reply(player, houses.setGaragePoint(h.id, null) ? `Въезд в гараж дома #${h.id} убран` : 'Ошибка');
    const at = houses.standPoint(player);
    return reply(player, houses.setGaragePoint(h.id, at, at.heading) ? `Въезд в гараж дома #${h.id}: ${at.x}, ${at.y}, ${at.z}, угол ${at.heading}` : 'Ошибка');
  }
  if (action === 'tp') {
    player.dimension = 0;
    player.position = new mp.Vector3(h.x, h.y, h.z);
    return undefined;
  }
  return reply(player, 'Использование: /house add|move|del|free|tp|list|garage');
}, { needsTarget: false });

// The interior of the house the admin stands in: where players appear, and the exit.
adminCommand('interior', 'spawn|exit', (player, [action]) => {
  if (action !== 'spawn' && action !== 'exit') return reply(player, 'Использование: /interior spawn|exit (стоя внутри дома)');
  const r = houses.setInteriorPoint(player, action);
  if (r.error) return reply(player, `!{#f66}${r.error}`);
  const at = r.pos.join(', ');
  return reply(player, action === 'spawn' ? `Интерьер «${r.id}»: вход — ${at}, угол ${r.heading}` : `Интерьер «${r.id}»: выход — ${at}`);
}, { needsTarget: false });

// The garage the admin stands in: where players appear, the exit, and the places of the cars.
adminCommand('garage', 'spawn|exit|slot <n>', (player, [action, n]) => {
  if (!['spawn', 'exit', 'slot'].includes(action)) return reply(player, 'Использование: /garage spawn|exit|slot <n> (стоя внутри гаража)');
  const r = houses.setGarageTemplatePoint(player, action, action === 'slot' ? Number(n) : null);
  if (r.error) return reply(player, `!{#f66}${r.error}`);
  const at = r.pos.join(', ');
  if (action === 'spawn') return reply(player, `Гараж «${r.id}»: появление — ${at}, угол ${r.heading}`);
  if (action === 'exit') return reply(player, `Гараж «${r.id}»: выход — ${at}`);
  return reply(player, `Гараж «${r.id}»: место ${r.slot} — ${at}, угол ${r.heading}`);
}, { needsTarget: false });

// Custom maps (maps.js, made in GoMP Studio).
adminCommand('maps', '[reload [имя] | on|off <имя>]', (player, [action, name]) => {
  if (action === 'reload') {
    if (name) maps.load(name);
    else maps.loadAll();
  } else if (action === 'on' || action === 'off') {
    if (!name || !maps.setEnabled(name, action === 'on')) return reply(player, `Нет карты ${name || ''}`);
  }
  const all = maps.list();
  if (!all.length) return reply(player, `Карт нет (папка ${maps.MAPS_DIR})`);
  all.forEach((m) => reply(player, `${m.name}: ${m.objects} объектов${m.enabled ? '' : ', выключена'}${m.error ? `, ошибка: ${m.error}` : ''}`));
  return undefined;
}, { needsTarget: false });

adminCommand('mapcursor', '', (player) => {
  const c = maps.writeCursor(player);
  return reply(player, `Позиция для GoMP Studio: ${c.x.toFixed(1)} ${c.y.toFixed(1)} ${c.z.toFixed(1)}`);
}, { needsTarget: false });


// ------------------------------------------------------------------ organizations

adminCommand('makeleader', '<статик> <lspd|army|ems|gov|none>', (player, target, [org]) => {
  const ts = target.getVariable('static');
  if (ts === null || ts === undefined) return reply(player, `${target.name} ещё не выбрал персонажа`);
  const id = String(org || '').toLowerCase();
  if (id === 'none') {
    const m = orgs.membership(ts);
    if (!m || !m.leader) return reply(player, `${target.name} не лидер`);
    orgs.makeLeader(null, m.id);
    target.notify(`~o~Вы больше не лидер ${m.def.name}`);
    return reply(player, `${target.name} снят с лидерства ${m.def.name}`);
  }
  if (!orgs.defs.has(id)) return reply(player, `Организации: ${[...orgs.defs.keys()].join(', ')}, none`);
  orgs.makeLeader(ts, id);
  target.notify(`Вы назначены лидером ~b~${orgs.defs.get(id).name}`);
  return reply(player, `${target.name} — лидер ${orgs.defs.get(id).name}`);
});

adminCommand('setorg', '<статик> <lspd|army|ems|gov|none> [ранг]', (player, target, [org, rank]) => {
  const ts = target.getVariable('static');
  if (ts === null || ts === undefined) return reply(player, `${target.name} ещё не выбрал персонажа`);
  const id = String(org || '').toLowerCase();
  if (id === 'none') {
    orgs.leave(ts);
    return reply(player, `${target.name} больше не состоит в организации`);
  }
  if (!orgs.defs.has(id)) return reply(player, `Организации: ${[...orgs.defs.keys()].join(', ')}, none`);
  const top = orgs.topRank(id);
  const r = Math.max(1, Math.min(top - 1, Math.floor(Number(rank)) || 1));
  orgs.join(ts, id, r);
  target.notify(`Вы приняты в ~b~${orgs.defs.get(id).name}~s~ (ранг ${r})`);
  return reply(player, `${target.name}: ${orgs.defs.get(id).name}, ранг ${r}`);
});

// ------------------------------------------------------------------ admin tools

// Invisible: others do not see the admin, his name or his blip; he sees himself faded.
adminCommand('invis', '', (player) => {
  const on = !player.getVariable('invisible');
  player.alpha = on ? 0 : 255;
  player.setVariable('invisible', on);
  return reply(player, on ? 'Вы невидимы' : 'Вы снова видимы');
}, { needsTarget: false });

// Flight through walls (the client moves the ped: W/S/A/D, Space up, Ctrl down, Shift faster);
// the movement checks of the core are off meanwhile.
adminCommand('fly', '', (player) => {
  const on = !player.getVariable('fly');
  player.setVariable('fly', on);
  player.anticheat = !on;
  return reply(player, on ? 'Полёт включён: W/S/A/D, пробел — вверх, Ctrl — вниз, Shift — быстрее. /fly — выключить' : 'Полёт выключен');
}, { needsTarget: false });

// Teleport to the waypoint of the map: the client asks to be moved high above it, then,
// once the ground there has streamed in, onto it (several moves within the time allowed).
const TPM_WINDOW_MS = 20000;
const tpmAsked = new Map();  // player.id -> time /tpm was typed

adminCommand('tpm', '', (player) => {
  tpmAsked.set(player.id, Date.now());
  player.call('gomp:admin:tpm', []);
}, { needsTarget: false });

mp.events.add('gomp:admin:tpm:go', (player, x, y, z) => {
  const asked = tpmAsked.get(player.id);
  if (!isAdmin(player) || !asked || Date.now() - asked > TPM_WINDOW_MS) return;
  const p = [Number(x), Number(y), Number(z)];
  if (!p.every(Number.isFinite) || Math.abs(p[0]) > 10000 || Math.abs(p[1]) > 10000 || p[2] < -200 || p[2] > 2000) return;
  const to = new mp.Vector3(p[0], p[1], p[2]);
  player.dimension = 0;
  if (player.vehicle && player.seat === 0) player.vehicle.position = to;
  else player.position = to;
  reply(player, `Телепорт к метке: ${p.map((v) => v.toFixed(1)).join(' ')}`);
});

mp.events.add('gomp:admin:tpm:none', (player) => {
  if (tpmAsked.delete(player.id)) reply(player, 'Поставьте метку на карте (Esc → Карта → ПКМ)');
});

mp.events.add('playerQuit', (player) => tpmAsked.delete(player.id));

module.exports = { isAdmin };
