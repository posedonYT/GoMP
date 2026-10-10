const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { load } = require('../api');
const { serverCoverage } = require('../coverage');
const { scan, usage } = require('../scan');
const { build } = require('../report');

test('the RAGE API is read from the type definitions', () => {
  const server = load('server');
  assert.ok(server.globals.has('mp.events'));
  assert.equal(server.globals.get('mp.players').type, 'PlayerMpPool');
  assert.ok(server.classes.get('PlayerMp').has('setVariable'));
  assert.equal(server.classes.get('PlayerMp').get('setVariable').declaredIn, 'EntityMp', 'inherited members are marked');
  const client = load('client');
  assert.ok(client.globals.has('mp.browsers') && client.globals.has('mp.gui'));
  const gui = client.globals.get('mp.gui');
  assert.ok(client.classes.get(gui.type).has('chat'), 'mp.gui.chat');
  assert.ok([...client.classes.keys()].some((c) => /^Game.*Mp$/.test(c)), 'mp.game namespaces');
  assert.deepEqual([...load('cef').globals.keys()].sort(), ['mp.events', 'mp.invoke', 'mp.trigger']);
});

test('the server JS runtime has almost all of the RAGE server API (regressions fail here)', () => {
  const r = serverCoverage();
  assert.ok(r.total > 250, `${r.total} API names`);
  assert.ok(r.have / r.total >= 0.98, `${r.have}/${r.total}`);
  const mp = r.sections.find((s) => s.name === 'mp.*');
  assert.deepEqual(mp.missing, [], 'every path from mp');
  for (const name of ['PlayerMp', 'VehicleMp', 'EventMpPool', 'ColshapeMpPool'])
    assert.deepEqual(r.sections.find((s) => s.name === name).missing, [], name);
});

test('a script\'s use of the API: paths from mp and members by name', () => {
  const u = usage(`
    mp.events.add('playerJoin', (player) => { player.setVariable('x', 1); player.outputChatBox('hi'); });
    mp['players'].forEach((p) => p.notify('x'));
    const myLib = { mp: 1 }; myLib.mp.thing;
    mp.events.add('x', () => {});
  `);
  assert.equal(u.paths.get('mp.events.add'), 2);
  assert.equal(u.paths.get('mp.players.forEach'), 1);
  assert.ok(!u.paths.has('mp.events'), 'only the longest chain');
  assert.equal(u.members.get('setVariable'), 1);
  assert.ok(!u.paths.has('mp.thing'));
  // TypeScript sources are read too.
  assert.equal(usage('const p: PlayerMp = mp.players.at(0) as PlayerMp; p.spawn(new mp.Vector3(0, 0, 0));', 'a.ts').paths.get('mp.players.at'), 1);
});

test('the scanner lists what a mod uses and what GoMP lacks of it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gomp-compat-'));
  fs.mkdirSync(path.join(dir, 'pkg'));
  fs.writeFileSync(path.join(dir, 'pkg', 'index.js'), `
    mp.events.add('playerJoin', (p) => p.setVariable('a', 1));
    const cp = mp.checkpoints.new(1, new mp.Vector3(0, 0, 0), 1);
    cp.color = [255, 0, 0, 255];
    mp.myOwnThing = 5;   // not RAGE API: ignored
  `);
  fs.mkdirSync(path.join(dir, 'node_modules', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'lib', 'index.js'), 'mp.events.callRemote("x")');
  const r = scan(dir, 'server');
  assert.equal(r.files, 1, 'node_modules skipped');
  const row = (api) => r.rows.find((x) => x.api === api);
  assert.equal(row('mp.events.add').have, true);
  assert.equal(row('.setVariable').have, true);
  assert.ok(!row('mp.myOwnThing'));
  assert.ok(r.rows.every((x) => x.api !== 'mp.events.callRemote'));
  // On the client side nothing is there yet.
  assert.ok(scan(dir, 'client').rows.every((x) => !x.have));
});

test('the report has every part', () => {
  const md = build();
  for (const s of ['Сервер, JS (Node)', 'Клиент, JS (client_packages)', 'CEF', 'Сервер, C# (GTANetworkAPI)', 'Тестовый корпус']) assert.ok(md.includes(s), s);
});

const BOOTSTRAPPER = path.join(__dirname, '..', '..', '..', 'third_party', 'ragemp', 'nuget', 'bootstrapper', 'lib', 'netcoreapp3.1', 'Bootstrapper.dll');
const EXE = path.join(__dirname, '..', 'dotnet', 'bin', 'out', process.platform === 'win32' ? 'gomp-compat.exe' : 'gomp-compat');

test('C#: the GTANetworkAPI surface of RAGE\'s assembly', { skip: !(fs.existsSync(BOOTSTRAPPER) && fs.existsSync(EXE)) && 'Bootstrapper.dll or the tool not here' }, () => {
  const env = { ...process.env, DOTNET_ROOT: process.env.DOTNET_ROOT || path.join(process.env.USERPROFILE || '', 'tools', 'dotnet') };
  const json = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gomp-cs-')), 'api.json');
  execFileSync(EXE, ['api', BOOTSTRAPPER, '--json', json], { env });
  const api = JSON.parse(fs.readFileSync(json, 'utf8'));
  assert.ok(api['GTANetworkAPI.Entity'].includes('SetData/2'));
  assert.ok(api['GTANetworkAPI.Player'].includes('SendChatMessage/1'));
  assert.ok(api['GTANetworkAPI.Script'], 'scripts derive from Script');
  assert.ok(Object.keys(api).some((t) => t === 'GTANetworkMethods.Player'), 'NAPI.Player');
  // A source folder: NAPI calls, events and entity members by name.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'gomp-cs-src-'));
  fs.writeFileSync(path.join(src, 'a.cs'), 'class A : Script { [ServerEvent(Event.PlayerConnected)] void C(Player p) { p.SendChatMessage("hi"); NAPI.Util.ConsoleOutput("x"); } }');
  const out = execFileSync(EXE, ['scan', src, '--api', BOOTSTRAPPER, '--impl', BOOTSTRAPPER], { env, encoding: 'utf8' });
  for (const name of ['NAPI.Util.ConsoleOutput', 'Event.PlayerConnected', '[ServerEvent]', 'Player.SendChatMessage']) assert.match(out, new RegExp(`ok\\s+${name.replace(/[.[\]]/g, '\\$&')}`), name);
});
