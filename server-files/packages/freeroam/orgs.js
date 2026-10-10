// Organizations (LSPD, Army, EMS, GOV): members with ranks, a base in a real
// interior of the map (walked into: no teleport, no other dimension), a shared
// storage at the base and work vehicles parked next to it.
//
// The definitions (bases, doors, storage points, vehicles, default rank names)
// are in server-files/organizations.json; members, rank settings and the storage
// are kept in the database (table "orgs", per organization id).
//
// Ranks are 1..N; N is the leader's (set by an admin: /makeleader). Each rank has
// a name and permissions; the leader has every permission and edits the others
// in the F2 menu (Организация):
//   invite   — /invite a player            uninvite — /uninvite a member of a lower rank
//   setrank  — /setrank below one's own     storage  — take things from the storage
//   vehicles — unlock the work vehicles
// Every member puts things into the storage.
//
// Commands: /invite <static>, /uninvite <static>, /setrank <static> <rank>, /org;
// admin: /makeleader <static> <org|none>, /setorg <static> <org|none> [rank].
//
// Client protocol:
//   server -> client  gomp:orgs [{id, name, color, base: {name, center, radius, interior, storage, doors}}]   bases (doors to unlock)
//                     gomp:org {id, name, full, rank, rankName, leader, perms, ranks: [{name, perms}],
//                               members: [{static, name, rank, online}], permNames} | null
//   client -> server  gomp:org:get
//                     gomp:org:rank index, name, perms          the leader edits rank index+1 (not his own)
//                     gomp:org:setrank static, rank
//                     gomp:org:kick static
//                     gomp:org:storage                          open the storage (at the base)
// Own variables of a member: org, orgName, orgRank, orgRankName, orgLeader.

const fs = require('fs');
const path = require('path');
const accounts = require('./accounts');
const roleplay = require('./roleplay');
const vehicles = require('./vehicles');
const inventory = require('./inventory');
const prompt = require('./prompt');

const FILE = process.env.GOMP_ORGS_FILE || path.join(__dirname, '..', '..', 'organizations.json');
const PERMS = ['invite', 'uninvite', 'setrank', 'storage', 'vehicles'];
const PERM_NAMES = { invite: 'Приглашать', uninvite: 'Увольнять', setrank: 'Менять ранги', storage: 'Брать со склада', vehicles: 'Рабочий транспорт' };
const STORAGE_SLOTS = 60;
const STORAGE_RANGE = 2.5;
const INVITE_RANGE = 10;
const RESPAWN_IDLE_MS = 10 * 60 * 1000;  // a work vehicle left away from its place goes back after this
const RESPAWN_DEAD_MS = 30 * 1000;       // a wrecked one is replaced after this

const defs = new Map();     // id -> definition
const byStatic = new Map(); // static -> org id
const fleet = [];           // { org, index, spot, veh, usedAt, deadAt }

// ------------------------------------------------------------------ definitions and state

function validate(doc) {
  if (!doc || doc.format !== 'gomp-orgs' || doc.version !== 1 || !Array.isArray(doc.orgs)) return { error: 'не файл организаций (format gomp-orgs, version 1)' };
  const point = (p) => Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every(Number.isFinite);
  const out = [];
  for (const o of doc.orgs) {
    if (!o || !/^[a-z][a-z0-9_]{1,15}$/.test(String(o.id)) || !o.base || !point(o.base.center) || !point(o.base.storage)) continue;
    const ranks = (Array.isArray(o.ranks) ? o.ranks : []).map(String).filter(Boolean).slice(0, 15);
    if (ranks.length < 2) continue;
    out.push({
      id: o.id, name: String(o.name || o.id), full: String(o.full || o.name || o.id),
      color: Array.isArray(o.color) ? o.color.slice(0, 3) : [255, 255, 255], blip: o.blip || null,
      base: {
        name: String(o.base.name || ''), center: o.base.center.slice(0, 3), radius: Number(o.base.radius) || 60,
        interior: point(o.base.interior) ? o.base.interior.slice(0, 3) : null, storage: o.base.storage.slice(0, 3),
        doors: (Array.isArray(o.base.doors) ? o.base.doors : []).filter((d) => d && d.model && point(d.pos)),
      },
      vehicles: (Array.isArray(o.vehicles) ? o.vehicles : []).filter((v) => v && v.model && point(v.pos)),
      ranks,
    });
  }
  return { orgs: out };
}

function load() {
  try {
    const r = validate(JSON.parse(fs.readFileSync(FILE, 'utf8')));
    if (r.error) return console.log(`[orgs] ${FILE}: ${r.error}`);
    defs.clear();
    for (const d of r.orgs) defs.set(d.id, d);
    return console.log(`[orgs] ${defs.size} organizations`);
  } catch (err) {
    return console.log(`[orgs] ${FILE}: ${err.message}`);
  }
}

// Default permissions of rank r of n: the top ranks run the organization.
function defaultPerms(r, n) {
  return { invite: r >= n - 2, uninvite: r >= n - 2, setrank: r >= n - 1, storage: r >= Math.min(3, n - 1), vehicles: true };
}

const db = () => accounts.table('orgs');

// The kept state of an organization (created with the defaults on first use; new ranks of the file appended).
function stateOf(id) {
  const t = db();
  const d = defs.get(id);
  if (!t[id]) t[id] = { leader: null, members: {}, ranks: [], storage: [] };
  const s = t[id];
  if (!s.members) s.members = {};
  if (!Array.isArray(s.ranks)) s.ranks = [];
  if (d) {
    const n = d.ranks.length;
    for (let i = s.ranks.length; i < n; i++) s.ranks.push({ name: d.ranks[i], perms: defaultPerms(i + 1, n) });
    s.ranks.length = n;
  }
  if (!Array.isArray(s.storage)) s.storage = [];
  while (s.storage.length < STORAGE_SLOTS) s.storage.push(null);
  return s;
}

function index() {
  byStatic.clear();
  for (const id of defs.keys()) {
    const s = stateOf(id);
    for (const st of Object.keys(s.members)) byStatic.set(Number(st), id);
  }
}

const topRank = (id) => defs.get(id).ranks.length;

// {id, def, state, rank, leader} of a character's organization, or null.
function membership(statik) {
  const id = byStatic.get(Number(statik));
  if (!id || !defs.has(id)) return null;
  const state = stateOf(id);
  const m = state.members[statik];
  if (!m) return null;
  return { id, def: defs.get(id), state, rank: m.rank, leader: state.leader === Number(statik) };
}

function can(statik, perm) {
  const m = membership(statik);
  if (!m) return false;
  if (m.leader) return true;
  const r = m.state.ranks[m.rank - 1];
  return !!(r && r.perms && r.perms[perm]);
}

// ------------------------------------------------------------------ members

const online = (statik) => roleplay.findByStatic(statik);

// The own variables of a member's player (cleared for one who left the organization).
function refresh(statik) {
  const p = online(statik);
  if (!p) return;
  const m = membership(statik);
  p.setOwnVariables(m
    ? { org: m.id, orgName: m.def.name, orgRank: m.rank, orgRankName: m.state.ranks[m.rank - 1].name, orgLeader: m.leader }
    : { org: null, orgName: null, orgRank: null, orgRankName: null, orgLeader: null });
}

function nameOf(statik) {
  const ch = accounts.characterByStatic(statik);
  return ch ? `${ch.first} ${ch.last}` : `#${statik}`;
}

function join(statik, id, rank = 1) {
  leave(statik);
  const s = stateOf(id);
  s.members[statik] = { rank: Math.max(1, Math.min(topRank(id), rank)), name: nameOf(statik), joined: Date.now() };
  byStatic.set(Number(statik), id);
  accounts.save();
  refresh(statik);
}

function leave(statik) {
  const id = byStatic.get(Number(statik));
  if (!id) return;
  const s = stateOf(id);
  delete s.members[statik];
  if (s.leader === Number(statik)) s.leader = null;
  byStatic.delete(Number(statik));
  accounts.save();
  refresh(statik);
}

function setRank(statik, rank) {
  const m = membership(statik);
  if (!m) return;
  m.state.members[statik].rank = rank;
  accounts.save();
  refresh(statik);
}

// Leader of an organization (null: none). The old leader stays, a rank lower.
function makeLeader(statik, id) {
  const s = stateOf(id);
  const old = s.leader;
  if (old !== null && old !== Number(statik) && s.members[old]) {
    s.members[old].rank = topRank(id) - 1;
    s.leader = null;
    refresh(old);
  }
  if (statik === null) {
    accounts.save();
    return;
  }
  if (byStatic.get(Number(statik)) !== id) join(statik, id, topRank(id));
  s.members[statik].rank = topRank(id);
  s.leader = Number(statik);
  accounts.save();
  refresh(statik);
}

// Rules shared by the commands and the F2 menu: null when allowed, else the reason.
function checkSetRank(actor, target, rank) {
  const a = membership(actor);
  if (!a || !can(actor, 'setrank')) return 'Нет доступа: менять ранги';
  const t = membership(target);
  if (!t || t.id !== a.id) return 'Игрок не в вашей организации';
  if (Number(actor) === Number(target)) return 'Нельзя менять свой ранг';
  const top = topRank(a.id);
  if (!(Number.isInteger(rank) && rank >= 1 && rank < top)) return `Ранг от 1 до ${top - 1} (${top} — лидер)`;
  if (!a.leader && (t.rank >= a.rank || rank >= a.rank)) return 'Только ниже вашего ранга';
  return null;
}

function checkKick(actor, target) {
  const a = membership(actor);
  if (!a || !can(actor, 'uninvite')) return 'Нет доступа: увольнять';
  const t = membership(target);
  if (!t || t.id !== a.id) return 'Игрок не в вашей организации';
  if (Number(actor) === Number(target)) return 'Нельзя уволить себя';
  if (t.leader) return 'Лидера снимает администратор';
  if (!a.leader && t.rank >= a.rank) return 'Только ниже вашего ранга';
  return null;
}

// ------------------------------------------------------------------ F2 menu

function view(statik) {
  const m = membership(statik);
  if (!m) return null;
  const perms = Object.fromEntries(PERMS.map((p) => [p, can(statik, p)]));
  const members = Object.entries(m.state.members)
    .map(([st, x]) => ({ static: Number(st), name: x.name || nameOf(st), rank: x.rank, online: !!online(st) }))
    .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  return {
    id: m.id, name: m.def.name, full: m.def.full, rank: m.rank, rankName: m.state.ranks[m.rank - 1].name, leader: m.leader,
    perms, ranks: m.state.ranks.map((r) => ({ name: r.name, perms: { ...r.perms } })), members, permNames: PERM_NAMES,
  };
}

function sendView(player) {
  player.call('gomp:org', [view(player.getVariable('static'))]);
}

const withCharacter = (fn) => (player, ...args) => {
  const ch = roleplay.character(player);
  if (!ch || ch.guest) return undefined;
  return fn(player, ch, ...args);
};

mp.events.add('gomp:org:get', withCharacter((player) => sendView(player)));

mp.events.add('gomp:org:rank', withCharacter((player, ch, index, name, perms) => {
  const m = membership(ch.static);
  if (!m || !m.leader) return player.notify('~r~Ранги настраивает лидер');
  const i = Math.floor(Number(index));
  if (!(i >= 0 && i < m.state.ranks.length - 1)) return player.notify('~r~Ранг лидера не меняется');
  const r = m.state.ranks[i];
  const n = String(name || '').trim().slice(0, 32);
  if (n) r.name = n;
  if (perms && typeof perms === 'object') for (const p of PERMS) if (p in perms) r.perms[p] = !!perms[p];
  accounts.save();
  Object.keys(m.state.members).forEach((st) => refresh(Number(st)));
  return sendView(player);
}));

mp.events.add('gomp:org:setrank', withCharacter((player, ch, target, rank) => {
  const err = checkSetRank(ch.static, Number(target), Math.floor(Number(rank)));
  if (err) return player.notify(`~r~${err}`);
  setRank(Number(target), Math.floor(Number(rank)));
  const p = online(target);
  if (p) p.notify(`Ваш ранг в ${membership(target).def.name}: ~b~${membership(target).state.ranks[Math.floor(Number(rank)) - 1].name}`);
  return sendView(player);
}));

mp.events.add('gomp:org:kick', withCharacter((player, ch, target) => {
  const err = checkKick(ch.static, Number(target));
  if (err) return player.notify(`~r~${err}`);
  const orgName = membership(target).def.name;
  leave(Number(target));
  const p = online(target);
  if (p) p.notify(`~o~Вас уволили из ${orgName}`);
  return sendView(player);
}));

// ------------------------------------------------------------------ storage

const near = (player, [x, y, z], r) => player.dimension === 0 && Math.hypot(player.position.x - x, player.position.y - y, player.position.z - z) <= r;

function openStorage(player, ch) {
  const m = membership(ch.static);
  if (!m) return player.notify('~r~Склад только для сотрудников');
  if (!near(player, m.def.base.storage, STORAGE_RANGE)) return player.notify('~r~Подойдите к складу');
  const statik = ch.static;
  return inventory.openExternal(player, ch, {
    title: `Склад ${m.def.name}`,
    slots: m.state.storage,
    canTake: () => can(statik, 'storage'),
    canPut: () => byStatic.get(statik) === m.id,
    check: () => byStatic.get(statik) === m.id && mp.players.exists(player) && near(player, m.def.base.storage, STORAGE_RANGE + 1),
    onChange: () => accounts.save(),
  });
}

mp.events.add('gomp:org:storage', withCharacter((player, ch) => openStorage(player, ch)));

// ------------------------------------------------------------------ commands

function command(name, fn) {
  mp.events.addCommand(name, (player, full, ...args) => {
    const ch = roleplay.character(player);
    if (!ch || ch.guest) return player.outputChatBox('!{#f66}Сначала войдите и выберите персонажа');
    return fn(player, ch, ...args);
  });
}

command('invite', (player, ch, target) => {
  const m = membership(ch.static);
  if (!m) return player.outputChatBox('!{#f66}Вы не состоите в организации');
  if (!can(ch.static, 'invite')) return player.outputChatBox('!{#f66}Нет доступа: приглашать');
  const p = roleplay.findByStatic(target);
  if (!p || p === player || !roleplay.isLogged(p)) return player.outputChatBox('Использование: /invite <статик> (игрок в сети)');
  if (p.position.subtract(player.position).length() > INVITE_RANGE) return player.outputChatBox('!{#f66}Игрок слишком далеко');
  const ts = p.getVariable('static');
  if (membership(ts)) return player.outputChatBox('!{#f66}Игрок уже состоит в организации');
  player.outputChatBox(`Приглашение отправлено: ${p.name}`);
  return prompt.ask(p, {
    title: `Приглашение в ${m.def.name}`,
    text: `${player.name} приглашает вас в ${m.def.full} на ранг «${m.state.ranks[0].name}»`,
    options: ['Принять', 'Отказаться'],
  }, (answer) => {
    if (answer !== 0) {
      if (mp.players.exists(player)) player.notify(`${p.name || 'Игрок'} отказался от приглашения`);
      return;
    }
    if (membership(ts)) return;
    join(ts, m.id, 1);
    if (mp.players.exists(p)) p.notify(`Добро пожаловать в ~b~${m.def.name}~s~!`);
    if (mp.players.exists(player)) player.notify(`${p.name} вступил в ${m.def.name}`);
  });
});

command('uninvite', (player, ch, target) => {
  const t = Number(target);
  const err = checkKick(ch.static, t);
  if (err) return player.outputChatBox(`!{#f66}${err}. Использование: /uninvite <статик>`);
  const orgName = membership(t).def.name;
  leave(t);
  const p = online(t);
  if (p) p.notify(`~o~Вас уволили из ${orgName}`);
  return player.outputChatBox(`${nameOf(t)} уволен из ${orgName}`);
});

command('setrank', (player, ch, target, rank) => {
  const t = Number(target);
  const r = Math.floor(Number(rank));
  const err = checkSetRank(ch.static, t, r);
  if (err) return player.outputChatBox(`!{#f66}${err}. Использование: /setrank <статик> <ранг>`);
  setRank(t, r);
  const m = membership(t);
  const p = online(t);
  if (p) p.notify(`Ваш ранг в ${m.def.name}: ~b~${m.state.ranks[r - 1].name}`);
  return player.outputChatBox(`${nameOf(t)}: ранг ${r} (${m.state.ranks[r - 1].name})`);
});

command('org', (player, ch) => {
  const m = membership(ch.static);
  if (!m) return player.outputChatBox('Вы не состоите в организации. Организации: ' + [...defs.values()].map((d) => d.name).join(', '));
  const on = Object.keys(m.state.members).filter((st) => online(st));
  player.outputChatBox(`!{#8ef}${m.def.full}: ваш ранг ${m.rank} «${m.state.ranks[m.rank - 1].name}»${m.leader ? ' (лидер)' : ''}`);
  return player.outputChatBox(`В сети (${on.length}): ${on.map((st) => `${nameOf(st)} [${st}] — ${m.state.ranks[m.state.members[st].rank - 1].name}`).join(', ')}`);
});

// ------------------------------------------------------------------ work vehicles

function spawnFleet(slot) {
  const d = defs.get(slot.org);
  const v = slot.spot;
  const veh = mp.vehicles.new(mp.joaat(v.model), new mp.Vector3(v.pos[0], v.pos[1], v.pos[2]), {
    heading: Number(v.heading) || 0, numberPlate: `${d.name.slice(0, 4).toUpperCase()}${String(slot.index + 1).padStart(3, '0')}`,
    dimension: 0, engine: false, locked: true,
  });
  vehicles.setup(veh, null);
  veh.setVariable('org', slot.org);
  if (Number.isInteger(v.color)) veh.setColor(v.color, v.color);
  slot.veh = veh;
  slot.usedAt = Date.now();
  slot.deadAt = 0;
}

// Members with the "vehicles" permission lock and unlock their organization's vehicles.
vehicles.lockRules.push((player, veh) => {
  const org = veh.getVariable('org');
  return !!org && byStatic.get(player.getVariable('static')) === org && can(player.getVariable('static'), 'vehicles');
});

// Wrecked vehicles are replaced, abandoned ones go back to their place.
function tickFleet(now = Date.now()) {
  for (const slot of fleet) {
    const veh = slot.veh;
    if (!veh || !mp.vehicles.exists(veh)) {
      spawnFleet(slot);
      continue;
    }
    if (veh.getOccupants().length) {
      slot.usedAt = now;
      continue;
    }
    if (veh.dead) {
      if (!slot.deadAt) slot.deadAt = now;
      if (now - slot.deadAt < RESPAWN_DEAD_MS) continue;
    } else {
      const [x, y, z] = slot.spot.pos;
      const away = Math.hypot(veh.position.x - x, veh.position.y - y, veh.position.z - z) > 5;
      if (!away || now - slot.usedAt < RESPAWN_IDLE_MS) continue;
    }
    veh.destroy();
    spawnFleet(slot);
  }
}

// ------------------------------------------------------------------ start

function sendBases(player) {
  player.call('gomp:orgs', [[...defs.values()].map((d) => ({ id: d.id, name: d.name, color: d.color, base: d.base }))]);
}

roleplay.onSpawn.push((player, ch) => {
  sendBases(player);
  const m = membership(ch.static);
  if (m && m.state.members[ch.static]) m.state.members[ch.static].name = `${ch.first} ${ch.last}`;
  refresh(ch.static);
});

load();
index();
for (const d of defs.values()) {
  d.vehicles.forEach((spot, i) => fleet.push({ org: d.id, index: i, spot, veh: null, usedAt: 0, deadAt: 0 }));
  if (d.blip) mp.blips.new(Number(d.blip.sprite) || 1, new mp.Vector3(...d.base.center), { name: `${d.name} — ${d.base.name}`, color: Number(d.blip.color) || 0, scale: 0.9, shortRange: true, dimension: 0 });
}
fleet.forEach(spawnFleet);
setInterval(() => tickFleet(), 30000);

module.exports = {
  FILE, PERMS, defs, fleet, validate, load, stateOf, membership, can, join, leave, setRank, makeLeader,
  checkSetRank, checkKick, view, openStorage, tickFleet, refresh, topRank,
};
