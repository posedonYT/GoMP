// Accounts and characters, stored in server-files/data/gomp-rp.json.
// Passwords are kept as scrypt hashes with a per-account salt.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// GOMP_DATA_DIR moves the database elsewhere (the tests use a temporary folder).
const dataDir = process.env.GOMP_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const dataFile = path.join(dataDir, 'gomp-rp.json');

const MAX_CHARACTERS = 3;

let db = { nextStatic: 1, nextCharId: 1, nextItemUid: 1, accounts: {}, characters: {} };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) };
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 1000);
}

// Writes the database atomically (temp file + rename).
function flush() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${dataFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, dataFile);
}

// Serial numbers of non-stackable items.
function nextUid() {
  db.nextItemUid = (db.nextItemUid || 1) + 1;
  return db.nextItemUid - 1;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

const loginRe = /^[A-Za-z0-9_]{3,20}$/;
const nameRe = /^[A-ZА-ЯЁ][a-zа-яё]{1,15}$/;

function validateCredentials(login, password) {
  if (typeof login !== 'string' || !loginRe.test(login)) return 'Логин: 3–20 латинских букв, цифр или _';
  if (typeof password !== 'string' || password.length < 6 || password.length > 64) return 'Пароль: от 6 до 64 символов';
  return null;
}

function register(login, password) {
  const err = validateCredentials(login, password);
  if (err) return { error: err };
  const key = login.toLowerCase();
  if (db.accounts[key]) return { error: 'Такой логин уже занят' };
  const salt = crypto.randomBytes(16).toString('hex');
  db.accounts[key] = { login, salt, hash: hashPassword(password, salt), created: Date.now(), chars: [] };
  save();
  return { account: db.accounts[key] };
}

function login(loginName, password) {
  if (typeof loginName !== 'string' || typeof password !== 'string') return { error: 'Неверный логин или пароль' };
  const acc = db.accounts[loginName.toLowerCase()];
  if (!acc) return { error: 'Неверный логин или пароль' };
  const hash = hashPassword(password, acc.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(acc.hash, 'hex'))) {
    return { error: 'Неверный логин или пароль' };
  }
  acc.lastLogin = Date.now();
  save();
  return { account: acc };
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
  const taken = Object.values(db.characters).some((c) => c.first.toLowerCase() === first.toLowerCase()
    && c.last.toLowerCase() === last.toLowerCase());
  if (taken) return { error: 'Персонаж с таким именем уже есть' };
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
  account.chars.push(ch.id);
  save();
  return { character: ch };
}

// Every character, also of players who are offline (phone numbers, transfers).
function allCharacters() {
  return Object.values(db.characters);
}

function characterByStatic(statik) {
  const n = Number(statik);
  return Object.values(db.characters).find((c) => c.static === n) || null;
}

// A named part of the database for other modules (houses.js keeps its owners here).
function table(name) {
  if (!db[name] || typeof db[name] !== 'object') db[name] = {};
  return db[name];
}

module.exports = {
  MAX_CHARACTERS, register, login, charactersOf, getCharacter, createCharacter, save, flush, nextUid,
  allCharacters, characterByStatic, table,
};
