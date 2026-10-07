package server

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"gomp/core/internal/hostbridge"
	"gomp/tools/bot"
	"gomp/wire/proto"
)

// startNode launches the real Node.js host with the packages in dir.
func startNode(t *testing.T, dir string) *hostbridge.Bridge {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	host, _ := filepath.Abs(filepath.Join("..", "..", "..", "runtimes", "node", "host.js"))
	if _, err := os.Stat(host); err != nil {
		t.Fatalf("host.js not found: %v", err)
	}
	pk, _ := filepath.Abs(dir)
	var logger *slog.Logger
	if os.Getenv("GOMP_TEST_LOG") != "" {
		logger = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	b, err := hostbridge.Start(hostbridge.Config{
		Command: node, Args: []string{host}, Env: []string{"GOMP_PACKAGES=" + pk}, Logger: logger, Watchdog: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func chatContains(b *bot.Bot, s string) bool {
	found := false
	b.View(func(x *bot.Bot) {
		found = slices.ContainsFunc(x.Chat, func(l string) bool { return strings.Contains(l, s) })
	})
	return found
}

func TestNodeRuntimeEndToEnd(t *testing.T) {
	bridge := startNode(t, filepath.Join("testdata", "packages"))
	h := newHarness(t, nil, bridge)
	// Wait until the Node host loaded the packages.
	eventually(t, 15*time.Second, "node host loaded packages", func() bool {
		ok := false
		h.exec(func(s *Server) {
			for _, hs := range s.hosts {
				ok = ok || hs.loaded
			}
		})
		return ok
	})

	b := h.bot("Neo")
	eventually(t, 3*time.Second, "welcome chat from playerJoin", func() bool { return chatContains(b, "Welcome, Neo!") })
	eventually(t, 3*time.Second, "shared variable set by script", func() bool {
		v := proto.Value(nil)
		b.View(func(x *bot.Bot) { v = x.Shared["job"] })
		return v == "driver"
	})
	b.Ready()
	eventually(t, 3*time.Second, "spawned and armed by script", func() bool {
		ok := false
		b.View(func(x *bot.Bot) {
			ok = x.Spawned && x.Pos.Dist(proto.Vec3{X: -425.5, Y: 1123.6, Z: 325.8}) < 0.1 && x.Weapons[proto.Joaat("weapon_pistol")] == 30
		})
		return ok
	})

	// Commands: registered, unknown, and a vehicle spawned by script.
	b.Say("/veh adder")
	eventually(t, 3*time.Second, "vehicle created and player seated", func() bool {
		ok := false
		b.View(func(x *bot.Bot) {
			v := x.Vehicles[x.VehicleID]
			ok = x.VehicleID != proto.NoID && x.Seat == 0 && v != nil && v.Model == proto.Joaat("adder") &&
				v.Props[proto.PropNumberPlate] == "E2E" && v.Shared["owner"] == "Neo"
		})
		return ok
	})
	b.Say("/teleportme")
	eventually(t, 3*time.Second, "unknown command handler", func() bool { return chatContains(b, "unknown command: teleportme") })

	// Remote event round trip: callRemote → mp.events → player.call.
	b.CallRemote("echo", "abc", int64(5), proto.Vec3{X: 1, Y: 2, Z: 3})
	eventually(t, 3*time.Second, "echo reply", func() bool {
		ok := false
		b.View(func(x *bot.Bot) {
			for _, e := range x.Events {
				if e.Name == "echoReply" && len(e.Args) == 3 && e.Args[0] == "abc" && e.Args[1] == int64(5) && e.Args[2] == (proto.Vec3{X: 1, Y: 2, Z: 3}) {
					ok = true
				}
			}
		})
		return ok
	})

	// Procedures in both directions.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sum, err := b.CallProc(ctx, "sum", int64(2), int64(40))
	if err != nil || sum != int64(42) {
		t.Fatalf("sum proc: %v %v", sum, err)
	}
	b.View(func(x *bot.Bot) {
		x.Procs["whoami"] = func([]proto.Value) (proto.Value, error) { return "the one", nil }
	})
	b.Say("/ask")
	eventually(t, 3*time.Second, "callProc answered by client", func() bool { return chatContains(b, "you are the one") })

	// Leave the vehicle, enter a colshape defined by the script.
	b.ExitVehicle()
	h.teleportBot(b, proto.Vec3{X: -401, Y: 1123.6, Z: 325.8})
	eventually(t, 3*time.Second, "colshape event", func() bool { return chatContains(b, "entered zone") })

	// Death and script-driven respawn.
	b.SelfDamage(proto.CauseFall, 100, 0)
	eventually(t, 3*time.Second, "death reported to script", func() bool { return chatContains(b, "died: ") })
	eventually(t, 3*time.Second, "respawned by script", func() bool {
		ok := false
		b.View(func(x *bot.Bot) { ok = !x.Dead && x.Health == 100 })
		return ok
	})
}

func TestNodeHostCrashIsIsolated(t *testing.T) {
	dir := t.TempDir()
	pkg := filepath.Join(dir, "crashy")
	if err := os.MkdirAll(pkg, 0o755); err != nil {
		t.Fatal(err)
	}
	// The package spawns a vehicle, then hard-crashes the Node process on a command.
	code := `mp.events.addCommand('crash', () => { process.exit(13); });
mp.events.addCommand('car', (p) => { p.putIntoVehicle(mp.vehicles.new('sultan', p.position), 0); });
mp.events.add('playerReady', (p) => p.spawn(new mp.Vector3(0, 0, 70)));`
	if err := os.WriteFile(filepath.Join(pkg, "index.js"), []byte(code), 0o644); err != nil {
		t.Fatal(err)
	}
	bridge := startNode(t, dir)
	h := newHarness(t, nil, bridge)
	eventually(t, 15*time.Second, "loaded", func() bool {
		ok := false
		h.exec(func(s *Server) {
			for _, hs := range s.hosts {
				ok = ok || hs.loaded
			}
		})
		return ok
	})
	b := h.bot("Victim")
	b.Ready()
	eventually(t, 3*time.Second, "spawned", func() bool {
		ok := false
		b.View(func(x *bot.Bot) { ok = x.Spawned })
		return ok
	})
	b.Say("/car")
	eventually(t, 3*time.Second, "in car", func() bool {
		ok := false
		b.View(func(x *bot.Bot) { ok = x.VehicleID != proto.NoID })
		return ok
	})
	b.Say("/crash")
	// The script host dies; its vehicle disappears, the player stays connected
	// and the core keeps syncing.
	eventually(t, 5*time.Second, "script entities cleaned up", func() bool {
		ok := false
		b.View(func(x *bot.Bot) { ok = x.VehicleID == proto.NoID && len(x.Vehicles) == 0 })
		return ok
	})
	if closed, reason := b.Closed(); closed {
		t.Fatalf("player lost connection when the script host crashed: %s", reason)
	}
	h.exec(func(s *Server) {
		if s.world.Players.Len() != 1 || len(s.hosts) != 0 {
			t.Errorf("players=%d hosts=%d", s.world.Players.Len(), len(s.hosts))
		}
	})
}
