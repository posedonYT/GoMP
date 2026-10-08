// Login / registration, character selection and creation, money and HUD data.
//
// Client protocol (GoMP game client screens, see client/game/screens.cpp):
//   server -> client  gomp:auth:show {error?}         login screen
//                     gomp:chars:show [chars], max    character list (creator if empty)
//                     gomp:creator:error message
//                     gomp:ui:close                   back to the game
//                     gomp:hud:online count
//   client -> server  gomp:auth:login login, password
//                     gomp:auth:register login, password
//                     gomp:chars:select id
//                     gomp:chars:create {first, last, gender, kit, appearance}
// Shared variables: static (everyone), own: cash, bank.

const accounts = require('./accounts');
const inventory = require('./inventory');
const vehicles = require('./vehicles');
const drops = require('./drops');

const LOBBY = new mp.Vector3(-425.5, 1123.6, 325.85);  // Galileo Observatory
const MAX_LOGIN_ATTEMPTS = 5;
const spawnPoints = [
  new mp.Vector3(-425.517, 1123.620, 325.854),
  new mp.Vector3(-1037.4, -2737.7, 20.17),
  new mp.Vector3(215.8, -810.1, 30.73),
  new mp.Vector3(-1388.8, -586.6, 30.21),
];

// Per-player session state (not replicated).
const sessions = new Map();
const session = (player) => {
  if (!sessions.has(player.id)) sessions.set(player.id, { account: null, character: null, attempts: 0 });
  return sessions.get(player.id);
};

function randomSpawn() {
  return spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
}

function isLogged(player) {
  return !!(sessions.get(player.id) || {}).character;
}

function character(player) {
  return (sessions.get(player.id) || {}).character || null;
}

function broadcastOnline() {
  const n = mp.players.length;
  mp.players.forEach((p) => p.call('gomp:hud:online', [n]));
}

function charSummary(c) {
  return { id: c.id, static: c.static, first: c.first, last: c.last, gender: c.gender, cash: c.cash, bank: c.bank };
}

function showCharacters(player) {
  const s = session(player);
  const list = accounts.charactersOf(s.account).map(charSummary);
  player.call('gomp:chars:show', [list, accounts.MAX_CHARACTERS]);
}

// ------------------------------------------------------------------ lobby

function enterLobby(player) {
  // A private dimension: nobody sees the player until a character is chosen.
  player.dimension = 100000 + player.id;
  player.removeAllWeapons();
  player.position = LOBBY;
  player.call('gomp:auth:show', [{}]);
  require('./houses').send(player);
}

mp.events.add('playerJoin', (player) => {
  session(player);
  broadcastOnline();
});

// Headless test bots (tools/bot, tools/stress) from this machine cannot log in:
// they play as temporary guest characters that are never saved.
function isLocalBot(player) {
  return /^(cli|stress)-/.test(player.serial) && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(player.ip);
}

function spawnGuest(player) {
  const ch = {
    id: 0, static: 90000 + player.id, first: 'Bot', last: String(player.id), gender: 'm', cash: 0, bank: 0,
    weapons: {}, armour: 0, vehicle: null, pos: null, guest: true,
    appearance: { father: 0, mother: 21, shapeMix: 0.5, skinMix: 0.5, hair: 0, hairColor: 0, eyeColor: 0, brows: 0,
      beard: -1, top: 0, topTex: 0, torso: 0, undershirt: 15, legs: 0, shoes: 1 },
  };
  session(player).character = ch;
  player.setVariable('static', ch.static);
  applyAppearance(player, ch);
  player.dimension = 0;
  player.spawn(randomSpawn(), 0);
  require('./houses').send(player);
  broadcastOnline();
}

mp.events.add('playerReady', (player) => (isLocalBot(player) ? spawnGuest(player) : enterLobby(player)));

mp.events.add('gomp:auth:login', (player, login, password) => {
  const s = session(player);
  if (s.account) return;
  const r = accounts.login(login, password);
  if (r.error) {
    s.attempts++;
    console.log(`[auth] failed login "${login}" by ${player.ip} (${s.attempts})`);
    if (s.attempts >= MAX_LOGIN_ATTEMPTS) return player.kick('Слишком много неудачных попыток входа');
    return player.call('gomp:auth:show', [{ error: r.error, login: String(login || '') }]);
  }
  s.account = r.account;
  console.log(`[auth] ${r.account.login} logged in from ${player.ip}`);
  return showCharacters(player);
});

mp.events.add('gomp:auth:register', (player, login, password) => {
  const s = session(player);
  if (s.account) return;
  const r = accounts.register(login, password);
  if (r.error) return player.call('gomp:auth:show', [{ error: r.error, login: String(login || ''), register: true }]);
  s.account = r.account;
  console.log(`[auth] new account ${r.account.login} from ${player.ip}`);
  return showCharacters(player);
});

mp.events.add('gomp:chars:select', (player, id) => {
  const s = session(player);
  if (!s.account || s.character) return;
  const ch = accounts.getCharacter(s.account, id);
  if (ch) spawnCharacter(player, ch);
});

mp.events.add('gomp:chars:create', (player, data) => {
  const s = session(player);
  if (!s.account || s.character) return;
  const r = accounts.createCharacter(s.account, data || {});
  if (r.error) return player.call('gomp:creator:error', [r.error]);
  console.log(`[chars] ${s.account.login} created ${r.character.first} ${r.character.last} (static ${r.character.static})`);
  return spawnCharacter(player, r.character, true);
});

// ------------------------------------------------------------------ spawn

const CLOTHES = { hair: 2, torso: 3, legs: 4, shoes: 6, undershirt: 8, top: 11 };

function applyAppearance(player, ch) {
  const a = ch.appearance;
  player.model = mp.joaat(ch.gender === 'f' ? 'mp_f_freemode_01' : 'mp_m_freemode_01');
  player.setHeadBlend(a.father, a.mother, 0, a.father, a.mother, 0, a.shapeMix, a.skinMix, 0);
  player.setClothes(CLOTHES.hair, a.hair, 0, 0);
  player.setClothes(CLOTHES.torso, a.torso, 0, 0);
  player.setClothes(CLOTHES.legs, a.legs, a.legsTex || 0, 0);
  player.setClothes(CLOTHES.shoes, a.shoes, a.shoesTex || 0, 0);
  player.setClothes(CLOTHES.undershirt, a.undershirt, 0, 0);
  player.setClothes(CLOTHES.top, a.top, a.topTex, 0);
  player.setHairColor(a.hairColor, a.hairColor);
  player.eyeColor = a.eyeColor;
  player.setHeadOverlay(2, [a.brows, 1, a.hairColor, a.hairColor]);
  player.setHeadOverlay(1, a.beard >= 0 ? [a.beard, 1, a.hairColor, a.hairColor] : [255, 0, 0, 0]);
}

// Weapons live in the inventory: the character starts unarmed (keys 1-9 take them).
function giveItems(player, ch) {
  inventory.holster(player);
  if (ch.armour) {
    player.armour = ch.armour;
    ch.armour = 0;  // the starter armour is given once
  }
}

function spawnPersonalVehicle(player, ch) {
  if (!ch.vehicle) return;
  const old = player.getVariable('personalVehicle');
  if (old && mp.vehicles.exists(old)) old.destroy();
  const p = player.position;
  const veh = mp.vehicles.new(mp.joaat(ch.vehicle), new mp.Vector3(p.x + 3, p.y, p.z + 0.5), {
    heading: player.heading,
    numberPlate: `GO${String(ch.static).padStart(5, '0')}`,
    dimension: player.dimension,
  });
  vehicles.setup(veh, ch.static, ch.vehicleFuel);
  player.setVariable('personalVehicle', veh);
  for (const fn of vehicles.onSpawn) fn(veh, player);
}

function spawnCharacter(player, ch, isNew = false) {
  const s = session(player);
  s.character = ch;
  player.name = `${ch.first} ${ch.last}`;
  player.setVariable('static', ch.static);
  player.setOwnVariables({ cash: ch.cash, bank: ch.bank, account: s.account.login, kit: ch.kit, gender: ch.gender });
  applyAppearance(player, ch);
  inventory.ensure(ch);
  inventory.applyEquipment(player, ch);
  inventory.sendDefs(player);
  player.dimension = 0;
  const pos = ch.pos ? new mp.Vector3(ch.pos[0], ch.pos[1], ch.pos[2]) : randomSpawn();
  player.spawn(pos, ch.heading || 0);
  giveItems(player, ch);
  player.call('gomp:ui:close', []);
  inventory.sync(player, ch);
  require('./places').sendPlaces(player);
  require('./houses').send(player);
  spawnPersonalVehicle(player, ch);
  player.outputChatBox(isNew
    ? `!{#8ef}Добро пожаловать, ${ch.first}! Ваш статик: ${ch.static}.`
    : `!{#8ef}С возвращением, ${ch.first}! Статик: ${ch.static}.`);
  mp.players.broadcast(`!{#8ef}${player.name} [${ch.static}] вошёл в игру.`);
  broadcastOnline();
}

mp.events.add('playerDeath', (player) => {
  const ch = character(player);
  if (!ch) return;
  setTimeout(() => {
    if (!mp.players.exists(player)) return;
    player.spawn(randomSpawn(), 0);
    giveItems(player, ch);
    if (!ch.guest) inventory.sync(player, ch);
  }, 3000);
});

// ------------------------------------------------------------------ animations (F2 menu)

// The same order as kAnimations in client/game/hud.cpp. [dict, name, flag] or a scenario name.
const ANIMATIONS = [
  ['gestures@m@standing@casual', 'gesture_hello', 48],
  ['missminuteman_1ig_2', 'handsup_base', 49],
  ['amb@world_human_hang_out_street@female_arms_crossed@base', 'base', 49],
  ['anim@mp_player_intcelebrationmale@face_palm', 'face_palm', 48],
  ['amb@world_human_picnic@male@base', 'base', 1],
  ['amb@world_human_sunbathe@male@back@base', 'base', 1],
  ['anim@amb@nightclub@dancers@crowddance_facedj@hi_intensity', 'hi_dance_facedj_09_v2_male^1', 1],
  'WORLD_HUMAN_SMOKING',
  'WORLD_HUMAN_LEANING',
  'WORLD_HUMAN_AA_COFFEE',
  'WORLD_HUMAN_TOURIST_MOBILE',
  'WORLD_HUMAN_PUSH_UPS',
  'WORLD_HUMAN_CHEERING',
  'WORLD_HUMAN_MUSICIAN',
];

mp.events.add('gomp:anim', (player, index) => {
  if (!isLogged(player) || player.vehicle) return;
  const i = Number(index);
  if (i === -1) return player.stopAnimation();
  const anim = ANIMATIONS[i];
  if (!anim) return undefined;
  if (typeof anim === 'string') return player.playScenario(anim);
  return player.playAnimation(anim[0], anim[1], 8, anim[2]);
});

// ------------------------------------------------------------------ inventory

function withCharacter(fn) {
  return (player, ...args) => {
    const ch = character(player);
    if (ch && !ch.guest) fn(player, ch, ...args);
  };
}

mp.events.add('gomp:inv:move', withCharacter((player, ch, from, fi, to, ti, count) => inventory.move(player, ch, String(from), Number(fi), String(to), Number(ti), count)));
mp.events.add('gomp:inv:use', withCharacter((player, ch, c, i) => inventory.use(player, ch, String(c), Number(i))));
mp.events.add('gomp:inv:usekey', withCharacter((player, ch, key) => inventory.ITEMS[String(key)] && inventory.useKey(player, ch, String(key))));
mp.events.add('gomp:inv:drop', withCharacter((player, ch, c, i, count) => {
  if (player.vehicle) return player.notify('~r~Нельзя выбросить в транспорте');
  const item = inventory.take(player, ch, String(c), Number(i), count);
  return item && drops.spawn(player, item);
}));
mp.events.add('gomp:drop:pickup', withCharacter((player, ch, id) => drops.pickup(player, ch, id)));
mp.events.add('gomp:inv:hotkey', withCharacter((player, ch, n) => inventory.hotkey(player, ch, Number(n))));
// The client knows which arms and undershirt the game forces for the worn top.
mp.events.add('gomp:inv:fixtop', withCharacter((player, ch, torso, undershirt) => {
  const top = ch.inventory && ch.inventory.equip[0];
  if (!top || !top.data) return;
  const t = Math.round(Number(torso));
  const u = Math.round(Number(undershirt));
  if (!(t >= 0 && t < 300) || top.data.torso === t && (!(u >= 0) || top.data.undershirt === u)) return;
  top.data.torso = t;
  if (u >= 0 && u < 300) top.data.undershirt = u;
  inventory.applyEquipment(player, ch);
  accounts.save();
}));

// Cartridges fired are taken from the inventory.
setInterval(() => {
  mp.players.forEach((player) => {
    const ch = character(player);
    if (ch && !ch.guest) inventory.reconcileAmmo(player, ch);
  });
}, 1000);

// ------------------------------------------------------------------ money

function setMoney(player, cash, bank) {
  const ch = character(player);
  if (!ch) return false;
  ch.cash = Math.max(0, Math.round(cash));
  ch.bank = Math.max(0, Math.round(bank));
  player.setOwnVariables({ cash: ch.cash, bank: ch.bank });
  accounts.save();
  return true;
}

// ------------------------------------------------------------------ persistence

function storePosition(player) {
  const ch = character(player);
  if (!ch || player.dimension !== 0) return;
  const p = player.position;
  ch.pos = [p.x, p.y, p.z];
  ch.heading = player.heading;
  ch.lastSeen = Date.now();
}

setInterval(() => {
  mp.players.forEach(storePosition);
  accounts.save();
}, 60000);

mp.events.add('playerQuit', (player) => {
  storePosition(player);
  const ch = character(player);
  if (ch && !ch.guest) inventory.reconcileAmmo(player, ch);
  inventory.held.delete(player.id);
  const veh = player.getVariable('personalVehicle');
  if (veh && mp.vehicles.exists(veh)) {
    if (ch && !ch.guest && ch.vehicle && veh.model === mp.joaat(ch.vehicle)) ch.vehicleFuel = vehicles.fuelOf(veh);
    veh.destroy();
  }
  sessions.delete(player.id);
  accounts.save();
  setTimeout(broadcastOnline, 100);
});

mp.events.add('serverShutdown', () => {
  mp.players.forEach(storePosition);
  accounts.flush();
});

// A player in the game by the static of their character.
function findByStatic(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return mp.players.toArray().find((p) => p.getVariable('static') === n) || null;
}

// The card statement shown by the phone's bank app: the last operations.
const BANK_LOG_SIZE = 30;
function logBank(ch, sum, text) {
  if (!ch || ch.guest || !sum) return;
  ch.bankLog = ch.bankLog || [];
  ch.bankLog.push({ at: Date.now(), sum: Math.round(sum), text: String(text || '') });
  if (ch.bankLog.length > BANK_LOG_SIZE) ch.bankLog.splice(0, ch.bankLog.length - BANK_LOG_SIZE);
}

// Takes money from cash (method 'cash') or the card ('bank'); false when there is not enough.
// What was paid for goes into the card statement.
function pay(player, sum, method, what = 'Оплата картой') {
  const ch = character(player);
  const n = Math.round(Number(sum));
  if (!ch || !(n >= 0)) return false;
  if (method === 'bank') {
    if (ch.bank < n) return false;
    logBank(ch, -n, what);
    return setMoney(player, ch.cash, ch.bank - n);
  }
  return ch.cash >= n && setMoney(player, ch.cash - n, ch.bank);
}

// Money onto the card (a house sold, a transfer received).
function deposit(player, sum, what) {
  const ch = character(player);
  const n = Math.round(Number(sum));
  if (!ch || !(n > 0)) return false;
  logBank(ch, n, what);
  return setMoney(player, ch.cash, ch.bank + n);
}

module.exports = { isLogged, character, setMoney, pay, deposit, logBank, randomSpawn, findByStatic };
