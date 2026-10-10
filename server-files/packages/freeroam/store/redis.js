// Records in Redis: a JSON string per record (gomp:acc:<login>,
// gomp:char:<id>, gomp:t:<table>:<key>, gomp:meta). Loaded once at start
// (SCAN + MGET); changed records are written together in one MULTI/EXEC.
// For durability run Redis with appendonly yes / appendfsync everysec.

const { Resp } = require('./resp');

const PREFIX = 'gomp:';

class RedisBackend {
  constructor(url, { log = console, prefix = PREFIX, timeoutMs } = {}) {
    this.url = url;
    this.log = log;
    this.prefix = prefix;
    this.kind = 'redis';
    this.r = new Resp(url, { log, timeoutMs });
  }

  async connect() {
    await this.r.connect();
  }

  async load() {
    const keys = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.r.command(['SCAN', cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 1000]);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    const out = [];
    for (let i = 0; i < keys.length; i += 500) {
      const part = keys.slice(i, i + 500);
      const values = await this.r.command(['MGET', ...part]);
      part.forEach((k, j) => {
        if (values[j] === null) return;
        try {
          out.push([k.slice(this.prefix.length), JSON.parse(values[j])]);
        } catch (e) {
          this.log.error(`[storage] ${k}: ${e.message}`);
        }
      });
    }
    return out;
  }

  // Number of records (to know whether a migration from files is needed).
  async count() {
    let n = 0;
    let cursor = '0';
    do {
      const [next, batch] = await this.r.command(['SCAN', cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 1000]);
      cursor = next;
      n += batch.length;
    } while (cursor !== '0');
    return n;
  }

  async write(changes) {
    if (!changes.length) return;
    await this.r.exec(changes.map((c) => (c.json === null ? ['DEL', this.prefix + c.key] : ['SET', this.prefix + c.key, c.json])));
  }

  // Counter with an expiry (rate limits that survive a restart). Every hit
  // renews the expiry: whoever keeps trying stays limited (and it works on
  // Redis older than 7, which has no EXPIRE NX).
  async hit(key, ttlSec) {
    const k = `${this.prefix}rl:${key}`;
    const [n] = await this.r.exec([['INCR', k], ['EXPIRE', k, ttlSec]]);
    return n;
  }

  close() {
    this.r.close();
  }
}

module.exports = { RedisBackend, PREFIX };
