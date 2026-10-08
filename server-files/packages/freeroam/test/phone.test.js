const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fakemp');
require('../index');
const roleplay = require('../roleplay');
const accounts = require('../accounts');
const phone = require('../phone');

function opened() {
  const p = fake.login(fake.join());
  fake.emit('gomp:phone:open', p);
  return { p, ch: roleplay.character(p), data: p.lastCall('gomp:phone:data')[0] };
}

test('every character gets a number of its own', () => {
  const a = opened();
  const b = opened();
  assert.match(a.data.number, phone.NUMBER_RE);
  assert.notStrictEqual(a.data.number, b.data.number);
  fake.emit('gomp:phone:open', a.p);
  assert.strictEqual(a.p.lastCall('gomp:phone:data')[0].number, a.data.number, 'kept');
  assert.strictEqual(phone.byNumber(a.data.number), a.ch);
});

test('contacts: added, renamed, checked and removed', () => {
  const { p, ch } = opened();
  fake.emit('gomp:phone:contact', p, 'Ivan', '555-1234');
  fake.emit('gomp:phone:contact', p, 'Anna', '555-0000');
  fake.emit('gomp:phone:contact', p, 'Ivan P.', '555-1234');
  assert.deepStrictEqual(ch.contacts, [{ name: 'Anna', number: '555-0000' }, { name: 'Ivan P.', number: '555-1234' }]);
  fake.emit('gomp:phone:contact', p, 'Bad', '5551234');
  fake.emit('gomp:phone:contact', p, '   ', '555-9999');
  assert.strictEqual(ch.contacts.length, 2);
  fake.emit('gomp:phone:contact', p, '~r~Red~s~', '555-7777');
  assert.ok(!ch.contacts.find((c) => c.number === '555-7777').name.includes('~'), 'no GTA colours');
  fake.emit('gomp:phone:uncontact', p, '555-0000');
  assert.ok(!ch.contacts.some((c) => c.number === '555-0000'));
  assert.deepStrictEqual(p.lastCall('gomp:phone:data')[0].contacts, ch.contacts);
});

test('messages reach a player in the game at once and one offline later', () => {
  const a = opened();
  const b = opened();
  fake.emit('gomp:phone:contact', b.p, 'Sasha', a.data.number);
  fake.emit('gomp:phone:sms', a.p, b.data.number, '  Привет!\nКак дела?  ');
  assert.deepStrictEqual(a.ch.sms.at(-1), { n: b.data.number, t: 'Привет! Как дела?', o: true, at: a.ch.sms.at(-1).at, r: true });
  assert.strictEqual(b.ch.sms.at(-1).n, a.data.number);
  assert.strictEqual(b.ch.sms.at(-1).r, false);
  assert.deepStrictEqual(b.p.lastCall('gomp:phone:sms')[0], { from: a.data.number, name: 'Sasha', text: 'Привет! Как дела?' });
  fake.emit('gomp:phone:read', b.p, a.data.number);
  assert.strictEqual(b.ch.sms.at(-1).r, true);

  // Too fast, to nobody, to oneself: nothing is sent.
  const count = a.ch.sms.length;
  fake.emit('gomp:phone:sms', a.p, b.data.number, 'again');
  fake.emit('gomp:phone:sms', a.p, '000-0000', 'hello');
  assert.strictEqual(a.ch.sms.length, count);

  // Offline: kept until the phone is opened.
  const c = opened();
  fake.emit('playerQuit', b.p);
  fake.emit('gomp:phone:sms', c.p, b.data.number, 'ты где?');
  assert.strictEqual(b.ch.sms.at(-1).t, 'ты где?');
});

test('transfers: card to card, online or offline, into both statements', () => {
  const a = opened();
  const b = opened();
  roleplay.setMoney(a.p, 0, 1000);
  const bBank = b.ch.bank;
  fake.emit('gomp:phone:transfer', a.p, b.data.number, 400);
  assert.strictEqual(a.ch.bank, 600);
  assert.strictEqual(b.ch.bank, bBank + 400);
  assert.strictEqual(b.p.own.bank, bBank + 400, 'the receiver sees it');
  assert.strictEqual(a.ch.bankLog.at(-1).sum, -400);
  assert.strictEqual(b.ch.bankLog.at(-1).sum, 400);
  assert.strictEqual(a.p.lastCall('gomp:phone:data')[0].bankLog[0].sum, -400, 'newest first');

  fake.emit('gomp:phone:transfer', a.p, b.data.number, 5000);
  fake.emit('gomp:phone:transfer', a.p, b.data.number, -5);
  fake.emit('gomp:phone:transfer', a.p, a.data.number, 10);
  assert.strictEqual(a.ch.bank, 600, 'too much, negative, to oneself');

  fake.emit('playerQuit', b.p);
  fake.emit('gomp:phone:transfer', a.p, b.data.number, 100);
  assert.strictEqual(accounts.characterByStatic(b.ch.static).bank, bBank + 500);
});

test('using the phone in the inventory opens it', () => {
  const { p, ch } = opened();
  const inv = ch.inventory;
  const where = ['pockets', 'hotbar'].map((c) => [c, inv[c].findIndex((s) => s && s.key === 'phone')]).find(([, i]) => i >= 0);
  assert.ok(where, 'a starter phone');
  fake.emit('gomp:inv:use', p, where[0], where[1]);
  assert.ok(p.lastCall('gomp:phone:show'));
});
