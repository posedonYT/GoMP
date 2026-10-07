// Package faultnet wraps a UDP socket to inject packet loss, duplication,
// latency and jitter (which also reorders packets). It is used by transport
// tests, bots and stress tests to emulate bad networks.
package faultnet

import (
	"math/rand/v2"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"
)

// Config describes the impairments, applied independently in each direction.
type Config struct {
	Loss      float64       // probability a datagram is dropped
	Duplicate float64       // probability a datagram is delivered twice
	Latency   time.Duration // fixed one-way delay
	Jitter    time.Duration // extra uniformly random delay in [0, Jitter)
	Seed      uint64        // 0 picks a random seed
}

// UDPConn is the subset of *net.UDPConn used by the transport.
type UDPConn interface {
	ReadFromUDPAddrPort(b []byte) (int, netip.AddrPort, error)
	WriteToUDPAddrPort(b []byte, addr netip.AddrPort) (int, error)
	LocalAddr() net.Addr
	Close() error
}

// Conn is an impaired socket.
type Conn struct {
	inner  UDPConn
	cfg    Config
	mu     sync.Mutex
	rng    *rand.Rand
	closed atomic.Bool

	Dropped    atomic.Uint64
	Duplicated atomic.Uint64
}

// Wrap returns an impaired view of c.
func Wrap(c UDPConn, cfg Config) *Conn {
	seed := cfg.Seed
	if seed == 0 {
		seed = rand.Uint64()
	}
	return &Conn{inner: c, cfg: cfg, rng: rand.New(rand.NewPCG(seed, seed^0x9E3779B97F4A7C15))}
}

func (c *Conn) roll(p float64) bool {
	if p <= 0 {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.rng.Float64() < p
}

func (c *Conn) delay() time.Duration {
	d := c.cfg.Latency
	if c.cfg.Jitter > 0 {
		c.mu.Lock()
		d += time.Duration(c.rng.Int64N(int64(c.cfg.Jitter)))
		c.mu.Unlock()
	}
	return d
}

// ReadFromUDPAddrPort reads the next datagram that survives inbound loss.
// Inbound latency is not modelled separately; configure it on the sender.
func (c *Conn) ReadFromUDPAddrPort(b []byte) (int, netip.AddrPort, error) {
	for {
		n, addr, err := c.inner.ReadFromUDPAddrPort(b)
		if err != nil {
			return n, addr, err
		}
		if c.roll(c.cfg.Loss) {
			c.Dropped.Add(1)
			continue
		}
		return n, addr, nil
	}
}

// WriteToUDPAddrPort sends b, possibly dropping, delaying or duplicating it.
func (c *Conn) WriteToUDPAddrPort(b []byte, addr netip.AddrPort) (int, error) {
	if c.roll(c.cfg.Loss) {
		c.Dropped.Add(1)
		return len(b), nil
	}
	copies := 1
	if c.roll(c.cfg.Duplicate) {
		copies = 2
		c.Duplicated.Add(1)
	}
	for i := 0; i < copies; i++ {
		d := c.delay()
		if d <= 0 {
			if _, err := c.inner.WriteToUDPAddrPort(b, addr); err != nil {
				return 0, err
			}
			continue
		}
		pkt := append([]byte(nil), b...)
		time.AfterFunc(d, func() {
			if !c.closed.Load() {
				_, _ = c.inner.WriteToUDPAddrPort(pkt, addr)
			}
		})
	}
	return len(b), nil
}

// LocalAddr returns the underlying socket address.
func (c *Conn) LocalAddr() net.Addr { return c.inner.LocalAddr() }

// Close closes the underlying socket; delayed datagrams are discarded.
func (c *Conn) Close() error {
	c.closed.Store(true)
	return c.inner.Close()
}
