package transport

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// ServerConfig configures a Server.
type ServerConfig struct {
	// Encryption enables X25519 + ChaCha20-Poly1305 for all sessions.
	Encryption bool
	// MaxConns caps concurrent and pending connections (0 = 4096).
	MaxConns int
	// Timeout disconnects silent peers (0 = DefaultTimeout).
	Timeout time.Duration
	// MaxMessageSize bounds reassembled reliable messages (0 = DefaultMaxMessageSize).
	MaxMessageSize int
	// MaxRelBacklog bounds reliable bytes queued for one peer; beyond it the
	// peer is disconnected (0 = DefaultMaxRelBacklog).
	MaxRelBacklog int
	// MaxPacketsPerSec limits datagrams from one connection, checked before
	// decryption (0 = no limit). A peer over it for 5 s in a row is cut off.
	MaxPacketsPerSec int
	// Now overrides the clock (tests).
	Now func() time.Time
}

// EventKind distinguishes server events.
type EventKind uint8

const (
	// EventConnect: a peer completed the handshake; call Accept or Reject.
	EventConnect EventKind = iota + 1
	// EventDisconnect: the connection is gone (timeout, peer, local or rejected).
	EventDisconnect
)

// Event is delivered by Server.PollEvents.
type Event struct {
	Kind    EventKind
	Conn    *Conn
	Payload []byte // EventConnect: the client's connect payload
	Reason  string // EventDisconnect
}

// Conn is a server-side connection.
type Conn struct {
	s        *session
	srv      *Server
	nonce    uint64
	accepted atomic.Bool
	gone     atomic.Bool
	flood    floodGate // read goroutine only
	// UserData is free for the application.
	UserData any
}

// Addr returns the peer address.
func (c *Conn) Addr() netip.AddrPort { return c.s.addr }

// SessionID returns the random session identifier.
func (c *Conn) SessionID() uint32 { return c.s.id }

// Send queues a message. data is copied.
func (c *Conn) Send(ch Channel, data []byte) error { return c.s.send(ch, data) }

// SendMany queues several messages under one lock. Data is copied.
func (c *Conn) SendMany(ch Channel, msgs [][]byte) error { return c.s.sendMany(ch, msgs) }

// Flush transmits everything due.
func (c *Conn) Flush(now time.Time) { c.s.flush(now) }

// Drain passes delivered messages to fn.
func (c *Conn) Drain(fn func(Message)) { c.s.drain(fn) }

// Stats returns connection statistics.
func (c *Conn) Stats() Stats { return c.s.stats(c.srv.now()) }

// Accept completes a pending connection.
func (c *Conn) Accept() {
	if c.accepted.Swap(true) {
		return
	}
	c.srv.sendAccept(c)
}

// Reject refuses a pending connection.
func (c *Conn) Reject(reason string) {
	if c.accepted.Load() {
		c.Disconnect(reason)
		return
	}
	c.srv.sendReject(c.s.addr, c.nonce, reason)
	c.srv.remove(c, reason)
}

// Disconnect closes the connection, notifying the peer.
func (c *Conn) Disconnect(reason string) {
	c.s.mu.Lock()
	c.s.closeLocked(reason)
	c.s.mu.Unlock()
	c.srv.remove(c, reason)
}

// Server accepts GoMP transport connections on one UDP socket.
type Server struct {
	pc      PacketConn
	cfg     ServerConfig
	secret  [32]byte
	priv    *ecdh.PrivateKey
	pub     []byte
	mu      sync.RWMutex
	conns   map[netip.AddrPort]*Conn
	evMu    sync.Mutex
	events  []Event
	closed  atomic.Bool
	done    chan struct{}
	dropped atomic.Uint64
	flooded atomic.Uint64
	writer  *socketWriter
}

// FloodDropped is how many datagrams were dropped by the per-connection limit.
func (s *Server) FloodDropped() uint64 { return s.flooded.Load() }

// Listen opens a UDP socket on addr ("host:port") and starts serving.
func Listen(addr string, cfg ServerConfig) (*Server, error) {
	ua, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return nil, err
	}
	uc, err := net.ListenUDP("udp", ua)
	if err != nil {
		return nil, err
	}
	_ = uc.SetReadBuffer(8 << 20)
	_ = uc.SetWriteBuffer(8 << 20)
	return NewServer(uc, cfg)
}

// NewServer serves on an existing socket.
func NewServer(pc PacketConn, cfg ServerConfig) (*Server, error) {
	if cfg.MaxConns <= 0 {
		cfg.MaxConns = 4096
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = DefaultTimeout
	}
	if cfg.MaxMessageSize <= 0 {
		cfg.MaxMessageSize = DefaultMaxMessageSize
	}
	if cfg.MaxRelBacklog <= 0 {
		cfg.MaxRelBacklog = DefaultMaxRelBacklog
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	s := &Server{pc: pc, cfg: cfg, conns: make(map[netip.AddrPort]*Conn), done: make(chan struct{})}
	if _, err := rand.Read(s.secret[:]); err != nil {
		return nil, err
	}
	if cfg.Encryption {
		k, err := newKeyPair()
		if err != nil {
			return nil, err
		}
		s.priv, s.pub = k, k.PublicKey().Bytes()
	}
	s.writer = newSocketWriter(pc, writerCount(runtime.GOOS, runtime.GOMAXPROCS(0)))
	go s.readLoop()
	return s, nil
}

// LocalAddr returns the bound address.
func (s *Server) LocalAddr() net.Addr { return s.pc.LocalAddr() }

func (s *Server) now() time.Time { return s.cfg.Now() }

// Close stops the server and closes the socket without notifying peers.
func (s *Server) Close() error {
	if s.closed.Swap(true) {
		return nil
	}
	s.writer.close()
	err := s.pc.Close()
	<-s.done
	return err
}

// Shutdown disconnects every peer with reason and closes the server.
func (s *Server) Shutdown(reason string) error {
	for _, c := range s.snapshotConns() {
		c.Disconnect(reason)
	}
	return s.Close()
}

// PollEvents passes queued connect/disconnect events to fn in order.
func (s *Server) PollEvents(fn func(Event)) {
	s.evMu.Lock()
	evs := s.events
	s.events = nil
	s.evMu.Unlock()
	for _, e := range evs {
		fn(e)
	}
}

func (s *Server) pushEvent(e Event) {
	s.evMu.Lock()
	s.events = append(s.events, e)
	s.evMu.Unlock()
}

// Update disconnects peers that timed out. Call it once per tick.
func (s *Server) Update() {
	now := s.now()
	for _, c := range s.snapshotConns() {
		if now.Sub(c.s.lastRecv()) > s.cfg.Timeout {
			c.Disconnect("timeout")
		}
	}
}

// FlushAll builds the due packets of every accepted connection using all
// CPUs and hands them to the socket writers; it does not wait for sendto.
func (s *Server) FlushAll() { s.FlushAllAt(s.now()) }

// FlushAllAt is FlushAll with an explicit time; connections already flushed
// with FlushAsync at the same time are skipped.
func (s *Server) FlushAllAt(now time.Time) {
	if s.closed.Load() {
		return
	}
	conns := s.snapshotConns()
	workers := max(1, min(runtime.GOMAXPROCS(0), len(conns)/16))
	var wg sync.WaitGroup
	var next atomic.Int64
	for range workers {
		wg.Go(func() {
			var batch []outPacket
			for {
				i := int(next.Add(1)) - 1
				if i >= len(conns) {
					break
				}
				if c := conns[i]; c.accepted.Load() {
					batch = c.s.flushDeferred(now, batch)
					if len(batch) >= batchSize {
						s.writer.enqueue(batch)
						batch = nil
					}
				}
			}
			s.writer.enqueue(batch)
		})
	}
	wg.Wait()
}

// NumConns returns the number of tracked (pending + accepted) connections.
func (s *Server) NumConns() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.conns)
}

// DroppedPackets counts datagrams discarded as malformed or unauthenticated.
func (s *Server) DroppedPackets() uint64 { return s.dropped.Load() }

// WriterStalls is how many times the game loop waited for the socket writers.
func (s *Server) WriterStalls() uint64 {
	if s.writer == nil {
		return 0
	}
	return s.writer.Stalls()
}

func (s *Server) snapshotConns() []*Conn {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Conn, 0, len(s.conns))
	for _, c := range s.conns {
		out = append(out, c)
	}
	return out
}

func (s *Server) remove(c *Conn, reason string) {
	s.mu.Lock()
	if cur, ok := s.conns[c.s.addr]; ok && cur == c {
		delete(s.conns, c.s.addr)
	}
	s.mu.Unlock()
	if !c.gone.Swap(true) {
		s.pushEvent(Event{Kind: EventDisconnect, Conn: c, Reason: reason})
	}
}

func (s *Server) readLoop() {
	defer close(s.done)
	buf := make([]byte, 2048)
	for {
		n, addr, err := s.pc.ReadFromUDPAddrPort(buf)
		if err != nil {
			if s.closed.Load() || errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		if n == 0 || n > MaxPacketSize {
			s.dropped.Add(1)
			continue
		}
		s.handlePacket(buf[:n], unmap(addr))
	}
}

func (s *Server) handlePacket(pkt []byte, addr netip.AddrPort) {
	now := s.now()
	switch pkt[0] {
	case kindHello:
		s.handleHello(pkt, addr, now)
	case kindConnect:
		s.handleConnect(pkt, addr, now)
	case kindData, kindDisconnect:
		s.mu.RLock()
		c := s.conns[addr]
		s.mu.RUnlock()
		if c == nil || !c.accepted.Load() {
			s.dropped.Add(1)
			return
		}
		if ok, cut := c.flood.allow(now, s.cfg.MaxPacketsPerSec); !ok {
			s.flooded.Add(1)
			if cut {
				c.Disconnect("packet flood")
			}
			return
		}
		switch c.s.handleFramed(pkt, now) {
		case frameRejected:
			s.dropped.Add(1)
		case frameClosed:
			_, reason := c.s.isClosed()
			s.remove(c, reason)
		}
	default:
		s.dropped.Add(1)
	}
}

func (s *Server) handleHello(pkt []byte, addr netip.AddrPort, now time.Time) {
	if len(pkt) < helloSize || binary.LittleEndian.Uint32(pkt[1:5]) != Magic {
		s.dropped.Add(1)
		return
	}
	nonce := binary.LittleEndian.Uint64(pkt[7:15])
	if v := binary.LittleEndian.Uint16(pkt[5:7]); v != ProtocolVersion {
		s.sendReject(addr, nonce, "protocol version mismatch")
		return
	}
	cookie := makeCookie(s.secret[:], addr, nonce, uint32(now.Unix()))
	out := make([]byte, 0, 1+8+cookieSize+1+keySize)
	out = append(out, kindChallenge)
	out = binary.LittleEndian.AppendUint64(out, nonce)
	out = append(out, cookie[:]...)
	if s.priv != nil {
		out = append(out, flagEncrypt)
		out = append(out, s.pub...)
	} else {
		out = append(out, 0)
	}
	_, _ = s.pc.WriteToUDPAddrPort(out, addr)
}

func (s *Server) handleConnect(pkt []byte, addr netip.AddrPort, now time.Time) {
	// kind(1) magic(4) version(2) nonce(8) cookie(20) [clientPub(32)] payloadLen(2) payload
	const fixed = 1 + 4 + 2 + 8 + cookieSize
	if len(pkt) < fixed+2 || binary.LittleEndian.Uint32(pkt[1:5]) != Magic {
		s.dropped.Add(1)
		return
	}
	nonce := binary.LittleEndian.Uint64(pkt[7:15])
	if !checkCookie(s.secret[:], addr, nonce, pkt[15:fixed], now) {
		s.dropped.Add(1)
		return
	}
	p := pkt[fixed:]
	var clientPub []byte
	if s.priv != nil {
		if len(p) < keySize+2 {
			s.dropped.Add(1)
			return
		}
		clientPub, p = p[:keySize], p[keySize:]
	}
	plen := int(binary.LittleEndian.Uint16(p))
	if plen > MaxConnectPayload || len(p) != 2+plen {
		s.dropped.Add(1)
		return
	}
	payload := append([]byte(nil), p[2:]...)

	s.mu.Lock()
	if old, ok := s.conns[addr]; ok {
		if old.nonce == nonce {
			s.mu.Unlock()
			if old.accepted.Load() {
				s.sendAccept(old) // the client missed our ACCEPT
			}
			return
		}
		// Same address, new handshake: the client restarted.
		s.mu.Unlock()
		old.Disconnect("reconnected")
		s.mu.Lock()
	}
	if len(s.conns) >= s.cfg.MaxConns {
		s.mu.Unlock()
		s.sendReject(addr, nonce, "server full")
		return
	}
	ss := newSession(s.pc, addr, randSessionID(), now)
	ss.ep.maxMsgSize = s.cfg.MaxMessageSize
	ss.ep.maxBacklog = s.cfg.MaxRelBacklog
	if s.priv != nil {
		peer, err := ecdh.X25519().NewPublicKey(clientPub)
		if err != nil {
			s.mu.Unlock()
			s.dropped.Add(1)
			return
		}
		shared, err := s.priv.ECDH(peer)
		if err != nil {
			s.mu.Unlock()
			s.dropped.Add(1)
			return
		}
		c2s, s2c, err := sessionKeys(shared, nonce, s.pub, clientPub)
		if err != nil {
			s.mu.Unlock()
			return
		}
		ss.recvAEAD, ss.sendAEAD = c2s, s2c
	}
	c := &Conn{s: ss, srv: s, nonce: nonce}
	s.conns[addr] = c
	s.mu.Unlock()
	s.pushEvent(Event{Kind: EventConnect, Conn: c, Payload: payload})
}

func (s *Server) sendAccept(c *Conn) {
	out := make([]byte, 0, 13)
	out = append(out, kindAccept)
	out = binary.LittleEndian.AppendUint64(out, c.nonce)
	out = binary.LittleEndian.AppendUint32(out, c.s.id)
	_, _ = s.pc.WriteToUDPAddrPort(out, c.s.addr)
}

func (s *Server) sendReject(addr netip.AddrPort, nonce uint64, reason string) {
	if len(reason) > maxDisconnectReason {
		reason = reason[:maxDisconnectReason]
	}
	out := make([]byte, 0, 10+len(reason))
	out = append(out, kindReject)
	out = binary.LittleEndian.AppendUint64(out, nonce)
	out = append(out, byte(len(reason)))
	out = append(out, reason...)
	_, _ = s.pc.WriteToUDPAddrPort(out, addr)
}
