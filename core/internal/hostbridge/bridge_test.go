package hostbridge

import (
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"gomp/wire/proto"
)

// TestMain doubles as a fake host process when GOMP_FAKE_HOST is set: it
// connects with the credentials from the environment, answers pings and
// echoes every other op back as [echo, ...op].
func TestMain(m *testing.M) {
	if mode := os.Getenv("GOMP_FAKE_HOST"); mode != "" {
		fakeHost(mode)
		return
	}
	os.Exit(m.Run())
}

func fakeHost(mode string) {
	c, err := Dial(os.Getenv("GOMP_IPC_NETWORK"), os.Getenv("GOMP_IPC_ADDR"), os.Getenv("GOMP_IPC_TOKEN"), "fake-"+mode)
	if err != nil {
		os.Exit(2)
	}
	if mode == "crash" {
		os.Exit(3)
	}
	for {
		ops, err := c.Recv()
		if err != nil {
			os.Exit(0)
		}
		for _, op := range ops {
			switch op[0] {
			case OpPing:
				if mode != "hang" {
					_ = c.Send(Op{CmdPong, op[1]})
				}
			default:
				_ = c.Send(append(Op{"echo"}, op...))
			}
		}
	}
}

func startFake(t *testing.T, mode string, cfg Config) *Bridge {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cfg.Command = exe
	cfg.Env = append(cfg.Env, "GOMP_FAKE_HOST="+mode)
	b, err := Start(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.Close() })
	return b
}

var backlog = map[*Bridge][]Event{}

// waitFor returns the first event of kind matching each, keeping other events
// queued for later calls.
func waitFor(t *testing.T, b *Bridge, kind EventKind, timeout time.Duration, each func(Event) bool) Event {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		b.Poll(func(e Event) { backlog[b] = append(backlog[b], e) })
		for i, e := range backlog[b] {
			if e.Kind == kind && (each == nil || each(e)) {
				backlog[b] = append(backlog[b][:i], backlog[b][i+1:]...)
				return e
			}
		}
		b.Flush()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no event %d within %v", kind, timeout)
	return Event{}
}

func TestSpawnAuthAndEcho(t *testing.T) {
	b := startFake(t, "echo", Config{})
	up := waitFor(t, b, HostUp, 10*time.Second, nil)
	if up.Name != "fake-echo" {
		t.Fatalf("name %q", up.Name)
	}
	payload := map[string]proto.Value{"pos": proto.Vec3{X: 1, Y: 2, Z: 3}, "n": int64(5)}
	b.Send(up.Host, Op{OpEvent, "playerJoin", []proto.Value{proto.EntityRef{Type: proto.EntityPlayer, ID: 4}, payload}})
	b.Flush()
	ev := waitFor(t, b, HostOps, 5*time.Second, nil)
	op := ev.Ops[0]
	if op[0] != "echo" || op[1] != OpEvent || op[2] != "playerJoin" {
		t.Fatalf("echo %v", op)
	}
	args := op[3].([]proto.Value)
	if args[0] != (proto.EntityRef{Type: proto.EntityPlayer, ID: 4}) {
		t.Fatalf("entity ref lost: %#v", args[0])
	}
	if m := args[1].(map[string]proto.Value); m["pos"] != (proto.Vec3{X: 1, Y: 2, Z: 3}) || m["n"] != int64(5) {
		t.Fatalf("map lost: %#v", m)
	}
}

func TestCrashRestart(t *testing.T) {
	b := startFake(t, "crash", Config{Restart: true})
	first := waitFor(t, b, HostUp, 10*time.Second, nil)
	waitFor(t, b, HostDown, 10*time.Second, func(e Event) bool { return e.Host == first.Host })
	second := waitFor(t, b, HostUp, 15*time.Second, nil)
	if second.Host == first.Host {
		t.Fatal("restarted host reused id")
	}
}

func TestWatchdogKillsHungHost(t *testing.T) {
	b := startFake(t, "hang", Config{Watchdog: 1500 * time.Millisecond})
	up := waitFor(t, b, HostUp, 10*time.Second, nil)
	down := waitFor(t, b, HostDown, 10*time.Second, func(e Event) bool { return e.Host == up.Host })
	if down.Reason == "" || down.Reason[:8] != "watchdog" {
		t.Fatalf("reason %q", down.Reason)
	}
}

// Silence shows a host that stopped answering pings well before the watchdog
// acts; a host that answers stays around the ping interval.
func TestSilenceShowsAHungHost(t *testing.T) {
	measure := func(mode string) time.Duration {
		b := startFake(t, mode, Config{Watchdog: time.Minute})
		waitFor(t, b, HostUp, 10*time.Second, nil)
		var worst time.Duration
		for end := time.Now().Add(2500 * time.Millisecond); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
			b.Flush()
			worst = max(worst, b.Silence())
		}
		return worst
	}
	if d := measure("echo"); d > pingInterval+500*time.Millisecond {
		t.Errorf("answering host: silence %v", d)
	}
	if d := measure("hang"); d < 2*time.Second {
		t.Errorf("hung host: silence %v, want 2s+", d)
	}
}

func TestBadTokenRejected(t *testing.T) {
	b, err := Start(Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	network, addr, _ := b.Endpoint()
	c, err := Dial(network, addr, "wrong", "intruder")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Recv(); err == nil {
		t.Fatal("connection with bad token stayed open")
	}
	b.Poll(func(e Event) {
		if e.Kind == HostUp {
			t.Fatal("intruder accepted")
		}
	})
}

func TestAttachedHostMalformedFrame(t *testing.T) {
	b, err := Start(Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	network, addr, token := b.Endpoint()
	c, err := Dial(network, addr, token, "manual")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	up := waitFor(t, b, HostUp, 5*time.Second, nil)
	_ = c.Send(Op{CmdSubscribe, []proto.Value{"playerJoin"}})
	ev := waitFor(t, b, HostOps, 5*time.Second, nil)
	if ev.Host != up.Host || ev.Ops[0][0] != CmdSubscribe {
		t.Fatalf("%+v", ev)
	}
	// A frame that is not an array of ops drops the host.
	_, _ = c.conn.Write([]byte{2, 0, 0, 0, proto.TagInt, 2})
	waitFor(t, b, HostDown, 5*time.Second, nil)
}

// Two host processes (RAGE servers run JS and C# side by side): each connects with
// its own token; the watchdog kills the one that hangs, the other keeps running.
func TestTwoProcessesAreSupervisedApart(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	b, err := Start(Config{
		Watchdog: 1500 * time.Millisecond,
		Processes: []Process{
			{Name: "js", Command: exe, Env: []string{"GOMP_FAKE_HOST=echo"}},
			{Name: "cs", Command: exe, Env: []string{"GOMP_FAKE_HOST=hang"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.Close() })
	names := map[string]int{}
	for len(names) < 2 {
		up := waitFor(t, b, HostUp, 10*time.Second, nil)
		names[up.Name] = up.Host
	}
	if names["fake-echo"] == 0 || names["fake-hang"] == 0 {
		t.Fatalf("hosts %v", names)
	}
	for end := time.Now().Add(3 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		b.Flush()
		if !slices.Contains(b.Hosts(), names["fake-hang"]) {
			break
		}
	}
	down := waitFor(t, b, HostDown, 5*time.Second, func(e Event) bool { return e.Host == names["fake-hang"] })
	if !strings.HasPrefix(down.Reason, "watchdog") {
		t.Fatalf("reason %q", down.Reason)
	}
	// The other one still answers.
	b.Send(names["fake-echo"], Op{OpEvent, "x", []proto.Value{}})
	b.Flush()
	ev := waitFor(t, b, HostOps, 5*time.Second, func(e Event) bool { return e.Host == names["fake-echo"] })
	if ev.Ops[0][0] != "echo" {
		t.Fatalf("echo %v", ev.Ops)
	}
	if !slices.Contains(b.Hosts(), names["fake-echo"]) {
		t.Fatal("the healthy host was dropped too")
	}
}
