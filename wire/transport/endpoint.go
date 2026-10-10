// Package transport implements the GoMP reliable UDP transport: a stateless
// cookie handshake, optional X25519 + ChaCha20-Poly1305 encryption, packet
// acknowledgement with a 32-bit ack field, a reliable-ordered channel with
// fragmentation and an unreliable channel for state sync.
//
// The protocol is specified in docs/protocol.md; the C++ client implements the
// same state machine.
package transport

import (
	"encoding/binary"
	"errors"
	"time"
)

// Channel selects delivery guarantees.
type Channel uint8

const (
	// Unreliable messages may be lost, duplicated packets are filtered.
	// Applications order state by their own timestamps.
	Unreliable Channel = 0
	// Reliable messages are delivered exactly once and in order.
	Reliable Channel = 1
)

const (
	// MaxPacketSize is the largest UDP payload ever sent.
	MaxPacketSize = 1200
	// maxBodySize is the space left for the inner body after the outer header
	// (kind + session + counter) and the AEAD tag.
	maxBodySize = MaxPacketSize - 1 - 4 - 8 - 16
	// innerHeaderSize is seq + ack + ackBits.
	innerHeaderSize = 2 + 2 + 4
	// MaxFragmentPayload is the largest single chunk payload.
	MaxFragmentPayload = 1100
	// DefaultMaxMessageSize bounds reassembled reliable messages.
	DefaultMaxMessageSize = 1 << 20

	window     = 1024 // reliable message window and sent-packet history
	maxAckBits = 32
	chunkUnrel = 0
	chunkRel   = 1
	chunkMore  = 0x80 // reliable fragment: more fragments follow
	minRTO     = 40 * time.Millisecond
	maxRTO     = time.Second
	initialRTT = 100 * time.Millisecond
	maxUnrelQ  = 8192
	// DefaultMaxRelBacklog bounds reliable bytes waiting for one peer. A peer
	// that does not take its data (a stalled client) is cut off instead of
	// growing the server's memory: 1000 such peers at the old 64 MiB were 64 GB.
	DefaultMaxRelBacklog = 4 << 20
)

var (
	errBadPacket     = errors.New("transport: malformed packet")
	errMessageTooBig = errors.New("transport: reliable message exceeds limit")
	errBacklog       = errors.New("transport: reliable send backlog overflow")
)

func seqGreater(a, b uint16) bool { return int16(a-b) > 0 }

type span struct{ start, end int32 }

type sentPacket struct {
	seq     uint16
	valid   bool
	acked   bool
	sentAt  time.Time
	size    int
	relSeqs []uint16
}

type relOut struct {
	data     []byte
	more     bool // fragment flag
	present  bool
	acked    bool
	lastSent time.Time
}

type recvSeq struct {
	seq   uint16
	valid bool
}

type relIn struct {
	data    []byte
	more    bool
	present bool
}

// Message is a delivered application message.
type Message struct {
	Channel Channel
	Data    []byte
}

// Stats are connection statistics.
type Stats struct {
	RTT         time.Duration
	PacketLoss  float64 // 0..1 over the recent history
	BytesSent   uint64
	BytesRecv   uint64
	PacketsSent uint64
	PacketsRecv uint64
	Resends     uint64
	RelBacklog  int // reliable messages queued but not acknowledged
}

// endpoint is the I/O-free reliability state machine shared by client and server.
type endpoint struct {
	// send side
	seq        uint16
	sent       [window]sentPacket
	relNext    uint16 // next reliable seq to assign
	relOldest  uint16 // oldest unacknowledged reliable seq
	relBuf     [window]relOut
	relQueue   []relOut // waiting for window space
	relBytes   int
	maxBacklog int
	// Unreliable messages are packed into one arena to avoid an allocation
	// per message; unrelMsgs holds [start, end) offsets into unrelBuf.
	unrelBuf  []byte
	unrelMsgs []span

	// receive side
	haveRemote  bool
	remoteSeq   uint16
	recvBits    uint32
	recvHist    [window]recvSeq
	recvSince   int // packets received since our last send (early ack trigger)
	ackPending  bool
	relRecvNext uint16
	relRecv     [window]relIn
	fragAcc     []byte
	inbox       []Message

	// timing & stats
	srtt, rttvar time.Duration
	rto          time.Duration
	lastSend     time.Time
	lastRecv     time.Time
	stats        Stats
	maxMsgSize   int
	err          error
}

func newEndpoint(now time.Time) *endpoint {
	return &endpoint{
		// Until the first packet arrives we acknowledge 0xFFFF with no bits:
		// it can only match a packet after 65535 sends, long past any timeout.
		remoteSeq:  0xFFFF,
		srtt:       initialRTT,
		rttvar:     initialRTT / 2,
		rto:        3 * initialRTT,
		lastRecv:   now,
		maxMsgSize: DefaultMaxMessageSize,
		maxBacklog: DefaultMaxRelBacklog,
	}
}

// queue schedules data for sending. data is copied.
func (e *endpoint) queue(ch Channel, data []byte) error {
	if e.err != nil {
		return e.err
	}
	if ch == Unreliable {
		if len(data) > MaxFragmentPayload {
			// Unreliable messages are never fragmented; fall back to reliable.
			return e.queue(Reliable, data)
		}
		if len(e.unrelMsgs) >= maxUnrelQ {
			return nil // receiver is not draining; drop new state updates
		}
		start := int32(len(e.unrelBuf))
		e.unrelBuf = append(e.unrelBuf, data...)
		e.unrelMsgs = append(e.unrelMsgs, span{start, int32(len(e.unrelBuf))})
		return nil
	}
	if len(data) > e.maxMsgSize {
		return errMessageTooBig
	}
	if e.relBytes+len(data) > e.maxBacklog {
		e.err = errBacklog
		return e.err
	}
	e.relBytes += len(data)
	for {
		n := min(len(data), MaxFragmentPayload)
		m := relOut{data: append([]byte(nil), data[:n]...), more: n < len(data), present: true}
		e.pushReliable(m)
		data = data[n:]
		if len(data) == 0 {
			return nil
		}
	}
}

func (e *endpoint) pushReliable(m relOut) {
	if len(e.relQueue) == 0 && uint16(e.relNext-e.relOldest) < window {
		e.relBuf[e.relNext%window] = m
		e.relNext++
		return
	}
	e.relQueue = append(e.relQueue, m)
}

func (e *endpoint) fillWindow() {
	for len(e.relQueue) > 0 && uint16(e.relNext-e.relOldest) < window {
		e.relBuf[e.relNext%window] = e.relQueue[0]
		e.relQueue[0] = relOut{}
		e.relQueue = e.relQueue[1:]
		e.relNext++
	}
	if len(e.relQueue) == 0 {
		e.relQueue = nil
	}
}

// receive processes an inner packet body. Duplicates are ignored silently.
func (e *endpoint) receive(body []byte, now time.Time) error {
	if len(body) < innerHeaderSize {
		return errBadPacket
	}
	seq := binary.LittleEndian.Uint16(body[0:])
	ack := binary.LittleEndian.Uint16(body[2:])
	ackBits := binary.LittleEndian.Uint32(body[4:])

	// Duplicate filtering over the last `window` packets. Packets older than
	// half the history are dropped; packets older than the 32-bit ack field are
	// still processed (their reliable content is deduplicated by sequence).
	if e.haveRemote {
		if diff := uint16(e.remoteSeq - seq); seqGreater(e.remoteSeq, seq) && diff >= window/2 {
			return nil
		}
	}
	h := &e.recvHist[seq%window]
	if h.valid && h.seq == seq {
		return nil
	}
	h.seq, h.valid = seq, true

	// Acknowledgement state.
	if !e.haveRemote {
		e.haveRemote = true
		e.remoteSeq = seq
		e.recvBits = 0
	} else if seqGreater(seq, e.remoteSeq) {
		shift := uint16(seq - e.remoteSeq)
		if shift > maxAckBits {
			e.recvBits = 0
		} else {
			e.recvBits = e.recvBits<<shift | 1<<(shift-1)
		}
		e.remoteSeq = seq
	} else if diff := uint16(e.remoteSeq - seq); diff <= maxAckBits {
		e.recvBits |= 1 << (diff - 1)
	}
	e.ackPending = true
	e.recvSince++
	e.lastRecv = now
	e.stats.PacketsRecv++
	e.stats.BytesRecv += uint64(len(body))

	e.processAcks(ack, ackBits, now)

	// Chunks.
	p := body[innerHeaderSize:]
	for len(p) > 0 {
		hdr := p[0]
		p = p[1:]
		kind := hdr &^ chunkMore
		var relSeq uint16
		if kind == chunkRel {
			if len(p) < 2 {
				return errBadPacket
			}
			relSeq = binary.LittleEndian.Uint16(p)
			p = p[2:]
		} else if kind != chunkUnrel {
			return errBadPacket
		}
		n, k := binary.Uvarint(p)
		if k <= 0 || n > uint64(len(p)-k) || n > MaxFragmentPayload {
			return errBadPacket
		}
		data := p[k : k+int(n)]
		p = p[k+int(n):]
		if kind == chunkUnrel {
			if hdr&chunkMore != 0 {
				return errBadPacket
			}
			e.inbox = append(e.inbox, Message{Channel: Unreliable, Data: append([]byte(nil), data...)})
			continue
		}
		e.receiveReliable(relSeq, data, hdr&chunkMore != 0)
	}
	return e.err
}

func (e *endpoint) receiveReliable(seq uint16, data []byte, more bool) {
	if seqGreater(e.relRecvNext, seq) {
		return // already delivered
	}
	if uint16(seq-e.relRecvNext) >= window {
		return // outside the window; the sender will retransmit
	}
	slot := &e.relRecv[seq%window]
	if slot.present {
		return
	}
	*slot = relIn{data: append([]byte(nil), data...), more: more, present: true}
	for {
		s := &e.relRecv[e.relRecvNext%window]
		if !s.present {
			return
		}
		if len(e.fragAcc)+len(s.data) > e.maxMsgSize {
			e.err = errMessageTooBig
			return
		}
		if s.more {
			e.fragAcc = append(e.fragAcc, s.data...)
		} else if len(e.fragAcc) > 0 {
			msg := append(e.fragAcc, s.data...)
			e.fragAcc = nil
			e.inbox = append(e.inbox, Message{Channel: Reliable, Data: msg})
		} else {
			e.inbox = append(e.inbox, Message{Channel: Reliable, Data: s.data})
		}
		*s = relIn{}
		e.relRecvNext++
	}
}

func (e *endpoint) processAcks(ack uint16, bits uint32, now time.Time) {
	e.ackPacket(ack, now)
	for i := uint16(0); i < maxAckBits; i++ {
		if bits&(1<<i) != 0 {
			e.ackPacket(ack-1-i, now)
		}
	}
	// Advance the reliable window.
	for e.relOldest != e.relNext {
		m := &e.relBuf[e.relOldest%window]
		if !m.acked {
			break
		}
		e.relBytes -= len(m.data)
		*m = relOut{}
		e.relOldest++
	}
	e.fillWindow()
}

func (e *endpoint) ackPacket(seq uint16, now time.Time) {
	sp := &e.sent[seq%window]
	if !sp.valid || sp.seq != seq || sp.acked {
		return
	}
	sp.acked = true
	e.sampleRTT(now.Sub(sp.sentAt))
	for _, rs := range sp.relSeqs {
		if uint16(rs-e.relOldest) >= uint16(e.relNext-e.relOldest) {
			continue // already released
		}
		m := &e.relBuf[rs%window]
		if m.present {
			m.acked = true
		}
	}
}

func (e *endpoint) sampleRTT(s time.Duration) {
	if s < 0 {
		return
	}
	diff := e.srtt - s
	if diff < 0 {
		diff = -diff
	}
	e.rttvar = (3*e.rttvar + diff) / 4
	e.srtt = (7*e.srtt + s) / 8
	e.rto = min(max(e.srtt+4*e.rttvar, minRTO), maxRTO)
}

// needsEarlyAck reports whether so many packets arrived since our last send
// that some would fall out of the 32-bit ack field without an immediate ack.
func (e *endpoint) needsEarlyAck() bool { return e.recvSince >= earlyAckThreshold }

// hasPending reports whether build would emit data packets.
func (e *endpoint) hasPending() bool {
	return len(e.unrelMsgs) > 0 || e.relNext != e.relOldest || e.ackPending
}

// build assembles packet bodies for everything that is due and passes each to
// emit. The slice passed to emit is reused after emit returns.
// keepalive forces an empty packet when nothing else is sent.
func (e *endpoint) build(now time.Time, scratch []byte, keepalive bool, maxPackets int, emit func(body []byte)) {
	sentAny := false
	relCursor := e.relOldest
	unrelIdx := 0
	for n := 0; n < maxPackets; n++ {
		body := scratch[:innerHeaderSize]
		var relSeqs []uint16
		// Reliable messages that are new or due for retransmission.
		for relCursor != e.relNext {
			m := &e.relBuf[relCursor%window]
			if !m.present || m.acked || (!m.lastSent.IsZero() && now.Sub(m.lastSent) < e.rto) {
				relCursor++
				continue
			}
			need := 1 + 2 + uvarintLen(len(m.data)) + len(m.data)
			if len(body)+need > maxBodySize {
				break
			}
			hdr := byte(chunkRel)
			if m.more {
				hdr |= chunkMore
			}
			body = append(body, hdr)
			body = binary.LittleEndian.AppendUint16(body, relCursor)
			body = binary.AppendUvarint(body, uint64(len(m.data)))
			body = append(body, m.data...)
			if !m.lastSent.IsZero() {
				e.stats.Resends++
			}
			m.lastSent = now
			relSeqs = append(relSeqs, relCursor)
			relCursor++
		}
		// Unreliable messages fill the remaining space.
		for unrelIdx < len(e.unrelMsgs) {
			sp := e.unrelMsgs[unrelIdx]
			d := e.unrelBuf[sp.start:sp.end]
			need := 1 + uvarintLen(len(d)) + len(d)
			if len(body)+need > maxBodySize {
				break
			}
			body = append(body, chunkUnrel)
			body = binary.AppendUvarint(body, uint64(len(d)))
			body = append(body, d...)
			unrelIdx++
		}
		hasChunks := len(body) > innerHeaderSize
		if !hasChunks && (sentAny || !(e.ackPending || keepalive)) {
			break
		}
		e.finishPacket(body, relSeqs, now)
		emit(body)
		sentAny = true
		if relCursor == e.relNext && unrelIdx >= len(e.unrelMsgs) {
			break
		}
	}
	// Drop what was sent; anything left over (packet cap) waits for the next flush.
	if unrelIdx >= len(e.unrelMsgs) {
		e.unrelBuf = e.unrelBuf[:0]
		e.unrelMsgs = e.unrelMsgs[:0]
	} else if unrelIdx > 0 {
		base := e.unrelMsgs[unrelIdx].start
		n := copy(e.unrelBuf, e.unrelBuf[base:])
		e.unrelBuf = e.unrelBuf[:n]
		rest := copy(e.unrelMsgs, e.unrelMsgs[unrelIdx:])
		e.unrelMsgs = e.unrelMsgs[:rest]
		for i := range e.unrelMsgs {
			e.unrelMsgs[i].start -= base
			e.unrelMsgs[i].end -= base
		}
	}
}

func (e *endpoint) finishPacket(body []byte, relSeqs []uint16, now time.Time) {
	seq := e.seq
	e.seq++
	binary.LittleEndian.PutUint16(body[0:], seq)
	binary.LittleEndian.PutUint16(body[2:], e.remoteSeq)
	binary.LittleEndian.PutUint32(body[4:], e.recvBits)
	sp := &e.sent[seq%window]
	sp.seq, sp.valid, sp.acked, sp.sentAt, sp.size = seq, true, false, now, len(body)
	sp.relSeqs = append(sp.relSeqs[:0], relSeqs...)
	e.ackPending = false
	e.recvSince = 0
	e.lastSend = now
	e.stats.PacketsSent++
	e.stats.BytesSent += uint64(len(body))
}

func uvarintLen(n int) int {
	l := 1
	for n >= 0x80 {
		n >>= 7
		l++
	}
	return l
}

// drain hands delivered messages to fn and clears the inbox.
func (e *endpoint) drain(fn func(Message)) {
	for i, m := range e.inbox {
		fn(m)
		e.inbox[i] = Message{}
	}
	e.inbox = e.inbox[:0]
}

// snapshot returns statistics, estimating loss from packets old enough to have
// been acknowledged.
func (e *endpoint) snapshot(now time.Time) Stats {
	s := e.stats
	s.RTT = e.srtt
	s.RelBacklog = int(uint16(e.relNext-e.relOldest)) + len(e.relQueue)
	cutoff := now.Add(-2*e.srtt - 50*time.Millisecond)
	horizon := now.Add(-5 * time.Second)
	total, lost := 0, 0
	for i := range e.sent {
		sp := &e.sent[i]
		if !sp.valid || sp.sentAt.After(cutoff) || sp.sentAt.Before(horizon) {
			continue
		}
		total++
		if !sp.acked {
			lost++
		}
	}
	if total > 0 {
		s.PacketLoss = float64(lost) / float64(total)
	}
	return s
}
