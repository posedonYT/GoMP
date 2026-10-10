// How much of the RAGE.MP server API GoMP's Node runtime has: every path from
// `mp` and every member of the API's classes (entities, pools, events, world),
// checked on a live runtime with one entity of each kind.
//
//   const r = serverCoverage();   // {total, have, sections: [{name, total, have, missing}]}

const path = require('path');
const { load } = require('./api');

const RUNTIME = path.join(__dirname, '..', '..', 'runtimes', 'node', 'lib');

// A Node runtime with no core behind it, an entity of each kind and a player.
function liveRuntime() {
  const { Runtime } = require(path.join(RUNTIME, 'runtime'));
  const { Vector3 } = require(path.join(RUNTIME, 'vector3'));
  const { EntityType } = require(path.join(RUNTIME, 'constants'));
  const rt = new Runtime({ send() {}, flush() {} }, { log: { log() {}, warn() {}, error() {} } });
  rt.handle(['hello', 1, { maxplayers: 10, name: 'compat' }, {
    maxPlayers: 10, streamDistance: 300, weather: 'CLEAR', time: [12, 0, 0],
    ranges: { 2: [0, 8000], 3: [0, 32000], 4: [0, 2000], 5: [0, 4000], 6: [0, 2000], 7: [0, 4000], 8: [0, 16000], 9: [0, 8000], 10: [0, 8000] },
  }]);
  rt.handle(['create', EntityType.player, 0, 1, {
    name: 'P', pos: new Vector3(0, 0, 70), dim: 0, health: 100, armour: 0, weapon: 0, weapons: {}, veh: -1, seat: 0,
    ip: '127.0.0.1', serial: 's', sc: 'P', spawned: true,
  }]);
  const mp = rt.mp;
  const pos = new mp.Vector3(0, 0, 0);
  const instances = {
    PlayerMp: mp.players.at(0),
    VehicleMp: mp.vehicles.new(mp.joaat('sultan'), pos),
    ObjectMp: mp.objects.new(mp.joaat('prop_bench_01a'), pos),
    PedMp: mp.peds.new(mp.joaat('a_m_y_skater_01'), pos),
    BlipMp: mp.blips.new(1, pos),
    MarkerMp: mp.markers.new(1, pos, 1),
    CheckpointMp: mp.checkpoints.new(1, pos, 1),
    ColshapeMp: mp.colshapes.newSphere(0, 0, 0, 1),
    TextLabelMp: mp.labels.new('x', pos),
    EventMp: new mp.Event('compat', () => {}),
  };
  try {
    instances.DummyMp = mp.dummies.new(1, pos, {});
  } catch {
    // no dummies: their members count as missing
  }
  instances.EntityMp = instances.VehicleMp;
  return { mp, instances };
}

// The live object a class of the API stands for.
function objectFor(name, mp, instances) {
  if (instances[name]) return instances[name];
  const pools = {
    PlayerMpPool: mp.players, VehicleMpPool: mp.vehicles, ObjectMpPool: mp.objects, PedMpPool: mp.peds, BlipMpPool: mp.blips,
    MarkerMpPool: mp.markers, CheckpointMpPool: mp.checkpoints, ColshapeMpPool: mp.colshapes, TextLabelMpPool: mp.labels,
    DummyMpPool: mp.dummies, EntityMpPool: mp.vehicles, EventMpPool: mp.events, WorldMp: mp.world, NetworkMp: mp.network, ConfigMp: mp.config,
  };
  return pools[name];
}

function resolve(root, dotted) {
  let o = root;
  for (const part of dotted.split('.').slice(1)) {
    if (o === null || o === undefined) return undefined;
    o = o[part];
  }
  return o;
}

function has(obj, name) {
  if (obj === null || obj === undefined) return false;
  try {
    return name in Object(obj);
  } catch {
    return false;
  }
}

function serverCoverage() {
  const api = load('server');
  const { mp, instances } = liveRuntime();
  const sections = [];
  // The paths from mp (only the first levels: the classes are counted below).
  const globals = { name: 'mp.*', total: 0, have: 0, missing: [] };
  for (const [p, info] of api.globals) {
    if (p.includes('.prototype.')) continue;
    const parent = p.slice(0, p.lastIndexOf('.'));
    const holder = parent === 'mp' ? mp : resolve(mp, parent);
    globals.total++;
    if (has(holder, p.slice(p.lastIndexOf('.') + 1))) globals.have++;
    else globals.missing.push(p);
    void info;
  }
  sections.push(globals);
  // ConfigMp is the server's conf.json: data, not API.
  for (const [cls, members] of api.classes) {
    if (cls === 'ConfigMp') continue;
    const obj = objectFor(cls, mp, instances);
    const s = { name: cls, total: 0, have: 0, missing: [] };
    for (const [m, info] of members) {
      // A member is counted where it is declared (inherited ones in their own class).
      if (info.declaredIn !== cls) continue;
      s.total++;
      if (has(obj, m)) s.have++;
      else s.missing.push(m);
    }
    if (s.total) sections.push(s);
  }
  const total = sections.reduce((n, s) => n + s.total, 0);
  const have = sections.reduce((n, s) => n + s.have, 0);
  return { side: 'server', total, have, sections };
}

module.exports = { serverCoverage, liveRuntime };
