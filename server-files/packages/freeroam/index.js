// GoMP gamemode: accounts and characters (roleplay.js), admin tools (admin.js)
// and a few freeroam commands. Written only against the RAGE.MP server API.

const roleplay = require('./roleplay');
const vehicles = require('./vehicles');
require('./places');
require('./houses');
require('./phone');
require('./maps');
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
  player.outputChatBox('Команды: /veh [модель], /tp x y z, /pos, /money, /pay <статик> <сумма>, /time ч, /weather тип. Клиент: /perf /status /reconnect. Админ: /ahelp');
  player.outputChatBox('Клавиши: Tab инвентарь, 1-9 быстрые слоты, E действие, G меню транспорта, L замок, J ремень, стрелка вверх — телефон, F2 меню, T чат');
  player.outputChatBox('Машины: /veh vaz2107, /veh m5, /veh rs7, /veh g37s, /veh agera, /veh regera, /veh jesko, /veh veyron, /veh cullinan или любая модель GTA. Тюнинг: LSC на карте');
  player.outputChatBox('Недвижимость: дома (зелёные домики на карте) покупаются у двери, E — меню дома, гараж — подъехать к своему дому');
});

command('veh', (player, _, name = 'sultan') => {
  vehicles.spawnFor(player, name);
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

command('pay', (player, _, statik, amount) => {
  const target = roleplay.findByStatic(statik);
  const sum = Math.floor(Number(amount));
  const from = roleplay.character(player);
  if (!target || target === player || !roleplay.isLogged(target)) return player.outputChatBox('Использование: /pay <статик> <сумма>');
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
