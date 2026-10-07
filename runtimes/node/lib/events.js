'use strict';
// mp.events — RAGE.MP's server-side EventMpPool.

/** Events produced by the core; adding a handler subscribes to them. */
const CORE_EVENTS = new Set([
  'incomingConnection', 'playerJoin', 'playerReady', 'playerQuit', 'playerChat', 'playerCommand', 'playerDeath',
  'playerDamage', 'playerSpawn', 'playerEnterVehicle', 'playerExitVehicle', 'playerStartEnterVehicle',
  'playerStartExitVehicle', 'playerWeaponChange', 'playerEnterColshape', 'playerExitColshape',
  'playerEnterCheckpoint', 'playerExitCheckpoint', 'playerStreamIn', 'playerStreamOut', 'vehicleDeath',
  'vehicleDamage', 'vehicleHornToggle', 'vehicleSirenToggle', 'trailerAttached', 'playerSyncViolation',
  'playerReachWaypoint',
]);

/** Events raised inside the host itself; never subscribed at the core. */
const LOCAL_EVENTS = new Set(['packagesLoaded', 'serverShutdown', 'entityCreated', 'entityDestroyed', 'entityModelChange']);

class EventMp {
  constructor(pool, name, callback) {
    this._pool = pool;
    this.name = name;
    this.callback = callback;
    pool.add(name, callback);
  }

  destroy() {
    this._pool.remove(this.name, this.callback);
  }
}

class EventMpPool {
  /**
   * @param {object} link { subscribe(names), unsubscribe(names), log }
   */
  constructor(link) {
    this._link = link;
    this._handlers = new Map(); // name -> Function[]
    this._commands = new Map(); // name -> Function
    this._procs = new Map(); // name -> Function
    this.delayInitialization = false;
    this.delayShutdown = false;
    this.delayTermination = false;
  }

  get binded() {
    return [...this._handlers.entries()].map(([name, fns]) => ({ [name]: fns }));
  }

  add(name, callback) {
    if (name !== null && typeof name === 'object') {
      for (const [n, fn] of Object.entries(name)) this.add(n, fn);
      return;
    }
    if (typeof name !== 'string' || typeof callback !== 'function') {
      throw new TypeError('mp.events.add(eventName: string, callback: Function)');
    }
    let list = this._handlers.get(name);
    if (!list) {
      list = [];
      this._handlers.set(name, list);
      if (!LOCAL_EVENTS.has(name)) this._link.subscribe([name]);
    }
    list.push(callback);
  }

  remove(name, callback) {
    if (Array.isArray(name)) {
      for (const n of name) this.remove(n);
      return;
    }
    const list = this._handlers.get(name);
    if (!list) return;
    if (callback) {
      const i = list.indexOf(callback);
      if (i >= 0) list.splice(i, 1);
    } else {
      list.length = 0;
    }
    if (list.length === 0) {
      this._handlers.delete(name);
      if (!LOCAL_EVENTS.has(name)) this._link.unsubscribe([name]);
    }
  }

  reset() {
    for (const name of [...this._handlers.keys()]) this.remove(name);
    this._commands.clear();
    for (const name of [...this._procs.keys()]) this._link.unsubscribe([`proc:${name}`]);
    this._procs.clear();
  }

  getAllOf(name) {
    return [...(this._handlers.get(name) || [])];
  }

  /** Calls local server-side handlers (mp.events.call). */
  call(name, ...args) {
    this.dispatch(name, args);
  }

  /** Runs handlers, isolating exceptions so one broken package cannot stop others. */
  dispatch(name, args) {
    const list = this._handlers.get(name);
    if (!list) return 0;
    for (const fn of [...list]) {
      try {
        const r = fn.apply({ name, cancel: false }, args);
        if (r && typeof r.catch === 'function') {
          r.catch((err) => this._link.log(`unhandled rejection in '${name}' handler`, err));
        }
      } catch (err) {
        this._link.log(`error in '${name}' handler`, err);
      }
    }
    return list.length;
  }

  addCommand(name, callback) {
    if (name !== null && typeof name === 'object') {
      for (const [n, fn] of Object.entries(name)) this.addCommand(n, fn);
      return;
    }
    if (typeof name !== 'string' || typeof callback !== 'function') {
      throw new TypeError('mp.events.addCommand(commandName: string, callback: Function)');
    }
    const first = this._commands.size === 0;
    this._commands.set(name, callback);
    if (first) this._link.subscribe(['playerCommand']);
  }

  /** Handles a raw command line (without "/"). Returns true if a command matched. */
  runCommand(player, text) {
    const trimmed = String(text).trim();
    const space = trimmed.indexOf(' ');
    const cmd = space < 0 ? trimmed : trimmed.slice(0, space);
    const fullText = space < 0 ? '' : trimmed.slice(space + 1).trim();
    const fn = this._commands.get(cmd) || this._commands.get(cmd.toLowerCase());
    if (!fn) return false;
    const args = fullText.length ? fullText.split(/\s+/) : [];
    try {
      const r = fn(player, fullText, ...args);
      if (r && typeof r.catch === 'function') r.catch((err) => this._link.log(`command /${cmd}`, err));
    } catch (err) {
      this._link.log(`error in command /${cmd}`, err);
    }
    return true;
  }

  addProc(name, callback) {
    if (name !== null && typeof name === 'object') {
      for (const [n, fn] of Object.entries(name)) this.addProc(n, fn);
      return;
    }
    if (typeof name !== 'string' || typeof callback !== 'function') {
      throw new TypeError('mp.events.addProc(procName: string, callback: Function)');
    }
    this._procs.set(name, callback);
    this._link.subscribe([`proc:${name}`]);
  }

  getProc(name) {
    return this._procs.get(name);
  }

  /** Names to subscribe after a host restart or reconnect. */
  subscriptions() {
    const out = [];
    for (const name of this._handlers.keys()) if (!LOCAL_EVENTS.has(name)) out.push(name);
    if (this._commands.size) out.push('playerCommand');
    for (const name of this._procs.keys()) out.push(`proc:${name}`);
    return out;
  }
}

module.exports = { EventMp, EventMpPool, CORE_EVENTS, LOCAL_EVENTS };
