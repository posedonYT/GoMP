package hostbridge

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"gomp/wire/proto"
)

// Op is one operation: an array whose first element is the operation name.
type Op = []proto.Value

// EventKind distinguishes bridge events.
type EventKind uint8

const (
	// HostUp: a host authenticated and is ready for the initial snapshot.
	HostUp EventKind = iota + 1
	// HostDown: a host disconnected, crashed or was killed by the watchdog.
	HostDown
	// HostOps: a batch of commands arrived.
	HostOps
)

// Event is delivered by Bridge.Poll on the caller's goroutine.
type Event struct {
	Kind   EventKind
	Host   int
	Name   string
	Ops    []Op
	Reason string
}

// Config configures a Bridge.
type Config struct {
	// Command and Args start the host process. An empty Command only listens
	// (tests attach their own host with Dial).
	Command string
	Args    []string
	Dir     string
	Env     []string
	// Watchdog kills a host that stops answering pings (0 = 10s).
	Watchdog time.Duration
	// Restart restarts a crashed host with exponential backoff.
	Restart bool
	// MaxFrame bounds frames from hosts (0 = 64 MiB).
	MaxFrame int
	Logger   *slog.Logger
}

const (
	maxOutFrames = 512
	pingInterval = time.Second
	authTimeout  = 10 * time.Second
	maxBackoff   = 30 * time.Second
	stableUptime = time.Minute
	defaultFrame = 64 << 20
)

type hostConn struct {
	id       int
	name     string
	conn     net.Conn
	out      chan []byte
	pending  []proto.Value
	lastPong atomic.Int64 // unix nanos
	pingN    int
	lastPing time.Time
	closed   atomic.Bool
	once     sync.Once
}

// Bridge supervises one host process and its IPC connection.
type Bridge struct {
	cfg      Config
	log      *slog.Logger
	ln       net.Listener
	addr     string
	network  string
	token    string
	mu       sync.Mutex
	events   []Event
	hosts    map[int]*hostConn
	nextID   int
	closed   atomic.Bool
	procMu   sync.Mutex
	proc     *exec.Cmd
	stopProc chan struct{}
	wg       sync.WaitGroup
}

// Start listens for hosts and launches the host process if configured.
func Start(cfg Config) (*Bridge, error) {
	if cfg.Watchdog <= 0 {
		cfg.Watchdog = 10 * time.Second
	}
	if cfg.MaxFrame <= 0 {
		cfg.MaxFrame = defaultFrame
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	tok := make([]byte, 16)
	if _, err := rand.Read(tok); err != nil {
		return nil, err
	}
	b := &Bridge{cfg: cfg, log: cfg.Logger, token: hex.EncodeToString(tok), hosts: map[int]*hostConn{}, stopProc: make(chan struct{})}
	if err := b.listen(); err != nil {
		return nil, err
	}
	b.wg.Go(b.acceptLoop)
	if cfg.Command != "" {
		b.wg.Go(b.superviseLoop)
	}
	return b, nil
}

func (b *Bridge) listen() error {
	if runtime.GOOS != "windows" {
		dir, err := os.MkdirTemp("", "gomp-ipc-")
		if err == nil {
			path := filepath.Join(dir, "host.sock")
			if ln, err := net.Listen("unix", path); err == nil {
				b.ln, b.network, b.addr = ln, "unix", path
				return nil
			}
			os.RemoveAll(dir)
		}
	}
	// Fallback (Windows, or unix sockets unavailable): loopback TCP, guarded by the token.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	b.ln, b.network, b.addr = ln, "tcp", ln.Addr().String()
	return nil
}

// Endpoint returns the network, address and token hosts must use.
func (b *Bridge) Endpoint() (network, addr, token string) { return b.network, b.addr, b.token }

// Env returns the environment variables passed to host processes.
func (b *Bridge) Env() []string {
	return []string{"GOMP_IPC_NETWORK=" + b.network, "GOMP_IPC_ADDR=" + b.addr, "GOMP_IPC_TOKEN=" + b.token}
}

func (b *Bridge) push(e Event) {
	b.mu.Lock()
	b.events = append(b.events, e)
	b.mu.Unlock()
}

// Poll passes queued events to fn in arrival order.
func (b *Bridge) Poll(fn func(Event)) {
	b.mu.Lock()
	evs := b.events
	b.events = nil
	b.mu.Unlock()
	for _, e := range evs {
		fn(e)
	}
}

// Send queues op for host. Ops are written by Flush.
func (b *Bridge) Send(host int, op Op) {
	b.mu.Lock()
	h := b.hosts[host]
	b.mu.Unlock()
	if h != nil && !h.closed.Load() {
		h.pending = append(h.pending, op)
	}
}

// Broadcast queues op for every connected host.
func (b *Bridge) Broadcast(op Op) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, h := range b.hosts {
		if !h.closed.Load() {
			h.pending = append(h.pending, op)
		}
	}
}

// Hosts returns the ids of connected hosts.
func (b *Bridge) Hosts() []int {
	b.mu.Lock()
	defer b.mu.Unlock()
	ids := make([]int, 0, len(b.hosts))
	for id := range b.hosts {
		ids = append(ids, id)
	}
	return ids
}

// Flush encodes pending ops into one frame per host, sends pings and enforces
// the watchdog. Call it once per tick from the game loop.
func (b *Bridge) Flush() {
	now := time.Now()
	b.mu.Lock()
	hosts := make([]*hostConn, 0, len(b.hosts))
	for _, h := range b.hosts {
		hosts = append(hosts, h)
	}
	b.mu.Unlock()
	for _, h := range hosts {
		if h.closed.Load() {
			continue
		}
		if now.Sub(h.lastPing) >= pingInterval {
			h.lastPing = now
			h.pingN++
			h.pending = append(h.pending, Op{OpPing, int64(h.pingN)})
		}
		if since := now.Sub(time.Unix(0, h.lastPong.Load())); since > b.cfg.Watchdog {
			b.log.Error("script host unresponsive, killing it", "host", h.name, "silent", since.Round(time.Millisecond))
			b.dropHost(h, "watchdog: no response for "+since.Round(time.Second).String())
			b.killProcess()
			continue
		}
		if len(h.pending) == 0 {
			continue
		}
		w := proto.NewWriter(make([]byte, 0, 1024))
		w.Raw([]byte{0, 0, 0, 0}) // length prefix, patched below
		if err := w.Value(h.pending); err != nil {
			b.log.Error("encoding ops for script host", "err", err)
			h.pending = h.pending[:0]
			continue
		}
		frame := w.Bytes()
		binary.LittleEndian.PutUint32(frame, uint32(len(frame)-4))
		h.pending = nil
		select {
		case h.out <- frame:
		default:
			b.log.Error("script host is not reading, killing it", "host", h.name)
			b.dropHost(h, "output queue overflow")
			b.killProcess()
		}
	}
}

// Close stops the host process and closes all connections.
func (b *Bridge) Close() error {
	if b.closed.Swap(true) {
		return nil
	}
	close(b.stopProc)
	b.killProcess()
	err := b.ln.Close()
	b.mu.Lock()
	hosts := b.hosts
	b.hosts = map[int]*hostConn{}
	b.mu.Unlock()
	for _, h := range hosts {
		h.close()
	}
	b.wg.Wait()
	if b.network == "unix" {
		os.RemoveAll(filepath.Dir(b.addr))
	}
	return err
}

func (h *hostConn) close() {
	h.once.Do(func() {
		h.closed.Store(true)
		close(h.out)
		h.conn.Close()
	})
}

func (b *Bridge) dropHost(h *hostConn, reason string) {
	b.mu.Lock()
	_, ok := b.hosts[h.id]
	delete(b.hosts, h.id)
	b.mu.Unlock()
	h.close()
	if ok {
		b.push(Event{Kind: HostDown, Host: h.id, Name: h.name, Reason: reason})
	}
}

func (b *Bridge) acceptLoop() {
	for {
		c, err := b.ln.Accept()
		if err != nil {
			if b.closed.Load() || errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		b.wg.Go(func() { b.serve(c) })
	}
}

func readFrame(r *bufio.Reader, max int) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(hdr[:])
	if int(n) > max {
		return nil, fmt.Errorf("frame of %d bytes exceeds limit", n)
	}
	buf := make([]byte, n)
	_, err := io.ReadFull(r, buf)
	return buf, err
}

func decodeOps(frame []byte) ([]Op, error) {
	r := proto.NewReader(frame)
	v := r.Value()
	if r.Err() != nil {
		return nil, r.Err()
	}
	arr, ok := v.([]proto.Value)
	if !ok {
		return nil, fmt.Errorf("frame is %T, want array of ops", v)
	}
	ops := make([]Op, 0, len(arr))
	for _, o := range arr {
		op, ok := o.([]proto.Value)
		if !ok || len(op) == 0 {
			return nil, fmt.Errorf("malformed op %v", o)
		}
		if _, ok := op[0].(string); !ok {
			return nil, fmt.Errorf("op name is %T", op[0])
		}
		ops = append(ops, op)
	}
	return ops, nil
}

func (b *Bridge) serve(c net.Conn) {
	r := bufio.NewReaderSize(c, 64<<10)
	_ = c.SetReadDeadline(time.Now().Add(authTimeout))
	frame, err := readFrame(r, 4096)
	if err != nil {
		c.Close()
		return
	}
	ops, err := decodeOps(frame)
	if err != nil || len(ops) != 1 || ops[0][0] != CmdAuth || len(ops[0]) < 3 || ops[0][1] != b.token {
		b.log.Warn("rejected script host connection: bad authentication")
		c.Close()
		return
	}
	name, _ := ops[0][2].(string)
	_ = c.SetReadDeadline(time.Time{})

	b.mu.Lock()
	b.nextID++
	h := &hostConn{id: b.nextID, name: name, conn: c, out: make(chan []byte, maxOutFrames), lastPing: time.Now()}
	h.lastPong.Store(time.Now().UnixNano())
	b.hosts[h.id] = h
	b.mu.Unlock()
	b.log.Info("script host connected", "host", name, "id", h.id)
	b.push(Event{Kind: HostUp, Host: h.id, Name: name})

	b.wg.Go(func() {
		w := bufio.NewWriterSize(c, 256<<10)
		for frame := range h.out {
			if _, err := w.Write(frame); err != nil {
				return
			}
			if len(h.out) == 0 {
				if err := w.Flush(); err != nil {
					return
				}
			}
		}
	})

	for {
		frame, err := readFrame(r, b.cfg.MaxFrame)
		if err != nil {
			reason := "disconnected"
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				reason = err.Error()
			}
			b.dropHost(h, reason)
			return
		}
		ops, err := decodeOps(frame)
		if err != nil {
			b.log.Error("malformed frame from script host", "host", name, "err", err)
			b.dropHost(h, "protocol error: "+err.Error())
			return
		}
		// Pongs are handled here so a busy game loop never trips the watchdog.
		kept := ops[:0]
		for _, op := range ops {
			if op[0] == CmdPong {
				h.lastPong.Store(time.Now().UnixNano())
				continue
			}
			kept = append(kept, op)
		}
		if len(kept) > 0 {
			b.push(Event{Kind: HostOps, Host: h.id, Name: name, Ops: kept})
		}
	}
}

func (b *Bridge) killProcess() {
	b.procMu.Lock()
	defer b.procMu.Unlock()
	if b.proc != nil && b.proc.Process != nil {
		_ = b.proc.Process.Kill()
	}
}

// superviseLoop runs the host process and restarts it when it exits.
func (b *Bridge) superviseLoop() {
	backoff := time.Second
	for {
		cmd := exec.Command(b.cfg.Command, b.cfg.Args...)
		cmd.Dir = b.cfg.Dir
		cmd.Env = append(append(os.Environ(), b.cfg.Env...), b.Env()...)
		stdout, _ := cmd.StdoutPipe()
		stderr, _ := cmd.StderrPipe()
		started := time.Now()
		if err := cmd.Start(); err != nil {
			b.log.Error("cannot start script host", "cmd", b.cfg.Command, "err", err)
		} else {
			b.procMu.Lock()
			b.proc = cmd
			b.procMu.Unlock()
			var pipes sync.WaitGroup
			pipes.Go(func() { b.pipeLog(stdout, slog.LevelInfo) })
			pipes.Go(func() { b.pipeLog(stderr, slog.LevelWarn) })
			pipes.Wait()
			err := cmd.Wait()
			b.procMu.Lock()
			b.proc = nil
			b.procMu.Unlock()
			if b.closed.Load() {
				return
			}
			b.log.Error("script host exited", "err", err, "uptime", time.Since(started).Round(time.Millisecond))
		}
		// Make sure a lingering connection of the dead process is dropped.
		b.mu.Lock()
		var stale []*hostConn
		for _, h := range b.hosts {
			stale = append(stale, h)
		}
		b.mu.Unlock()
		for _, h := range stale {
			b.dropHost(h, "process exited")
		}
		if !b.cfg.Restart {
			return
		}
		if time.Since(started) > stableUptime {
			backoff = time.Second
		}
		b.log.Info("restarting script host", "in", backoff)
		select {
		case <-b.stopProc:
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

func (b *Bridge) pipeLog(r io.Reader, level slog.Level) {
	if r == nil {
		return
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		b.log.Log(context.Background(), level, sc.Text(), "src", "script")
	}
	if err := sc.Err(); err != nil {
		b.log.Debug("script host output pipe", "err", err)
	}
}
