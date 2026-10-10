// Token buckets for things players can spam: registrations and logins (per
// IP, so a reconnect does not reset them), commands, spawning vehicles...
//
//   const auth = limiter({ rate: 5 / 60, burst: 5 });   // 5 a minute
//   if (!auth.allow(player.ip)) return player.notify('~r~Слишком часто');

const buckets = new Set();

function limiter({ rate, burst, now = () => Date.now() }) {
  const state = new Map();  // key -> { tokens, at }
  const b = {
    allow(key, cost = 1) {
      const t = now();
      let s = state.get(key);
      if (!s) state.set(key, (s = { tokens: burst, at: t }));
      s.tokens = Math.min(burst, s.tokens + ((t - s.at) / 1000) * rate);
      s.at = t;
      if (s.tokens < cost) return false;
      s.tokens -= cost;
      return true;
    },
    // Seconds until the next attempt is allowed.
    wait(key) {
      const s = state.get(key);
      if (!s || s.tokens >= 1) return 0;
      return Math.ceil((1 - s.tokens) / rate);
    },
    // Full buckets carry no information: dropped so the map does not grow.
    sweep() {
      const t = now();
      for (const [k, s] of state) if (s.tokens + ((t - s.at) / 1000) * rate >= burst) state.delete(k);
    },
    get size() {
      return state.size;
    },
  };
  buckets.add(b);
  return b;
}

const timer = setInterval(() => buckets.forEach((b) => b.sweep()), 60000);
if (timer && timer.unref) timer.unref();

// A limit kept by the storage (Redis: a counter with an expiry), so a server restart
// does not reset it: resolves true while key has been hit at most max times in the
// last ttlSec. A storage without counters (files) or an unreachable one allows: the
// in-memory limiter still applies.
function persistent(backend, key, max, ttlSec) {
  if (!backend || typeof backend.hit !== 'function') return Promise.resolve(true);
  return backend.hit(key, ttlSec).then((n) => n <= max, () => true);
}

module.exports = { limiter, persistent };
