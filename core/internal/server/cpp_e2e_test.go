package server

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gomp/tools/bot"
)

// TestCppHeadlessClient runs the C++ client stack (client/build/gomp-headless,
// built with `make -C client`) against the Go server with encryption on: the
// C++ client connects, spawns and walks, and a Go bot must see it move.
func TestCppHeadlessClient(t *testing.T) {
	bin, _ := filepath.Abs(filepath.Join("..", "..", "..", "client", "build", "gomp-headless"))
	if _, err := os.Stat(bin); err != nil {
		t.Skip("C++ headless client not built (make -C client)")
	}
	h := newHarness(t, func(c *configT) { c.Encryption = true }, nil)
	observer := h.spawned("Observer")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "--server", h.addr, "--name", "CppPlayer", "--seconds", "3", "--expect-player", "Observer")
	type result struct {
		out []byte
		err error
	}
	done := make(chan result, 1)
	go func() {
		out, err := cmd.CombinedOutput()
		done <- result{out, err}
	}()

	// The observer must see the C++ player and its movement east (3 m/s).
	var cppID uint16
	eventually(t, 10*time.Second, "observer sees the C++ player", func() bool {
		found := false
		observer.View(func(b *bot.Bot) {
			for id, r := range b.Players {
				if r.Name == "CppPlayer" {
					cppID, found = id, true
				}
			}
		})
		return found
	})
	start := remote(observer, cppID).Pos
	eventually(t, 10*time.Second, "C++ player walked", func() bool {
		p := remote(observer, cppID).Pos
		return p.X-start.X > 4 && p.Dist2DSq(start) > 16
	})
	// Keep the observer syncing so the C++ client receives its updates.
	stop := make(chan struct{})
	go func() {
		tick := time.NewTicker(33 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				observer.SendPedSync(time.Now())
			}
		}
	}()
	res := <-done
	close(stop)
	out := string(res.out)
	if res.err != nil {
		t.Fatalf("headless client failed: %v\n%s", res.err, out)
	}
	for _, want := range []string{"OK connected", "OK welcome", "OK spawned", "SEEN Observer"} {
		if !strings.Contains(out, want) {
			t.Errorf("headless output lacks %q:\n%s", want, out)
		}
	}
	h.exec(func(s *Server) {
		if m := s.metrics.Snapshot(); m.Violations != 0 {
			t.Errorf("C++ client movement flagged by anti-cheat: %+v", m)
		}
	})
}
