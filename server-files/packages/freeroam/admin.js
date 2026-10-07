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

// Finds a player by id or by a (case-insensitive) part of the name.
function findPlayer(query) {
  if (query === undefined) return null;
  const id = Number(query);
  if (Number.isInteger(id) && mp.players.at(id)) return mp.players.at(id);
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
  reply(player, 'players, kick <id> [причина], ban <id> [причина], goto <id>, bring <id>');
  reply(player, 'sethp <id> <hp>, setarmour <id> <n>, give <id> <оружие> [патроны], slay <id>, respawn <id>');
  reply(player, 'setdim <id> <n>, setmoney <id> <нал> [карта], delveh [all], announce <текст>');
}, { needsTarget: false });

adminCommand('players', '', (player) => {
  reply(player, `Игроков: ${mp.players.length}`);
  mp.players.forEach((p) => {
    const pos = p.position;
    reply(player, `#${p.id} ${p.name} [static ${p.getVariable('static') ?? '-'}]  hp ${p.health}  dim ${p.dimension}  ping ${p.ping}  ` +
      `${pos.x.toFixed(0)} ${pos.y.toFixed(0)} ${pos.z.toFixed(0)}${isAdmin(p) ? '  [admin]' : ''}`);
  });
}, { needsTarget: false });

adminCommand('kick', '<id> [причина]', (player, target, _, fullText) => {
  const reason = restOf(fullText, 1) || 'kicked by admin';
  mp.players.broadcast(`!{#f96}${target.name} кикнут: ${reason}`);
  target.kick(reason);
});

adminCommand('ban', '<id> [причина]', (player, target, _, fullText) => {
  const reason = restOf(fullText, 1) || 'banned by admin';
  mp.players.broadcast(`!{#f66}${target.name} забанен: ${reason}`);
  target.ban(reason);
});

adminCommand('goto', '<id>', (player, target) => {
  const p = target.position;
  player.dimension = target.dimension;
  player.position = new mp.Vector3(p.x + 1, p.y, p.z);
  reply(player, `Телепорт к ${target.name}`);
});

adminCommand('bring', '<id>', (player, target) => {
  const p = player.position;
  target.dimension = player.dimension;
  target.position = new mp.Vector3(p.x + 1, p.y, p.z);
  reply(player, `${target.name} перемещён к вам`);
});

adminCommand('sethp', '<id> <hp>', (player, target, [hp]) => {
  const v = Math.max(0, Math.min(100, Number(hp)));
  if (Number.isNaN(v)) return reply(player, 'Использование: /sethp <id> <0..100>');
  target.health = v;
  return reply(player, `${target.name}: здоровье ${v}`);
});

adminCommand('setarmour', '<id> <n>', (player, target, [n]) => {
  const v = Math.max(0, Math.min(100, Number(n)));
  if (Number.isNaN(v)) return reply(player, 'Использование: /setarmour <id> <0..100>');
  target.armour = v;
  return reply(player, `${target.name}: броня ${v}`);
});

adminCommand('give', '<id> <оружие> [патроны]', (player, target, [weapon = 'pistol', ammo = '250']) => {
  const name = weapon.startsWith('weapon_') ? weapon : `weapon_${weapon}`;
  target.giveWeapon(mp.joaat(name), Number(ammo) || 250);
  reply(player, `${target.name}: выдано ${name}`);
});

adminCommand('slay', '<id>', (player, target) => {
  target.health = 0;
  reply(player, `${target.name} убит`);
});

adminCommand('respawn', '<id>', (player, target) => {
  target.spawn(target.position, target.heading);
  reply(player, `${target.name} возрождён`);
});

adminCommand('setdim', '<id> <n>', (player, target, [dim = '0']) => {
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

adminCommand('setmoney', '<id> <наличные> [карта]', (player, target, [cash, bank]) => {
  const ch = roleplay.character(target);
  if (!ch) return reply(player, `${target.name} ещё не выбрал персонажа`);
  const c = Number(cash);
  const b = bank === undefined ? ch.bank : Number(bank);
  if (!Number.isFinite(c) || !Number.isFinite(b)) return reply(player, 'Использование: /setmoney <id> <наличные> [карта]');
  roleplay.setMoney(target, c, b);
  return reply(player, `${target.name}: наличные $${ch.cash}, карта $${ch.bank}`);
});

adminCommand('announce', '<текст>', (player, args, fullText) => {
  const text = (fullText || '').trim();
  if (!text) return reply(player, 'Использование: /announce <текст>');
  mp.players.broadcast(`!{#fc6}[Объявление] ${text}`);
  mp.players.forEach((p) => p.notify(`~y~Объявление~s~: ${text}`));
  return undefined;
}, { needsTarget: false });

module.exports = { isAdmin };
