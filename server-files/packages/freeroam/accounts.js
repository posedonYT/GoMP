// Accounts and characters. The data lives in the store (store/index.js): files
// in server-files/data (one per record) or Redis (conf.json "storage":
// "redis://host:6379/0", or GOMP_REDIS_URL). Passwords are scrypt hashes with a
// per-account salt; hashing runs off the game's thread (crypto.scrypt), so a
// login never freezes the server.

const path = require('path');
const crypto = require('crypto');
const store = require('./store').open({
  // GOMP_DATA_DIR moves the database elsewhere (the tests use a temporary folder).
  dataDir: process.env.GOMP_DATA_DIR || path.join(__dirname, '..', '..', 'data'),
  config: typeof mp !== 'undefined' ? mp.config : {},
});

const MAX_CHARACTERS = 3;
const db = store.db;

// Lookups that used to scan every character (name taken, phone numbers, statics).
const byStatic = new Map();
const byName = new Map();   // "first last" in lower case
const byPhone = new Map();
const nameKey = (first, last) => `${String(first).toLowerCase()} ${String(last).toLowerCase()}`;

function index(ch) {
  byStatic.set(ch.static, ch);
  byName.set(nameKey(ch.first, ch.last), ch);
  if (ch.phone) byPhone.set(ch.phone, ch);
}

function buildIndexes() {
  byStatic.clear();
  byName.clear();
  byPhone.clear();
  for (const ch of Object.values(db.characters)) index(ch);
}

const ready = store.ready.then(() => buildIndexes());
buildIndexes();  // files: the data is there already

function save(record) {
  store.save(record);
}

// Writes what is waiting; resolves when it is written.
function flush() {
  return store.flush();
}

// Serial numbers of non-stackable items.
function nextUid() {
  db.nextItemUid = (db.nextItemUid || 1) + 1;
  save();
  return db.nextItemUid - 1;
}

// The tests hash synchronously (same results, the handlers finish at once);
// the server never does.
const SYNC_HASH = process.env.GOMP_SYNC_HASH === '1';

function hashPassword(password, salt, done) {
  if (SYNC_HASH) {
    let key;
    try {
      key = crypto.scryptSync(password, salt, 32);
    } catch (e) {
      done(e);
      return;
    }
    done(null, key);
    return;
  }
  crypto.scrypt(password, salt, 32, done);
}

const loginRe = /^[A-Za-z0-9_]{3,20}$/;
const nameRe = /^[A-ZА-ЯЁ][a-zа-яё]{1,15}$/;

function validateCredentials(login, password) {
  if (typeof login !== 'string' || !loginRe.test(login)) return 'Логин: 3–20 латинских букв, цифр или _';
  if (typeof password !== 'string' || password.length < 6 || password.length > 64) return 'Пароль: от 6 до 64 символов';
  return null;
}

const notReady = { error: 'Сервер загружает данные, попробуйте через несколько секунд' };

// done({ account } | { error }), at once or after the hash is computed.
function register(login, password, done) {
  const err = validateCredentials(login, password);
  if (err) return done({ error: err });
  if (store.loaded === false) return done(notReady);
  const key = login.toLowerCase();
  if (db.accounts[key]) return done({ error: 'Такой логин уже занят' });
  const salt = crypto.randomBytes(16).toString('hex');
  return hashPassword(password, salt, (e, hash) => {
    if (e) return done({ error: 'Не удалось создать аккаунт' });
    // Someone took the login while the hash was computed.
    if (db.accounts[key]) return done({ error: 'Такой логин уже занят' });
    db.accounts[key] = { login, salt, hash: hash.toString('hex'), created: Date.now(), chars: [] };
    save(db.accounts[key]);
    return done({ account: db.accounts[key] });
  });
}

function login(loginName, password, done) {
  const bad = { error: 'Неверный логин или пароль' };
  if (typeof loginName !== 'string' || typeof password !== 'string') return done(bad);
  if (store.loaded === false) return done(notReady);
  const acc = db.accounts[loginName.toLowerCase()];
  if (!acc) return done(bad);
  return hashPassword(password, acc.salt, (e, hash) => {
    const stored = Buffer.from(String(acc.hash || ''), 'hex');
    if (e || stored.length !== hash.length || !crypto.timingSafeEqual(hash, stored)) return done(bad);
    acc.lastLogin = Date.now();
    save(acc);
    return done({ account: acc });
  });
}

function charactersOf(account) {
  return account.chars.map((id) => db.characters[id]).filter(Boolean);
}

function getCharacter(account, id) {
  return account.chars.includes(Number(id)) ? db.characters[id] : null;
}

// Sanitizes the appearance chosen in the character creator.
function cleanAppearance(a = {}) {
  const int = (v, lo, hi, def) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const num = (v, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : def;
  };
  return {
    father: int(a.father, 0, 20, 0),
    mother: int(a.mother, 21, 41, 21),
    shapeMix: num(a.shapeMix, 0.5),
    skinMix: num(a.skinMix, 0.5),
    hair: int(a.hair, 0, 200, 0),
    hairColor: int(a.hairColor, 0, 63, 0),
    eyeColor: int(a.eyeColor, 0, 31, 0),
    brows: int(a.brows, 0, 33, 0),
    beard: int(a.beard, -1, 28, -1),
    top: int(a.top, 0, 500, 0),
    topTex: int(a.topTex, 0, 25, 0),
    torso: int(a.torso, 0, 200, 0),
    undershirt: int(a.undershirt, 0, 200, 15),
    legs: int(a.legs, 0, 200, 0),
    legsTex: int(a.legsTex, 0, 25, 0),
    shoes: int(a.shoes, 0, 200, 0),
    shoesTex: int(a.shoesTex, 0, 25, 0),
  };
}

const KITS = [
  { id: 'civil', cash: 5000, bank: 10000, weapons: {}, vehicle: null, armour: 0 },
  { id: 'driver', cash: 1500, bank: 5000, weapons: {}, vehicle: 'blista', armour: 0 },
  { id: 'guard', cash: 1500, bank: 5000, weapons: { weapon_pistol: 120, weapon_nightstick: 1 }, vehicle: null, armour: 50 },
];

function createCharacter(account, data = {}) {
  if (account.chars.length >= MAX_CHARACTERS) return { error: `Не больше ${MAX_CHARACTERS} персонажей` };
  const first = String(data.first || '').trim();
  const last = String(data.last || '').trim();
  if (!nameRe.test(first) || !nameRe.test(last)) {
    return { error: 'Имя и фамилия: 2–16 букв, с заглавной (например, Ivan Petrov)' };
  }
  if (byName.has(nameKey(first, last))) return { error: 'Персонаж с таким именем уже есть' };
  const kit = KITS[Math.round(Number(data.kit))] || KITS[0];
  const ch = {
    id: db.nextCharId++,
    static: db.nextStatic++,
    account: account.login.toLowerCase(),
    first,
    last,
    gender: data.gender === 'f' ? 'f' : 'm',
    appearance: cleanAppearance(data.appearance),
    kit: kit.id,
    cash: kit.cash,
    bank: kit.bank,
    weapons: { ...kit.weapons },
    armour: kit.armour,
    vehicle: kit.vehicle,
    pos: null,
    heading: 0,
    created: Date.now(),
  };
  db.characters[ch.id] = ch;
  index(ch);
  account.chars.push(ch.id);
  save(ch);
  save(account);
  save();  // the counters
  return { character: ch };
}

// Every character, also of players who are offline (phone numbers, transfers).
function allCharacters() {
  return Object.values(db.characters);
}

function characterByStatic(statik) {
  return byStatic.get(Number(statik)) || null;
}

function characterByPhone(number) {
  return byPhone.get(String(number)) || null;
}

// Gives a character a phone number (kept in the index).
function setPhone(ch, number) {
  if (ch.phone) byPhone.delete(ch.phone);
  ch.phone = number;
  byPhone.set(number, ch);
  save(ch);
}

// A character in play: saved with every save() until the player leaves.
function play(ch) {
  store.play(ch);
}

function release(ch) {
  store.release(ch);
}

// A named part of the database for other modules (houses.js keeps its owners here).
function table(name) {
  return store.table(name);
}

module.exports = {
  MAX_CHARACTERS, register, login, charactersOf, getCharacter, createCharacter, save, flush, nextUid,
  allCharacters, characterByStatic, characterByPhone, setPhone, play, release, table, ready, store,
};
