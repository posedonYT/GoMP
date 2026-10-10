// The phone (the "up" arrow in the game client, with a phone in the inventory):
// a number, contacts, messages, card transfers and the card statement. Every
// character gets a number of its own the first time the phone is opened.
// Messages and transfers reach characters that are offline too.
//
// Client protocol:
//   client -> server  gomp:phone:open                       → gomp:phone:data
//                     gomp:phone:contact name, number       add a contact or rename it
//                     gomp:phone:uncontact number
//                     gomp:phone:sms number, text
//                     gomp:phone:read number                 the conversation was read
//                     gomp:phone:transfer number, sum        card to card
//   server -> client  gomp:phone:data {number, contacts: [{name, number}],
//                                      sms: [{n, t, o, at, r}], bankLog: [{at, sum, text}]}
//                       sms: n the other number, t text, o outgoing, r read
//                     gomp:phone:sms {from, name, text}      a new message arrived

const accounts = require('./accounts');
const roleplay = require('./roleplay');

const MAX_CONTACTS = 100;
const MAX_SMS = 200;          // kept per character
const SENT_SMS = 100;         // sent to the client
const MAX_TEXT = 160;
const MAX_NAME = 24;
const MAX_TRANSFER = 10000000;
const SMS_INTERVAL_MS = 1000;
const NUMBER_RE = /^\d{3}-\d{4}$/;

const lastSms = new Map();  // player id -> time

// GTA formatting (~r~, ~n~...) is not allowed in what players type.
function clean(text, max) {
  return String(text ?? '').replace(/[~\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function numberOf(ch) {
  if (ch.phone) return ch.phone;
  let n;
  do {
    n = `${200 + Math.floor(Math.random() * 800)}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
  } while (accounts.characterByPhone(n));
  accounts.setPhone(ch, n);
  return n;
}

function byNumber(number) {
  return accounts.characterByPhone(number);
}

// The player who is in the game with this character.
function playerOf(ch) {
  const p = roleplay.findByStatic(ch.static);
  return p && roleplay.character(p) === ch ? p : null;
}

function data(ch) {
  return {
    number: numberOf(ch),
    contacts: ch.contacts || [],
    sms: (ch.sms || []).slice(-SENT_SMS),
    bankLog: [...(ch.bankLog || [])].reverse(),
  };
}

function push(player, ch) {
  player.call('gomp:phone:data', [data(ch)]);
}

function addSms(ch, entry) {
  ch.sms = ch.sms || [];
  ch.sms.push(entry);
  if (ch.sms.length > MAX_SMS) ch.sms.splice(0, ch.sms.length - MAX_SMS);
}

function contactName(ch, number) {
  const c = (ch.contacts || []).find((x) => x.number === number);
  return c ? c.name : number;
}

function withPhone(fn) {
  return (player, ...args) => {
    const ch = roleplay.character(player);
    if (ch && !ch.guest) fn(player, ch, ...args);
  };
}

mp.events.add('gomp:phone:open', withPhone((player, ch) => push(player, ch)));

mp.events.add('gomp:phone:contact', withPhone((player, ch, name, number) => {
  const n = clean(number, 8);
  const nm = clean(name, MAX_NAME);
  if (!NUMBER_RE.test(n)) return player.notify('~r~Номер в формате 123-4567');
  if (!nm) return player.notify('~r~Введите имя контакта');
  ch.contacts = ch.contacts || [];
  const existing = ch.contacts.find((c) => c.number === n);
  if (existing) existing.name = nm;
  else if (ch.contacts.length >= MAX_CONTACTS) return player.notify('~r~Список контактов заполнен');
  else ch.contacts.push({ name: nm, number: n });
  ch.contacts.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  accounts.save();
  return push(player, ch);
}));

mp.events.add('gomp:phone:uncontact', withPhone((player, ch, number) => {
  ch.contacts = (ch.contacts || []).filter((c) => c.number !== String(number));
  accounts.save();
  push(player, ch);
}));

mp.events.add('gomp:phone:read', withPhone((player, ch, number) => {
  let changed = false;
  for (const m of ch.sms || []) {
    if (m.n === String(number) && !m.o && !m.r) {
      m.r = true;
      changed = true;
    }
  }
  if (changed) accounts.save();
}));

mp.events.add('gomp:phone:sms', withPhone((player, ch, number, text) => {
  const n = clean(number, 8);
  const t = clean(text, MAX_TEXT);
  if (!t) return undefined;
  const now = Date.now();
  if (now - (lastSms.get(player.id) || 0) < SMS_INTERVAL_MS) return undefined;
  lastSms.set(player.id, now);
  const to = byNumber(n);
  const from = numberOf(ch);
  if (!to) return player.notify('~r~Абонент не найден');
  if (to === ch) return player.notify('~r~Нельзя написать самому себе');
  addSms(ch, { n, t, o: true, at: now, r: true });
  addSms(to, { n: from, t, o: false, at: now, r: false });
  accounts.save(ch);
  accounts.save(to);  // may be offline: named, a broad save covers only characters in play
  push(player, ch);
  const target = playerOf(to);
  if (target) {
    const name = contactName(to, from);
    target.call('gomp:phone:sms', [{ from, name, text: t }]);
    push(target, to);
  }
  return undefined;
}));

mp.events.add('gomp:phone:transfer', withPhone((player, ch, number, amount) => {
  const n = clean(number, 8);
  const sum = Math.floor(Number(amount));
  const to = byNumber(n);
  if (!to) return player.notify('~r~Абонент не найден');
  if (to === ch) return player.notify('~r~Нельзя перевести самому себе');
  if (!(sum >= 1 && sum <= MAX_TRANSFER)) return player.notify('~r~Неверная сумма');
  const from = numberOf(ch);
  if (!roleplay.pay(player, sum, 'bank', `Перевод: ${contactName(ch, n)}`)) return player.notify('~r~Недостаточно денег на карте');
  const target = playerOf(to);
  const what = `Перевод от ${contactName(to, from)}`;
  if (target) {
    roleplay.deposit(target, sum, what);
    target.notify(`~g~+$${sum}~s~ на карту: ${what}`);
  } else {
    to.bank += sum;
    roleplay.logBank(to, sum, what);
  }
  accounts.save(ch);
  accounts.save(to);  // may be offline
  player.notify(`Перевод ~g~$${sum}~s~ отправлен: ${contactName(ch, n)}`);
  return push(player, ch);
}));

mp.events.add('playerQuit', (player) => lastSms.delete(player.id));

module.exports = { numberOf, byNumber, data, NUMBER_RE };
