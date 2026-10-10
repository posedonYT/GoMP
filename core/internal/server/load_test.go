package server

import (
	"testing"
	"time"

	"gomp/core/internal/config"
	"gomp/core/internal/hostbridge"
	"gomp/tools/bot"
	"gomp/wire/proto"
)

func startFakeHost(t *testing.T, h *harness, fb *fakeBridge) {
	t.Helper()
	fb.hostUp(1)
	fb.find(t, 1, "ready", func(op hostbridge.Op) bool { return op[0] == hostbridge.OpReady })
	fb.cmd(1, hostbridge.Op{hostbridge.CmdLoaded, int64(1)})
	eventually(t, 2*time.Second, "host commands applied", func() bool {
		fb.mu.Lock()
		n := len(fb.events)
		fb.mu.Unlock()
		ok := false
		h.exec(func(s *Server) { ok = n == 0 && len(s.hostBacklog) == 0 && s.scriptsLoaded })
		return ok
	})
}

// scriptSpawned connects a bot and spawns it the way a script does.
func scriptSpawned(t *testing.T, h *harness, fb *fakeBridge, name string, at proto.Vec3) *bot.Bot {
	t.Helper()
	b := h.bot(name)
	create := fb.find(t, 1, name+" create", func(op hostbridge.Op) bool {
		return op[0] == hostbridge.OpCreate && op[1] == int64(proto.EntityPlayer)
	})
	b.Ready()
	fb.cmd(1, hostbridge.Op{hostbridge.CmdCall, int64(proto.EntityPlayer), create[2], create[3], "spawn", []proto.Value{at, 0.0}})
	eventually(t, 2*time.Second, name+" spawned", func() bool {
		ok := false
		b.View(func(x *bot.Bot) { ok = x.Spawned })
		return ok
	})
	return b
}

// A flood of host commands runs at most host-ops-per-tick per tick; the rest
// waits for the next ticks, in order, and is counted.
func TestHostCommandsBudgetPerTick(t *testing.T) {
	fb := newFakeBridge()
	h := newHarness(t, func(c *config.Config) { c.GoMP.HostOpsPerTick = 100 }, fb)
	startFakeHost(t, h, fb)
	ops := make([]hostbridge.Op, 1000)
	for i := range ops {
		ops[i] = hostbridge.Op{hostbridge.CmdSubscribe, []proto.Value{"evt" + string(rune('a'+i%26)) + string(rune('a'+i/26))}}
	}
	var ran, left uint64
	var waiting int
	h.exec(func(s *Server) {
		before := s.metrics.hostOpsIn.Load()
		fb.mu.Lock()
		fb.events = append(fb.events, hostbridge.Event{Kind: hostbridge.HostOps, Host: 1, Ops: ops})
		fb.mu.Unlock()
		s.pollHosts()
		ran = s.metrics.hostOpsIn.Load() - before
		left = s.metrics.hostOpsDeferred.Load()
		for _, e := range s.hostBacklog {
			waiting += len(e.Ops)
		}
	})
	if ran != 100 || waiting != 900 || left == 0 {
		t.Fatalf("one tick ran %d, %d wait, deferred %d", ran, waiting, left)
	}
	// The next ticks finish them, the last one included.
	last := ops[999][1].([]proto.Value)[0].(string)
	eventually(t, 3*time.Second, "all commands applied", func() bool {
		ok := false
		h.exec(func(s *Server) { ok = len(s.hostBacklog) == 0 && s.hosts[1].subs[last] })
		return ok
	})
}

// Positions reach the script host as one compact "updates" op per mirror tick
// (host-mirror-rate, 10 a second by default), not a map per entity every tick.
func TestMirrorUpdatesAreCompactAndRateLimited(t *testing.T) {
	fb := newFakeBridge()
	h := newHarness(t, nil, fb)
	startFakeHost(t, h, fb)
	b := scriptSpawned(t, h, fb, "runner", proto.Vec3{X: 100, Y: 100, Z: 30})
	id := botID(b)
	// Keep moving for a second.
	stop := time.Now().Add(time.Second)
	for time.Now().Before(stop) {
		b.Lock()
		b.Pos = b.Pos.Add(proto.Vec3{X: 0.1})
		b.Unlock()
		b.SendPedSync(time.Now())
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(150 * time.Millisecond)
	fb.mu.Lock()
	defer fb.mu.Unlock()
	updates, maps := 0, 0
	var lastPos proto.Vec3
	for _, op := range fb.sent[1] {
		switch op[0] {
		case hostbridge.OpUpdates:
			v := op[1].([]proto.Value)
			if len(v)%hostbridge.MirrorStride != 0 {
				t.Fatalf("updates of %d values", len(v))
			}
			for i := 0; i < len(v); i += hostbridge.MirrorStride {
				if v[i] == int64(proto.EntityPlayer) && v[i+1] == int64(id) {
					updates++
					lastPos = v[i+2].(proto.Vec3)
				}
			}
		case hostbridge.OpUpdate:
			if f, ok := op[3].(map[string]proto.Value); ok {
				if _, has := f["pos"]; has && op[2] == int64(id) {
					maps++
				}
			}
		}
	}
	if updates < 5 || updates > 14 {
		t.Fatalf("%d position updates in about a second, want ~10", updates)
	}
	if maps != 0 {
		t.Fatalf("%d positions still sent as maps", maps)
	}
	var cur proto.Vec3
	b.View(func(x *bot.Bot) { cur = x.Pos })
	if lastPos.X < cur.X-1 {
		t.Fatalf("host position %v, bot at %v", lastPos, cur)
	}
}

// silentBridge reports a fixed host silence, like a Node blocked for a while.
type silentBridge struct {
	*fakeBridge
	silence time.Duration
}

func (b silentBridge) Silence() time.Duration { return b.silence }

// The stress report watches Node's health: the longest silence of a host and
// the hosts lost (each loses every entity its scripts created).
func TestHostStabilityMetrics(t *testing.T) {
	fb := newFakeBridge()
	h := newHarness(t, nil, silentBridge{fb, 1700 * time.Millisecond})
	fb.hostUp(1)
	eventually(t, 2*time.Second, "silence recorded", func() bool {
		return h.srv.Metrics().Snapshot().HostSilence >= 1700
	})
	fb.hostDown(1)
	eventually(t, 2*time.Second, "lost host counted", func() bool { return h.srv.Metrics().Snapshot().HostsDown == 1 })
	h.srv.Metrics().ResetTickMax()
	if snap := h.srv.Metrics().Snapshot(); snap.HostsDown != 1 || snap.HostSilence < 1700 {
		t.Fatalf("host health is counted from the server start: %+v", snap)
	}
}
