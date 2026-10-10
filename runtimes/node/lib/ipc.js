'use strict';
// Framed IPC link to the GoMP core (see core/internal/hostbridge).

const net = require('net');
const { frame, decode } = require('./codec');

const MAX_FRAME = 64 * 1024 * 1024;
// Ops waiting while the socket is full; past this a warning is logged (once
// per backlog) so a host that outruns the core is visible.
const QUEUE_WARN = 200000;

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
    this.need = 0;         // size of the frame being received (header + body), 0: header not read yet
    this.blocked = false;  // the socket buffer is full: wait for 'drain'
    this.warned = false;
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
      sock.on('drain', () => {
        this.blocked = false;
        this.warned = false;
        this.flush();
      });
      this.sock = sock;
    });
  }

  // Chunks are joined once per complete frame: joining on every chunk made a
  // large frame cost O(n²) while it arrived.
  _onData(chunk) {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (this.buffered >= 4) {
      if (this.need === 0) {
        const len = this._peek4().readUInt32LE(0);
        if (len > MAX_FRAME) {
          this.sock.destroy(new Error(`frame of ${len} bytes`));
          return;
        }
        this.need = 4 + len;
      }
      if (this.buffered < this.need) return;
      const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
      const body = all.subarray(4, this.need);
      const rest = all.subarray(this.need);
      this.chunks = rest.length ? [rest] : [];
      this.buffered = rest.length;
      this.need = 0;
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

  // The first four bytes, wherever the chunk boundaries are.
  _peek4() {
    if (this.chunks[0].length >= 4) return this.chunks[0];
    const head = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [head];
    return head;
  }

  /** Queues an op; all ops of the current macrotask go out as one frame. */
  send(op) {
    this.queue.push(op);
    if (this.blocked) {
      if (!this.warned && this.queue.length > QUEUE_WARN) {
        this.warned = true;
        console.warn(`[gomp] ${this.queue.length} operations wait for the core (the link is full)`);
      }
      return;
    }
    if (this.queue.length >= 4096) {
      this.flush();
      return;
    }
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this.flush());
    }
  }

  // While the socket is full (write returned false) nothing more is written:
  // ops keep queueing and go out as one frame on 'drain', instead of piling
  // up in Node's write buffer without limit.
  flush() {
    this.scheduled = false;
    if (!this.queue.length || !this.sock || this.blocked) return;
    const ops = this.queue;
    this.queue = [];
    try {
      if (!this.sock.write(frame(ops, this.encodeHooks))) this.blocked = true;
    } catch (err) {
      console.error('[gomp] cannot encode operations for the core:', err);
    }
  }

  /** Ops waiting to be written (diagnostics). */
  get queued() {
    return this.queue.length;
  }

  close() {
    if (this.sock) this.sock.end();
  }
}

module.exports = { IpcLink };
