package transport

import "time"

// floodGate limits the datagrams one connection may send, before they are
// decrypted (a flood must not cost a ChaCha20 open per packet). A token bucket
// of rate per second and twice that as burst; a peer over the limit for
// floodStrikes seconds in a row is disconnected.
type floodGate struct {
	tokens  float64
	last    time.Time
	second  time.Time // start of the current one-second window
	dropped bool      // something was dropped in this window
	strikes int       // windows in a row with drops
}

const floodStrikes = 5

// allow reports whether a datagram may be processed and whether the peer has
// flooded long enough to be cut off. Only the read goroutine calls it.
func (g *floodGate) allow(now time.Time, rate int) (ok, cut bool) {
	if rate <= 0 {
		return true, false
	}
	burst := float64(2 * rate)
	if g.last.IsZero() {
		g.tokens, g.last, g.second = burst, now, now
	}
	if el := now.Sub(g.last).Seconds(); el > 0 {
		g.tokens = min(burst, g.tokens+el*float64(rate))
		g.last = now
	}
	if now.Sub(g.second) >= time.Second {
		if g.dropped {
			g.strikes++
		} else {
			g.strikes = 0
		}
		g.second, g.dropped = now, false
	}
	if g.tokens >= 1 {
		g.tokens--
		return true, false
	}
	g.dropped = true
	return false, g.strikes >= floodStrikes
}
