'use strict';
// The RAGE.MP compatibility runtime: keeps the mirror of the core's world,
// translates core operations into mp.* events and mp.* calls into commands.

const fs = require('fs');
const path = require('path');
const { Vector3 } = require('./vector3');
const { joaat } = require('./joaat');
const { EntityType, EntityTypeName, GLOBAL_DIMENSION } = require('./constants');

const MIRROR_STRIDE = 8; // values per entity in an 'updates' op (core: hostbridge.MirrorStride)
const E = require('./entities');
const P = require('./pools');
const { EventMp, EventMpPool } = require('./events');

const CLASSES = {
  [EntityType.player]: E.PlayerMp,
  [EntityType.vehicle]: E.VehicleMp,
  [EntityType.object]: E.ObjectMp,
  [EntityType.ped]: E.PedMp,
  [EntityType.blip]: E.BlipMp,
  [EntityType.checkpoint]: E.CheckpointMp,
  [EntityType.marker]: E.MarkerMp,
  [EntityType.colshape]: E.ColshapeMp,
  [EntityType.textlabel]: E.TextLabelMp,
  [EntityType.dummy]: E.DummyMp,
};

/** Placeholder for entity references decoded before the entity is known. */
class Ref {
  constructor(type, id) {
    this.type = type;
    this.id = id;
  }
}

class Runtime {
  /**
   * @param {{send(op: any[]): void, flush(): void}} link
   * @param {{packagesDir?: string, log?: Console, requireFn?: Function}} opts
   */
  constructor(link, opts = {}) {
    this.link = link;
    this.console = opts.log || console;
    this.packagesDir = opts.packagesDir;
    this.requireFn = opts.requireFn || require;
    this.config = {};
    this.info = { streamDistance: 500, maxPlayers: 100 };
    this.loaded = false;
    this.subscribed = new Set();
    this.procCalls = new Map();
    this.nextProcId = 1;
    this.alloc = {};
    this.events = new EventMpPool({
      subscribe: (names) => this._subscribe(names),
      unsubscribe: (names) => this._unsubscribe(names),
      log: (msg, err) => this.console.error(`[packages] ${msg}:`, err && err.stack ? err.stack : err),
    });
    this.pools = {
      player: new P.PlayerMpPool(this, EntityType.player, 100),
      vehicle: new P.VehicleMpPool(this, EntityType.vehicle, 8000),
      object: new P.ObjectMpPool(this, EntityType.object, 32000),
      ped: new P.PedMpPool(this, EntityType.ped, 2000),
      blip: new P.BlipMpPool(this, EntityType.blip, 4000),
      checkpoint: new P.CheckpointMpPool(this, EntityType.checkpoint, 2000),
      marker: new P.MarkerMpPool(this, EntityType.marker, 4000),
      colshape: new P.ColshapeMpPool(this, EntityType.colshape, 16000),
      textlabel: new P.TextLabelMpPool(this, EntityType.textlabel, 8000),
      dummy: new P.DummyMpPool(this, EntityType.dummy, 8000),
    };
    this.worldState = { weather: 'EXTRASUNNY', hour: 12, minute: 0, second: 0, trafficLocked: false, trafficState: 0 };
    this.mp = this._buildMp();
    this.decodeHooks = {
      vector3: (x, y, z) => new Vector3(x, y, z),
      entity: (type, id) => new Ref(type, id),
    };
    this.encodeHooks = {
      entityRef: (v) => (v instanceof E.EntityMp ? { type: v._t, id: v._id } : null),
      isVector3: (v) => v instanceof Vector3,
    };
  }

  pool(typeName) {
    return this.pools[typeName];
  }

  poolOf(type) {
    return this.pools[EntityTypeName[type]];
  }

  _send(op) {
    this.link.send(op);
  }

  // ------------------------------------------------------------ subscriptions

  _subscribe(names) {
    const fresh = names.filter((n) => !this.subscribed.has(n));
    for (const n of fresh) this.subscribed.add(n);
    if (fresh.length) this._send(['sub', fresh]);
  }

  _unsubscribe(names) {
    const still = new Set(this.events.subscriptions());
    const gone = names.filter((n) => this.subscribed.has(n) && !still.has(n));
    for (const n of gone) this.subscribed.delete(n);
    if (gone.length) this._send(['unsub', gone]);
  }

  // ------------------------------------------------------------ refs

  resolve(v) {
    if (v instanceof Ref) {
      const pool = this.poolOf(v.type);
      return pool ? pool.at(v.id) : undefined;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = this.resolve(v[i]);
      return v;
    }
    if (v !== null && typeof v === 'object' && !(v instanceof Vector3) && !(v instanceof E.EntityMp)) {
      for (const k of Object.keys(v)) v[k] = this.resolve(v[k]);
    }
    return v;
  }

  // ------------------------------------------------------------ core → host

  handle(op) {
    const name = op[0];
    switch (name) {
      case 'hello':
        return this._onHello(op[2] || {}, op[3] || {});
      case 'create':
        return this._onCreate(op[1], op[2], op[3], this.resolve(op[4] || {}));
      case 'destroy':
        return this._onDestroy(op[1], op[2], op[3]);
      case 'update':
        return this._onUpdate(op[1], op[2], this.resolve(op[3] || {}));
      case 'updates':
        return this._onUpdates(op[1] || []);
      case 'event':
        return this._onEvent(op[1], this.resolve(op[2] || []));
      case 'procReq':
        return this._onProcReq(op[1], this.resolve(op[2]), op[3], this.resolve(op[4] || []));
      case 'procRes':
        return this._onProcRes(op[1], op[2], this.resolve(op[3]));
      case 'ready':
        return this._onReady();
      case 'ping':
        this._send(['pong', op[1]]);
        return this.link.flush();
      case 'shutdown':
        return this._onShutdown();
      case 'error':
        return this.console.warn(`[core] ${op[1]}`);
      default:
        return this.console.warn(`[gomp] unknown operation from core: ${name}`);
    }
  }

  _onHello(config, info) {
    this.config = config;
    this.info = { ...this.info, ...info };
    if (info.maxPlayers) this.pools.player._capacity = info.maxPlayers;
    for (const [type, range] of Object.entries(info.ranges || {})) {
      const pool = this.poolOf(Number(type));
      if (pool) pool._capacity = range[1] - range[0];
      this.alloc[type] = { from: range[0], to: range[1], next: range[0], free: [], gens: new Map() };
    }
    if (info.weather) this.worldState.weather = info.weather;
    if (Array.isArray(info.time)) [this.worldState.hour, this.worldState.minute, this.worldState.second] = info.time;
    Object.assign(this.mp.config, config);
  }

  _onCreate(type, id, gen, state) {
    const pool = this.poolOf(type);
    const Cls = CLASSES[type];
    if (!pool || !Cls) return;
    const existing = pool.at(id);
    if (existing) {
      if (existing._origin === 'self') return; // our own create echoed by another path
      pool._remove(id);
    }
    const e = new Cls(this, type, id, gen, state);
    e._origin = 'core';
    pool._add(e);
  }

  _onDestroy(type, id, gen) {
    const pool = this.poolOf(type);
    const e = pool && pool.at(id);
    if (!e) return;
    if (e._origin === 'self') return; // we destroyed it ourselves already; the id may be reused
    if (type === EntityType.player && e._gen !== gen) return;
    pool._remove(id);
    // Scripts keep state per entity (fuel, owners...): they must hear about
    // entities the core removes too, or that state leaks.
    if (type !== EntityType.player) this.events.dispatch('entityDestroyed', [e]);
  }

  _onUpdate(type, id, fields) {
    const pool = this.poolOf(type);
    const e = pool && pool.at(id);
    if (!e) return;
    const s = e._s;
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'props' || k === 'shared' || k === 'own') {
        const m = s[k] || (s[k] = {});
        for (const [pk, pv] of Object.entries(v || {})) {
          if (pv === null) delete m[pk];
          else m[pk] = pv;
        }
      } else {
        s[k] = v;
      }
    }
  }

  // Synced state of many entities, MIRROR_STRIDE values each (core:
  // hostbridge.OpUpdates): type, id, pos, vel, rot (players: heading in x),
  // flags, move|steer, aim|null. Cheaper than a map per entity per tick.
  _onUpdates(v) {
    for (let i = 0; i + MIRROR_STRIDE <= v.length; i += MIRROR_STRIDE) {
      const pool = this.poolOf(v[i]);
      const e = pool && pool.at(v[i + 1]);
      if (!e) continue;
      const s = e._s;
      s.pos = v[i + 2];
      s.vel = v[i + 3];
      if (v[i] === EntityType.player) {
        s.heading = v[i + 4] ? v[i + 4].x : 0;
        s.flags = v[i + 5];
        s.move = v[i + 6];
        if (v[i + 7]) s.aimPos = v[i + 7];
      } else {
        s.rot = v[i + 4];
        s.vflags = v[i + 5];
        s.steer = v[i + 6];
      }
    }
  }

  _onEvent(name, args) {
    if (name === 'playerCommand') {
      if (this.events.runCommand(args[0], args[1])) return;
    }
    this.events.dispatch(name, args);
  }

  _onProcReq(callId, player, name, args) {
    const fn = this.events.getProc(name);
    const reply = (ok, v) => {
      this._send(['procRes', callId, ok, ok ? v : String(v && v.message ? v.message : v)]);
      this.link.flush();
    };
    if (!fn) return reply(false, `procedure not found: ${name}`);
    let result;
    try {
      result = fn(player, ...args);
    } catch (err) {
      this.console.error(`[packages] error in proc '${name}':`, err);
      return reply(false, err);
    }
    Promise.resolve(result).then(
      (v) => reply(true, v === undefined ? null : v),
      (err) => reply(false, err),
    );
    return undefined;
  }

  _onProcRes(hostCallId, ok, value) {
    const pending = this.procCalls.get(hostCallId);
    if (!pending) return;
    this.procCalls.delete(hostCallId);
    if (ok) pending.resolve(value);
    else pending.reject(new Error(String(value)));
  }

  _onReady() {
    if (this.loaded) return;
    this.loaded = true;
    global.mp = this.mp;
    const count = this.packagesDir ? this.loadPackages(this.packagesDir) : 0;
    const finish = () => {
      if (this.events.delayInitialization) {
        setTimeout(finish, 50);
        return;
      }
      this.events.dispatch('packagesLoaded', []);
      this._send(['loaded', count]);
      this.link.flush();
    };
    finish();
  }

  loadPackages(dir) {
    if (!fs.existsSync(dir)) {
      this.console.warn(`[gomp] packages directory ${dir} does not exist`);
      return 0;
    }
    const names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => d.name)
      .sort();
    let loaded = 0;
    for (const name of names) {
      const entry = path.join(dir, name);
      try {
        this.requireFn(entry);
        loaded++;
        this.console.log(`[gomp] package loaded: ${name}`);
      } catch (err) {
        this.console.error(`[gomp] failed to load package ${name}:`, err && err.stack ? err.stack : err);
      }
    }
    return loaded;
  }

  _onShutdown() {
    this.events.dispatch('serverShutdown', []);
    const wait = () => {
      if (this.events.delayShutdown) {
        setTimeout(wait, 50);
        return;
      }
      this._send(['shutdownReady']);
      this.link.flush();
    };
    wait();
  }

  // ------------------------------------------------------------ host → core

  _ensure(e) {
    if (!e._valid) throw new Error(`${e.type} ${e._id} does not exist anymore`);
  }

  _set(e, key, value) {
    this._ensure(e);
    const s = e._s;
    switch (key) {
      case 'props': {
        const m = s.props || (s.props = {});
        for (const [k, v] of Object.entries(value)) {
          if (v === null || v === undefined) delete m[k];
          else m[k] = v;
        }
        break;
      }
      case 'controller':
        s.controller = value ? value.id : -1;
        break;
      case 'weaponAmmo':
        if (s.weapons && s.weapon) s.weapons[s.weapon] = value;
        break;
      case 'eyeColor':
        (s.props || (s.props = {}))[22] = value;
        break;
      default:
        s[key] = value;
    }
    this._send(['set', e._t, e._id, e._gen, key, value]);
  }

  _call(e, method, args) {
    this._ensure(e);
    this._send(['call', e._t, e._id, e._gen, method, args]);
  }

  _shared(e, kv, own) {
    this._ensure(e);
    const target = own ? (e._s.own || (e._s.own = {})) : (e._s.shared || (e._s.shared = {}));
    for (const [k, v] of Object.entries(kv)) {
      if (v === null) delete target[k];
      else target[k] = v;
    }
    this._send(['call', e._t, e._id, e._gen, own ? 'setOwnVariables' : 'setVariables', [kv]]);
  }

  _global(method, args) {
    this._send(['global', method, args]);
  }

  _allocId(type) {
    const a = this.alloc[type];
    if (!a) throw new Error(`cannot create ${EntityTypeName[type]} before the core handshake`);
    if (a.free.length) return a.free.pop();
    if (a.next < a.to) return a.next++;
    throw new Error(`${EntityTypeName[type]} pool is full`);
  }

  _create(type, state) {
    const id = this._allocId(type);
    const a = this.alloc[type];
    const gen = a.gens.get(id) || 0;
    const Cls = CLASSES[type];
    const e = new Cls(this, type, id, gen, { ...state, shared: { ...(state.shared || {}) }, props: { ...(state.props || {}) } });
    e._origin = 'self';
    this.poolOf(type)._add(e);
    this._send(['create', type, id, state]);
    this.events.dispatch('entityCreated', [e]);
    return e;
  }

  _destroy(e) {
    if (!e._valid) return;
    if (e._t === EntityType.player) {
      this.console.warn('[gomp] players cannot be destroyed; use player.kick()');
      return;
    }
    this._send(['destroy', e._t, e._id, e._gen]);
    this.poolOf(e._t)._remove(e._id);
    const a = this.alloc[e._t];
    if (a) {
      a.gens.set(e._id, (a.gens.get(e._id) || 0) + 1);
      a.free.push(e._id);
    }
    this.events.dispatch('entityDestroyed', [e]);
  }

  _callProc(player, name, args) {
    this._ensure(player);
    const id = this.nextProcId++;
    return new Promise((resolve, reject) => {
      this.procCalls.set(id, { resolve, reject, player, name });
      this._send(['procCall', id, player._id, player._gen, name, args]);
    });
  }

  _hasPendingProc(player, name) {
    for (const p of this.procCalls.values()) {
      if (p.player === player && (name === undefined || p.name === name)) return true;
    }
    return false;
  }

  _cancelPendingProc(player, name) {
    for (const [id, p] of this.procCalls) {
      if (p.player === player && (name === undefined || p.name === name)) {
        this.procCalls.delete(id);
        p.reject(new Error('cancelled'));
      }
    }
  }

  streamedFor(entity) {
    const d = this.info.streamDistance || 500;
    const d2 = d * d;
    const dim = entity.dimension;
    return this.pools.player.toArray().filter((p) => p !== entity && p._s.spawned !== false
      && (p.dimension === dim || p.dimension === GLOBAL_DIMENSION || dim === GLOBAL_DIMENSION)
      && p.distSquared(entity.position) <= d2);
  }

  // ------------------------------------------------------------ mp

  _buildMp() {
    const rt = this;
    const ws = this.worldState;
    const world = {
      get weather() {
        return ws.weather;
      },
      set weather(v) {
        ws.weather = String(v).toUpperCase();
        rt._global('weather', [ws.weather]);
      },
      time: {
        get hour() {
          return ws.hour;
        },
        get minute() {
          return ws.minute;
        },
        get second() {
          return ws.second;
        },
        set(hour, minute = 0, second = 0) {
          Object.assign(ws, { hour: hour | 0, minute: minute | 0, second: second | 0 });
          rt._global('time', [hour | 0, minute | 0, second | 0]);
        },
      },
      setWeatherTransition(weather, duration = 0) {
        ws.weather = String(weather).toUpperCase();
        rt._global('weatherTransition', [ws.weather, Math.round(Number(duration) * 1000) || 0]);
      },
      requestIpl(name) {
        rt._global('requestIpl', [String(name)]);
      },
      removeIpl(name) {
        rt._global('removeIpl', [String(name)]);
      },
      trafficLights: {
        get locked() {
          return ws.trafficLocked;
        },
        set locked(v) {
          ws.trafficLocked = !!v;
          rt._global('trafficLights', [ws.trafficLocked, ws.trafficState]);
        },
        get state() {
          return ws.trafficState;
        },
        set state(v) {
          ws.trafficState = v | 0;
          rt._global('trafficLights', [ws.trafficLocked, ws.trafficState]);
        },
      },
    };
    const events = this.events;
    function Event(name, callback) {
      return new EventMp(events, name, callback);
    }
    return {
      players: this.pools.player,
      vehicles: this.pools.vehicle,
      objects: this.pools.object,
      peds: this.pools.ped,
      blips: this.pools.blip,
      checkpoints: this.pools.checkpoint,
      markers: this.pools.marker,
      colshapes: this.pools.colshape,
      labels: this.pools.textlabel,
      dummies: this.pools.dummy,
      events,
      world,
      config: {},
      network: { startBatch() {}, endBatch() {} },
      joaat,
      Vector3,
      Event,
      Entity: E.EntityMp,
      Player: E.PlayerMp,
      Vehicle: E.VehicleMp,
      Object: E.ObjectMp,
      Ped: E.PedMp,
      Blip: E.BlipMp,
      Marker: E.MarkerMp,
      Checkpoint: E.CheckpointMp,
      Colshape: E.ColshapeMp,
      TextLabel: E.TextLabelMp,
      Dummy: E.DummyMp,
      gomp: { version: 1, runtime: 'node' },
    };
  }
}

module.exports = { Runtime, Ref };
