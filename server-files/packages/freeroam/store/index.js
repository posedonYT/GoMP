// The gamemode's database. Everything lives in memory as plain objects that the
// modules change directly (as before); this module decides what reaches the
// disk or Redis, and when:
//   - save(record) marks one record (an account, a character, a table entry);
//   - save() marks the "hot" records: characters in play, every table entry
//     and the counters (for the call sites that do not name what changed);
//   - once a second the marked records are serialised; only those whose JSON
//     changed since the last write go to the backend, asynchronously. A failed
//     write keeps them marked and is retried (with backoff), nothing is lost.
//
// db shape (unchanged for the modules): { nextStatic, nextCharId, nextItemUid,
// accounts: { login: acc }, characters: { id: ch }, <table>: { key: rec } }.

const crypto = require('crypto');
const path = require('path');
const { FileBackend } = require('./file');

const FLUSH_MS = 1000;
const RETRY_MAX_MS = 30000;
const RESERVED = new Set(['accounts', 'characters']);

const digest = (json) => crypto.createHash('sha1').update(json).digest('base64');

class Store {
  constructor(backend, { log = console } = {}) {
    this.backend = backend;
    this.log = log;
    this.db = { nextStatic: 1, nextCharId: 1, nextItemUid: 1, accounts: {}, characters: {} };
    this.keys = new WeakMap();   // record object -> key
    this.written = new Map();    // key -> digest of the JSON last written
    this.dirty = new Set();      // keys marked by save(record)
    this.broad = false;          // save() without a record since the last flush
    this.hot = new Set();        // characters in play
    this.timer = null;
    this.writing = null;         // promise of the write in progress
    this.retryMs = FLUSH_MS;
    this.failures = 0;
    this.stats = { writes: 0, records: 0, skipped: 0, failed: 0 };
  }

  // Fills the database from [key, value] pairs (load or migration). The objects
  // of tables handed out before (table()) are kept and filled in place.
  fill(pairs) {
    for (const [key, value] of pairs) {
      if (key === 'meta') {
        for (const [k, v] of Object.entries(value || {})) if (!RESERVED.has(k)) this.db[k] = v;
      } else if (key.startsWith('acc:')) {
        this.db.accounts[key.slice(4)] = value;
      } else if (key.startsWith('char:')) {
        this.db.characters[key.slice(5)] = value;
      } else if (key.startsWith('t:')) {
        const rest = key.slice(2);
        const i = rest.indexOf(':');
        this.table(rest.slice(0, i))[rest.slice(i + 1)] = value;
      }
      // What is already on the backend need not be written again.
      this.written.set(key, digest(JSON.stringify(value)));
    }
  }

  table(name) {
    if (!this.db[name] || typeof this.db[name] !== 'object') this.db[name] = {};
    return this.db[name];
  }

  // The key of a record (null: not a record of the store).
  keyOf(rec) {
    if (!rec || typeof rec !== 'object') return null;
    const known = this.keys.get(rec);
    if (known) return known;
    if (rec.login && this.db.accounts[rec.login.toLowerCase()] === rec) return this._remember(rec, `acc:${rec.login.toLowerCase()}`);
    if (rec.id !== undefined && this.db.characters[rec.id] === rec) return this._remember(rec, `char:${rec.id}`);
    for (const [name, t] of Object.entries(this.db)) {
      if (RESERVED.has(name) || !t || typeof t !== 'object') continue;
      for (const [k, v] of Object.entries(t)) if (v === rec) return this._remember(rec, `t:${name}:${k}`);
    }
    return null;
  }

  _remember(rec, key) {
    this.keys.set(rec, key);
    return key;
  }

  // A character in play: part of every broad save until released.
  play(ch) {
    if (ch) this.hot.add(ch);
  }

  release(ch) {
    if (!ch) return;
    this.save(ch);
    this.hot.delete(ch);
  }

  save(rec) {
    if (rec === undefined) {
      this.broad = true;
    } else {
      const key = this.keyOf(rec);
      if (key) this.dirty.add(key);
      else this.broad = true;  // not a known record: be safe
    }
    this._schedule(FLUSH_MS);
  }

  _schedule(ms) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, ms);
    if (this.timer.unref) this.timer.unref();
  }

  // What changed: [{ key, json }] (json null: a table entry that is gone).
  _changes() {
    const keys = new Set(this.dirty);
    this.dirty.clear();
    let tablesScanned = false;
    if (this.broad) {
      this.broad = false;
      tablesScanned = true;
      keys.add('meta');
      for (const ch of this.hot) {
        const k = this.keyOf(ch);
        if (k) keys.add(k);
      }
      for (const [name, t] of Object.entries(this.db)) {
        if (RESERVED.has(name) || !t || typeof t !== 'object') continue;
        for (const k of Object.keys(t)) keys.add(`t:${name}:${k}`);
      }
    }
    const out = [];
    for (const key of keys) {
      const value = this._valueOf(key);
      if (value === undefined) {
        if (this.written.has(key)) out.push({ key, json: null });
        continue;
      }
      const json = JSON.stringify(value);
      if (this.written.get(key) === digest(json)) {
        this.stats.skipped++;
        continue;
      }
      out.push({ key, json });
    }
    // Table entries deleted since the last write.
    if (tablesScanned) {
      for (const key of this.written.keys()) {
        if (key.startsWith('t:') && !keys.has(key) && this._valueOf(key) === undefined) out.push({ key, json: null });
      }
    }
    return out;
  }

  _valueOf(key) {
    if (key === 'meta') {
      const meta = {};
      for (const [k, v] of Object.entries(this.db)) if (!v || typeof v !== 'object') meta[k] = v;
      return meta;
    }
    if (key.startsWith('acc:')) return this.db.accounts[key.slice(4)];
    if (key.startsWith('char:')) return this.db.characters[key.slice(5)];
    if (key.startsWith('t:')) {
      const rest = key.slice(2);
      const i = rest.indexOf(':');
      const t = this.db[rest.slice(0, i)];
      return t && typeof t === 'object' ? t[rest.slice(i + 1)] : undefined;
    }
    return undefined;
  }

  // Writes what changed. Resolves when written; a failure re-marks the records.
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // One write at a time; changes made meanwhile go in the next one.
    while (this.writing) await this.writing.catch(() => {});
    const changes = this._changes();
    if (!changes.length) return;
    this.writing = this.backend.write(changes);
    try {
      await this.writing;
      for (const c of changes) {
        if (c.json === null) this.written.delete(c.key);
        else this.written.set(c.key, digest(c.json));
      }
      this.stats.writes++;
      this.stats.records += changes.length;
      if (this.failures) this.log.log(`[storage] writing again after ${this.failures} failures`);
      this.failures = 0;
      this.retryMs = FLUSH_MS;
    } catch (err) {
      this.failures++;
      this.stats.failed++;
      for (const c of changes) this.dirty.add(c.key);
      this.log.error(`[storage] ${changes.length} records not written (${err.message}); retry in ${this.retryMs} ms`);
      const wait = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
      this._schedule(wait);
      throw err;
    } finally {
      this.writing = null;
    }
  }

  // Shutdown: everything marked goes now (synchronously where the backend can).
  async close() {
    this.broad = true;
    if (this.backend.writeSync && !this.writing) {
      const changes = this._changes();
      if (changes.length) this.backend.writeSync(changes);
    } else {
      await this.flush().catch(() => {});
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.backend.close();
  }
}

// The store described by the configuration: Redis when storage (conf.json) or
// GOMP_REDIS_URL names a redis:// URL, else files in dataDir.
function storageUrl(config) {
  const s = (config && config.storage) || process.env.GOMP_REDIS_URL || '';
  if (typeof s === 'string') return s.startsWith('redis://') ? s : '';
  return s && s.type === 'redis' ? s.url || '' : '';
}

// A store whose data is there at once (files) or after `ready` (Redis).
function open({ dataDir, config, log = console } = {}) {
  const url = storageUrl(config);
  if (!url) {
    const store = new Store(new FileBackend(dataDir, { log }), { log });
    store.fill(store.backend.loadSync());
    store.ready = Promise.resolve(store);
    store.kind = 'file';
    return store;
  }
  const { RedisBackend } = require('./redis');
  const store = new Store(new RedisBackend(url, { log }), { log });
  store.kind = 'redis';
  store.loaded = false;
  store.ready = (async () => {
    for (let wait = 500; ; wait = Math.min(wait * 2, 10000)) {
      try {
        await store.backend.connect();
        break;
      } catch (err) {
        log.warn(`[storage] redis ${url.replace(/\/\/[^@]*@/, '//***@')}: ${err.message}; retrying in ${wait} ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    // An empty Redis next to files: the files are moved in once.
    if ((await store.backend.count()) === 0) {
      const files = new FileBackend(dataDir, { log }).loadSync();
      if (files.length) {
        await store.backend.write(files.map(([key, value]) => ({ key, json: JSON.stringify(value) })));
        log.log(`[storage] ${files.length} records copied from ${dataDir} to redis`);
      }
    }
    store.fill(await store.backend.load());
    store.loaded = true;
    log.log(`[storage] redis: ${Object.keys(store.db.accounts).length} accounts, ${Object.keys(store.db.characters).length} characters`);
    return store;
  })();
  return store;
}

module.exports = { Store, open, storageUrl, FileBackend, defaultDir: (base) => path.join(base, 'data') };
