// The "JS" half of a RAGE-style RP server (TestTwoHostsRageStyle): the patterns
// RAGE.MP mods use, against the real Node runtime.
mp.events.add({
  playerJoin: (player) => {
    player.data.job = 'medic';                 // the data proxy: a shared variable
    player.setOwnVariable('cash', 500);        // only the player sees it
  },
  playerReady: (player) => {
    player.spawn(new mp.Vector3(100, 200, 70));
  },
});

mp.events.addCommand({
  hp: (player) => player.outputChatBox(`hp ${player.health}`),
  car: (player) => {
    const v = mp.vehicles.new(mp.joaat('police'), player.position, { numberPlate: 'LSPD', dimension: player.dimension });
    v.setVariable('org', 'lspd');
    player.putIntoVehicle(v, 0);
  },
  near: (player) => mp.players.callInRange(player.position, 50, player.dimension, 'rp:near', [player.name]),
});

mp.events.addProc('rp:double', async (player, n) => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return n * 2;
});

mp.events.add('rp:ping', (player) => player.call('rp:pong', ['main']));
