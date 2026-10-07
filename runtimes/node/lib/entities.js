'use strict';
// RAGE.MP server-side entity classes backed by the GoMP core.
//
// Getters read a local mirror kept up to date by the core; setters and
// methods update the mirror optimistically and queue a command for the core,
// which validates and applies it on its next tick.

const { Vector3 } = require('./vector3');
const { hashOf } = require('./joaat');
const { EntityTypeName, Prop, PedFlags, VehicleFlags, ShapeType } = require('./constants');

function vec(v) {
  if (v instanceof Vector3) return v;
  if (v && typeof v === 'object') return new Vector3(v.x, v.y, v.z);
  throw new TypeError('expected a Vector3');
}

class EntityMp {
  constructor(rt, type, id, gen, state) {
    Object.defineProperty(this, '_rt', { value: rt, enumerable: false });
    this._t = type;
    this._id = id;
    this._gen = gen || 0;
    this._s = state || {};
    this._valid = true;
  }

  get id() {
    return this._id;
  }

  get type() {
    return EntityTypeName[this._t];
  }

  get model() {
    return this._s.model >>> 0;
  }

  set model(v) {
    const old = this.model;
    const h = hashOf(v);
    this._rt._set(this, 'model', h);
    this._rt.events.dispatch('entityModelChange', [this, old]);
  }

  get position() {
    const p = this._s.pos;
    return p ? new Vector3(p.x, p.y, p.z) : new Vector3();
  }

  set position(v) {
    this._rt._set(this, 'pos', vec(v).clone());
  }

  get dimension() {
    return this._s.dim || 0;
  }

  set dimension(v) {
    this._rt._set(this, 'dim', Number(v) >>> 0);
  }

  get alpha() {
    return this._s.alpha === undefined ? 255 : this._s.alpha;
  }

  set alpha(v) {
    this._rt._set(this, 'alpha', Math.max(0, Math.min(255, Number(v) | 0)));
  }

  get data() {
    if (!this._dataProxy) {
      const self = this;
      Object.defineProperty(this, '_dataProxy', {
        enumerable: false,
        value: new Proxy({}, {
          get: (_, k) => (typeof k === 'string' ? self.getVariable(k) : undefined),
          set: (_, k, v) => {
            self.setVariable(String(k), v);
            return true;
          },
          deleteProperty: (_, k) => {
            self.setVariable(String(k), null);
            return true;
          },
          has: (_, k) => Object.prototype.hasOwnProperty.call(self._s.shared || {}, k),
          ownKeys: () => Object.keys(self._s.shared || {}),
          getOwnPropertyDescriptor: (_, k) => {
            const shared = self._s.shared || {};
            if (!Object.prototype.hasOwnProperty.call(shared, k)) return undefined;
            return { value: shared[k], writable: true, enumerable: true, configurable: true };
          },
        }),
      });
    }
    return this._dataProxy;
  }

  set data(obj) {
    if (obj && typeof obj === 'object') this.setVariables(obj);
  }

  getVariable(name) {
    const shared = this._s.shared;
    if (!shared || !Object.prototype.hasOwnProperty.call(shared, name)) return null;
    return shared[name];
  }

  setVariable(name, value) {
    if (name !== null && typeof name === 'object') return this.setVariables(name);
    this._rt._shared(this, { [name]: value === undefined ? null : value }, false);
    return undefined;
  }

  setVariables(values) {
    const kv = {};
    for (const [k, v] of Object.entries(values || {})) kv[k] = v === undefined ? null : v;
    this._rt._shared(this, kv, false);
  }

  hasVariable(name) {
    return this.getVariable(name) !== null;
  }

  dist(pos) {
    return Math.sqrt(this.distSquared(pos));
  }

  distSquared(pos) {
    const p = this._s.pos || { x: 0, y: 0, z: 0 };
    const dx = p.x - pos.x;
    const dy = p.y - pos.y;
    const dz = p.z - pos.z;
    return dx * dx + dy * dy + dz * dz;
  }

  destroy() {
    this._rt._destroy(this);
  }

  _prop(id) {
    return this._s.props ? this._s.props[id] : undefined;
  }

  _setProps(props) {
    this._rt._set(this, 'props', props);
  }

  _call(method, ...args) {
    this._rt._call(this, method, args);
  }
}

// ---------------------------------------------------------------- players

class PlayerWeaponCollection {
  constructor(player) {
    Object.defineProperty(this, '_p', { value: player, enumerable: false });
  }

  get current() {
    return this._p.weapon;
  }

  set current(v) {
    this._p.weapon = v;
  }

  get(hash) {
    return this._p.getWeaponAmmo(hash);
  }

  set(hash, ammo) {
    this._p.setWeaponAmmo(hash, ammo);
  }

  at(hash) {
    return this.get(hash);
  }

  reset() {
    this._p.removeAllWeapons();
  }

  forEach(fn) {
    for (const [h, a] of Object.entries(this._p.allWeapons)) fn(Number(h), a);
  }
}

class PlayerMp extends EntityMp {
  get name() {
    return this._s.name || '';
  }

  set name(v) {
    this._rt._set(this, 'name', String(v));
  }

  get health() {
    return this._s.health || 0;
  }

  set health(v) {
    this._rt._set(this, 'health', Math.max(0, Math.min(100, Math.round(Number(v) || 0))));
  }

  get armour() {
    return this._s.armour || 0;
  }

  set armour(v) {
    this._rt._set(this, 'armour', Math.max(0, Math.min(100, Math.round(Number(v) || 0))));
  }

  get armor() {
    return this.armour;
  }

  set armor(v) {
    this.armour = v;
  }

  get heading() {
    return this._s.heading || 0;
  }

  set heading(v) {
    this._rt._set(this, 'heading', Number(v) || 0);
  }

  get weapon() {
    return (this._s.weapon || 0) >>> 0;
  }

  set weapon(v) {
    this._rt._set(this, 'weapon', hashOf(v));
  }

  get weaponAmmo() {
    return this.getWeaponAmmo(this.weapon);
  }

  set weaponAmmo(v) {
    this._rt._set(this, 'weaponAmmo', Number(v) | 0);
  }

  get allWeapons() {
    const out = {};
    for (const [h, a] of Object.entries(this._s.weapons || {})) out[h] = a;
    return out;
  }

  get weapons() {
    return new PlayerWeaponCollection(this);
  }

  get vehicle() {
    const id = this._s.veh;
    if (id === undefined || id < 0) return null;
    return this._rt.pool('vehicle').at(id) || null;
  }

  get seat() {
    return this._s.veh === undefined || this._s.veh < 0 ? -1 : this._s.seat;
  }

  get ip() {
    return this._s.ip || '';
  }

  get serial() {
    return this._s.serial || '';
  }

  get socialClub() {
    return this._s.sc || '';
  }

  get rgscId() {
    return this._s.rgscId || '';
  }

  get gameType() {
    return this._s.gameType || 'gta5';
  }

  set gameType(v) {
    this._rt._set(this, 'gameType', String(v));
  }

  get ping() {
    return this._s.ping || 0;
  }

  get packetLoss() {
    return this._s.loss || 0;
  }

  get velocity() {
    const v = this._s.vel;
    return v ? new Vector3(v.x, v.y, v.z) : new Vector3();
  }

  _flag(f) {
    return ((this._s.flags || 0) & f) !== 0;
  }

  get isAiming() {
    return this._flag(PedFlags.aiming);
  }

  get isReloading() {
    return this._flag(PedFlags.reloading);
  }

  get isInMelee() {
    return this._flag(PedFlags.inMelee);
  }

  get isJumping() {
    return this._flag(PedFlags.jumping);
  }

  get isClimbing() {
    return this._flag(PedFlags.climbing);
  }

  get isOnLadder() {
    return this._flag(PedFlags.onLadder);
  }

  get isInCover() {
    return this._flag(PedFlags.inCover);
  }

  get isEnteringVehicle() {
    return this._flag(PedFlags.enteringVehicle);
  }

  get isLeavingVehicle() {
    return this._flag(PedFlags.leavingVehicle);
  }

  get aimTarget() {
    return null;
  }

  get action() {
    if (this._s.dead) return 'dead';
    if (this.vehicle) return 'in_vehicle';
    if (this.isAiming) return 'aiming';
    if (this.isJumping) return 'jumping';
    if (this.isClimbing) return 'climbing';
    if (this.isInCover) return 'cover';
    if ((this._s.move || 0) > 0) return 'moving';
    return 'stopped';
  }

  get dead() {
    return !!this._s.dead;
  }

  get eyeColor() {
    return this._prop(Prop.eyeColor) || 0;
  }

  set eyeColor(v) {
    this._rt._set(this, 'eyeColor', Number(v) | 0);
  }

  get hairColor() {
    const h = this._prop(Prop.hairColor);
    return h ? h[0] : 0;
  }

  get hairHighlightColor() {
    const h = this._prop(Prop.hairColor);
    return h ? h[1] : 0;
  }

  get disableOutgoingSync() {
    return !!this._s.disableOutgoingSync;
  }

  set disableOutgoingSync(v) {
    this._rt._set(this, 'disableOutgoingSync', !!v);
  }

  /** Players within stream distance in the same dimension (approximation of RAGE's stream set). */
  get streamedPlayers() {
    return this._rt.streamedFor(this);
  }

  get voiceListeners() {
    return [];
  }

  isStreamed(player) {
    return this.streamedPlayers.includes(player);
  }

  getOwnVariable(name) {
    const own = this._s.own;
    if (!own || !Object.prototype.hasOwnProperty.call(own, name)) return null;
    return own[name];
  }

  setOwnVariable(name, value) {
    this._rt._shared(this, { [name]: value === undefined ? null : value }, true);
  }

  setOwnVariables(values) {
    const kv = {};
    for (const [k, v] of Object.entries(values || {})) kv[k] = v === undefined ? null : v;
    this._rt._shared(this, kv, true);
  }

  spawn(position, heading) {
    const args = [vec(position)];
    if (heading !== undefined) args.push(Number(heading));
    this._s.dead = false;
    this._s.health = 100;
    this._s.pos = vec(position).clone();
    this._call('spawn', ...args);
  }

  giveWeapon(weapon, ammo = 0) {
    const hashes = Array.isArray(weapon) ? weapon.map(hashOf) : hashOf(weapon);
    const weapons = this._s.weapons || (this._s.weapons = {});
    for (const h of Array.isArray(hashes) ? hashes : [hashes]) weapons[h] = (weapons[h] || 0) + (ammo | 0);
    this._s.weapon = Array.isArray(hashes) ? hashes[hashes.length - 1] : hashes;
    this._call('giveWeapon', hashes, ammo | 0);
  }

  removeWeapon(weapon) {
    const h = hashOf(weapon);
    if (this._s.weapons) delete this._s.weapons[h];
    this._call('removeWeapon', h);
  }

  removeAllWeapons() {
    this._s.weapons = {};
    this._call('removeAllWeapons');
  }

  getWeaponAmmo(weapon) {
    const w = this._s.weapons || {};
    return w[hashOf(weapon)] || 0;
  }

  setWeaponAmmo(weapon, ammo) {
    const h = hashOf(weapon);
    if (this._s.weapons && h in this._s.weapons) this._s.weapons[h] = ammo | 0;
    this._call('setWeaponAmmo', h, ammo | 0);
  }

  putIntoVehicle(vehicle, seat = 0) {
    this._call('putIntoVehicle', vehicle, Number(seat) | 0);
  }

  removeFromVehicle() {
    this._call('removeFromVehicle');
  }

  kick(reason) {
    this._call('kick', reason === undefined ? 'kicked' : String(reason));
  }

  kickSilent() {
    this._call('kickSilent');
  }

  ban(reason) {
    this._call('ban', reason === undefined ? 'banned' : String(reason));
  }

  outputChatBox(message) {
    this._call('outputChatBox', String(message));
  }

  notify(message) {
    this._call('notify', String(message));
  }

  call(eventName, args = []) {
    this._call('call', String(eventName), Array.isArray(args) ? args : [args]);
  }

  callUnreliable(eventName, args = []) {
    this._call('callUnreliable', String(eventName), Array.isArray(args) ? args : [args]);
  }

  callToStreamed(includeSelf, eventName, args = []) {
    this._call('callToStreamed', !!includeSelf, String(eventName), Array.isArray(args) ? args : [args]);
  }

  callProc(procName, args = []) {
    return this._rt._callProc(this, String(procName), Array.isArray(args) ? args : [args]);
  }

  hasPendingProc(procName) {
    return this._rt._hasPendingProc(this, procName);
  }

  cancelPendingProc(procName) {
    this._rt._cancelPendingProc(this, procName);
  }

  invoke(hash, ...args) {
    this._call('invoke', typeof hash === 'string' ? hash : Number(hash), args);
  }

  eval(code) {
    this._call('eval', String(code));
  }

  setClothes(component, drawable, texture, palette = 2) {
    this._mapProp(Prop.clothes, component, [drawable | 0, texture | 0, palette | 0]);
    this._call('setClothes', component | 0, drawable | 0, texture | 0, palette | 0);
  }

  getClothes(component) {
    const c = (this._prop(Prop.clothes) || {})[component];
    return c ? { drawable: c[0], texture: c[1], palette: c[2] } : { drawable: 0, texture: 0, palette: 0 };
  }

  setProp(prop, drawable, texture) {
    this._mapProp(Prop.accessories, prop, [drawable | 0, texture | 0]);
    this._call('setProp', prop | 0, drawable | 0, texture | 0);
  }

  getProp(prop) {
    const p = (this._prop(Prop.accessories) || {})[prop];
    return p ? { drawable: p[0], texture: p[1] } : { drawable: -1, texture: 0 };
  }

  setHeadBlend(shapeFirst, shapeSecond, shapeThird, skinFirst, skinSecond, skinThird, shapeMix, skinMix, thirdMix) {
    const vals = [shapeFirst, shapeSecond, shapeThird, skinFirst, skinSecond, skinThird, shapeMix, skinMix, thirdMix].map(Number);
    this._localProp(Prop.headBlend, vals);
    this._call('setHeadBlend', ...vals);
  }

  updateHeadBlend(shapeMix, skinMix, thirdMix) {
    const old = (this._prop(Prop.headBlend) || [0, 0, 0, 0, 0, 0, 0, 0, 0]).slice();
    old[6] = Number(shapeMix);
    old[7] = Number(skinMix);
    old[8] = Number(thirdMix);
    this._localProp(Prop.headBlend, old);
    this._call('updateHeadBlend', old[6], old[7], old[8]);
  }

  getHeadBlend() {
    const b = this._prop(Prop.headBlend) || [0, 0, 0, 0, 0, 0, 0, 0, 0];
    return {
      shapes: [b[0], b[1], b[2]],
      skins: [b[3], b[4], b[5]],
      shapeMix: b[6],
      skinMix: b[7],
      thirdMix: b[8],
    };
  }

  setFaceFeature(index, scale) {
    this._mapProp(Prop.faceFeatures, index, Number(scale));
    this._call('setFaceFeature', index | 0, Number(scale));
  }

  getFaceFeature(index) {
    return (this._prop(Prop.faceFeatures) || {})[index] || 0;
  }

  setHeadOverlay(overlay, value) {
    const v = Array.isArray(value) ? value.map(Number) : [Number(value), 1, 0, 0];
    this._mapProp(Prop.headOverlays, overlay, v);
    this._call('setHeadOverlay', overlay | 0, v);
  }

  getHeadOverlay(overlay) {
    return (this._prop(Prop.headOverlays) || {})[overlay] || [255, 0, 0, 0];
  }

  setDecoration(collection, overlay) {
    this._call('setDecoration', hashOf(collection), hashOf(overlay));
  }

  getDecoration(collection) {
    const d = this._prop(Prop.decorations) || {};
    const prefix = `${hashOf(collection)}:`;
    const key = Object.keys(d).find((k) => k.startsWith(prefix));
    return key ? d[key] : 0;
  }

  clearDecorations() {
    this._localProp(Prop.decorations, null);
    this._call('clearDecorations');
  }

  setHairColor(first, second) {
    this._localProp(Prop.hairColor, [first | 0, second | 0]);
    this._call('setHairColor', first | 0, second | 0);
  }

  setCustomization(gender, shapeFirst, shapeSecond, shapeThird, skinFirst, skinSecond, skinThird, shapeMix, skinMix,
    thirdMix, eyeColor, hairColor, highlightColor, faceFeatures = []) {
    this._call('setCustomization', !!gender, shapeFirst, shapeSecond, shapeThird, skinFirst, skinSecond, skinThird,
      shapeMix, skinMix, thirdMix, eyeColor | 0, hairColor | 0, highlightColor | 0, faceFeatures.map(Number));
  }

  playAnimation(dict, name, speed = 8, flag = 0) {
    this._call('playAnimation', String(dict), String(name), Number(speed), flag | 0);
  }

  playScenario(scenario) {
    this._call('playScenario', String(scenario));
  }

  stopAnimation() {
    this._call('stopAnimation');
  }

  enableVoiceTo(target) {
    this._call('enableVoiceTo', target);
  }

  disableVoiceTo(target) {
    this._call('disableVoiceTo', target);
  }

  _localProp(id, value) {
    const props = this._s.props || (this._s.props = {});
    if (value === null) delete props[id];
    else props[id] = value;
  }

  _mapProp(id, key, value) {
    const props = this._s.props || (this._s.props = {});
    props[id] = { ...(props[id] || {}), [key]: value };
  }
}

// ---------------------------------------------------------------- vehicles

function quatFromEuler(r) {
  const d = Math.PI / 360;
  const qz = [0, 0, Math.sin(r.z * d), Math.cos(r.z * d)];
  const qx = [Math.sin(r.x * d), 0, 0, Math.cos(r.x * d)];
  const qy = [0, Math.sin(r.y * d), 0, Math.cos(r.y * d)];
  const mul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const q = mul(mul(qz, qx), qy);
  return { x: q[0], y: q[1], z: q[2], w: q[3] };
}

class VehicleMp extends EntityMp {
  get rotation() {
    const r = this._s.rot;
    return r ? new Vector3(r.x, r.y, r.z) : new Vector3();
  }

  set rotation(v) {
    this._rt._set(this, 'rot', vec(v).clone());
  }

  get heading() {
    let h = this.rotation.z % 360;
    if (h < 0) h += 360;
    return h;
  }

  set heading(v) {
    const r = this.rotation;
    r.z = Number(v) || 0;
    this.rotation = r;
  }

  get quaternion() {
    return quatFromEuler(this.rotation);
  }

  get velocity() {
    const v = this._s.vel;
    return v ? new Vector3(v.x, v.y, v.z) : new Vector3();
  }

  get steerAngle() {
    return (this._s.steer || 0) * 40;
  }

  _vflag(f) {
    return ((this._s.vflags || 0) & f) !== 0;
  }

  get horn() {
    return this._vflag(VehicleFlags.horn);
  }

  get siren() {
    return this._vflag(VehicleFlags.siren) || !!this._prop(Prop.siren);
  }

  get highbeams() {
    return this._vflag(VehicleFlags.highBeams);
  }

  get brake() {
    return this._vflag(VehicleFlags.handbrake);
  }

  get rocketBoost() {
    return false;
  }

  get engine() {
    return !!this._s.engine;
  }

  set engine(v) {
    this._rt._set(this, 'engine', !!v);
  }

  get locked() {
    return !!this._s.locked;
  }

  set locked(v) {
    this._rt._set(this, 'locked', !!v);
  }

  get dead() {
    return !!this._s.dead;
  }

  set dead(v) {
    this._rt._set(this, 'dead', !!v);
  }

  get movable() {
    return this._s.movable !== false;
  }

  set movable(v) {
    this._rt._set(this, 'movable', !!v);
  }

  get bodyHealth() {
    return this._s.bodyHealth === undefined ? 1000 : this._s.bodyHealth;
  }

  set bodyHealth(v) {
    this._rt._set(this, 'bodyHealth', Number(v));
  }

  get engineHealth() {
    return this._s.engineHealth === undefined ? 1000 : this._s.engineHealth;
  }

  set engineHealth(v) {
    this._rt._set(this, 'engineHealth', Number(v));
  }

  get controller() {
    const id = this._s.controller;
    return id === undefined || id < 0 ? undefined : this._rt.pool('player').at(id);
  }

  set controller(p) {
    this._rt._set(this, 'controller', p || null);
  }

  _simpleProp(id, def) {
    const v = this._prop(id);
    return v === undefined ? def : v;
  }

  get numberPlate() {
    return this._simpleProp(Prop.numberPlate, '');
  }

  set numberPlate(v) {
    this._setProps({ [Prop.numberPlate]: String(v).slice(0, 8) });
  }

  get numberPlateType() {
    return this._simpleProp(Prop.numberPlateType, 0);
  }

  set numberPlateType(v) {
    this._setProps({ [Prop.numberPlateType]: v | 0 });
  }

  get livery() {
    return this._simpleProp(Prop.livery, 0);
  }

  set livery(v) {
    this._setProps({ [Prop.livery]: v | 0 });
  }

  get neonEnabled() {
    const n = this._prop(Prop.neon);
    return n ? !!n[0] : false;
  }

  set neonEnabled(v) {
    const n = (this._prop(Prop.neon) || [false, 255, 255, 255]).slice();
    n[0] = !!v;
    this._setProps({ [Prop.neon]: n });
  }

  get pearlescentColor() {
    return this._simpleProp(Prop.pearlColor, 0);
  }

  set pearlescentColor(v) {
    this._setProps({ [Prop.pearlColor]: v | 0 });
  }

  get wheelColor() {
    return this._simpleProp(Prop.wheelColor, 0);
  }

  set wheelColor(v) {
    this._setProps({ [Prop.wheelColor]: v | 0 });
  }

  get wheelType() {
    return this._simpleProp(Prop.wheelType, 0);
  }

  set wheelType(v) {
    this._setProps({ [Prop.wheelType]: v | 0 });
  }

  get windowTint() {
    return this._simpleProp(Prop.windowTint, 0);
  }

  set windowTint(v) {
    this._setProps({ [Prop.windowTint]: v | 0 });
  }

  get dashboardColor() {
    return this._simpleProp(Prop.dashboardColor, 0);
  }

  set dashboardColor(v) {
    this._setProps({ [Prop.dashboardColor]: v | 0 });
  }

  get trimColor() {
    return this._simpleProp(Prop.trimColor, 0);
  }

  set trimColor(v) {
    this._setProps({ [Prop.trimColor]: v | 0 });
  }

  get taxiLights() {
    return !!this._prop(Prop.taxiLights);
  }

  set taxiLights(v) {
    this._setProps({ [Prop.taxiLights]: !!v });
  }

  get customTires() {
    return !!this._prop(Prop.customTires);
  }

  set customTires(v) {
    this._setProps({ [Prop.customTires]: !!v });
  }

  get extras() {
    const e = this._prop(Prop.extras) || {};
    const out = [];
    for (let i = 0; i <= 14; i++) out[i] = !!e[i];
    return out;
  }

  get mods() {
    const m = this._prop(Prop.mods) || {};
    const out = [];
    for (let i = 0; i < 50; i++) out[i] = m[i] === undefined ? -1 : m[i];
    return out;
  }

  get trailer() {
    return null;
  }

  get traileredBy() {
    return null;
  }

  get streamedPlayers() {
    return this._rt.streamedFor(this);
  }

  isStreamed(player) {
    return this.streamedPlayers.includes(player);
  }

  explode() {
    this._s.dead = true;
    this._call('explode');
  }

  repair() {
    Object.assign(this._s, { bodyHealth: 1000, engineHealth: 1000, dead: false });
    this._call('repair');
  }

  setColor(primary, secondary) {
    this._call('setColor', primary | 0, secondary | 0);
  }

  getColor(id) {
    const c = this._prop(Prop.colors);
    return c ? c[id ? 1 : 0] : 0;
  }

  setColorRGB(r1, g1, b1, r2, g2, b2) {
    this._call('setColorRGB', r1 | 0, g1 | 0, b1 | 0, r2 | 0, g2 | 0, b2 | 0);
  }

  getColorRGB(id) {
    const c = this._prop(Prop.colorRGB) || [0, 0, 0, 0, 0, 0];
    const o = id ? 3 : 0;
    return [c[o], c[o + 1], c[o + 2]];
  }

  setPaint(primaryType, primaryColor, secondaryType, secondaryColor) {
    this._call('setPaint', primaryType | 0, primaryColor | 0, secondaryType | 0, secondaryColor | 0);
  }

  getPaint(id) {
    const p = this._prop(Prop.paint) || [0, 0, 0, 0];
    return id ? p[3] : p[1];
  }

  setExtra(index, value) {
    this._call('setExtra', index | 0, !!value);
  }

  getExtra(index) {
    return !!(this._prop(Prop.extras) || {})[index];
  }

  setMod(modType, modIndex) {
    this._call('setMod', modType | 0, modIndex | 0);
  }

  getMod(modType) {
    const m = (this._prop(Prop.mods) || {})[modType];
    return m === undefined ? -1 : m;
  }

  setNeonColor(r, g, b) {
    this._call('setNeonColor', r | 0, g | 0, b | 0);
  }

  getNeonColor() {
    const n = this._prop(Prop.neon) || [false, 0, 0, 0];
    return [n[1], n[2], n[3]];
  }

  getOccupant(seat) {
    return this.getOccupants().find((p) => p.seat === seat);
  }

  getOccupants() {
    return this._rt.pool('player').toArray().filter((p) => p._s.veh === this._id);
  }

  setOccupant(seat, player) {
    this._call('setOccupant', seat | 0, player);
  }

  spawn(position, heading = 0) {
    this._call('spawn', vec(position), Number(heading));
  }
}

// ---------------------------------------------------------------- other entities

function propAccessor(cls, name, id, def, conv = (v) => v) {
  Object.defineProperty(cls.prototype, name, {
    configurable: true,
    get() {
      const v = this._prop(id);
      return v === undefined ? def : v;
    },
    set(v) {
      this._setProps({ [id]: conv(v) });
    },
  });
}

class ObjectMp extends EntityMp {
  get rotation() {
    const r = this._s.rot;
    return r ? new Vector3(r.x, r.y, r.z) : new Vector3();
  }

  set rotation(v) {
    this._rt._set(this, 'rot', vec(v).clone());
  }
}

class PedMp extends EntityMp {
  get heading() {
    return this._s.heading || 0;
  }

  set heading(v) {
    this._rt._set(this, 'heading', Number(v) || 0);
  }

  get controller() {
    const id = this._s.controller;
    return id === undefined || id < 0 ? undefined : this._rt.pool('player').at(id);
  }

  set controller(_) {
    // Ped AI sync arrives in a later phase; accepted for compatibility.
  }
}

class BlipMp extends EntityMp {
  routeFor(players, color = 0, scale = 1) {
    const list = players === undefined ? this._rt.pool('player').toArray() : [].concat(players);
    this._call('routeFor', list, color | 0, Number(scale));
  }

  unrouteFor(players) {
    this._call('unrouteFor', [].concat(players));
  }
}
propAccessor(BlipMp, 'sprite', Prop.blipSprite, 1, (v) => v | 0);
propAccessor(BlipMp, 'color', Prop.blipColor, 0, (v) => v | 0);
propAccessor(BlipMp, 'name', Prop.blipName, '', String);
propAccessor(BlipMp, 'scale', Prop.blipScale, 1, Number);
propAccessor(BlipMp, 'shortRange', Prop.blipShortRange, false, Boolean);
propAccessor(BlipMp, 'drawDistance', Prop.blipDrawDistance, 0, Number);
propAccessor(BlipMp, 'rotation', Prop.blipRotation, 0, Number);

class VisualMp extends EntityMp {
  getColor() {
    return (this._prop(this._colorProp) || [255, 255, 255, 255]).slice();
  }

  setColor(r, g, b, a = 255) {
    this._call('setColor', r | 0, g | 0, b | 0, a | 0);
    const props = this._s.props || (this._s.props = {});
    props[this._colorProp] = [r | 0, g | 0, b | 0, a | 0];
  }

  showFor(player) {
    this._call('showFor', player);
  }

  hideFor(player) {
    this._call('hideFor', player);
  }
}
propAccessor(VisualMp, 'visible', Prop.visible, true, Boolean);

class MarkerMp extends VisualMp {
  get _colorProp() {
    return Prop.markerColor;
  }
}
propAccessor(MarkerMp, 'scale', Prop.markerScale, 1, Number);
propAccessor(MarkerMp, 'direction', Prop.markerDirection, new Vector3(), (v) => vec(v));

class CheckpointMp extends VisualMp {
  get _colorProp() {
    return Prop.checkpointColor;
  }

  get radius() {
    return this._s.radius || 0;
  }

  set radius(v) {
    this._rt._set(this, 'radius', Number(v));
  }
}
propAccessor(CheckpointMp, 'destination', Prop.destination, new Vector3(), (v) => vec(v));

class TextLabelMp extends EntityMp {}
propAccessor(TextLabelMp, 'text', Prop.labelText, '', String);
propAccessor(TextLabelMp, 'color', Prop.labelColor, [255, 255, 255, 255], (v) => [].concat(v).map((n) => n | 0));
propAccessor(TextLabelMp, 'drawDistance', Prop.labelDrawDistance, 20, Number);
propAccessor(TextLabelMp, 'los', Prop.labelLOS, false, Boolean);
propAccessor(TextLabelMp, 'font', Prop.labelFont, 4, (v) => v | 0);

class ColshapeMp extends EntityMp {
  get shapeType() {
    return ShapeType[this._s.shape] || 'unknown';
  }

  isPointWithin(point) {
    const s = this._s;
    const o = s.pos || { x: 0, y: 0, z: 0 };
    const dx = point.x - o.x;
    const dy = point.y - o.y;
    const dz = point.z - o.z;
    switch (this.shapeType) {
      case 'circle':
        return dx * dx + dy * dy <= s.radius * s.radius;
      case 'sphere':
        return dx * dx + dy * dy + dz * dz <= s.radius * s.radius;
      case 'tube':
        return dx * dx + dy * dy <= s.radius * s.radius && dz >= 0 && dz <= s.height;
      case 'rectangle':
        return Math.abs(dx) <= s.width / 2 && Math.abs(dy) <= s.depth / 2;
      case 'cuboid':
        return Math.abs(dx) <= s.width / 2 && Math.abs(dy) <= s.depth / 2 && Math.abs(dz) <= s.height / 2;
      default:
        return false;
    }
  }
}

class DummyMp extends EntityMp {
  get dummyType() {
    return this._s.dummyType || 0;
  }
}

module.exports = {
  EntityMp, PlayerMp, VehicleMp, ObjectMp, PedMp, BlipMp, MarkerMp, CheckpointMp, TextLabelMp, ColshapeMp, DummyMp,
  PlayerWeaponCollection, quatFromEuler,
};
