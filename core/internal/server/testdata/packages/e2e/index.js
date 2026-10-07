// A RAGE.MP-style package written against the stock RAGE.MP server API only.
// The Go end-to-end test drives it with bots through the real Node.js host.

const spawnPoint = new mp.Vector3(-425.5, 1123.6, 325.8);
const zone = mp.colshapes.newSphere(-400, 1123.6, 325.8, 3);

mp.events.add('playerJoin', (player) => {
  player.setVariable('job', 'driver');
  player.outputChatBox(`Welcome, ${player.name}!`);
});

mp.events.add('playerReady', (player) => {
  player.spawn(spawnPoint, 180);
  player.giveWeapon(mp.joaat('weapon_pistol'), 30);
});

mp.events.add('playerDeath', (player, reason, killer) => {
  player.outputChatBox(`died: ${reason}${killer ? ` by ${killer.name}` : ''}`);
  setTimeout(() => {
    if (mp.players.exists(player)) player.spawn(spawnPoint, 0);
  }, 100);
});

mp.events.add('playerEnterColshape', (player, shape) => {
  if (shape === zone) player.outputChatBox('entered zone');
});

mp.events.addCommand('veh', (player, fullText, model = 'sultan') => {
  const pos = player.position;
  const veh = mp.vehicles.new(mp.joaat(model), new mp.Vector3(pos.x + 2, pos.y, pos.z), {
    heading: player.heading,
    numberPlate: 'E2E',
    color: [[255, 0, 0], [0, 0, 0]],
  });
  veh.setVariable('owner', player.name);
  player.putIntoVehicle(veh, 0);
});

mp.events.addCommand('ask', async (player) => {
  try {
    const who = await player.callProc('whoami', ['?']);
    player.outputChatBox(`you are ${who}`);
  } catch (e) {
    player.outputChatBox(`proc failed: ${e.message}`);
  }
});

mp.events.add('playerCommand', (player, command) => {
  player.outputChatBox(`unknown command: ${command}`);
});

mp.events.add('echo', (player, ...args) => {
  player.call('echoReply', args);
});

mp.events.addProc('sum', (player, a, b) => a + b);

mp.events.add('packagesLoaded', () => {
  console.log(`e2e package ready, ${mp.players.length} players`);
});
