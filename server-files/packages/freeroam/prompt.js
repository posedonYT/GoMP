// Questions to a player answered with a button (an invitation into an
// organization...): the client shows the choice window, the answer comes back
// once. A question unanswered within its time counts as "no".
//
// Client protocol:
//   server -> client  gomp:prompt {id, title, text, options: [label]}
//   client -> server  gomp:prompt:answer id, index        (-1: closed)

const TIMEOUT_MS = 30000;

let nextId = 1;
const pending = new Map(); // id -> { player, done, timer }

// Asks; done(index) gets the option chosen, or -1 (closed, timed out, the player left).
function ask(player, { title, text = '', options }, done, timeoutMs = TIMEOUT_MS) {
  const id = nextId++;
  const timer = setTimeout(() => finish(id, -1), timeoutMs);
  if (timer.unref) timer.unref();
  pending.set(id, { player, done, timer });
  player.call('gomp:prompt', [{ id, title, text, options }]);
  return id;
}

function finish(id, index) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  p.done(index);
}

mp.events.add('gomp:prompt:answer', (player, id, index) => {
  const p = pending.get(Number(id));
  if (!p || p.player !== player) return;
  const i = Math.floor(Number(index));
  finish(Number(id), Number.isInteger(i) && i >= 0 ? i : -1);
});

mp.events.add('playerQuit', (player) => {
  for (const [id, p] of pending) if (p.player === player) finish(id, -1);
});

module.exports = { ask, pending, TIMEOUT_MS };
