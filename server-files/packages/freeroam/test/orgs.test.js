const test = require('node:test');
const assert = require('node:assert');
const fake = require('./fakemp');
require('../index');
const roleplay = require('../roleplay');
const orgs = require('../orgs');
const inventory = require('../inventory');
const vehicles = require('../vehicles');
const prompt = require('../prompt');

const at = ([x, y, z]) => new mp.Vector3(x, y, z);
const st = (p) => p.getVariable('static');

// A fresh leader of an organization (each test its own people; the org state is shared).
function leaderOf(id) {
  const admin = fake.login(fake.join());
  const p = fake.login(fake.join());
  fake.command(admin, `/makeleader ${st(p)} ${id}`);
  return p;
}

// The answer to the last question the player was asked.
function answer(p, index) {
  const [q] = p.lastCall('gomp:prompt');
  fake.emit('gomp:prompt:answer', p, q.id, index);
}

test('organizations: LSPD, Army, EMS and GOV with bases, storages, doors and work vehicles', () => {
  assert.deepStrictEqual([...orgs.defs.keys()], ['lspd', 'army', 'ems', 'gov']);
  for (const d of orgs.defs.values()) {
    assert.ok(d.base.interior && d.base.storage && d.base.doors.length, d.id);
    assert.ok(d.vehicles.length >= 3, `${d.id}: work vehicles`);
    assert.ok(d.ranks.length >= 8, `${d.id}: ranks`);
    // The storage is inside the base, the vehicles next to it.
    const [cx, cy] = d.base.center;
    assert.ok(Math.hypot(d.base.storage[0] - cx, d.base.storage[1] - cy) < d.base.radius, `${d.id}: storage at the base`);
    for (const v of d.vehicles) assert.ok(Math.hypot(v.pos[0] - cx, v.pos[1] - cy) < 120, `${d.id}: ${v.model} near the base`);
  }
  // Every base and its doors reach the client.
  const p = fake.login(fake.join());
  const [bases] = p.lastCall('gomp:orgs');
  assert.deepStrictEqual(bases.map((b) => b.id), ['lspd', 'army', 'ems', 'gov']);
  assert.ok(bases[0].base.doors.some((d) => d.model === 'v_ilev_ph_door01'));
  // Blips on the map.
  assert.ok(fake.blips.toArray().some((b) => b.sprite === 60 && /LSPD/.test(b.name)));
});

test('/makeleader: the top rank and every permission; own variables for the client; none removes', () => {
  const p = leaderOf('lspd');
  const m = orgs.membership(st(p));
  assert.strictEqual(m.rank, orgs.topRank('lspd'));
  assert.ok(m.leader);
  for (const perm of orgs.PERMS) assert.ok(orgs.can(st(p), perm), perm);
  assert.deepStrictEqual([p.own.org, p.own.orgRank, p.own.orgLeader], ['lspd', 10, true]);
  assert.strictEqual(p.own.orgRankName, 'Шеф полиции');
  // A new leader: the old one stays, a rank lower.
  const next = leaderOf('lspd');
  assert.ok(orgs.membership(st(next)).leader);
  assert.deepStrictEqual([orgs.membership(st(p)).rank, orgs.membership(st(p)).leader], [9, false]);
  const admin = fake.login(fake.join());
  fake.command(admin, `/makeleader ${st(next)} none`);
  assert.ok(!orgs.membership(st(next)).leader);
  assert.strictEqual(orgs.stateOf('lspd').leader, null);
});

test('/invite: the player is asked and joins on the first rank; a refusal or another organization does not', () => {
  const boss = leaderOf('ems');
  const a = fake.login(fake.join());
  a.position = boss.position;
  fake.command(boss, `/invite ${st(a)}`);
  const [q] = a.lastCall('gomp:prompt');
  assert.match(q.title, /EMS/);
  assert.deepStrictEqual(q.options, ['Принять', 'Отказаться']);
  // Somebody else answering does nothing.
  fake.emit('gomp:prompt:answer', boss, q.id, 0);
  assert.strictEqual(orgs.membership(st(a)), null);
  answer(a, 0);
  assert.deepStrictEqual([orgs.membership(st(a)).id, orgs.membership(st(a)).rank], ['ems', 1]);
  assert.strictEqual(a.own.org, 'ems');

  const b = fake.login(fake.join());
  b.position = boss.position;
  fake.command(boss, `/invite ${st(b)}`);
  answer(b, 1);
  assert.strictEqual(orgs.membership(st(b)), null, 'refused');
  // Members of a rank without the permission cannot invite; nobody invites a member of another org.
  fake.command(a, `/invite ${st(b)}`);
  assert.ok(a.chat.some((l) => /Нет доступа: приглашать/.test(l)));
  const cop = leaderOf('lspd');
  cop.position = boss.position;
  fake.command(boss, `/invite ${st(cop)}`);
  assert.ok(boss.chat.some((l) => /уже состоит/.test(l)));
  // Too far away.
  const far = fake.login(fake.join());
  far.position = new mp.Vector3(boss.position.x + 500, 0, 0);
  fake.command(boss, `/invite ${st(far)}`);
  assert.ok(boss.chat.some((l) => /слишком далеко/.test(l)));
});

test('a question unanswered in time, or a player who left, counts as no', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = fake.login(fake.join());
  const answers = [];
  prompt.ask(p, { title: 'Вопрос', options: ['Да', 'Нет'] }, (i) => answers.push(i));
  t.mock.timers.tick(prompt.TIMEOUT_MS + 1);
  prompt.ask(p, { title: 'Ещё', options: ['Да'] }, (i) => answers.push(i));
  fake.emit('playerQuit', p);
  assert.deepStrictEqual(answers, [-1, -1]);
});

test('/setrank and /uninvite: only below one\'s own rank, never the leader; the permission is needed', () => {
  const boss = leaderOf('army');
  const join = (rank) => {
    const p = fake.login(fake.join());
    orgs.join(st(p), 'army', rank);
    return p;
  };
  const sergeant = join(9);   // the default permissions of rank 9 of 10: invite, uninvite, setrank
  const soldier = join(1);
  const other = join(5);
  fake.command(boss, `/setrank ${st(soldier)} 4`);
  assert.strictEqual(orgs.membership(st(soldier)).rank, 4);
  fake.command(boss, `/setrank ${st(soldier)} 10`);
  assert.strictEqual(orgs.membership(st(soldier)).rank, 4, 'the top rank is the leader\'s');
  fake.command(sergeant, `/setrank ${st(soldier)} 8`);
  assert.strictEqual(orgs.membership(st(soldier)).rank, 8);
  fake.command(sergeant, `/setrank ${st(soldier)} 9`);
  assert.strictEqual(orgs.membership(st(soldier)).rank, 8, 'not up to his own rank');
  fake.command(sergeant, `/setrank ${st(boss)} 1`);
  assert.ok(orgs.membership(st(boss)).leader);
  fake.command(other, `/setrank ${st(soldier)} 1`);
  assert.strictEqual(orgs.membership(st(soldier)).rank, 8, 'rank 5 has no setrank');
  fake.command(sergeant, `/uninvite ${st(boss)}`);
  assert.ok(orgs.membership(st(boss)), 'the leader stays');
  fake.command(sergeant, `/uninvite ${st(other)}`);
  assert.strictEqual(orgs.membership(st(other)), null);
  assert.strictEqual(other.own.org, null);
  assert.ok(other.notes.some((n) => /уволили/.test(n)));
});

test('F2: the organization tab; the leader renames ranks and changes their permissions', () => {
  const boss = leaderOf('gov');
  const clerk = fake.login(fake.join());
  orgs.join(st(clerk), 'gov', 1);
  fake.emit('gomp:org:get', clerk);
  const [v] = clerk.lastCall('gomp:org');
  assert.deepStrictEqual([v.id, v.rank, v.rankName, v.leader], ['gov', 1, 'Стажёр', false]);
  assert.ok(v.members.some((m) => m.static === st(boss) && m.online && m.rank === orgs.topRank('gov')));
  assert.strictEqual(v.perms.storage, false);
  assert.strictEqual(v.ranks.length, 8);
  // Only the leader edits, and not his own rank.
  fake.emit('gomp:org:rank', clerk, 0, 'Хакер', { storage: true });
  assert.strictEqual(orgs.stateOf('gov').ranks[0].name, 'Стажёр');
  fake.emit('gomp:org:rank', boss, 0, 'Помощник', { storage: true, bogus: true });
  assert.strictEqual(orgs.stateOf('gov').ranks[0].name, 'Помощник');
  assert.ok(orgs.can(st(clerk), 'storage'));
  assert.strictEqual(orgs.stateOf('gov').ranks[0].perms.bogus, undefined);
  assert.strictEqual(clerk.own.orgRankName, 'Помощник', 'members see the new name');
  fake.emit('gomp:org:rank', boss, 7, 'Король', {});
  assert.strictEqual(orgs.stateOf('gov').ranks[7].name, 'Губернатор');
  // Members are promoted and dismissed from the tab too.
  fake.emit('gomp:org:setrank', boss, st(clerk), 3);
  assert.strictEqual(orgs.membership(st(clerk)).rank, 3);
  fake.emit('gomp:org:kick', boss, st(clerk));
  assert.strictEqual(orgs.membership(st(clerk)), null);
  // Not a member: no tab.
  fake.emit('gomp:org:get', clerk);
  assert.strictEqual(clerk.lastCall('gomp:org')[0], null);
});

test('storage: members put things in at the base; taking needs the permission; viewers see changes', () => {
  const boss = leaderOf('lspd');
  const cadet = fake.login(fake.join());
  orgs.join(st(cadet), 'lspd', 1);
  const base = orgs.defs.get('lspd').base;
  const cch = roleplay.character(cadet);
  const bch = roleplay.character(boss);
  inventory.give(cadet, cch, 'medkit', 3);
  // Away from the storage it does not open.
  fake.emit('gomp:org:storage', cadet);
  assert.ok(cadet.notes.some((n) => /Подойдите к складу/.test(n)));
  cadet.position = at(base.storage);
  boss.position = at(base.storage);
  fake.emit('gomp:org:storage', cadet);
  fake.emit('gomp:org:storage', boss);
  const [sync] = cadet.lastCall('gomp:inv:sync');
  assert.strictEqual(sync.storage.title, 'Склад LSPD');
  assert.strictEqual(sync.storage.slots.length, 60);
  assert.deepStrictEqual([sync.storage.take, sync.storage.put], [false, true]);
  const pocket = cch.inventory.pockets.findIndex((s) => s && s.key === 'medkit');
  const free = orgs.stateOf('lspd').storage.indexOf(null);
  fake.emit('gomp:inv:move', cadet, 'pockets', pocket, 'storage', free, 3);
  assert.strictEqual(orgs.stateOf('lspd').storage[free].key, 'medkit');
  assert.strictEqual(inventory.countOf(cch, 'medkit'), 0);
  assert.strictEqual(boss.lastCall('gomp:inv:sync')[0].storage.slots[free].key, 'medkit', 'the other viewer sees it');
  // The cadet cannot take it back; the leader can.
  fake.emit('gomp:inv:move', cadet, 'storage', free, 'pockets', pocket, 1);
  assert.ok(cadet.notes.some((n) => /брать со склада/.test(n)));
  assert.strictEqual(orgs.stateOf('lspd').storage[free].count, 3);
  fake.emit('gomp:inv:move', boss, 'storage', free, 'pockets', bch.inventory.pockets.indexOf(null), 2);
  assert.strictEqual(orgs.stateOf('lspd').storage[free].count, 1);
  // Walked away: the storage is closed.
  boss.position = new mp.Vector3(0, 0, 0);
  fake.emit('gomp:inv:move', boss, 'storage', free, 'pockets', bch.inventory.pockets.indexOf(null), 1);
  assert.strictEqual(orgs.stateOf('lspd').storage[free].count, 1);
  assert.strictEqual(boss.lastCall('gomp:inv:sync')[0].storage, undefined);
  // Equipment never goes straight into the storage.
  fake.emit('gomp:inv:move', cadet, 'equip', 0, 'storage', free + 1, 1);
  assert.ok(cadet.notes.some((n) => /в карманы/.test(n)));
  // Not a member: no storage.
  const stranger = fake.login(fake.join());
  stranger.position = at(base.storage);
  fake.emit('gomp:org:storage', stranger);
  assert.ok(stranger.notes.some((n) => /только для сотрудников/.test(n)));
  fake.emit('gomp:inv:close', cadet);
  assert.ok(!inventory.external.has(cadet.id));
});

test('work vehicles: parked locked at the base; members unlock them; wrecked or abandoned ones come back', () => {
  const lspd = orgs.fleet.filter((s) => s.org === 'lspd');
  assert.strictEqual(lspd.length, orgs.defs.get('lspd').vehicles.length);
  const slot = lspd[0];
  const veh = slot.veh;
  assert.ok(mp.vehicles.exists(veh));
  assert.deepStrictEqual([veh.getVariable('org'), veh.getVariable('owner'), veh.locked], ['lspd', null, true]);
  assert.strictEqual(veh.model, mp.joaat(slot.spot.model));
  const cop = fake.login(fake.join());
  orgs.join(st(cop), 'lspd', 1);
  const civ = fake.login(fake.join());
  civ.position = veh.position;
  fake.emit('gomp:veh:lock', civ, veh.id);
  assert.strictEqual(veh.locked, true, 'a stranger cannot');
  cop.position = veh.position;
  fake.emit('gomp:veh:lock', cop, veh.id);
  assert.strictEqual(veh.locked, false, 'a member unlocks it');
  // Driven away and left: back at its place after a while.
  veh.position = new mp.Vector3(veh.position.x + 300, veh.position.y, veh.position.z);
  orgs.tickFleet(Date.now());
  assert.ok(mp.vehicles.exists(veh), 'not at once');
  orgs.tickFleet(Date.now() + 11 * 60 * 1000);
  assert.ok(!mp.vehicles.exists(veh));
  assert.ok(mp.vehicles.exists(slot.veh));
  assert.ok(Math.hypot(slot.veh.position.x - slot.spot.pos[0], slot.veh.position.y - slot.spot.pos[1]) < 0.01);
  // Destroyed: a new one.
  slot.veh.destroy();
  orgs.tickFleet();
  assert.ok(mp.vehicles.exists(slot.veh));
});

test('/setorg: an admin puts a player into an organization (or out of it)', () => {
  const admin = fake.login(fake.join());
  const p = fake.login(fake.join());
  fake.command(admin, `/setorg ${st(p)} army 4`);
  assert.deepStrictEqual([orgs.membership(st(p)).id, orgs.membership(st(p)).rank], ['army', 4]);
  fake.command(admin, `/setorg ${st(p)} ems`);
  assert.deepStrictEqual([orgs.membership(st(p)).id, orgs.membership(st(p)).rank], ['ems', 1], 'one organization at a time');
  fake.command(admin, `/setorg ${st(p)} none`);
  assert.strictEqual(orgs.membership(st(p)), null);
});

// ------------------------------------------------------------------ admin tools

test('admin: /invis, /fly (movement checks off) and /tpm to the map waypoint', () => {
  const admin = fake.login(fake.join());
  fake.command(admin, '/invis');
  assert.deepStrictEqual([admin.alpha, admin.getVariable('invisible')], [0, true]);
  fake.command(admin, '/invis');
  assert.deepStrictEqual([admin.alpha, admin.getVariable('invisible')], [255, false]);
  fake.command(admin, '/fly');
  assert.deepStrictEqual([admin.getVariable('fly'), admin.anticheat], [true, false]);
  fake.command(admin, '/fly');
  assert.deepStrictEqual([admin.getVariable('fly'), admin.anticheat], [false, true]);

  // The waypoint: the client is asked, it answers with the ground there.
  fake.emit('gomp:admin:tpm:go', admin, 100, 200, 30);
  assert.notStrictEqual(admin.position.x, 100, 'nothing without /tpm');
  fake.command(admin, '/tpm');
  assert.ok(admin.lastCall('gomp:admin:tpm'));
  fake.emit('gomp:admin:tpm:go', admin, 100, 200, 30);
  assert.deepStrictEqual([admin.position.x, admin.position.y, admin.position.z], [100, 200, 30]);
  fake.command(admin, '/tpm');
  fake.emit('gomp:admin:tpm:go', admin, 1e9, 0, 0);
  assert.strictEqual(admin.position.x, 100, 'out of the world: ignored');
  // Somebody who is not an admin.
  const p = fake.login(fake.join({ ip: '10.1.2.3' }));
  fake.command(p, '/fly');
  assert.notStrictEqual(p.getVariable('fly'), true);
  fake.emit('gomp:admin:tpm:go', p, 5, 5, 5);
  assert.notStrictEqual(p.position.x, 5);
});

test('/veh is for everybody: the vehicle belongs to nobody, its F2 property list stays empty', () => {
  const p = fake.login(fake.join());
  fake.command(p, '/veh sultan');
  assert.strictEqual(p.vehicle.getVariable('owner'), null);
  assert.ok(vehicles.canLock(fake.login(fake.join()), p.vehicle));
  fake.emit('gomp:property:get', p);
  assert.deepStrictEqual(p.lastCall('gomp:property')[0].cars, []);
});
