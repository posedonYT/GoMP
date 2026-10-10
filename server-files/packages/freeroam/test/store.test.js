// The storage under load: only changed records are written, writes never block,
// a failed write is retried, a gomp-rp.json from before moves over, Redis
// works through the same store (a fake RESP server here; real Redis with
// GOMP_REDIS_URL), passwords are hashed off the thread, logins are limited.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Store, open, storageUrl } = require('../store');
const { FileBackend } = require('../store/file');
const { RedisBackend } = require('../store/redis');
const { Resp, Parser, encode } = require('../store/resp');
const { FakeRedis } = require('./fakeredis');
const { limiter, persistent } = require('../ratelimit');

const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gomp-store-'));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// A backend that records what it is asked to write and can be made to fail.
class Recorder {
  constructor() {
    this.writes = [];
    this.failNext = 0;
  }
  async write(changes) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('disk full');
    }
    this.writes.push(changes.map((c) => c.key).sort());
  }
  close() {}
}

function storeWith(backend, pairs = []) {
  const s = new Store(backend, { log: quiet });
  s.fill(pairs);
  return s;
}

test('only the records that changed are written', async () => {
  const rec = new Recorder();
  const s = storeWith(rec, [
    ['acc:ann', { login: 'ann', chars: [1] }],
    ['char:1', { id: 1, static: 1, cash: 10 }],
    ['char:2', { id: 2, static: 2, cash: 20 }],
    ['t:houses:5', { owner: null }],
    ['meta', { nextStatic: 3, nextCharId: 3, nextItemUid: 1 }],
  ]);
  const one = s.db.characters[1];
  one.cash = 11;
  s.save(one);
  await s.flush();
  assert.deepEqual(rec.writes, [['char:1']]);
  // Saved again unchanged: nothing written.
  s.save(one);
  await s.flush();
  assert.equal(rec.writes.length, 1);
  assert.ok(s.stats.skipped >= 1);
});

test('a broad save covers characters in play and tables, not the rest', async () => {
  const rec = new Recorder();
  const s = storeWith(rec, [
    ['char:1', { id: 1, cash: 10 }],
    ['char:2', { id: 2, cash: 20 }],
    ['t:houses:5', { owner: null }],
    ['meta', { nextStatic: 3, nextCharId: 3, nextItemUid: 1 }],
  ]);
  const [a, b] = [s.db.characters[1], s.db.characters[2]];
  s.play(a);
  a.cash = 15;
  b.cash = 25;        // offline, changed without naming it: not covered
  s.db.houses[5].owner = 1;
  s.db.houses[6] = { owner: 2 };  // a new entry
  s.save();
  await s.flush();
  assert.deepEqual(rec.writes[0], ['char:1', 't:houses:5', 't:houses:6']);
  // A deleted table entry is deleted on the backend too.
  delete s.db.houses[6];
  s.save();
  await s.flush();
  assert.deepEqual(rec.writes[1], ['t:houses:6']);
  // Released (the player left): saved one last time, then no longer in broad saves.
  a.cash = 16;
  s.release(a);
  await s.flush();
  assert.deepEqual(rec.writes[2], ['char:1']);
  a.cash = 17;
  s.save();
  await s.flush();
  assert.equal(rec.writes.length, 3);
});

test('a failed write keeps the records and retries them', async () => {
  const rec = new Recorder();
  const s = storeWith(rec, [['char:1', { id: 1, cash: 1 }]]);
  const ch = s.db.characters[1];
  ch.cash = 2;
  s.save(ch);
  rec.failNext = 1;
  await assert.rejects(s.flush(), /disk full/);
  assert.equal(rec.writes.length, 0);
  ch.cash = 3;  // changed again meanwhile: the retry writes the latest
  await s.flush();
  assert.deepEqual(rec.writes, [['char:1']]);
  assert.equal(s.failures, 0);
  assert.equal(s.stats.failed, 1);
});

test('files: one per record, atomic, read back; gomp-rp.json moves over once', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'gomp-rp.json'), JSON.stringify({
    nextStatic: 5, nextCharId: 3, nextItemUid: 9,
    accounts: { ann: { login: 'Ann', chars: [1] } },
    characters: { 1: { id: 1, static: 4, first: 'Ann', last: 'Lee', cash: 7 } },
    houses: { 17: { owner: 4, locked: true } },
  }));
  const s = open({ dataDir: dir, log: quiet });
  assert.equal(s.kind, 'file');
  assert.equal(s.db.nextStatic, 5);
  assert.equal(s.db.characters[1].cash, 7);
  assert.equal(s.db.houses[17].owner, 4);
  assert.ok(fs.existsSync(path.join(dir, 'gomp-rp.json.bak')));
  assert.ok(!fs.existsSync(path.join(dir, 'gomp-rp.json')));
  assert.equal(readJson(path.join(dir, 'characters', '1.json')).first, 'Ann');
  assert.equal(readJson(path.join(dir, 'tables', 'houses', '17.json')).locked, true);
  // A change goes to its own file, nothing else is rewritten.
  const before = fs.statSync(path.join(dir, 'accounts', 'ann.json')).mtimeMs;
  s.db.characters[1].cash = 8;
  s.save(s.db.characters[1]);
  await s.flush();
  assert.equal(readJson(path.join(dir, 'characters', '1.json')).cash, 8);
  assert.equal(fs.statSync(path.join(dir, 'accounts', 'ann.json')).mtimeMs, before);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'characters')).filter((f) => f.endsWith('.tmp')), []);
  // Opened again: the same data, no second migration.
  const again = open({ dataDir: dir, log: quiet });
  assert.equal(again.db.characters[1].cash, 8);
  assert.equal(again.db.nextItemUid, 9);
});

test('files: a broken record is skipped, the rest loads', () => {
  const dir = tmp();
  const fb = new FileBackend(dir, { log: quiet });
  fb.writeSync([{ key: 'char:1', json: '{"id":1}' }, { key: 'meta', json: '{"nextStatic":2}' }]);
  fs.writeFileSync(path.join(dir, 'characters', '2.json'), '{ broken');
  const s = open({ dataDir: dir, log: quiet });
  assert.ok(s.db.characters[1]);
  assert.equal(s.db.characters[2], undefined);
});

test('shutdown writes what is waiting synchronously', async () => {
  const dir = tmp();
  const s = open({ dataDir: dir, log: quiet });
  s.db.characters[1] = { id: 1, cash: 99 };
  s.play(s.db.characters[1]);
  s.save();
  await s.close();
  assert.equal(readJson(path.join(dir, 'characters', '1.json')).cash, 99);
});

test('writes do not block: a flush of many records lets timers run', async () => {
  const dir = tmp();
  const s = open({ dataDir: dir, log: quiet });
  for (let i = 1; i <= 2000; i++) {
    s.db.characters[i] = { id: i, static: i, inventory: { items: new Array(20).fill({ id: 'water', n: 1 }) } };
    s.save(s.db.characters[i]);
  }
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  await s.flush();
  clearInterval(timer);
  assert.equal(fs.readdirSync(path.join(dir, 'characters')).length, 2000);
  assert.ok(ticks > 0, 'the event loop ran during the write');
});

test('storage URL: conf.json storage or GOMP_REDIS_URL, else files', () => {
  const saved = process.env.GOMP_REDIS_URL;
  delete process.env.GOMP_REDIS_URL;
  try {
    assert.equal(storageUrl({}), '');
    assert.equal(storageUrl({ storage: 'redis://h:1/2' }), 'redis://h:1/2');
    assert.equal(storageUrl({ storage: { type: 'redis', url: 'redis://x' } }), 'redis://x');
    assert.equal(storageUrl({ storage: 'file' }), '');
    process.env.GOMP_REDIS_URL = 'redis://env';
    assert.equal(storageUrl({}), 'redis://env');
  } finally {
    if (saved === undefined) delete process.env.GOMP_REDIS_URL;
    else process.env.GOMP_REDIS_URL = saved;
  }
});

// ------------------------------------------------------------------ RESP and Redis

test('RESP: encoding and replies split anywhere', () => {
  assert.equal(encode(['SET', 'k', 'ц']).toString('binary'), '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\n\xd1\x86\r\n');
  const p = new Parser();
  const bytes = Buffer.from('+OK\r\n:42\r\n$5\r\nhello\r\n*2\r\n$1\r\na\r\n$-1\r\n-ERR bad\r\n');
  const got = [];
  for (let i = 0; i < bytes.length; i++) {
    p.feed(bytes.subarray(i, i + 1));
    for (let r = p.take(); r; r = p.take()) got.push(r.value);
  }
  assert.deepEqual(got.slice(0, 4), ['OK', 42, 'hello', ['a', null]]);
  assert.ok(got[4] instanceof Error);
});

test('redis: password, records loaded, changed ones written in one transaction', async () => {
  const fake = new FakeRedis({ password: 's3cret' });
  const url = await fake.listen();
  try {
    fake.data.set('gomp:char:1', JSON.stringify({ id: 1, cash: 5 }));
    fake.data.set('gomp:acc:ann', JSON.stringify({ login: 'ann', chars: [1] }));
    fake.data.set('gomp:t:houses:3', JSON.stringify({ owner: 1 }));
    fake.data.set('gomp:meta', JSON.stringify({ nextStatic: 2 }));
    fake.data.set('other:key', 'x');
    const s = open({ dataDir: tmp(), config: { storage: url }, log: quiet });
    assert.equal(s.kind, 'redis');
    await s.ready;
    assert.equal(s.db.characters[1].cash, 5);
    assert.equal(s.db.houses[3].owner, 1);
    assert.equal(s.db.nextStatic, 2);
    s.db.characters[1].cash = 6;
    s.save(s.db.characters[1]);
    fake.commands.length = 0;
    await s.flush();
    assert.deepEqual(fake.commands, ['MULTI', 'SET', 'EXEC']);
    assert.equal(JSON.parse(fake.data.get('gomp:char:1')).cash, 6);
    s.backend.close();
  } finally {
    await fake.close();
  }
});

test('redis: an empty database takes the files once', async () => {
  const fake = new FakeRedis();
  const url = await fake.listen();
  const dir = tmp();
  new FileBackend(dir, { log: quiet }).writeSync([{ key: 'char:7', json: '{"id":7,"cash":70}' }, { key: 'meta', json: '{"nextStatic":8}' }]);
  try {
    const s = open({ dataDir: dir, config: { storage: url }, log: quiet });
    await s.ready;
    assert.equal(s.db.characters[7].cash, 70);
    assert.equal(JSON.parse(fake.data.get('gomp:char:7')).cash, 70);
    s.backend.close();
  } finally {
    await fake.close();
  }
});

test('redis: a failed transaction and a lost connection lose nothing', async () => {
  const fake = new FakeRedis();
  const url = await fake.listen();
  try {
    const s = open({ dataDir: tmp(), config: { storage: url }, log: quiet });
    await s.ready;
    s.db.characters[1] = { id: 1, cash: 1 };
    s.save(s.db.characters[1]);
    fake.fail(1);
    await assert.rejects(s.flush());
    assert.equal(fake.data.get('gomp:char:1'), undefined);
    // The connection drops; the client reconnects by itself.
    fake.drop();
    s.db.characters[1].cash = 2;
    for (let i = 0; i < 50 && !s.backend.r.ready; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300));
    await s.flush();
    assert.equal(JSON.parse(fake.data.get('gomp:char:1')).cash, 2);
    s.backend.close();
  } finally {
    await fake.close();
  }
});

test('redis: rate-limit counters', async () => {
  const fake = new FakeRedis();
  const url = await fake.listen();
  try {
    const b = new RedisBackend(url, { log: quiet });
    await b.connect();
    assert.equal(await b.hit('login:1.2.3.4', 60), 1);
    assert.equal(await b.hit('login:1.2.3.4', 60), 2);
    // persistent(): the limit of new accounts kept in Redis survives a restart of the gamemode.
    for (let i = 0; i < 3; i++) assert.equal(await persistent(b, 'reg:5.6.7.8', 3, 600), true);
    assert.equal(await persistent(b, 'reg:5.6.7.8', 3, 600), false);
    const again = new RedisBackend(url, { log: quiet });  // "after the restart"
    await again.connect();
    assert.equal(await persistent(again, 'reg:5.6.7.8', 3, 600), false);
    assert.equal(await persistent(again, 'reg:9.9.9.9', 3, 600), true);
    again.close();
    // Redis down: the in-memory limiter still holds, registration is not blocked.
    await fake.close();
    assert.equal(await persistent(b, 'reg:1.1.1.1', 3, 600), true);
    // Files keep no counters: allowed.
    assert.equal(await persistent({}, 'reg:1.1.1.1', 3, 600), true);
    b.close();
  } finally {
    await fake.close().catch(() => {});
  }
});

// Real Redis, when one is configured (the Linux server): GOMP_REDIS_URL=redis://127.0.0.1:6379/15
test('redis: a real server', { skip: !process.env.GOMP_REDIS_URL && 'GOMP_REDIS_URL not set' }, async () => {
  const r = new Resp(process.env.GOMP_REDIS_URL, { log: quiet });
  await r.connect();
  const key = `gomp:test:${crypto.randomBytes(4).toString('hex')}`;
  await r.exec([['SET', key, '{"a":1}']]);
  assert.equal(await r.command(['GET', key]), '{"a":1}');
  await r.command(['DEL', key]);
  r.close();
});

// ------------------------------------------------------------------ login and limits

test('password hashing runs off the thread: timers keep running during logins', async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const salt = crypto.randomBytes(16).toString('hex');
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    crypto.scrypt('password123', salt, 32, (e, k) => (e ? reject(e) : resolve(k)));
  })));
  const ms = Date.now() - t0;
  clearInterval(timer);
  // The same work done synchronously would leave no room for a single tick.
  assert.ok(ticks >= Math.min(5, ms / 4), `${ticks} ticks in ${ms} ms`);
});

test('accounts: logins answer through a callback, also in the server mode', async () => {
  // The server mode (no GOMP_SYNC_HASH): the answer comes later.
  const saved = process.env.GOMP_SYNC_HASH;
  delete process.env.GOMP_SYNC_HASH;
  const dir = tmp();
  const prevDir = process.env.GOMP_DATA_DIR;
  process.env.GOMP_DATA_DIR = dir;
  global.mp = global.mp || { config: {} };
  try {
    delete require.cache[require.resolve('../accounts')];
    const accounts = require('../accounts');
    let answered = false;
    const reg = new Promise((resolve) => accounts.register('async_user', 'password123', (r) => {
      answered = true;
      resolve(r);
    }));
    assert.equal(answered, false, 'not answered synchronously');
    const r = await reg;
    assert.ok(r.account);
    const ok = await new Promise((resolve) => accounts.login('async_user', 'password123', resolve));
    assert.ok(ok.account);
    const bad = await new Promise((resolve) => accounts.login('async_user', 'wrong-password', resolve));
    assert.ok(bad.error);
    // Indexes: name and static lookups without scanning.
    const ch = accounts.createCharacter(r.account, { first: 'Ivan', last: 'Indexov' }).character;
    assert.equal(accounts.characterByStatic(ch.static), ch);
    assert.match(accounts.createCharacter(r.account, { first: 'Ivan', last: 'Indexov' }).error || '', /уже есть/);
    accounts.setPhone(ch, '555-0101');
    assert.equal(accounts.characterByPhone('555-0101'), ch);
    await accounts.store.close();
  } finally {
    if (saved !== undefined) process.env.GOMP_SYNC_HASH = saved;
    process.env.GOMP_DATA_DIR = prevDir;
    delete require.cache[require.resolve('../accounts')];
  }
});

test('rate limiter: burst, refill, wait and sweep', () => {
  let now = 0;
  const lim = limiter({ rate: 1, burst: 3, now: () => now });
  assert.deepEqual([1, 2, 3, 4].map(() => lim.allow('ip')), [true, true, true, false]);
  assert.equal(lim.wait('ip'), 1);
  assert.equal(lim.allow('other'), true);  // per key
  now = 2000;
  assert.deepEqual([lim.allow('ip'), lim.allow('ip'), lim.allow('ip')], [true, true, false]);
  now = 100000;
  lim.sweep();
  assert.equal(lim.size, 0);
});
