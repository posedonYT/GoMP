// A Redis stand-in for the tests (real Redis cannot run on the development PC):
// a TCP server speaking RESP2 with the commands the store uses — PING, AUTH,
// SELECT, GET, SET, MGET, DEL, SCAN (MATCH, COUNT), INCR, EXPIRE, MULTI/EXEC.
// fail(n) makes the next n write transactions fail; drop() cuts every client.

const net = require('net');
const { Parser } = require('../store/resp');

function reply(v) {
  if (v === null || v === undefined) return '$-1\r\n';
  if (v instanceof Error) return `-${v.message}\r\n`;
  if (typeof v === 'number') return `:${v}\r\n`;
  if (Array.isArray(v)) return `*${v.length}\r\n${v.map(reply).join('')}`;
  if (v && v.simple) return `+${v.simple}\r\n`;
  const s = Buffer.from(String(v));
  return `$${s.length}\r\n${s.toString('binary')}\r\n`;
}

const OK = { simple: 'OK' };

function glob(pattern) {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

class FakeRedis {
  constructor({ password = '' } = {}) {
    this.data = new Map();
    this.password = password;
    this.failing = 0;
    this.commands = [];
    this.sockets = new Set();
    this.server = net.createServer((sock) => this._client(sock));
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => resolve(this.url())));
  }

  url(db = 0) {
    const { port } = this.server.address();
    return `redis://${this.password ? `:${this.password}@` : ''}127.0.0.1:${port}/${db}`;
  }

  fail(n = 1) {
    this.failing = n;
  }

  drop() {
    for (const s of this.sockets) s.destroy();
  }

  close() {
    this.drop();
    return new Promise((r) => this.server.close(() => r()));
  }

  _client(sock) {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => {});
    const parser = new Parser();
    const conn = { authed: !this.password, multi: null };
    sock.on('data', (chunk) => {
      parser.feed(chunk);
      for (let r = parser.take(); r; r = parser.take()) {
        const out = this._run(conn, r.value);
        if (out !== undefined) sock.write(Buffer.from(out, 'binary'));
      }
    });
  }

  _run(conn, args) {
    const cmd = String(args[0]).toUpperCase();
    this.commands.push(cmd);
    if (cmd === 'AUTH') {
      const pw = args[args.length - 1];
      conn.authed = pw === this.password;
      return reply(conn.authed ? OK : new Error('WRONGPASS invalid password'));
    }
    if (!conn.authed) return reply(new Error('NOAUTH Authentication required'));
    if (conn.multi && cmd !== 'EXEC') {
      conn.multi.push(args);
      return reply({ simple: 'QUEUED' });
    }
    switch (cmd) {
      case 'PING':
        return reply({ simple: 'PONG' });
      case 'SELECT':
        return reply(OK);
      case 'MULTI':
        conn.multi = [];
        return reply(OK);
      case 'EXEC': {
        const queued = conn.multi || [];
        conn.multi = null;
        const writes = queued.some((a) => ['SET', 'DEL', 'INCR', 'EXPIRE'].includes(String(a[0]).toUpperCase()));
        if (writes && this.failing > 0) {
          this.failing--;
          return reply(new Error('EXECABORT simulated failure'));
        }
        return `*${queued.length}\r\n${queued.map((a) => this._exec(a)).join('')}`;
      }
      default:
        return this._exec(args);
    }
  }

  _exec(args) {
    const cmd = String(args[0]).toUpperCase();
    switch (cmd) {
      case 'GET':
        return reply(this.data.has(args[1]) ? this.data.get(args[1]) : null);
      case 'SET':
        this.data.set(args[1], args[2]);
        return reply(OK);
      case 'MGET':
        return reply(args.slice(1).map((k) => (this.data.has(k) ? this.data.get(k) : null)));
      case 'DEL': {
        let n = 0;
        for (const k of args.slice(1)) if (this.data.delete(k)) n++;
        return reply(n);
      }
      case 'INCR': {
        const v = Number(this.data.get(args[1]) || 0) + 1;
        this.data.set(args[1], String(v));
        return reply(v);
      }
      case 'EXPIRE':
        return reply(this.data.has(args[1]) ? 1 : 0);
      case 'SCAN': {
        // Two pages, to exercise the cursor.
        const i = args.indexOf('MATCH');
        const re = glob(i > 0 ? args[i + 1] : '*');
        const keys = [...this.data.keys()].filter((k) => re.test(k));
        const start = Number(args[1]);
        const page = Math.max(1, Math.ceil(keys.length / 2));
        const next = start + page >= keys.length ? 0 : start + page;
        return reply([String(next), keys.slice(start, start + page)]);
      }
      default:
        return reply(new Error(`ERR unknown command ${cmd}`));
    }
  }
}

module.exports = { FakeRedis };
