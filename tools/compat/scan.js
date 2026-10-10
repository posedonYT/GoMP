// What RAGE.MP API a mod uses, and what of it GoMP lacks:
//
//   node tools/compat/scan.js <folder> [--side server|client|cef] [--json]
//
// Every .js/.ts file of the folder (node_modules and minified bundles of other
// libraries skipped by size) is parsed with the TypeScript compiler. Counted:
//   - paths from `mp` (mp.events.add, mp.players.forEach, mp.game.ui.setNewWaypoint...);
//   - calls and properties on other objects whose name is a member of the API's
//     entity classes (player.setVariable, vehicle.numberPlate...): by name, since a
//     script's variables have no types.
// On the server side the result is checked against the live Node runtime
// (coverage.js); for the client and CEF sides GoMP's runtime is the list in
// clientHave (empty until the client JS runtime exists).

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { load } = require('./api');

const MAX_FILE = 4 * 1024 * 1024;

function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs|ts)$/.test(e.name) && !e.name.endsWith('.d.ts') && fs.statSync(p).size <= MAX_FILE) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// mp.a.b.c(...) -> 'mp.a.b.c'; also mp['a'].
function chainOf(node) {
  const parts = [];
  let n = node;
  while (ts.isPropertyAccessExpression(n) || (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression))) {
    parts.unshift(ts.isPropertyAccessExpression(n) ? n.name.text : n.argumentExpression.text);
    n = n.expression;
  }
  return ts.isIdentifier(n) && n.text === 'mp' ? ['mp', ...parts].join('.') : null;
}

// Usage of one source text: {paths: Map path -> count, members: Map name -> count}.
function usage(text, fileName = 'x.js') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const paths = new Map();
  const members = new Map();
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      // Only the longest chain: the parent of mp.a is mp.a.b when there is one.
      const parentIsAccess = node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node;
      const chain = chainOf(node);
      if (chain && !parentIsAccess) paths.set(chain, (paths.get(chain) || 0) + 1);
      if (!chain) members.set(node.name.text, (members.get(node.name.text) || 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { paths, members };
}

function merge(into, from) {
  for (const [k, v] of from) into.set(k, (into.get(k) || 0) + v);
}

// The API of a side, flattened: known paths and the members of its entity classes.
function apiOf(side) {
  const api = load(side);
  const paths = new Set(api.globals.keys());
  // Paths through pools and objects: mp.players.forEach comes from the pool's class.
  for (const [p, info] of api.globals) {
    if (info.kind === 'object' && info.type && api.classes.has(info.type))
      for (const m of api.classes.get(info.type).keys()) paths.add(`${p}.${m}`);
  }
  // mp.game.<namespace>.<native>: the namespaces are classes of their own on the client.
  const gameNs = side === 'client' ? gameNamespaces(api) : new Map();
  for (const [ns, natives] of gameNs) for (const n of natives) paths.add(`mp.game.${ns}.${n}`);
  const entityMembers = new Set();
  // Entities and their pools only (not the server's config, the world or the network settings).
  const notEntities = new Set(['ConfigMp', 'WorldMp', 'NetworkMp']);
  for (const [cls, members] of api.classes)
    if (/Mp(Pool)?$/.test(cls) && !/^Game/.test(cls) && !notEntities.has(cls)) for (const m of members.keys()) entityMembers.add(m);
  return { api, paths, entityMembers };
}

function gameNamespaces(api) {
  const out = new Map();
  const game = api.globals.get('mp.game');
  const gameCls = game && game.type && api.classes.get(game.type);
  if (!gameCls) return out;
  for (const [ns] of gameCls) {
    const clsName = [...api.classes.keys()].find((c) => c.toLowerCase() === `game${ns}mp`.toLowerCase());
    if (clsName) out.set(ns, [...api.classes.get(clsName).keys()]);
  }
  return out;
}

// What GoMP has of a side: a predicate on paths and on member names.
function implementation(side) {
  if (side !== 'server') return { hasPath: () => false, hasMember: () => false };
  const { liveRuntime } = require('./coverage');
  const { mp, instances } = liveRuntime();
  const resolve = (p) => {
    let o = mp;
    for (const part of p.split('.').slice(1)) {
      if (o === null || o === undefined) return undefined;
      try {
        o = o[part];
      } catch {
        return undefined;
      }
    }
    return o;
  };
  const objects = [...Object.values(instances), mp.players, mp.vehicles, mp.events, mp.world];
  return {
    hasPath: (p) => resolve(p) !== undefined,
    hasMember: (m) => objects.some((o) => o && m in Object(o)),
  };
}

function scan(dir, side = 'server') {
  const use = { paths: new Map(), members: new Map() };
  const list = files(dir);
  for (const f of list) {
    const u = usage(fs.readFileSync(f, 'utf8'), f);
    merge(use.paths, u.paths);
    merge(use.members, u.members);
  }
  const { paths: known, entityMembers } = apiOf(side);
  const impl = implementation(side);
  const rows = [];
  for (const [p, count] of use.paths) {
    // Only what the RAGE API has (a mod's own globals hung on mp are its business).
    const prefix = [...known].some((k) => k === p || p.startsWith(`${k}.`));
    if (!prefix) continue;
    rows.push({ api: p, kind: 'path', count, have: impl.hasPath(p) });
  }
  for (const [m, count] of use.members) {
    if (!entityMembers.has(m)) continue;
    rows.push({ api: `.${m}`, kind: 'member', count, have: impl.hasMember(m) });
  }
  rows.sort((a, b) => Number(a.have) - Number(b.have) || b.count - a.count || a.api.localeCompare(b.api));
  return { dir, side, files: list.length, used: rows.length, missing: rows.filter((r) => !r.have).length, rows };
}

function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const side = (args[args.indexOf('--side') + 1] && args.includes('--side')) ? args[args.indexOf('--side') + 1] : 'server';
  if (!dir) {
    console.error('usage: node tools/compat/scan.js <folder> [--side server|client|cef] [--json]');
    process.exit(2);
  }
  const r = scan(dir, side);
  if (args.includes('--json')) return console.log(JSON.stringify(r, null, 1));
  console.log(`${r.dir} (${r.side}): ${r.files} files, ${r.used} RAGE API names used, ${r.missing} missing in GoMP`);
  for (const row of r.rows) console.log(`${row.have ? '  ok ' : '  -- '} ${row.api.padEnd(48)} x${row.count}`);
  return undefined;
}

if (require.main === module) main();

module.exports = { scan, usage, apiOf, files };
