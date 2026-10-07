// Stress-test gamemode (RAGE.MP API). Spawn layout is controlled by the
// stress tool through environment variables.

// Profiles:
//   uniform  - everybody spread over the map (radius 3000 m)
//   mixed    - four city hubs of 250 m radius (typical RP server)
//   hotspot  - every fifth player in one 60 m spot, the rest spread over the map
//   extreme  - everybody in one 60 m spot
const profile = process.env.GOMP_STRESS_PROFILE || 'mixed';
const hubs = [new mp.Vector3(200, -800, 30), new mp.Vector3(-1200, -1500, 4), new mp.Vector3(1700, 3600, 35), new mp.Vector3(-400, 1100, 325)];
const spot = new mp.Vector3(200, -800, 30);
const map = new mp.Vector3(0, 0, 70);

function around(c, radius) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * radius;
  return new mp.Vector3(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, c.z);
}

function spawnPos(player) {
  switch (profile) {
    case 'uniform':
      return around(map, 3000);
    case 'hotspot':
      return player.id % 5 === 0 ? around(spot, 60) : around(map, 3000);
    case 'extreme':
      return around(spot, 60);
    default:
      return around(hubs[player.id % hubs.length], 250);
  }
}

mp.events.add('playerReady', (player) => {
  player.spawn(spawnPos(player), 0);
  player.giveWeapon(mp.joaat('weapon_pistol'), 9999);
});

mp.events.add('playerDeath', (player) => {
  setTimeout(() => {
    if (!mp.players.exists(player)) return;
    player.spawn(spawnPos(player), 0);
    player.giveWeapon(mp.joaat('weapon_pistol'), 9999);
  }, 1000);
});

mp.events.addCommand('veh', (player, _, model = 'sultan') => {
  if (player.vehicle) return;
  const pos = player.position;
  const veh = mp.vehicles.new(mp.joaat(model), new mp.Vector3(pos.x, pos.y, pos.z), { engine: true, dimension: player.dimension });
  player.putIntoVehicle(veh, 0);
});

mp.events.add('playerQuit', (player) => {
  const veh = player.vehicle;
  if (veh && veh.getOccupants().length <= 1) veh.destroy();
});

let chats = 0;
mp.events.add('playerChat', () => {
  chats++;
});

mp.events.addProc('stress:stats', () => ({ players: mp.players.length, vehicles: mp.vehicles.length, chats }));
