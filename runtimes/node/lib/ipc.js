'use strict';
// Framed IPC link to the GoMP core (see core/internal/hostbridge).

const net = require('net');
const { frame, decode } = require('./codec');

const MAX_FRAME = 64 * 1024 * 1024;

class IpcLink {
  /**
   * @param {{network: string, addr: string, token: string, name: string}} endpoint
   */
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.queue = [];
    this.scheduled = false;
    this.encodeHooks = null;
    this.decodeHooks = null;
    this.onOps = () => {};
    this.onClose = () => {};
    this.chunks = [];
    this.buffered = 0;
  }

  connect() {
    const { network, addr } = this.endpoint;
    return new Promise((resolve, reject) => {
      const opts = network === 'unix' ? { path: addr } : (() => {
        const i = addr.lastIndexOf(':');
        return { host: addr.slice(0, i), port: Number(addr.slice(i + 1)) };
      })();
      const sock = net.createConnection(opts, () => {
        sock.setNoDelay(true);
        sock.write(frame([['auth', this.endpoint.token, this.endpoint.name]]));
        resolve();
      });
      sock.on('error', (err) => {
        reject(err);
        this.onClose(err);
      });
      sock.on('close', () => this.onClose());
      sock.on('data', (d) => this._onData(d));
      this.sock = sock;
    });
  }

  _onData(chunk) {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (this.buffered >= 4) {
      const head = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      this.chunks = [head];
      const len = head.readUInt32LE(0);
      if (len > MAX_FRAME) {
        this.sock.destroy(new Error(`frame of ${len} bytes`));
        return;
      }
      if (head.length < 4 + len) return;
      const body = head.subarray(4, 4 + len);
      const rest = head.subarray(4 + len);
      this.chunks = rest.length ? [rest] : [];
      this.buffered = rest.length;
      let ops;
      try {
        ops = decode(body, this.decodeHooks);
      } catch (err) {
        console.error('[gomp] malformed frame from core:', err);
        continue;
      }
      this.onOps(ops);
    }
  }

  /** Queues an op; all ops of the current macrotask go out as one frame. */
  send(op) {
    this.queue.push(op);
    if (this.queue.length >= 4096) {
      this.flush();
      return;
    }
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this.flush());
    }
  }

  flush() {
    this.scheduled = false;
    if (!this.queue.length || !this.sock) return;
    const ops = this.queue;
    this.queue = [];
    try {
      this.sock.write(frame(ops, this.encodeHooks));
    } catch (err) {
      console.error('[gomp] cannot encode operations for the core:', err);
    }
  }

  close() {
    if (this.sock) this.sock.end();
  }
}

module.exports = { IpcLink };
