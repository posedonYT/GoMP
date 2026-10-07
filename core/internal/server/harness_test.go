package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"sync"
	"testing"
	"time"

	"gomp/core/internal/config"
	"gomp/core/internal/hostbridge"
	"gomp/core/internal/world"
	"gomp/tools/bot"
	"gomp/wire/proto"
	"gomp/wire/transport"
)

type configT = config.Config

func asRejected(err error, target **transport.RejectedError) bool { return errors.As(err, target) }

// harness runs a real server on loopback; bots connect over UDP.
type harness struct {
	t      *testing.T
	srv    *Server
	addr   string
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}

func testConfig() config.Config {
	cfg := config.Default()
	cfg.Bind = "127.0.0.1"
	cfg.MaxPlayers = 64
	cfg.StreamDistance = 300
	cfg.GoMP.TickRate = 30
	cfg.GoMP.StreamUpdateRate = 10
	cfg.GoMP.AutoSpawn = true
	cfg.GoMP.SpawnX, cfg.GoMP.SpawnY, cfg.GoMP.SpawnZ = 100, 100, 30
	cfg.Raw = map[string]any{"maxplayers": 64}
	return cfg
}

func newHarness(t *testing.T, mutate func(*config.Config), scripts ScriptBridge) *harness {
	t.Helper()
	cfg := testConfig()
	if mutate != nil {
		mutate(&cfg)
	}
	uc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	var logger *slog.Logger
	if os.Getenv("GOMP_TEST_LOG") != "" {
		logger = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	}
	srv, err := New(Options{Config: cfg, Conn: uc, Scripts: scripts, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	srv.respawnDelay = 300 * time.Millisecond
	h := &harness{t: t, srv: srv, addr: uc.LocalAddr().String(), done: make(chan struct{})}
	h.ctx, h.cancel = context.WithCancel(context.Background())
	go func() {
		defer close(h.done)
		_ = srv.Run(h.ctx)
	}()
	t.Cleanup(func() {
		h.cancel()
		<-h.done
	})
	return h
}

// exec runs fn on the tick goroutine.
func (h *harness) exec(fn func(s *Server)) {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.srv.Exec(ctx, func() { fn(h.srv) }); err != nil {
		h.t.Fatal(err)
	}
}

// bot connects a bot that pumps in the background; the test drives actions.
func (h *harness) bot(name string) *bot.Bot {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	b, err := bot.Connect(ctx, bot.Config{Server: h.addr, Name: name, Serial: "serial-" + name})
	if err != nil {
		h.t.Fatal(err)
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Go(func() {
		tick := time.NewTicker(5 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case now := <-tick.C:
				b.Pump(now)
				b.Flush(now)
			}
		}
	})
	h.t.Cleanup(func() {
		close(stop)
		wg.Wait()
		b.Close()
	})
	eventually(h.t, 2*time.Second, name+" welcomed", func() bool { return botID(b) != proto.NoID })
	return b
}

// spawned connects a bot, sends Ready and waits for the auto-spawn.
func (h *harness) spawned(name string) *bot.Bot {
	h.t.Helper()
	b := h.bot(name)
	b.Ready()
	eventually(h.t, 3*time.Second, fmt.Sprintf("%s spawned", name), func() bool {
		ok := false
		b.View(func(b *bot.Bot) { ok = b.Spawned })
		return ok
	})
	return b
}

func eventually(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}

// never asserts cond stays false for d.
func never(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			t.Fatalf("unexpected: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// moveTo walks a bot to pos in small legal steps, syncing each one.
func moveTo(b *bot.Bot, pos proto.Vec3) {
	for {
		var cur proto.Vec3
		b.View(func(b *bot.Bot) { cur = b.Pos })
		d := pos.Sub(cur)
		if d.Len() < 0.01 {
			return
		}
		step := d
		if l := d.Len(); l > 0.2 {
			step = d.Scale(0.2 / l) // 0.2 m every 33 ms ≈ 6 m/s
		}
		b.View(func(b *bot.Bot) {
			b.Pos = b.Pos.Add(step)
			b.Vel = step.Scale(30)
			b.Move = proto.MoveRun
		})
		b.SendPedSync(time.Now())
		time.Sleep(33 * time.Millisecond)
	}
}

// teleportBot moves a bot server-side and waits until the client applied it.
func (h *harness) teleportBot(b *bot.Bot, pos proto.Vec3) {
	h.t.Helper()
	id := botID(b)
	h.exec(func(s *Server) { s.setPosition(s.world.Players.Get(id), pos) })
	eventually(h.t, 2*time.Second, "teleport applied", func() bool {
		var p proto.Vec3
		b.View(func(b *bot.Bot) { p = b.Pos })
		return p == pos
	})
	h.exec(func(s *Server) {}) // let the ack be processed
	time.Sleep(50 * time.Millisecond)
}

func botID(b *bot.Bot) uint16 {
	var id uint16
	b.View(func(b *bot.Bot) { id = b.ID })
	return id
}

func sees(b *bot.Bot, id uint16) bool {
	ok := false
	b.View(func(b *bot.Bot) { _, ok = b.Players[id] })
	return ok
}

func remote(b *bot.Bot, id uint16) bot.Remote {
	var r bot.Remote
	b.View(func(b *bot.Bot) {
		if p := b.Players[id]; p != nil {
			r = *p
		}
	})
	return r
}

// spawnVehicle creates a vehicle like a script would.
func (h *harness) spawnVehicle(model string, pos proto.Vec3, heading float32) uint16 {
	var id uint16
	h.exec(func(s *Server) {
		v := world.NewVehicle(proto.Joaat(model), pos, heading, s.vehicles.Seats(proto.Joaat(model)))
		if err := s.world.Add(v, -1); err != nil {
			h.t.Fatal(err)
		}
		s.indexEntity(v)
		id = v.ID
	})
	return id
}

func (h *harness) giveWeapon(b *bot.Bot, weapon string, ammo int) {
	id := botID(b)
	h.exec(func(s *Server) {
		x := &args{a: []proto.Value{int64(proto.Joaat(weapon)), int64(ammo)}}
		if err := s.callPlayer(nil, s.world.Players.Get(id), "giveWeapon", x); err != nil {
			h.t.Fatal(err)
		}
	})
	eventually(h.t, 2*time.Second, "loadout received", func() bool {
		ok := false
		b.View(func(b *bot.Bot) { ok = b.Weapons[proto.Joaat(weapon)] > 0 })
		return ok
	})
}

// ------------------------------------------------------------------ fake script bridge

// fakeBridge is an in-memory ScriptBridge driven by tests.
type fakeBridge struct {
	mu      sync.Mutex
	events  []hostbridge.Event
	pending map[int][]hostbridge.Op
	sent    map[int][]hostbridge.Op
	up      map[int]bool
}

func newFakeBridge() *fakeBridge {
	return &fakeBridge{pending: map[int][]hostbridge.Op{}, sent: map[int][]hostbridge.Op{}, up: map[int]bool{}}
}

func (f *fakeBridge) Poll(fn func(hostbridge.Event)) {
	f.mu.Lock()
	evs := f.events
	f.events = nil
	f.mu.Unlock()
	for _, e := range evs {
		fn(e)
	}
}

func (f *fakeBridge) Send(host int, op hostbridge.Op) {
	f.mu.Lock()
	if f.up[host] {
		f.pending[host] = append(f.pending[host], op)
	}
	f.mu.Unlock()
}

func (f *fakeBridge) Broadcast(op hostbridge.Op) {
	f.mu.Lock()
	for id := range f.up {
		f.pending[id] = append(f.pending[id], op)
	}
	f.mu.Unlock()
}

func (f *fakeBridge) Flush() {
	f.mu.Lock()
	for id, ops := range f.pending {
		f.sent[id] = append(f.sent[id], ops...)
		delete(f.pending, id)
		for _, op := range ops {
			if op[0] == hostbridge.OpShutdown { // behave like a host without delayShutdown
				f.events = append(f.events, hostbridge.Event{Kind: hostbridge.HostOps, Host: id,
					Ops: []hostbridge.Op{{hostbridge.CmdShutdownReady}}})
			}
		}
	}
	f.mu.Unlock()
}

func (f *fakeBridge) Close() error { return nil }

func (f *fakeBridge) hostUp(id int) {
	f.mu.Lock()
	f.up[id] = true
	f.events = append(f.events, hostbridge.Event{Kind: hostbridge.HostUp, Host: id, Name: fmt.Sprintf("fake%d", id)})
	f.mu.Unlock()
}

func (f *fakeBridge) hostDown(id int) {
	f.mu.Lock()
	delete(f.up, id)
	f.events = append(f.events, hostbridge.Event{Kind: hostbridge.HostDown, Host: id, Reason: "test"})
	f.mu.Unlock()
}

func (f *fakeBridge) cmd(id int, ops ...hostbridge.Op) {
	f.mu.Lock()
	f.events = append(f.events, hostbridge.Event{Kind: hostbridge.HostOps, Host: id, Ops: ops})
	f.mu.Unlock()
}

// find returns the first op sent to host matching pred, consuming everything before it.
func (f *fakeBridge) find(t *testing.T, host int, what string, pred func(hostbridge.Op) bool) hostbridge.Op {
	t.Helper()
	var found hostbridge.Op
	eventually(t, 3*time.Second, what, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		for i, op := range f.sent[host] {
			if pred(op) {
				found = op
				f.sent[host] = f.sent[host][i+1:]
				return true
			}
		}
		return false
	})
	return found
}

// subscribe registers events for host and waits until the core applied it.
func (h *harness) subscribe(f *fakeBridge, host int, names ...string) {
	h.t.Helper()
	list := make([]proto.Value, len(names))
	for i, n := range names {
		list[i] = n
	}
	f.cmd(host, hostbridge.Op{hostbridge.CmdSubscribe, list})
	eventually(h.t, 2*time.Second, "subscription applied", func() bool {
		ok := false
		h.exec(func(s *Server) {
			hs := s.hosts[host]
			ok = hs != nil && hs.subs[names[len(names)-1]]
		})
		return ok
	})
}

func isEvent(name string) func(hostbridge.Op) bool {
	return func(op hostbridge.Op) bool { return op[0] == hostbridge.OpEvent && op[1] == name }
}
