// A small stand-in for the RAGE.MP server API (the parts the freeroam package
// uses), so the gamemode runs under `node --test` without the GoMP core.
// Require it before any module of the package.
//
//   const fake = require('./fakemp');
//   const player = fake.join({ name: 'Tester' });
//   fake.emit('gomp:inv:use', player, 'pockets', 0);
//   fake.tick();                         // one run of every setInterval callback

const fs = require('fs');
const os = require('os');
const path = require('path');
const { joaat } = require('../../../../runtimes/node/lib/joaat');

// The account database and the maps go to fresh temporary folders.
process.env.GOMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gomp-test-'));
process.env.GOMP_MAPS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gomp-maps-'));

// Intervals are collected (and never keep the test process alive); tick() runs them.
const intervals = [];
const realSetInterval = global.setInterval;
global.setInterval = (fn, ms, ...args) => {
  intervals.push(() => fn(...args));
  const t = realSetInterval(fn, ms, ...args);
  if (t.unref) t.unref();
  return t;
};

class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  subtract(o) { return new Vector3(this.x - o.x, this.y - o.y, this.z - o.z); }
  add(o) { return new Vector3(this.x + o.x, this.y + o.y, this.z + o.z); }
  length() { return Math.hypot(this.x, this.y, this.z); }
}

const handlers = new Map();
const commands = new Map();

function emit(name, ...args) {
  let result;
  for (const fn of handlers.get(name) || []) result = fn(...args);
  return result;
}

class Pool {
  constructor(type) {
    this.type = type;
    this.items = new Map();
    this.nextId = 0;
  }
  add(e) {
    e.id = this.nextId++;
    e.type = this.type;
    this.items.set(e.id, e);
    return e;
  }
  at(id) { return this.items.get(Number(id)); }
  exists(e) { return !!e && this.items.get(typeof e === 'number' ? e : e.id) !== undefined && (typeof e === 'number' || this.items.get(e.id) === e); }
  toArray() { return [...this.items.values()]; }
  forEach(fn) { this.toArray().forEach((e) => fn(e, e.id)); }
  forEachInRange(pos, range, dim, fn) {
    for (const e of this.toArray())
      if ((dim === undefined || e.dimension === dim) && e.position.subtract(pos).length() <= range) fn(e, e.id);
  }
  get length() { return this.items.size; }
  remove(e) {
    if (this.items.get(e.id) !== e) return;
    this.items.delete(e.id);
    emit('entityDestroyed', e);
  }
}

class Entity {
  constructor(pool) {
    this._pool = pool;
    this.vars = {};
    this.dimension = 0;
    this.position = new Vector3();
  }
  getVariable(k) { return Object.prototype.hasOwnProperty.call(this.vars, k) ? this.vars[k] : null; }
  setVariable(k, v) {
    if (k !== null && typeof k === 'object') return this.setVariables(k);
    this.vars[k] = v === undefined ? null : v;
    return undefined;
  }
  setVariables(o) { for (const [k, v] of Object.entries(o)) this.setVariable(k, v); }
  hasVariable(k) { return this.getVariable(k) !== null; }
  destroy() { this._pool.remove(this); }
}

class Player extends Entity {
  constructor(opts) {
    super(players);
    Object.assign(this, { name: 'Player', ip: '127.0.0.1', serial: 'test-serial', health: 100, armour: 0, heading: 0,
      dead: false, vehicle: null, seat: -1, weapon: 0, model: 0 }, opts);
    this.notes = [];
    this.calls = [];
    this.chat = [];
    this.weapons = new Map();
    this.own = {};
    this.anims = [];
  }
  notify(t) { this.notes.push(t); }
  outputChatBox(t) { this.chat.push(t); }
  call(name, args = []) { this.calls.push([name, args]); }
  lastCall(name) { return [...this.calls].reverse().find(([n]) => n === name)?.[1]; }
  setOwnVariables(o) { Object.assign(this.own, o); }
  spawn(pos, heading) { this.position = pos; this.heading = heading || 0; this.dead = false; }
  giveWeapon(hash, ammo) { this.weapons.set(hash, ammo); }
  removeAllWeapons() { this.weapons.clear(); }
  getWeaponAmmo(hash) { return this.weapons.get(hash) || 0; }
  setWeaponAmmo(hash, ammo) { if (this.weapons.has(hash)) this.weapons.set(hash, ammo); }
  putIntoVehicle(veh, seat) { this.vehicle = veh; this.seat = seat; }
  removeFromVehicle() { this.vehicle = null; this.seat = -1; }
  playAnimation(dict, name) { this.anims.push(`${dict}/${name}`); }
  playScenario(s) { this.anims.push(s); }
  stopAnimation() { this.anims.push('stop'); }
  kick(reason) { this.kicked = reason; }
  ban(reason) { this.banned = reason; }
  setClothes() {}
  setHeadBlend() {}
  setHairColor() {}
  setHeadOverlay() {}
}

class Vehicle extends Entity {
  constructor(model, pos, opts = {}) {
    super(vehicles);
    Object.assign(this, { model, position: pos, heading: opts.heading || 0, dimension: opts.dimension || 0,
      engine: !!opts.engine, locked: !!opts.locked, dead: false, bodyHealth: 1000, engineHealth: 1000,
      numberPlate: opts.numberPlate || '', pearlescentColor: 0, wheelColor: 0, wheelType: 0, windowTint: 0,
      numberPlateType: 0, livery: 0, neonEnabled: false });
    this._mods = {};
    this._colors = [0, 0];
    this._neon = [255, 255, 255];
  }
  get mods() { return Array.from({ length: 50 }, (_, i) => (this._mods[i] === undefined ? -1 : this._mods[i])); }
  setMod(type, index) { if (index < 0) delete this._mods[type]; else this._mods[type] = index; }
  getMod(type) { return this._mods[type] === undefined ? -1 : this._mods[type]; }
  setColor(p, s) { this._colors = [p, s]; }
  getColor(i) { return this._colors[i ? 1 : 0]; }
  setNeonColor(r, g, b) { this._neon = [r, g, b]; }
  getNeonColor() { return [...this._neon]; }
  repair() { Object.assign(this, { bodyHealth: 1000, engineHealth: 1000, dead: false }); this.repaired = (this.repaired || 0) + 1; }
  getOccupant(seat) { return players.toArray().find((p) => p.vehicle === this && p.seat === seat); }
}

class SimpleEntity extends Entity {
  constructor(pool, model, pos, opts = {}) {
    super(pool);
    Object.assign(this, { model, position: pos, rotation: opts.rotation, dimension: opts.dimension || 0, alpha: opts.alpha === undefined ? 255 : opts.alpha });
  }
}

const players = new Pool('player');
const vehicles = new Pool('vehicle');
const objects = new Pool('object');
const blips = new Pool('blip');

players.broadcast = (msg) => players.forEach((p) => p.outputChatBox(msg));

global.mp = {
  Vector3,
  joaat,
  events: {
    add(name, fn) {
      if (typeof name === 'object') {
        for (const [n, f] of Object.entries(name)) this.add(n, f);
        return;
      }
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    addCommand(name, fn) { commands.set(name, fn); },
    call: emit,
  },
  players,
  vehicles: Object.assign(vehicles, { new: (model, pos, opts) => vehicles.add(new Vehicle(model, pos, opts)) }),
  objects: Object.assign(objects, { new: (model, pos, opts) => objects.add(new SimpleEntity(objects, model, pos, opts)) }),
  blips: Object.assign(blips, { new: (sprite, pos, opts = {}) => blips.add(Object.assign(new SimpleEntity(blips, sprite, pos, opts), { sprite, ...opts })) }),
  world: { time: { set() {} }, weather: 'EXTRASUNNY' },
};

// A player who connected (playerJoin) and is ready (playerReady: the login screen).
function join(opts = {}) {
  const p = players.add(new Player(opts));
  emit('playerJoin', p);
  emit('playerReady', p);
  return p;
}

// Registers an account and creates a character: the player is then in the game.
let accountNo = 0;
function login(player, character = {}) {
  accountNo++;
  emit('gomp:auth:register', player, `tester${accountNo}`, 'password123');
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const n = accountNo;
  const unique = `${letters[Math.floor(n / 26) % 26]}${letters[n % 26]}`;
  emit('gomp:chars:create', player, { first: `Ivan${unique}`, last: 'Petrov', gender: 'm', kit: 0, ...character });
  return player;
}

// /command [args] as the player typed it.
function command(player, line) {
  const [name, ...args] = line.replace(/^\//, '').split(' ');
  const fn = commands.get(name);
  if (!fn) throw new Error(`no command /${name}`);
  return fn(player, args.join(' '), ...args);
}

module.exports = {
  Vector3, Player, Vehicle, players, vehicles, objects, blips, emit, join, login, command,
  tick: () => intervals.forEach((fn) => fn()),
  handlers, commands,
};
