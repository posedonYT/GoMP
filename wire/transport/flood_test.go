package transport

import (
	"testing"
	"time"
)

func TestFloodGateAllowsTheRateAndABurst(t *testing.T) {
	var g floodGate
	now := time.Unix(1000, 0)
	ok := 0
	for range 300 {
		if a, _ := g.allow(now, 100); a {
			ok++
		}
	}
	if ok != 200 { // burst = 2 × rate
		t.Fatalf("burst allowed %d, want 200", ok)
	}
	// Half a second later 50 more tokens.
	now = now.Add(500 * time.Millisecond)
	ok = 0
	for range 100 {
		if a, _ := g.allow(now, 100); a {
			ok++
		}
	}
	if ok != 50 {
		t.Fatalf("refill allowed %d, want 50", ok)
	}
}

func TestFloodGateCutsOffAPersistentFlooder(t *testing.T) {
	var g floodGate
	now := time.Unix(1000, 0)
	cut := false
	seconds := 0
	for seconds = 0; seconds < 20 && !cut; seconds++ {
		for i := range 500 { // 5× the rate, every second
			_, c := g.allow(now.Add(time.Duration(i)*2*time.Millisecond), 100)
			cut = cut || c
		}
		now = now.Add(time.Second)
	}
	if !cut || seconds < floodStrikes {
		t.Fatalf("cut=%v after %d s", cut, seconds)
	}
}

func TestFloodGateForgivesAShortBurst(t *testing.T) {
	var g floodGate
	now := time.Unix(1000, 0)
	for i := range 1000 { // one burst
		g.allow(now.Add(time.Duration(i)*time.Microsecond), 100)
	}
	// Then a normal rate for a while: no cut-off, and the strikes reset.
	for s := 1; s <= 10; s++ {
		for i := range 50 {
			if _, cut := g.allow(now.Add(time.Duration(s)*time.Second+time.Duration(i)*10*time.Millisecond), 100); cut {
				t.Fatalf("cut off at second %d", s)
			}
		}
	}
	if g.strikes != 0 {
		t.Fatalf("strikes %d", g.strikes)
	}
}

func TestFloodGateOffWithoutALimit(t *testing.T) {
	var g floodGate
	for range 10000 {
		if ok, _ := g.allow(time.Now(), 0); !ok {
			t.Fatal("dropped without a limit")
		}
	}
}

func TestReliableBacklogLimit(t *testing.T) {
	e := newEndpoint(time.Now())
	e.maxBacklog = 64 << 10
	msg := make([]byte, 1000)
	var err error
	n := 0
	for ; n < 1000 && err == nil; n++ {
		err = e.queue(Reliable, msg)
	}
	if err == nil || n > 70 {
		t.Fatalf("backlog not bounded: %d messages, err %v", n, err)
	}
	if e.queue(Reliable, []byte{1}) == nil {
		t.Fatal("endpoint usable after overflow")
	}
	if newEndpoint(time.Now()).maxBacklog != DefaultMaxRelBacklog {
		t.Fatal("default backlog")
	}
}
