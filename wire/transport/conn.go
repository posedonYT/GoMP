package transport

import (
	"crypto/cipher"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"sync"
	"time"
)

const (
	// KeepaliveInterval is the longest a connection stays silent.
	KeepaliveInterval = 250 * time.Millisecond
	// DefaultTimeout disconnects a peer that sent nothing for this long.
	DefaultTimeout = 10 * time.Second
	// earlyAckThreshold sends an ack immediately after this many packets so
	// acknowledgements never fall outside the 32-bit ack window.
	earlyAckThreshold   = 16
	maxPacketsPerFlush  = 256
	maxDisconnectReason = 200
)

// ErrClosed is returned when using a closed connection.
var ErrClosed = errors.New("transport: connection closed")

// session holds the per-peer state common to server and client connections.
type session struct {
	mu       sync.Mutex
	ep       *endpoint
	id       uint32
	addr     netip.AddrPort
	pc       PacketConn
	sendAEAD cipher.AEAD
	recvAEAD cipher.AEAD
	sendCtr  uint64
	recvCtr  uint64 // highest counter accepted
	closed   bool
	reason   string
	scratch  []byte
	out      []byte
	// deferred collects datagrams in outBatch instead of writing them
	// (server flushes hand them to the socket writers).
	deferred  bool
	outBatch  []outPacket
	udpAddr   *net.UDPAddr
	lastFlush time.Time // time of the last deferred flush (skip duplicates)
}

func newSession(pc PacketConn, addr netip.AddrPort, id uint32, now time.Time) *session {
	return &session{
		udpAddr: net.UDPAddrFromAddrPort(addr),
		ep:      newEndpoint(now),
		id:      id,
		addr:    addr,
		pc:      pc,
		scratch: make([]byte, 0, MaxPacketSize),
		out:     make([]byte, 0, MaxPacketSize+64),
	}
}

// writeFramed sends a DATA or DISCONNECT datagram. Caller holds mu.
func (s *session) writeFramed(kind byte, body []byte) {
	out := s.out[:0]
	out = append(out, kind)
	out = binary.LittleEndian.AppendUint32(out, s.id)
	if s.sendAEAD != nil {
		s.sendCtr++
		out = binary.LittleEndian.AppendUint64(out, s.sendCtr)
		var nonce [12]byte
		binary.LittleEndian.PutUint64(nonce[4:], s.sendCtr)
		out = s.sendAEAD.Seal(out, nonce[:], body, out)
	} else {
		out = append(out, body...)
	}
	s.out = out
	if s.deferred {
		buf := packetPool.Get().(*[]byte)
		*buf = append((*buf)[:0], out...)
		s.outBatch = append(s.outBatch, outPacket{buf: buf, addr: s.addr, ua: s.udpAddr})
		return
	}
	_, _ = s.pc.WriteToUDPAddrPort(out, s.addr)
}

// openFramed authenticates and decrypts a DATA/DISCONNECT datagram, returning
// the inner body. Caller holds mu.
func (s *session) openFramed(pkt []byte) ([]byte, bool) {
	if len(pkt) < 5 || binary.LittleEndian.Uint32(pkt[1:5]) != s.id {
		return nil, false
	}
	if s.recvAEAD == nil {
		return pkt[5:], true
	}
	if len(pkt) < 5+8+tagSize {
		return nil, false
	}
	ctr := binary.LittleEndian.Uint64(pkt[5:13])
	// Reject counters far behind the newest one (replays); recent ones are
	// filtered as duplicate packets by the endpoint.
	if s.recvCtr > window && ctr < s.recvCtr-window {
		return nil, false
	}
	var nonce [12]byte
	binary.LittleEndian.PutUint64(nonce[4:], ctr)
	body, err := s.recvAEAD.Open(s.scratch[:0], nonce[:], pkt[13:], pkt[:13])
	if err != nil {
		return nil, false
	}
	if ctr > s.recvCtr {
		s.recvCtr = ctr
	}
	return body, true
}

type frameResult uint8

const (
	frameOK frameResult = iota
	frameRejected
	frameClosed
)

// handleFramed processes a DATA/DISCONNECT datagram.
func (s *session) handleFramed(pkt []byte, now time.Time) frameResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return frameRejected
	}
	body, ok := s.openFramed(pkt)
	if !ok {
		return frameRejected
	}
	if pkt[0] == kindDisconnect {
		s.closed = true
		r := string(body)
		if len(r) > maxDisconnectReason {
			r = r[:maxDisconnectReason]
		}
		s.reason = r
		return frameClosed
	}
	if err := s.ep.receive(body, now); err != nil {
		s.closeLocked("protocol error: " + err.Error())
		return frameClosed
	}
	if s.ep.needsEarlyAck() {
		s.flushLocked(now, false)
	}
	return frameOK
}

func (s *session) send(ch Channel, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	if err := s.ep.queue(ch, data); err != nil {
		s.closeLocked(err.Error())
		return err
	}
	return nil
}

func (s *session) sendMany(ch Channel, msgs [][]byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	for _, m := range msgs {
		if err := s.ep.queue(ch, m); err != nil {
			s.closeLocked(err.Error())
			return err
		}
	}
	return nil
}

func (s *session) flush(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	keepalive := now.Sub(s.ep.lastSend) >= KeepaliveInterval
	s.flushLocked(now, keepalive)
}

// flushDeferred builds due packets and returns them for the socket writers.
func (s *session) flushDeferred(now time.Time, into []outPacket) []outPacket {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return into
	}
	if s.lastFlush.Equal(now) {
		return into
	}
	s.lastFlush = now
	keepalive := now.Sub(s.ep.lastSend) >= KeepaliveInterval
	s.deferred, s.outBatch = true, into
	s.flushLocked(now, keepalive)
	into = s.outBatch
	s.deferred, s.outBatch = false, nil
	return into
}

func (s *session) flushLocked(now time.Time, keepalive bool) {
	s.ep.build(now, s.scratch, keepalive, maxPacketsPerFlush, func(body []byte) {
		// writeFramed reuses scratch only for decryption, so body is safe here.
		s.writeFramed(kindData, body)
	})
}

func (s *session) drain(fn func(Message)) {
	s.mu.Lock()
	inbox := s.ep.inbox
	s.ep.inbox = nil
	s.mu.Unlock()
	for _, m := range inbox {
		fn(m)
	}
}

// closeLocked sends DISCONNECT a few times and marks the session closed.
func (s *session) closeLocked(reason string) {
	if s.closed {
		return
	}
	if len(reason) > maxDisconnectReason {
		reason = reason[:maxDisconnectReason]
	}
	body := []byte(reason)
	for range 3 {
		s.writeFramed(kindDisconnect, body)
	}
	s.closed = true
	s.reason = reason
}

func (s *session) stats(now time.Time) Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ep.snapshot(now)
}

func (s *session) lastRecv() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ep.lastRecv
}

func (s *session) isClosed() (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed, s.reason
}
