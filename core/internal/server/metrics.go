package server

import (
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

const tickWindow = 1024

// Tick phases measured separately (exposed as average milliseconds per tick).
const (
	phaseInbound = iota
	phaseScripts
	phaseStreaming
	phaseShapes
	phaseControllers
	phaseSync
	phaseFlush
	phaseHosts
	numPhases
)

var phaseNames = [numPhases]string{"inbound", "scripts", "streaming", "shapes", "controllers", "sync", "flush", "hosts"}

type phaseTimer struct {
	last time.Time
	m    *Metrics
}

func (p *phaseTimer) mark(phase int) {
	now := time.Now()
	p.m.phaseNanos[phase].Add(uint64(now.Sub(p.last)))
	p.m.phaseMax[phase].Store(max(p.m.phaseMax[phase].Load(), uint64(now.Sub(p.last))))
	p.last = now
}

// Metrics are updated by the tick goroutine and read concurrently by the admin endpoint.
type Metrics struct {
	mu        sync.Mutex
	ticks     [tickWindow]time.Duration
	tickIdx   int
	tickCount uint64
	tickMax   time.Duration
	players   int
	vehicles  int
	netStats  NetStats

	msgIn, syncIn, syncOut, syncDeferred         atomic.Uint64
	shotsAccepted, shotsRejected                 atomic.Uint64
	hitsAccepted, hitsRejected, deaths           atomic.Uint64
	violations, corrections                      atomic.Uint64
	streamIns, hostEvents, hostOpsIn, hostOpsOut atomic.Uint64
	droppedEvents                                atomic.Uint64
	phaseNanos, phaseMax                         [numPhases]atomic.Uint64
}

// NetStats aggregates transport statistics over all connections.
type NetStats struct {
	BytesOut, BytesIn     uint64
	PacketsOut, PacketsIn uint64
	Resends               uint64
	AvgRTTMs              float64
	AvgLoss               float64
	Dropped               uint64
}

func newMetrics() *Metrics { return &Metrics{} }

func (m *Metrics) observeTick(d time.Duration, players int) {
	m.mu.Lock()
	m.ticks[m.tickIdx] = d
	m.tickIdx = (m.tickIdx + 1) % tickWindow
	m.tickCount++
	m.tickMax = max(m.tickMax, d)
	m.players = players
	m.mu.Unlock()
}

// Snapshot is a point-in-time copy of the metrics.
type Snapshot struct {
	Ticks        uint64   `json:"ticks"`
	TickP50Ms    float64  `json:"tickP50Ms"`
	TickP99Ms    float64  `json:"tickP99Ms"`
	TickMaxMs    float64  `json:"tickMaxMs"`
	Players      int      `json:"players"`
	Vehicles     int      `json:"vehicles"`
	MessagesIn   uint64   `json:"messagesIn"`
	SyncIn       uint64   `json:"syncIn"`
	SyncOut      uint64   `json:"syncOut"`
	SyncDeferred uint64   `json:"syncDeferred"`
	ShotsOK      uint64   `json:"shotsAccepted"`
	ShotsBad     uint64   `json:"shotsRejected"`
	HitsOK       uint64   `json:"hitsAccepted"`
	HitsBad      uint64   `json:"hitsRejected"`
	Deaths       uint64   `json:"deaths"`
	Violations   uint64   `json:"violations"`
	Corrections  uint64   `json:"corrections"`
	StreamIns    uint64   `json:"streamIns"`
	HostEvents   uint64   `json:"hostEvents"`
	HostOpsIn    uint64   `json:"hostOpsIn"`
	HostOpsOut   uint64   `json:"hostOpsOut"`
	DroppedEvts  uint64   `json:"droppedRemoteEvents"`
	Net          NetStats `json:"net"`
	// PhaseAvgMs is the average time per tick spent in each phase since reset.
	PhaseAvgMs map[string]float64 `json:"phaseAvgMs"`
	// PhaseMaxMs is the longest single execution of each phase since reset.
	PhaseMaxMs map[string]float64 `json:"phaseMaxMs"`
}

// Snapshot returns current metrics; safe for concurrent use.
func (m *Metrics) Snapshot() Snapshot {
	m.mu.Lock()
	n := min(int(m.tickCount), tickWindow)
	window := slices.Clone(m.ticks[:n])
	snap := Snapshot{Ticks: m.tickCount, TickMaxMs: ms(m.tickMax), Players: m.players, Vehicles: m.vehicles, Net: m.netStats}
	m.mu.Unlock()
	if n > 0 {
		slices.Sort(window)
		snap.TickP50Ms = ms(window[n/2])
		snap.TickP99Ms = ms(window[min(n-1, n*99/100)])
	}
	snap.MessagesIn = m.msgIn.Load()
	snap.SyncIn = m.syncIn.Load()
	snap.SyncOut = m.syncOut.Load()
	snap.SyncDeferred = m.syncDeferred.Load()
	snap.ShotsOK = m.shotsAccepted.Load()
	snap.ShotsBad = m.shotsRejected.Load()
	snap.HitsOK = m.hitsAccepted.Load()
	snap.HitsBad = m.hitsRejected.Load()
	snap.Deaths = m.deaths.Load()
	snap.Violations = m.violations.Load()
	snap.Corrections = m.corrections.Load()
	snap.StreamIns = m.streamIns.Load()
	snap.HostEvents = m.hostEvents.Load()
	snap.HostOpsIn = m.hostOpsIn.Load()
	snap.HostOpsOut = m.hostOpsOut.Load()
	snap.DroppedEvts = m.droppedEvents.Load()
	snap.PhaseAvgMs = make(map[string]float64, numPhases)
	snap.PhaseMaxMs = make(map[string]float64, numPhases)
	for i := range numPhases {
		if snap.Ticks > 0 {
			snap.PhaseAvgMs[phaseNames[i]] = float64(m.phaseNanos[i].Load()) / float64(snap.Ticks) / 1e6
		}
		snap.PhaseMaxMs[phaseNames[i]] = float64(m.phaseMax[i].Load()) / 1e6
	}
	return snap
}

// ResetTickMax clears the maximum tick duration (stress tests measure phases).
func (m *Metrics) ResetTickMax() {
	m.mu.Lock()
	m.tickMax = 0
	m.tickCount = 0
	m.tickIdx = 0
	for i := range numPhases {
		m.phaseNanos[i].Store(0)
		m.phaseMax[i].Store(0)
	}
	m.mu.Unlock()
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

// Metrics returns the live metrics.
func (s *Server) Metrics() *Metrics { return s.metrics }

// updateStats refreshes per-player ping/loss and aggregated transport stats (1 Hz).
func (s *Server) updateStats() {
	var ns NetStats
	n := 0
	for _, c := range s.byID {
		if c == nil {
			continue
		}
		st := c.conn.Stats()
		ns.BytesOut += st.BytesSent
		ns.BytesIn += st.BytesRecv
		ns.PacketsOut += st.PacketsSent
		ns.PacketsIn += st.PacketsRecv
		ns.Resends += st.Resends
		ns.AvgRTTMs += float64(st.RTT.Microseconds()) / 1000
		ns.AvgLoss += st.PacketLoss
		n++
		p := c.p
		ping := int(st.RTT.Milliseconds())
		if ping != p.Ping || st.PacketLoss != p.PacketLoss {
			p.Ping, p.PacketLoss = ping, st.PacketLoss
			s.hostUpdate(p, "ping", int64(ping))
			s.hostUpdate(p, "loss", st.PacketLoss)
		}
		if s.cfg.MaxPing > 0 && ping > s.cfg.MaxPing && s.now.Sub(c.joinedAt) > 30*time.Second {
			s.kick(c, "ping too high")
		}
	}
	if n > 0 {
		ns.AvgRTTMs /= float64(n)
		ns.AvgLoss /= float64(n)
	}
	ns.Dropped = s.net.DroppedPackets()
	s.metrics.mu.Lock()
	s.metrics.netStats = ns
	s.metrics.vehicles = s.world.Vehicles.Len()
	s.metrics.mu.Unlock()
}
