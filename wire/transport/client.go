package transport

import (
	"context"
	"crypto/ecdh"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sync/atomic"
	"time"
)

// ClientConfig configures Dial.
type ClientConfig struct {
	// Payload is delivered to the server application with EventConnect.
	Payload []byte
	// ConnectTimeout bounds the handshake (0 = 5s).
	ConnectTimeout time.Duration
	// Timeout disconnects when the server is silent (0 = DefaultTimeout).
	Timeout time.Duration
	// MaxMessageSize bounds reassembled reliable messages (0 = DefaultMaxMessageSize).
	MaxMessageSize int
}

// restartHandshakeAfter bounds how long CONNECT is retried with one cookie.
const restartHandshakeAfter = 3 * time.Second

// RejectedError is returned by Dial when the server refused the connection.
type RejectedError struct{ Reason string }

func (e *RejectedError) Error() string { return "transport: connection rejected: " + e.Reason }

// Client is a connection to a GoMP server.
type Client struct {
	s       *session
	pc      PacketConn
	ownsPC  bool
	cfg     ClientConfig
	done    chan struct{}
	notify  chan struct{}
	stopped atomic.Bool

	nonce     atomic.Uint64
	priv      *ecdh.PrivateKey
	challenge chan []byte
	accept    chan uint32
	reject    chan string
}

// Dial connects to a server at addr ("host:port").
func Dial(ctx context.Context, addr string, cfg ClientConfig) (*Client, error) {
	ua, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return nil, err
	}
	uc, err := net.ListenUDP("udp", nil)
	if err != nil {
		return nil, err
	}
	_ = uc.SetReadBuffer(1 << 20)
	c, err := DialConn(ctx, uc, ua.AddrPort(), cfg)
	if err != nil {
		uc.Close()
		return nil, err
	}
	c.ownsPC = true
	return c, nil
}

// DialConn performs the handshake over an existing socket.
func DialConn(ctx context.Context, pc PacketConn, server netip.AddrPort, cfg ClientConfig) (*Client, error) {
	if len(cfg.Payload) > MaxConnectPayload {
		return nil, fmt.Errorf("transport: connect payload %d > %d", len(cfg.Payload), MaxConnectPayload)
	}
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = 5 * time.Second
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = DefaultTimeout
	}
	if cfg.MaxMessageSize <= 0 {
		cfg.MaxMessageSize = DefaultMaxMessageSize
	}
	c := &Client{
		pc:        pc,
		cfg:       cfg,
		done:      make(chan struct{}),
		notify:    make(chan struct{}, 1),
		challenge: make(chan []byte, 1),
		accept:    make(chan uint32, 1),
		reject:    make(chan string, 1),
	}
	c.nonce.Store(randUint64())
	c.s = newSession(pc, unmap(server), 0, time.Now())
	c.s.ep.maxMsgSize = cfg.MaxMessageSize
	go c.readLoop()
	if err := c.handshake(ctx); err != nil {
		c.stopped.Store(true)
		if !c.ownsPC {
			// The caller owns the socket; unblock our reader by deadline-free close of state only.
			c.s.mu.Lock()
			c.s.closed = true
			c.s.mu.Unlock()
		}
		return nil, err
	}
	return c, nil
}

func (c *Client) handshake(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, c.cfg.ConnectTimeout)
	defer cancel()
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()

	hello := make([]byte, helloSize)
	hello[0] = kindHello
	binary.LittleEndian.PutUint32(hello[1:], Magic)
	binary.LittleEndian.PutUint16(hello[5:], ProtocolVersion)
	binary.LittleEndian.PutUint64(hello[7:], c.nonce.Load())

	var connect []byte
	var connectSince time.Time
	send := func() {
		if connect != nil {
			_, _ = c.pc.WriteToUDPAddrPort(connect, c.s.addr)
		} else {
			_, _ = c.pc.WriteToUDPAddrPort(hello, c.s.addr)
		}
	}
	send()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("transport: handshake: %w", ctx.Err())
		case reason := <-c.reject:
			return &RejectedError{Reason: reason}
		case ch := <-c.challenge:
			if connect != nil {
				continue
			}
			var err error
			connect, err = c.buildConnect(ch)
			if err != nil {
				return err
			}
			connectSince = time.Now()
			send()
		case id := <-c.accept:
			if connect == nil {
				continue
			}
			c.s.mu.Lock()
			c.s.id = id
			c.s.ep.lastRecv = time.Now()
			c.s.mu.Unlock()
			return nil
		case <-tick.C:
			// Cookies expire after cookieTTL: if CONNECT gets no answer for a
			// while (lost reply, rejected pending connection), start over with
			// a fresh challenge instead of retrying a stale cookie forever.
			if connect != nil && time.Since(connectSince) > restartHandshakeAfter {
				// A new nonce makes the server treat this as a fresh client and
				// drop any half-open session keyed to the old keys.
				connect = nil
				c.nonce.Store(randUint64())
				binary.LittleEndian.PutUint64(hello[7:], c.nonce.Load())
			}
			send()
		}
	}
}

// buildConnect parses CHALLENGE (nonce already verified) and builds CONNECT.
func (c *Client) buildConnect(ch []byte) ([]byte, error) {
	// nonce(8) cookie(20) flags(1) [serverPub(32)]
	if len(ch) < 8+cookieSize+1 {
		return nil, errors.New("transport: short challenge")
	}
	cookie := ch[8 : 8+cookieSize]
	flags := ch[8+cookieSize]
	out := make([]byte, 0, 1+4+2+8+cookieSize+keySize+2+len(c.cfg.Payload))
	out = append(out, kindConnect)
	out = binary.LittleEndian.AppendUint32(out, Magic)
	out = binary.LittleEndian.AppendUint16(out, ProtocolVersion)
	out = binary.LittleEndian.AppendUint64(out, c.nonce.Load())
	out = append(out, cookie...)
	if flags&flagEncrypt != 0 {
		if len(ch) < 8+cookieSize+1+keySize {
			return nil, errors.New("transport: short challenge key")
		}
		serverPub := ch[8+cookieSize+1 : 8+cookieSize+1+keySize]
		priv, err := newKeyPair()
		if err != nil {
			return nil, err
		}
		peer, err := ecdh.X25519().NewPublicKey(serverPub)
		if err != nil {
			return nil, err
		}
		shared, err := priv.ECDH(peer)
		if err != nil {
			return nil, err
		}
		clientPub := priv.PublicKey().Bytes()
		c2s, s2c, err := sessionKeys(shared, c.nonce.Load(), serverPub, clientPub)
		if err != nil {
			return nil, err
		}
		c.s.mu.Lock()
		c.s.sendAEAD, c.s.recvAEAD = c2s, s2c
		c.s.mu.Unlock()
		out = append(out, clientPub...)
	}
	out = binary.LittleEndian.AppendUint16(out, uint16(len(c.cfg.Payload)))
	out = append(out, c.cfg.Payload...)
	return out, nil
}

func (c *Client) readLoop() {
	defer close(c.done)
	buf := make([]byte, 2048)
	for {
		n, addr, err := c.pc.ReadFromUDPAddrPort(buf)
		if err != nil {
			if c.stopped.Load() || errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		if c.stopped.Load() {
			return
		}
		if n == 0 || unmap(addr) != c.s.addr {
			continue
		}
		pkt := buf[:n]
		switch pkt[0] {
		case kindChallenge:
			if n >= 9 && binary.LittleEndian.Uint64(pkt[1:9]) == c.nonce.Load() {
				select {
				case c.challenge <- append([]byte(nil), pkt[1:]...):
				default:
				}
			}
		case kindAccept:
			if n >= 13 && binary.LittleEndian.Uint64(pkt[1:9]) == c.nonce.Load() {
				select {
				case c.accept <- binary.LittleEndian.Uint32(pkt[9:13]):
				default:
				}
			}
		case kindReject:
			if n >= 10 && binary.LittleEndian.Uint64(pkt[1:9]) == c.nonce.Load() {
				l := int(pkt[9])
				if 10+l > n {
					l = n - 10
				}
				reason := string(pkt[10 : 10+l])
				select {
				case c.reject <- reason:
				default:
				}
			}
		case kindData, kindDisconnect:
			c.s.mu.Lock()
			ready := c.s.id != 0
			c.s.mu.Unlock()
			if !ready {
				continue
			}
			c.s.handleFramed(pkt, time.Now())
			select {
			case c.notify <- struct{}{}:
			default:
			}
		}
	}
}

// Send queues a message. data is copied.
func (c *Client) Send(ch Channel, data []byte) error { return c.s.send(ch, data) }

// Flush transmits everything due and checks the timeout.
func (c *Client) Flush(now time.Time) {
	if now.Sub(c.s.lastRecv()) > c.cfg.Timeout {
		c.s.mu.Lock()
		c.s.closeLocked("timeout")
		c.s.mu.Unlock()
		return
	}
	c.s.flush(now)
}

// Drain passes delivered messages to fn.
func (c *Client) Drain(fn func(Message)) { c.s.drain(fn) }

// Notify is signalled (best effort) when a datagram arrives.
func (c *Client) Notify() <-chan struct{} { return c.notify }

// Stats returns connection statistics.
func (c *Client) Stats() Stats { return c.s.stats(time.Now()) }

// Closed reports whether the connection ended and why.
func (c *Client) Closed() (bool, string) { return c.s.isClosed() }

// LocalAddr returns the local socket address.
func (c *Client) LocalAddr() net.Addr { return c.pc.LocalAddr() }

// Close disconnects with reason and releases the socket if Dial created it.
func (c *Client) Close(reason string) error {
	c.s.mu.Lock()
	c.s.closeLocked(reason)
	c.s.mu.Unlock()
	if c.stopped.Swap(true) {
		return nil
	}
	if c.ownsPC {
		err := c.pc.Close()
		<-c.done
		return err
	}
	return nil
}
