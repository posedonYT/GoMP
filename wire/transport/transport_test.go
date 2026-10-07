package transport_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"sync"
	"testing"
	"time"

	"gomp/wire/transport"
	"gomp/wire/transport/faultnet"
)

// harness runs a server with a goroutine that accepts every connection
// (unless rejectAll) and echoes reliable messages back.
type harness struct {
	t      *testing.T
	srv    *transport.Server
	stop   chan struct{}
	wg     sync.WaitGroup
	mu     sync.Mutex
	events []transport.Event
}

func newHarness(t *testing.T, cfg transport.ServerConfig, reject string) *harness {
	t.Helper()
	srv, err := transport.Listen("127.0.0.1:0", cfg)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, srv: srv, stop: make(chan struct{})}
	conns := map[*transport.Conn]bool{}
	h.wg.Go(func() {
		tick := time.NewTicker(5 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-h.stop:
				return
			case <-tick.C:
			}
			srv.PollEvents(func(e transport.Event) {
				h.mu.Lock()
				h.events = append(h.events, e)
				h.mu.Unlock()
				switch e.Kind {
				case transport.EventConnect:
					if reject != "" {
						e.Conn.Reject(reject)
						return
					}
					e.Conn.Accept()
					conns[e.Conn] = true
				case transport.EventDisconnect:
					delete(conns, e.Conn)
				}
			})
			for c := range conns {
				c.Drain(func(m transport.Message) { _ = c.Send(m.Channel, m.Data) })
			}
			srv.Update()
			srv.FlushAll()
		}
	})
	t.Cleanup(func() {
		close(h.stop)
		h.wg.Wait()
		srv.Close()
	})
	return h
}

func (h *harness) addr() netip.AddrPort {
	return h.srv.LocalAddr().(*net.UDPAddr).AddrPort()
}

func (h *harness) waitEvent(kind transport.EventKind, timeout time.Duration) transport.Event {
	h.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		h.mu.Lock()
		for i, e := range h.events {
			if e.Kind == kind {
				h.events = append(h.events[:i], h.events[i+1:]...)
				h.mu.Unlock()
				return e
			}
		}
		h.mu.Unlock()
		time.Sleep(2 * time.Millisecond)
	}
	h.t.Fatalf("no event %d within %v", kind, timeout)
	return transport.Event{}
}

func dial(t *testing.T, h *harness, pc transport.PacketConn, payload []byte) *transport.Client {
	t.Helper()
	ctx := context.Background()
	var c *transport.Client
	var err error
	if pc == nil {
		c, err = transport.Dial(ctx, h.addr().String(), transport.ClientConfig{Payload: payload})
	} else {
		c, err = transport.DialConn(ctx, pc, h.addr(), transport.ClientConfig{Payload: payload, ConnectTimeout: 10 * time.Second})
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close("test end") })
	return c
}

// echo sends n reliable messages and waits for all echoes in order.
func echo(t *testing.T, c *transport.Client, n, size int, timeout time.Duration) {
	t.Helper()
	for i := range n {
		b := make([]byte, size)
		binary.LittleEndian.PutUint32(b, uint32(i))
		if err := c.Send(transport.Reliable, b); err != nil {
			t.Fatal(err)
		}
	}
	got := 0
	deadline := time.Now().Add(timeout)
	for got < n {
		if time.Now().After(deadline) {
			t.Fatalf("echoed %d/%d", got, n)
		}
		c.Flush(time.Now())
		c.Drain(func(m transport.Message) {
			if v := binary.LittleEndian.Uint32(m.Data); v != uint32(got) || len(m.Data) != size {
				t.Fatalf("echo %d: got id %d len %d", got, v, len(m.Data))
			}
			got++
		})
		time.Sleep(2 * time.Millisecond)
	}
}

func TestHandshakeAndEcho(t *testing.T) {
	for _, enc := range []bool{false, true} {
		t.Run(map[bool]string{false: "plain", true: "encrypted"}[enc], func(t *testing.T) {
			h := newHarness(t, transport.ServerConfig{Encryption: enc}, "")
			c := dial(t, h, nil, []byte("hello payload"))
			ev := h.waitEvent(transport.EventConnect, time.Second)
			if string(ev.Payload) != "hello payload" {
				t.Fatalf("payload %q", ev.Payload)
			}
			echo(t, c, 200, 64, 5*time.Second)
			echo(t, c, 3, 50_000, 5*time.Second) // fragmented
		})
	}
}

func TestEchoOverBadNetwork(t *testing.T) {
	h := newHarness(t, transport.ServerConfig{Encryption: true}, "")
	uc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	fc := faultnet.Wrap(uc, faultnet.Config{Loss: 0.2, Duplicate: 0.1, Latency: 20 * time.Millisecond, Jitter: 30 * time.Millisecond, Seed: 42})
	t.Cleanup(func() { fc.Close() })
	c := dial(t, h, fc, nil)
	echo(t, c, 1000, 32, 20*time.Second)
	if fc.Dropped.Load() == 0 {
		t.Fatal("faultnet dropped nothing")
	}
	st := c.Stats()
	if st.Resends == 0 {
		t.Fatal("no resends despite loss")
	}
}

func TestReject(t *testing.T) {
	h := newHarness(t, transport.ServerConfig{}, "banned")
	_, err := transport.Dial(context.Background(), h.addr().String(), transport.ClientConfig{})
	var re *transport.RejectedError
	if !errors.As(err, &re) || re.Reason != "banned" {
		t.Fatalf("err = %v", err)
	}
}

func TestServerFull(t *testing.T) {
	h := newHarness(t, transport.ServerConfig{MaxConns: 1}, "")
	dial(t, h, nil, nil)
	_, err := transport.Dial(context.Background(), h.addr().String(), transport.ClientConfig{})
	var re *transport.RejectedError
	if !errors.As(err, &re) || re.Reason != "server full" {
		t.Fatalf("err = %v", err)
	}
}

func TestClientDisconnectNotifiesServer(t *testing.T) {
	h := newHarness(t, transport.ServerConfig{}, "")
	c := dial(t, h, nil, nil)
	h.waitEvent(transport.EventConnect, time.Second)
	c.Close("bye")
	ev := h.waitEvent(transport.EventDisconnect, 2*time.Second)
	if ev.Reason != "bye" {
		t.Fatalf("reason %q", ev.Reason)
	}
}

func TestServerTimeout(t *testing.T) {
	h := newHarness(t, transport.ServerConfig{Timeout: 300 * time.Millisecond}, "")
	dial(t, h, nil, nil) // never flushes after the handshake
	h.waitEvent(transport.EventConnect, time.Second)
	ev := h.waitEvent(transport.EventDisconnect, 3*time.Second)
	if ev.Reason != "timeout" {
		t.Fatalf("reason %q", ev.Reason)
	}
}

func TestServerKickReachesClient(t *testing.T) {
	h := newHarness(t, transport.ServerConfig{Encryption: true}, "")
	c := dial(t, h, nil, nil)
	ev := h.waitEvent(transport.EventConnect, time.Second)
	ev.Conn.Disconnect("kicked: cheating")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if closed, reason := c.Closed(); closed {
			if reason != "kicked: cheating" {
				t.Fatalf("reason %q", reason)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("client not disconnected")
}

func rawSocket(t *testing.T) *net.UDPConn {
	uc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { uc.Close() })
	return uc
}

func readWithin(uc *net.UDPConn, d time.Duration) []byte {
	_ = uc.SetReadDeadline(time.Now().Add(d))
	buf := make([]byte, 2048)
	n, err := uc.Read(buf)
	if err != nil {
		return nil
	}
	return buf[:n]
}

func TestForgedCookieIgnored(t *testing.T) {
	h := newHarness(t, transport.ServerConfig{}, "")
	uc := rawSocket(t)
	pkt := []byte{3}
	pkt = binary.LittleEndian.AppendUint32(pkt, transport.Magic)
	pkt = binary.LittleEndian.AppendUint16(pkt, transport.ProtocolVersion)
	pkt = binary.LittleEndian.AppendUint64(pkt, 1234)
	pkt = append(pkt, make([]byte, 20)...) // bogus cookie
	pkt = binary.LittleEndian.AppendUint16(pkt, 0)
	_, _ = uc.WriteToUDPAddrPort(pkt, h.addr())
	if r := readWithin(uc, 200*time.Millisecond); r != nil {
		t.Fatalf("server answered forged CONNECT: %x", r)
	}
	if h.srv.NumConns() != 0 {
		t.Fatal("connection created from forged cookie")
	}
}

func TestShortHelloNotAmplified(t *testing.T) {
	h := newHarness(t, transport.ServerConfig{Encryption: true}, "")
	uc := rawSocket(t)
	pkt := []byte{1}
	pkt = binary.LittleEndian.AppendUint32(pkt, transport.Magic)
	pkt = binary.LittleEndian.AppendUint16(pkt, transport.ProtocolVersion)
	pkt = binary.LittleEndian.AppendUint64(pkt, 1)
	_, _ = uc.WriteToUDPAddrPort(pkt, h.addr())
	if r := readWithin(uc, 200*time.Millisecond); r != nil {
		t.Fatal("server answered an unpadded HELLO")
	}
	// A padded HELLO gets a CHALLENGE no larger than the request.
	padded := append(pkt, make([]byte, 96-len(pkt))...)
	_, _ = uc.WriteToUDPAddrPort(padded, h.addr())
	r := readWithin(uc, time.Second)
	if r == nil || r[0] != 2 || len(r) > len(padded) {
		t.Fatalf("challenge %x (len %d)", r, len(r))
	}
}

func TestTamperedEncryptedPacketDropped(t *testing.T) {
	h := newHarness(t, transport.ServerConfig{Encryption: true}, "")
	uc := rawSocket(t)
	// Proxy socket: client talks to uc, uc forwards to the server flipping one bit
	// in the first DATA packet.
	c, err := transport.DialConn(context.Background(), &tamper{UDPConn: uc, flipFirstData: true}, h.addr(), transport.ClientConfig{})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close("end")
	echo(t, c, 50, 16, 5*time.Second)
	if h.srv.DroppedPackets() == 0 {
		t.Fatal("tampered packet was not dropped")
	}
}

type tamper struct {
	*net.UDPConn
	mu            sync.Mutex
	flipFirstData bool
}

func (tc *tamper) WriteToUDPAddrPort(b []byte, addr netip.AddrPort) (int, error) {
	tc.mu.Lock()
	if tc.flipFirstData && len(b) > 20 && b[0] == 6 {
		tc.flipFirstData = false
		tc.mu.Unlock()
		bad := bytes.Clone(b)
		bad[len(bad)-1] ^= 1
		return tc.UDPConn.WriteToUDPAddrPort(bad, addr)
	}
	tc.mu.Unlock()
	return tc.UDPConn.WriteToUDPAddrPort(b, addr)
}

func TestManyClients(t *testing.T) {
	h := newHarness(t, transport.ServerConfig{}, "")
	var wg sync.WaitGroup
	for range 50 {
		wg.Go(func() {
			c, err := transport.Dial(context.Background(), h.addr().String(), transport.ClientConfig{})
			if err != nil {
				t.Error(err)
				return
			}
			defer c.Close("done")
			echo(t, c, 100, 24, 10*time.Second)
		})
	}
	wg.Wait()
}

// dropAccept discards incoming ACCEPT packets until a deadline, emulating a
// lost reply; the client must restart the handshake with a fresh cookie.
type dropAccept struct {
	*net.UDPConn
	until time.Time
}

func (d *dropAccept) ReadFromUDPAddrPort(b []byte) (int, netip.AddrPort, error) {
	for {
		n, addr, err := d.UDPConn.ReadFromUDPAddrPort(b)
		if err == nil && n > 0 && b[0] == 4 && time.Now().Before(d.until) {
			continue
		}
		return n, addr, err
	}
}

func TestHandshakeRestartsAfterLostAccept(t *testing.T) {
	h := newHarness(t, transport.ServerConfig{Encryption: true}, "")
	uc := rawSocket(t)
	pc := &dropAccept{UDPConn: uc, until: time.Now().Add(4 * time.Second)}
	c, err := transport.DialConn(context.Background(), pc, h.addr(), transport.ClientConfig{ConnectTimeout: 15 * time.Second})
	if err != nil {
		t.Fatalf("handshake did not recover: %v", err)
	}
	defer c.Close("end")
	// The session must be usable: keys on both sides match the final handshake.
	echo(t, c, 20, 16, 5*time.Second)
}
