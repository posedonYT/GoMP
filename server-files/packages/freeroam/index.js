// GoMP gamemode: accounts and characters (roleplay.js), admin tools (admin.js)
// and a few freeroam commands. Written only against the RAGE.MP server API.

const roleplay = require('./roleplay');
require('./admin');

// Chat and commands are available once a character is in the game.
mp.events.add('playerChat', (player, text) => {
  if (!roleplay.isLogged(player)) return;
  const st = player.getVariable('static');
  mp.players.broadcast(`${player.name} [${st}]: ${text}`);
});

mp.events.add('playerQuit', (player, exitType, reason) => {
  if (!roleplay.isLogged(player)) return;
  mp.players.broadcast(`!{#8ef}${player.name} вышел (${exitType}${reason ? `: ${reason}` : ''}).`);
});

mp.events.add('playerDeath', (player, reason, killer) => {
  if (killer && killer !== player && roleplay.isLogged(killer)) {
    mp.players.broadcast(`${killer.name} убил ${player.name}`);
  }
});

mp.events.add('playerCommand', (player, command) => {
  player.outputChatBox(`Неизвестная команда: /${command}`);
});

// Commands for players with a character; others get a hint.
function command(name, fn) {
  mp.events.addCommand(name, (player, ...args) => {
    if (!roleplay.isLogged(player)) return player.outputChatBox('!{#f66}Сначала войдите и выберите персонажа');
    return fn(player, ...args);
  });
}

command('help', (player) => {
  player.outputChatBox('Команды: /veh [модель], /tp x y z, /pos, /money, /pay <id> <сумма>, /time ч, /weather тип. Консоль: \\');
});

command('veh', (player, _, model = 'sultan') => {
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

command('tp', (player, _, x, y, z) => {
  if ([x, y, z].some((v) => Number.isNaN(Number(v)))) return player.outputChatBox('Использование: /tp x y z');
  player.position = new mp.Vector3(Number(x), Number(y), Number(z));
  return undefined;
});

command('pos', (player) => {
  const p = player.position;
  player.outputChatBox(`${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} heading ${player.heading.toFixed(1)}`);
});

command('money', (player) => {
  const ch = roleplay.character(player);
  player.outputChatBox(`Наличные: $${ch.cash}, на карте: $${ch.bank}`);
});

command('pay', (player, _, id, amount) => {
  const target = mp.players.at(Number(id));
  const sum = Math.floor(Number(amount));
  const from = roleplay.character(player);
  if (!target || target === player || !roleplay.isLogged(target)) return player.outputChatBox('Использование: /pay <id> <сумма>');
  if (!(sum > 0) || sum > from.cash) return player.outputChatBox('!{#f66}Недостаточно наличных');
  if (target.position.subtract(player.position).length() > 5) return player.outputChatBox('!{#f66}Игрок слишком далеко');
  const to = roleplay.character(target);
  roleplay.setMoney(player, from.cash - sum, from.bank);
  roleplay.setMoney(target, to.cash + sum, to.bank);
  player.outputChatBox(`Вы передали $${sum} игроку ${target.name}`);
  target.outputChatBox(`${player.name} передал вам $${sum}`);
  return undefined;
});

command('time', (_, __, hour = '12') => {
  mp.world.time.set(Number(hour) % 24, 0, 0);
});

command('weather', (_, __, weather = 'EXTRASUNNY') => {
  mp.world.weather = weather;
});
