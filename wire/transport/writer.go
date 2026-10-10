package transport

import (
	"net"
	"net/netip"
	"runtime"
	"sync"
	"sync/atomic"

	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

// outPacket is a datagram ready for the socket.
type outPacket struct {
	buf  *[]byte
	addr netip.AddrPort
	ua   *net.UDPAddr
}

var packetPool = sync.Pool{New: func() any {
	b := make([]byte, 0, MaxPacketSize+64)
	return &b
}}

const (
	writeQueueLen = 256
	batchSize     = 64
)

// batchWriter is implemented by ipv4.PacketConn and ipv6.PacketConn.
type batchWriter interface {
	WriteBatch(ms []ipv4.Message, flags int) (int, error)
}

type ipv6Batch struct{ c *ipv6.PacketConn }

func (b ipv6Batch) WriteBatch(ms []ipv4.Message, flags int) (int, error) {
	return b.c.WriteBatch(ms, flags)
}

// writerCount is how many goroutines write to the socket. With sendmmsg (Linux)
// two keep up with any load. Windows has no batched send: every datagram is a
// system call (~1.5M a second at 1000 players), and two writers fell behind and
// blocked the game loop, so there it scales with the cores.
func writerCount(goos string, procs int) int {
	if goos == "windows" {
		return max(2, min(procs, 8))
	}
	return 2
}

// socketWriter drains packet batches on dedicated goroutines so the game
// loop never waits for sendto. On Linux it uses sendmmsg.
type socketWriter struct {
	pc     PacketConn
	batch  batchWriter
	q      chan []outPacket
	wg     sync.WaitGroup
	stalls atomic.Uint64
}

func newSocketWriter(pc PacketConn, workers int) *socketWriter {
	w := &socketWriter{pc: pc, q: make(chan []outPacket, writeQueueLen)}
	// x/net has no batch I/O on Windows (WriteBatch always fails there), so
	// datagrams are written one by one.
	if uc, ok := pc.(*net.UDPConn); ok && runtime.GOOS != "windows" {
		if la, ok := uc.LocalAddr().(*net.UDPAddr); ok && la.IP.To4() != nil {
			w.batch = ipv4.NewPacketConn(uc)
		} else {
			w.batch = ipv6Batch{ipv6.NewPacketConn(uc)}
		}
	}
	for range workers {
		w.wg.Go(w.loop)
	}
	return w
}

// enqueue hands a batch to the writers (blocking when they fall behind,
// which back-pressures the game loop instead of growing memory).
func (w *socketWriter) enqueue(b []outPacket) {
	if len(b) == 0 {
		return
	}
	select {
	case w.q <- b:
	default:
		// Full: the game loop waits. Counted, so a stall shows in the metrics.
		w.stalls.Add(1)
		w.q <- b
	}
}

// Stalls is how many times the game loop had to wait for the writers.
func (w *socketWriter) Stalls() uint64 { return w.stalls.Load() }

func (w *socketWriter) close() {
	close(w.q)
	w.wg.Wait()
}

func (w *socketWriter) loop() {
	msgs := make([]ipv4.Message, 0, batchSize)
	for batch := range w.q {
		if w.batch != nil {
			for start := 0; start < len(batch); {
				end := min(start+batchSize, len(batch))
				msgs = msgs[:0]
				for _, p := range batch[start:end] {
					msgs = append(msgs, ipv4.Message{Buffers: [][]byte{*p.buf}, Addr: p.ua})
				}
				n, err := w.batch.WriteBatch(msgs, 0)
				if err != nil || n <= 0 {
					// Skip the failing datagram (unreachable peer) and continue.
					n = 1
				}
				start += n
			}
		} else {
			for _, p := range batch {
				_, _ = w.pc.WriteToUDPAddrPort(*p.buf, p.addr)
			}
		}
		for i := range batch {
			packetPool.Put(batch[i].buf)
			batch[i] = outPacket{}
		}
	}
}
