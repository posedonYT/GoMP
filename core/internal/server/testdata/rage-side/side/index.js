// The other half (the C# resources of a RAGE server run in a host of their own):
// it sees what the first host did, and gets the client's events too.
mp.events.add('playerReady', (player) => {
  setTimeout(() => {
    if (mp.players.exists(player)) player.outputChatBox(`side sees job=${player.getVariable('job')}`);
  }, 50);
});

mp.events.add('rp:ping', (player) => player.call('rp:pong', ['side']));

mp.events.add('rp:count', (player) => {
  const police = mp.vehicles.toArray().filter((v) => v.getVariable('org') === 'lspd');
  player.call('rp:counted', [police.length, police.length ? police[0].numberPlate : '']);
});
