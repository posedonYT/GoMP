// Freeroam gamemode for GoMP, written only against the RAGE.MP server API.
// Drop it into a RAGE.MP server's packages/ folder and it works there too.

const spawnPoints = [
  new mp.Vector3(-425.517, 1123.620, 325.854), // Galileo Observatory
  new mp.Vector3(-1037.4, -2737.7, 20.17), // LSIA
  new mp.Vector3(215.8, -810.1, 30.73), // Legion Square
  new mp.Vector3(-1388.8, -586.6, 30.21), // Del Perro
];

const starterWeapons = ['weapon_pistol', 'weapon_carbinerifle', 'weapon_knife'];

function randomSpawn() {
  return spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
}

function armPlayer(player) {
  player.removeAllWeapons();
  for (const w of starterWeapons) player.giveWeapon(mp.joaat(w), 250);
}

mp.events.add('playerJoin', (player) => {
  console.log(`[freeroam] ${player.name} (${player.socialClub}) joined from ${player.ip}`);
  mp.players.broadcast(`!{#8ef}${player.name} joined the server.`);
  player.setVariable('kills', 0);
});

mp.events.add('playerReady', (player) => {
  player.spawn(randomSpawn(), 0);
  armPlayer(player);
  player.outputChatBox('Commands: /veh [model], /weapon [name] [ammo], /tp x y z, /dim [n], /hp, /kill, /pos, /time h, /weather name');
});

mp.events.add('playerQuit', (player, exitType, reason) => {
  mp.players.broadcast(`!{#8ef}${player.name} left (${exitType}${reason ? `: ${reason}` : ''}).`);
  const veh = player.getVariable('personalVehicle');
  if (veh && mp.vehicles.exists(veh)) veh.destroy();
});

mp.events.add('playerChat', (player, text) => {
  mp.players.broadcast(`${player.name}: ${text}`);
});

mp.events.add('playerDeath', (player, reason, killer) => {
  if (killer && killer !== player) {
    killer.setVariable('kills', (killer.getVariable('kills') || 0) + 1);
    mp.players.broadcast(`${killer.name} killed ${player.name}`);
  }
  setTimeout(() => {
    if (!mp.players.exists(player)) return;
    player.spawn(randomSpawn(), 0);
    armPlayer(player);
  }, 3000);
});

mp.events.add('playerCommand', (player, command) => {
  player.outputChatBox(`Unknown command: /${command}`);
});

mp.events.addCommand('veh', (player, _, model = 'sultan') => {
  const old = player.getVariable('personalVehicle');
  if (old && mp.vehicles.exists(old)) old.destroy();
  const pos = player.position;
  const veh = mp.vehicles.new(mp.joaat(model), new mp.Vector3(pos.x, pos.y, pos.z + 0.5), {
    heading: player.heading,
    numberPlate: player.name.slice(0, 8).toUpperCase(),
    dimension: player.dimension,
    engine: true,
  });
  player.setVariable('personalVehicle', veh);
  player.putIntoVehicle(veh, 0);
});

mp.events.addCommand('weapon', (player, _, name = 'pistol', ammo = '250') => {
  player.giveWeapon(mp.joaat(name.startsWith('weapon_') ? name : `weapon_${name}`), Number(ammo) || 250);
});

mp.events.addCommand('tp', (player, _, x, y, z) => {
  if ([x, y, z].some((v) => Number.isNaN(Number(v)))) return player.outputChatBox('Usage: /tp x y z');
  player.position = new mp.Vector3(Number(x), Number(y), Number(z));
  return undefined;
});

mp.events.addCommand('dim', (player, _, dim = '0') => {
  player.dimension = Number(dim) >>> 0;
  player.outputChatBox(`Dimension: ${player.dimension}`);
});

mp.events.addCommand('hp', (player) => {
  player.health = 100;
  player.armour = 100;
});

mp.events.addCommand('kill', (player) => {
  player.health = 0;
});

mp.events.addCommand('pos', (player) => {
  const p = player.position;
  player.outputChatBox(`${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} heading ${player.heading.toFixed(1)}`);
});

mp.events.addCommand('time', (_, __, hour = '12') => {
  mp.world.time.set(Number(hour) % 24, 0, 0);
});

mp.events.addCommand('weather', (_, __, weather = 'EXTRASUNNY') => {
  mp.world.weather = weather;
});

mp.events.addCommand('kills', (player) => {
  player.outputChatBox(`Kills: ${player.getVariable('kills') || 0}`);
});
