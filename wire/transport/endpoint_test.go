package transport

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math/rand/v2"
	"sort"
	"testing"
	"time"
)

// simLink connects two endpoints through a lossy, delaying, duplicating link
// driven by a fake clock. It is fully deterministic for a given seed.
type simLink struct {
	rng     *rand.Rand
	loss    float64
	dup     float64
	latency time.Duration
	jitter  time.Duration
	now     time.Time
	a, b    *endpoint
	inFly   []flight
	scratch []byte
}

type flight struct {
	at   time.Time
	toB  bool
	body []byte
	seq  int
}

func newSimLink(seed uint64, loss, dup float64, latency, jitter time.Duration) *simLink {
	now := time.Unix(1_700_000_000, 0)
	return &simLink{
		rng: rand.New(rand.NewPCG(seed, seed+1)), loss: loss, dup: dup, latency: latency, jitter: jitter,
		now: now, a: newEndpoint(now), b: newEndpoint(now), scratch: make([]byte, 0, MaxPacketSize),
	}
}

func (l *simLink) send(toB bool, body []byte) {
	if l.rng.Float64() < l.loss {
		return
	}
	n := 1
	if l.rng.Float64() < l.dup {
		n = 2
	}
	for range n {
		d := l.latency
		if l.jitter > 0 {
			d += time.Duration(l.rng.Int64N(int64(l.jitter)))
		}
		l.inFly = append(l.inFly, flight{at: l.now.Add(d), toB: toB, body: append([]byte(nil), body...), seq: len(l.inFly)})
	}
}

// step advances the clock by dt, delivers due packets and flushes both sides.
func (l *simLink) step(dt time.Duration, flush bool) error {
	l.now = l.now.Add(dt)
	sort.SliceStable(l.inFly, func(i, j int) bool { return l.inFly[i].at.Before(l.inFly[j].at) })
	keep := l.inFly[:0]
	var due []flight
	for _, f := range l.inFly {
		if !f.at.After(l.now) {
			due = append(due, f)
		} else {
			keep = append(keep, f)
		}
	}
	l.inFly = keep
	for _, f := range due {
		dst := l.a
		if f.toB {
			dst = l.b
		}
		if err := dst.receive(f.body, l.now); err != nil {
			return err
		}
		if dst.needsEarlyAck() {
			l.flushOne(dst, false)
		}
	}
	if flush {
		l.flushOne(l.a, l.now.Sub(l.a.lastSend) >= KeepaliveInterval)
		l.flushOne(l.b, l.now.Sub(l.b.lastSend) >= KeepaliveInterval)
	}
	return nil
}

func (l *simLink) flushOne(e *endpoint, keepalive bool) {
	toB := e == l.a
	e.build(l.now, l.scratch, keepalive, maxPacketsPerFlush, func(b []byte) { l.send(toB, b) })
}

func payload(i, size int) []byte {
	b := make([]byte, size)
	for j := range b {
		b[j] = byte(i*31 + j)
	}
	if size >= 4 {
		binary.LittleEndian.PutUint32(b, uint32(i))
	}
	return b
}

func runReliable(t *testing.T, seed uint64, loss, dup float64, sizes []int, n int) *simLink {
	t.Helper()
	l := newSimLink(seed, loss, dup, 30*time.Millisecond, 40*time.Millisecond)
	for i := range n {
		if err := l.a.queue(Reliable, payload(i, sizes[i%len(sizes)])); err != nil {
			t.Fatal(err)
		}
	}
	var got [][]byte
	for steps := 0; len(got) < n; steps++ {
		if steps > 200000 {
			t.Fatalf("only %d/%d delivered", len(got), n)
		}
		if err := l.step(5*time.Millisecond, steps%6 == 0); err != nil {
			t.Fatal(err)
		}
		l.b.drain(func(m Message) {
			if m.Channel != Reliable {
				t.Fatalf("unexpected channel %d", m.Channel)
			}
			got = append(got, m.Data)
		})
	}
	for i, d := range got {
		if !bytes.Equal(d, payload(i, sizes[i%len(sizes)])) {
			t.Fatalf("message %d corrupted or out of order (len %d)", i, len(d))
		}
	}
	return l
}

func TestReliableOrderedUnderLoss(t *testing.T) {
	for _, tc := range []struct {
		loss, dup float64
	}{{0, 0}, {0.1, 0.05}, {0.3, 0.1}, {0.5, 0.2}} {
		t.Run(fmt.Sprintf("loss=%v,dup=%v", tc.loss, tc.dup), func(t *testing.T) {
			runReliable(t, 7, tc.loss, tc.dup, []int{1, 16, 200, 1100}, 3000)
		})
	}
}

func TestFragmentation(t *testing.T) {
	// Messages from tiny to 200 KiB, mixed, under loss.
	runReliable(t, 11, 0.2, 0.05, []int{5000, 3, 200 * 1024, 1101, 2200}, 40)
}

func TestReliableWindowOverflow(t *testing.T) {
	// More messages than the window queued at once must still arrive in order.
	l := runReliable(t, 13, 0.1, 0, []int{8}, 5*window)
	if st := l.a.snapshot(l.now); st.Resends == 0 {
		t.Log("no resends observed (unexpected with 10% loss)")
	}
}

func TestUnreliableDeliveryAndDuplicates(t *testing.T) {
	l := newSimLink(3, 0.2, 0.5, 20*time.Millisecond, 30*time.Millisecond)
	const n = 2000
	seen := map[uint32]int{}
	for i := range n {
		_ = l.a.queue(Unreliable, payload(i, 12))
		if err := l.step(10*time.Millisecond, true); err != nil {
			t.Fatal(err)
		}
		l.b.drain(func(m Message) { seen[binary.LittleEndian.Uint32(m.Data)]++ })
	}
	for range 50 {
		_ = l.step(10*time.Millisecond, true)
		l.b.drain(func(m Message) { seen[binary.LittleEndian.Uint32(m.Data)]++ })
	}
	for id, c := range seen {
		if c != 1 {
			t.Fatalf("message %d delivered %d times", id, c)
		}
	}
	ratio := float64(len(seen)) / n
	if ratio < 0.7 || ratio > 0.9 {
		t.Fatalf("delivery ratio %.2f outside expected range for 20%% loss", ratio)
	}
}

func TestRTTAndLossEstimate(t *testing.T) {
	l := newSimLink(5, 0.1, 0, 50*time.Millisecond, 0)
	for range 2000 {
		_ = l.a.queue(Unreliable, []byte{1})
		_ = l.b.queue(Unreliable, []byte{2})
		if err := l.step(10*time.Millisecond, true); err != nil {
			t.Fatal(err)
		}
		l.a.drain(func(Message) {})
		l.b.drain(func(Message) {})
	}
	st := l.a.snapshot(l.now)
	// RTT = 2×50ms + up to one 10ms flush interval of ack delay.
	if st.RTT < 95*time.Millisecond || st.RTT > 125*time.Millisecond {
		t.Fatalf("rtt %v", st.RTT)
	}
	if st.PacketLoss < 0.05 || st.PacketLoss > 0.16 {
		t.Fatalf("loss estimate %.3f for 10%% loss", st.PacketLoss)
	}
}

func TestSequenceWraparound(t *testing.T) {
	l := newSimLink(9, 0.05, 0, 5*time.Millisecond, 5*time.Millisecond)
	got := 0
	const n = 70000 // > 65536 packet and reliable sequence numbers
	for i := 0; got < n; i++ {
		if i < n {
			_ = l.a.queue(Reliable, payload(i, 4))
		}
		if err := l.step(time.Millisecond, true); err != nil {
			t.Fatal(err)
		}
		l.b.drain(func(m Message) {
			if binary.LittleEndian.Uint32(m.Data) != uint32(got) {
				t.Fatalf("out of order at %d", got)
			}
			got++
		})
		if i > 5*n {
			t.Fatalf("stalled at %d", got)
		}
	}
}

func TestMalformedBodies(t *testing.T) {
	now := time.Now()
	cases := [][]byte{
		{},
		{1, 2, 3},
		append(make([]byte, innerHeaderSize), 7), // unknown chunk kind
		append(make([]byte, innerHeaderSize), chunkRel, 0),          // truncated rel seq
		append(make([]byte, innerHeaderSize), chunkUnrel, 0x80),     // bad varint
		append(make([]byte, innerHeaderSize), chunkUnrel, 10, 1, 2), // length beyond packet
		append(make([]byte, innerHeaderSize), chunkUnrel|chunkMore, 1, 1),
	}
	for i, c := range cases {
		e := newEndpoint(now)
		if err := e.receive(c, now); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
}

func TestMessageTooBig(t *testing.T) {
	e := newEndpoint(time.Now())
	e.maxMsgSize = 100
	if err := e.queue(Reliable, make([]byte, 101)); err == nil {
		t.Fatal("oversized message queued")
	}
	// Oversized unreliable messages fall back to the reliable channel.
	e.maxMsgSize = DefaultMaxMessageSize
	if err := e.queue(Unreliable, make([]byte, 5000)); err != nil {
		t.Fatal(err)
	}
	if len(e.unrelMsgs) != 0 || e.relNext == 0 {
		t.Fatal("large unreliable message not promoted to reliable")
	}
}

func BenchmarkEndpointBuild(b *testing.B) {
	now := time.Now()
	e := newEndpoint(now)
	scratch := make([]byte, 0, MaxPacketSize)
	msg := make([]byte, 40)
	b.ReportAllocs()
	for b.Loop() {
		for range 30 {
			_ = e.queue(Unreliable, msg)
		}
		e.build(now, scratch, false, maxPacketsPerFlush, func([]byte) {})
	}
}
