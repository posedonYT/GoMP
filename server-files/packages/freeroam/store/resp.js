// A small Redis client (RESP2) with no dependencies: commands, pipelines and
// MULTI/EXEC, AUTH and SELECT from the URL, reconnection with backoff and a
// timeout per command. Enough for the gamemode's storage and rate limits.
//
//   const r = new Resp('redis://:password@127.0.0.1:6379/0');
//   await r.connect();
//   await r.command(['SET', 'k', 'v']);
//   await r.exec([['SET', 'a', '1'], ['DEL', 'b']]);   // MULTI ... EXEC

const net = require('net');

const CRLF = '\r\n';

function encode(args) {
  let out = `*${args.length}${CRLF}`;
  for (const a of args) {
    const s = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
    out += `$${s.length}${CRLF}`;
    out += s.toString('binary') + CRLF;
  }
  return Buffer.from(out, 'binary');
}

class RedisError extends Error {}

// Incremental RESP2 reader: feed() bytes, take() complete replies.
class Parser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
  }

  // A complete reply, or undefined when more bytes are needed.
  take() {
    const r = this._read(0);
    if (!r) return undefined;
    this.buf = this.buf.subarray(r.end);
    return r;
  }

  _line(at) {
    const i = this.buf.indexOf(CRLF, at);
    return i < 0 ? null : { text: this.buf.toString('utf8', at + 1, i), end: i + 2 };
  }

  _read(at) {
    if (at >= this.buf.length) return null;
    const type = String.fromCharCode(this.buf[at]);
    const line = this._line(at);
    if (!line) return null;
    switch (type) {
      case '+':
        return { value: line.text, end: line.end };
      case '-':
        return { value: new RedisError(line.text), end: line.end };
      case ':':
        return { value: Number(line.text), end: line.end };
      case '$': {
        const n = Number(line.text);
        if (n < 0) return { value: null, end: line.end };
        if (this.buf.length < line.end + n + 2) return null;
        return { value: this.buf.toString('utf8', line.end, line.end + n), end: line.end + n + 2 };
      }
      case '*': {
        const n = Number(line.text);
        if (n < 0) return { value: null, end: line.end };
        const items = [];
        let end = line.end;
        for (let i = 0; i < n; i++) {
          const item = this._read(end);
          if (!item) return null;
          items.push(item.value);
          end = item.end;
        }
        return { value: items, end };
      }
      default:
        throw new RedisError(`bad reply type ${JSON.stringify(type)}`);
    }
  }
}

function parseUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'redis:') throw new Error(`storage: not a redis:// URL: ${url}`);
  return {
    host: u.hostname || '127.0.0.1',
    port: Number(u.port) || 6379,
    password: u.password ? decodeURIComponent(u.password) : '',
    user: u.username ? decodeURIComponent(u.username) : '',
    db: Number((u.pathname || '/0').slice(1)) || 0,
  };
}

class Resp {
  constructor(url, { timeoutMs = 5000, log = console } = {}) {
    this.opts = parseUrl(url);
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.sock = null;
    this.ready = false;
    this.closing = false;
    this.waiting = [];   // { resolve, reject, timer } in send order
    this.backoff = 100;
  }

  // Connects (AUTH, SELECT); rejects when the first connection fails.
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.opts.host, port: this.opts.port });
      sock.setNoDelay(true);
      const parser = new Parser();
      let opened = false;
      sock.on('connect', async () => {
        opened = true;
        this.sock = sock;
        try {
          if (this.opts.password) {
            await this._raw(this.opts.user ? ['AUTH', this.opts.user, this.opts.password] : ['AUTH', this.opts.password]);
          }
          if (this.opts.db) await this._raw(['SELECT', this.opts.db]);
          this.ready = true;
          this.backoff = 100;
          resolve();
        } catch (err) {
          reject(err);
          sock.destroy();
        }
      });
      sock.on('data', (chunk) => {
        parser.feed(chunk);
        for (;;) {
          let r;
          try {
            r = parser.take();
          } catch (err) {
            sock.destroy(err);
            return;
          }
          if (!r) break;
          const w = this.waiting.shift();
          if (!w) continue;
          clearTimeout(w.timer);
          if (r.value instanceof RedisError) w.reject(r.value);
          else w.resolve(r.value);
        }
      });
      sock.on('error', (err) => {
        if (!opened) reject(err);
      });
      sock.on('close', () => {
        this.ready = false;
        this.sock = null;
        // Everything in flight failed: the caller keeps its data and retries.
        for (const w of this.waiting.splice(0)) {
          clearTimeout(w.timer);
          w.reject(new RedisError('connection lost'));
        }
        if (opened && !this.closing) this._reconnect();
      });
    });
  }

  _reconnect() {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 5000);
    setTimeout(() => {
      if (this.closing) return;
      this.connect().catch((err) => {
        this.log.warn(`[storage] redis ${this.opts.host}:${this.opts.port}: ${err.message}; retrying`);
        this._reconnect();
      });
    }, delay).unref();
  }

  _raw(args) {
    return new Promise((resolve, reject) => {
      if (!this.sock) {
        reject(new RedisError('not connected'));
        return;
      }
      const timer = setTimeout(() => {
        // A reply that never comes: the connection is broken, start over.
        reject(new RedisError(`timeout: ${args[0]}`));
        if (this.sock) this.sock.destroy();
      }, this.timeoutMs);
      timer.unref();
      this.waiting.push({ resolve, reject, timer });
      this.sock.write(encode(args));
    });
  }

  command(args) {
    if (!this.ready) return Promise.reject(new RedisError('not connected'));
    return this._raw(args);
  }

  // Several commands written at once; resolves with every reply (errors as values).
  pipeline(cmds) {
    if (!this.ready) return Promise.reject(new RedisError('not connected'));
    return Promise.all(cmds.map((c) => this._raw(c).catch((e) => e)));
  }

  // MULTI ... EXEC: all or nothing. Resolves with the replies of the commands.
  async exec(cmds) {
    if (!this.ready) throw new RedisError('not connected');
    const replies = await Promise.all([this._raw(['MULTI']), ...cmds.map((c) => this._raw(c)), this._raw(['EXEC'])]);
    const result = replies[replies.length - 1];
    if (result === null) throw new RedisError('transaction aborted');
    return result;
  }

  close() {
    this.closing = true;
    if (this.sock) this.sock.end();
  }
}

module.exports = { Resp, Parser, RedisError, encode, parseUrl };
