// Package server is the GoMP game server: the fixed-rate tick loop that ties
// the transport, the world model, streaming, sync validation, combat and the
// script hosts together. All world state is mutated on the tick goroutine
// only; outbound snapshot building is parallelised over read-only state.
package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"gomp/core/internal/anticheat"
	"gomp/core/internal/combat"
	"gomp/core/internal/config"
	"gomp/core/internal/gamedata"
	"gomp/core/internal/hostbridge"
	"gomp/core/internal/spatial"
	"gomp/core/internal/streaming"
	"gomp/core/internal/world"
	"gomp/wire/proto"
	"gomp/wire/transport"
)

// ScriptBridge is the core's view of the script hosts (hostbridge.Bridge).
type ScriptBridge interface {
	Poll(fn func(hostbridge.Event))
	Send(host int, op hostbridge.Op)
	Broadcast(op hostbridge.Op)
	Flush()
	Close() error
}

// Options configure a Server.
type Options struct {
	Config config.Config
	Logger *slog.Logger
	// Scripts connects script hosts; nil runs the core without scripting.
	Scripts ScriptBridge
	// Conn overrides the UDP socket (tests); nil listens on Config.ListenAddr().
	Conn transport.PacketConn
	// Weapons overrides the weapon table; nil uses defaults plus gomp.weapons-file.
	Weapons *gamedata.Weapons
	// WaitForScripts delays accepting players until a host reports its packages loaded.
	WaitForScripts time.Duration
}

// Server is a running game server.
type Server struct {
	cfg      config.Config
	log      *slog.Logger
	net      *transport.Server
	world    *world.World
	grid     *spatial.Grid // streamable entities
	shapes   *spatial.Grid // colshapes and checkpoints by centre
	weapons  *gamedata.Weapons
	vehicles *gamedata.Vehicles
	combat   combat.Config
	acLimits anticheat.Limits

	clients map[*transport.Conn]*client
	byID    []*client // indexed by player id

	// streamers[entity] = receivers that have the entity streamed in.
	streamers map[proto.EntityRef]map[uint16]struct{}
	// syncCache holds the encoded latest sync message per player / vehicle id.
	playerSync  []*cachedSync
	vehicleSync []*cachedSync
	netDirty    []proto.EntityRef

	maxShapeRadius float32
	largeShapes    map[uint16]*world.Colshape

	sliceBuf     []*client
	limits       streaming.Limits
	tick         uint64
	tickRate     int
	tickDur      time.Duration
	streamEvery  uint64
	bytesPerTick int
	now          time.Time
	started      time.Time

	scripts       ScriptBridge
	hosts         map[int]*hostState
	scriptsLoaded bool
	waitScripts   time.Time
	hostPending   []pendingUpdate
	hostPendingIx map[world.Entity]int
	hostSyncDirty map[world.Entity]struct{}
	serverProcs   map[uint32]serverProc
	nextProcID    uint32

	bans        map[string]string // serial or ip -> reason
	lastConnect map[string]time.Time

	exec         chan execReq
	metrics      *Metrics
	running      atomic.Bool
	respawnDelay time.Duration
}

type cachedSync struct {
	seq   uint32
	bytes []byte
}

type execReq struct {
	fn   func()
	done chan struct{}
}

type pendingUpdate struct {
	ent    world.Entity
	fields map[string]proto.Value
}

// New creates a server and opens its socket.
func New(opts Options) (*Server, error) {
	cfg := opts.Config
	if cfg.MaxPlayers == 0 {
		cfg = config.Default()
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	weapons := opts.Weapons
	if weapons == nil {
		weapons = gamedata.DefaultWeapons()
		if cfg.GoMP.WeaponsFile != "" {
			if err := weapons.LoadOverrides(cfg.GoMP.WeaponsFile); err != nil {
				return nil, fmt.Errorf("weapons file: %w", err)
			}
		}
	}
	tcfg := transport.ServerConfig{
		Encryption: cfg.Encryption,
		MaxConns:   cfg.MaxPlayers + 64,
		Timeout:    time.Duration(cfg.GoMP.ConnectionTimeoutMs) * time.Millisecond,
	}
	var tsrv *transport.Server
	var err error
	if opts.Conn != nil {
		tsrv, err = transport.NewServer(opts.Conn, tcfg)
	} else {
		tsrv, err = transport.Listen(cfg.ListenAddr(), tcfg)
	}
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg:           cfg,
		log:           log,
		net:           tsrv,
		world:         world.New(cfg.MaxPlayers),
		grid:          spatial.New(100),
		shapes:        spatial.New(100),
		weapons:       weapons,
		vehicles:      gamedata.DefaultVehicles(),
		combat:        combat.Config{HeadMultiplier: float32(cfg.GoMP.HeadshotMultiplier), LimbMultiplier: float32(cfg.GoMP.LimbMultiplier)},
		acLimits:      anticheat.Limits{MaxFootSpeed: float32(cfg.GoMP.MaxFootSpeed), Tolerance: float32(cfg.GoMP.SpeedTolerance)},
		clients:       make(map[*transport.Conn]*client),
		byID:          make([]*client, cfg.MaxPlayers),
		streamers:     make(map[proto.EntityRef]map[uint16]struct{}),
		playerSync:    make([]*cachedSync, cfg.MaxPlayers),
		vehicleSync:   make([]*cachedSync, world.MaxVehicles),
		largeShapes:   make(map[uint16]*world.Colshape),
		tickRate:      cfg.GoMP.TickRate,
		tickDur:       time.Second / time.Duration(cfg.GoMP.TickRate),
		streamEvery:   uint64(max(1, cfg.GoMP.TickRate/cfg.GoMP.StreamUpdateRate)),
		bytesPerTick:  cfg.GoMP.BandwidthPerPlayer / cfg.GoMP.TickRate,
		scripts:       opts.Scripts,
		hosts:         make(map[int]*hostState),
		hostPendingIx: make(map[world.Entity]int),
		hostSyncDirty: make(map[world.Entity]struct{}),
		serverProcs:   make(map[uint32]serverProc),
		bans:          make(map[string]string),
		lastConnect:   make(map[string]time.Time),
		exec:          make(chan execReq, 64),
		metrics:       newMetrics(),
		now:           time.Now(),
		respawnDelay:  5 * time.Second,
	}
	s.started = s.now
	s.limits = s.streamLimits()
	if s.scripts == nil {
		s.scriptsLoaded = true
	} else if opts.WaitForScripts > 0 {
		s.waitScripts = s.now.Add(opts.WaitForScripts)
	} else {
		s.scriptsLoaded = true
	}
	for _, w := range cfg.Warnings {
		log.Warn("conf.json: " + w)
	}
	return s, nil
}

// Addr returns the UDP address the server listens on.
func (s *Server) Addr() net.Addr { return s.net.LocalAddr() }

// Config returns the effective configuration.
func (s *Server) Config() config.Config { return s.cfg }

// Run executes the tick loop until ctx is cancelled, then shuts down.
func (s *Server) Run(ctx context.Context) error {
	if s.running.Swap(true) {
		return errors.New("server: already running")
	}
	s.log.Info("server started", "addr", s.Addr().String(), "tick-rate", s.tickRate,
		"maxplayers", s.cfg.MaxPlayers, "stream-distance", s.cfg.StreamDistance, "encryption", s.cfg.Encryption)
	ticker := time.NewTicker(s.tickDur)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.shutdown()
			return nil
		case <-ticker.C:
			s.step()
		case req := <-s.exec:
			s.now = time.Now()
			req.fn()
			close(req.done)
		}
	}
}

// Exec runs fn on the tick goroutine and waits for it. It is meant for tests
// and admin tooling; fn may use every method of the server.
func (s *Server) Exec(ctx context.Context, fn func()) error {
	req := execReq{fn: fn, done: make(chan struct{})}
	select {
	case s.exec <- req:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-req.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// World exposes the world model to code running inside Exec.
func (s *Server) World() *world.World { return s.world }

// step runs one simulation tick.
func (s *Server) step() {
	start := time.Now()
	s.now = start
	s.tick++
	ph := phaseTimer{last: start, m: s.metrics}

	if !s.scriptsLoaded && !s.waitScripts.IsZero() && s.now.After(s.waitScripts) {
		s.log.Warn("script host did not report loaded packages in time; accepting players anyway")
		s.scriptsLoaded = true
	}
	s.net.PollEvents(s.onNetEvent)
	s.processInbound()
	ph.mark(phaseInbound)
	if s.scripts != nil {
		s.scripts.Poll(s.onHostEvent)
	}
	s.checkTimers()
	ph.mark(phaseScripts)
	// Streaming and trigger volumes run for 1/streamEvery of the players each
	// tick (round robin), so every player is updated stream-update-rate times
	// per second without periodic load spikes.
	s.updateStreaming()
	ph.mark(phaseStreaming)
	s.updateShapes()
	ph.mark(phaseShapes)
	if s.tick%uint64(s.tickRate) == 0 {
		s.assignControllers()
		s.updateStats()
		ph.mark(phaseControllers)
	}
	s.sendSync()
	ph.mark(phaseSync)
	// Packets are built in parallel and handed to the socket writers in
	// large batches; the tick never waits for sendto.
	s.net.Update()
	s.net.FlushAll()
	ph.mark(phaseFlush)
	s.flushHosts()
	ph.mark(phaseHosts)
	s.metrics.observeTick(time.Since(start), len(s.clients))
}

// shutdown notifies hosts (serverShutdown), disconnects players and closes sockets.
func (s *Server) shutdown() {
	s.log.Info("server shutting down")
	if s.scripts != nil && len(s.hosts) > 0 {
		s.scripts.Broadcast(hostbridge.Op{hostbridge.OpShutdown})
		s.scripts.Flush()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			ready := true
			s.scripts.Poll(func(e hostbridge.Event) {
				if e.Kind == hostbridge.HostOps {
					for _, op := range e.Ops {
						if op[0] == hostbridge.CmdShutdownReady {
							if h := s.hosts[e.Host]; h != nil {
								h.shutdownReady = true
							}
						}
					}
				} else if e.Kind == hostbridge.HostDown {
					delete(s.hosts, e.Host)
				}
			})
			for _, h := range s.hosts {
				ready = ready && h.shutdownReady
			}
			if ready {
				break
			}
			s.scripts.Flush()
			time.Sleep(20 * time.Millisecond)
		}
	}
	_ = s.net.Shutdown("server shutting down")
	if s.scripts != nil {
		_ = s.scripts.Close()
	}
}

// parallel runs fn(i) for i in [0, n) on all CPUs.
func parallel(n int, fn func(i int)) {
	workers := min(runtime.GOMAXPROCS(0), n)
	if workers <= 1 || n < 32 {
		for i := range n {
			fn(i)
		}
		return
	}
	var next atomic.Int64
	var wg sync.WaitGroup
	for range workers {
		wg.Go(func() {
			for {
				i := int(next.Add(1)) - 1
				if i >= n {
					return
				}
				fn(i)
			}
		})
	}
	wg.Wait()
}

// clientList returns connected clients ordered by player id.
func (s *Server) clientList() []*client {
	out := make([]*client, 0, len(s.clients))
	for _, c := range s.byID {
		if c != nil {
			out = append(out, c)
		}
	}
	return out
}

// checkTimers handles time-based state: expired enter reservations,
// unacknowledged teleports and stale proc calls.
func (s *Server) checkTimers() {
	for _, c := range s.byID {
		if c == nil {
			continue
		}
		p := c.p
		if p.Entering != nil && s.now.After(p.EnterExpires) {
			s.clearReservation(p)
		}
		if p.TeleportPending && s.now.Sub(p.TeleportAt) > time.Second {
			// Resend the unacknowledged position (lost or slow client).
			p.TeleportAt = s.now
			s.sendTo(c, transport.Reliable, &proto.SetPosition{Seq: p.TeleportSeq, Reason: proto.PosTeleport, Pos: p.Pos, Heading: proto.KeepHeading})
		}
		if c.respawnAt != (time.Time{}) && s.now.After(c.respawnAt) {
			c.respawnAt = time.Time{}
			if p.Dead {
				s.spawnPlayer(p, s.defaultSpawn(), float32(s.cfg.GoMP.SpawnHeading))
			}
		}
		for id, pp := range c.procs {
			if s.now.After(pp.expires) {
				delete(c.procs, id)
				s.sendToHost(pp.host, hostbridge.Op{hostbridge.OpProcRes, int64(pp.hostCallID), false, "timeout"})
			}
		}
	}
	for id, sp := range s.serverProcs {
		if s.now.After(sp.expires) {
			delete(s.serverProcs, id)
			if c := s.clientByRef(sp.player); c != nil {
				s.sendTo(c, transport.Reliable, &proto.ProcResult{CallID: sp.clientCallID, OK: false, Error: "timeout"})
			}
		}
	}
}

func (s *Server) defaultSpawn() proto.Vec3 {
	g := s.cfg.GoMP
	return proto.Vec3{X: float32(g.SpawnX), Y: float32(g.SpawnY), Z: float32(g.SpawnZ)}
}
