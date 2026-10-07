// Command stress load-tests a GoMP server with many headless bots and writes
// a report. By default it launches bin/gomp-server with the Node.js host and
// a stress gamemode in a temporary server directory.
package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"gomp/tools/bot"
	"gomp/wire/proto"
	"gomp/wire/transport/faultnet"
)

//go:embed assets
var assets embed.FS

type options struct {
	server     string
	serverBin  string
	nodeHost   string
	admin      string
	port       int
	bots       int
	duration   time.Duration
	ramp       time.Duration
	warmup     time.Duration
	profile    string
	mix        string
	loss       float64
	latency    time.Duration
	jitter     time.Duration
	reportDir  string
	encryption bool
	label      string
	isolate    bool
}

func main() {
	var o options
	flag.StringVar(&o.server, "server", "", "address of a running server (empty: launch -server-bin)")
	flag.StringVar(&o.serverBin, "server-bin", "bin/gomp-server", "server binary to launch")
	flag.StringVar(&o.nodeHost, "node-host", "runtimes/node/host.js", "Node.js host script for the launched server")
	flag.StringVar(&o.admin, "admin", "", "admin endpoint (default: launched server's)")
	flag.IntVar(&o.port, "port", 23005, "UDP port for the launched server")
	flag.IntVar(&o.bots, "bots", 1000, "number of bots")
	flag.DurationVar(&o.duration, "duration", 60*time.Second, "measurement window")
	flag.DurationVar(&o.ramp, "ramp", 10*time.Second, "time over which bots connect")
	flag.DurationVar(&o.warmup, "warmup", 5*time.Second, "settling time before measuring")
	flag.StringVar(&o.profile, "profile", "mixed", "spawn layout: mixed (4 hubs of 250 m), uniform (whole map), hotspot (20% in one 60 m spot) or extreme (everybody in one spot)")
	flag.StringVar(&o.mix, "mix", "walkers=60,drivers=20,shooters=20", "behaviour mix in percent")
	flag.Float64Var(&o.loss, "loss", 0, "packet loss per direction (0..1)")
	flag.DurationVar(&o.latency, "latency", 0, "added one-way latency")
	flag.DurationVar(&o.jitter, "jitter", 0, "added random latency")
	flag.StringVar(&o.reportDir, "report", "reports", "directory for reports")
	flag.BoolVar(&o.encryption, "encryption", true, "enable transport encryption on the launched server")
	flag.StringVar(&o.label, "label", "", "label appended to the report name")
	flag.BoolVar(&o.isolate, "isolate", true, "lower the bots' scheduling priority so they do not compete with the server for CPU")
	flag.Parse()
	if err := run(o); err != nil {
		fmt.Fprintln(os.Stderr, "stress:", err)
		os.Exit(1)
	}
}

// ------------------------------------------------------------------ histogram

type hist struct {
	buckets [5001]atomic.Uint64 // 0.1 ms resolution up to 500 ms, last bucket = overflow
	count   atomic.Uint64
	max     atomic.Int64
}

func (h *hist) add(d time.Duration) {
	if d < 0 {
		d = 0
	}
	i := int(d / (100 * time.Microsecond))
	if i >= len(h.buckets) {
		i = len(h.buckets) - 1
	}
	h.buckets[i].Add(1)
	h.count.Add(1)
	for {
		m := h.max.Load()
		if int64(d) <= m || h.max.CompareAndSwap(m, int64(d)) {
			break
		}
	}
}

func (h *hist) quantile(q float64) float64 {
	n := h.count.Load()
	if n == 0 {
		return 0
	}
	target := uint64(math.Ceil(float64(n) * q))
	var acc uint64
	for i := range h.buckets {
		acc += h.buckets[i].Load()
		if acc >= target {
			return float64(i) / 10
		}
	}
	return 500
}

func (h *hist) reset() {
	for i := range h.buckets {
		h.buckets[i].Store(0)
	}
	h.count.Store(0)
	h.max.Store(0)
}

// ------------------------------------------------------------------ server process

func prepareServerDir(o options) (string, error) {
	dir, err := os.MkdirTemp("", "gomp-stress-")
	if err != nil {
		return "", err
	}
	sub, _ := fs.Sub(assets, "assets")
	if err := os.CopyFS(dir, sub); err != nil {
		return "", err
	}
	host, err := filepath.Abs(o.nodeHost)
	if err != nil {
		return "", err
	}
	conf := map[string]any{
		"maxplayers":      o.bots + 50,
		"name":            "GoMP stress",
		"gamemode":        "stress",
		"stream-distance": 300,
		"bind":            "127.0.0.1",
		"port":            o.port,
		"encryption":      o.encryption,
		"enable-nodejs":   true,
		"gomp": map[string]any{
			"admin-bind":            fmt.Sprintf("127.0.0.1:%d", o.port+5),
			"host-script":           host,
			"log-level":             "warn",
			"connection-timeout-ms": 15000,
		},
	}
	data, _ := json.MarshalIndent(conf, "", "  ")
	return dir, os.WriteFile(filepath.Join(dir, "conf.json"), data, 0o644)
}

func launchServer(ctx context.Context, o options) (*exec.Cmd, string, error) {
	dir, err := prepareServerDir(o)
	if err != nil {
		return nil, "", err
	}
	bin, err := filepath.Abs(o.serverBin)
	if err != nil {
		return nil, "", err
	}
	cmd := exec.CommandContext(ctx, bin, "-dir", dir)
	cmd.Env = append(os.Environ(), "GOMP_STRESS_PROFILE="+o.profile)
	logf, _ := os.Create(filepath.Join(dir, "server.log"))
	cmd.Stdout, cmd.Stderr = logf, logf
	cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
	cmd.WaitDelay = 15 * time.Second
	if err := cmd.Start(); err != nil {
		return nil, "", fmt.Errorf("start %s: %w (build it with: go build -o bin/gomp-server ./core/cmd/gomp-server)", bin, err)
	}
	return cmd, dir, nil
}

// ------------------------------------------------------------------ admin metrics

type serverMetrics struct {
	Server struct {
		Ticks        uint64  `json:"ticks"`
		TickP50Ms    float64 `json:"tickP50Ms"`
		TickP99Ms    float64 `json:"tickP99Ms"`
		TickMaxMs    float64 `json:"tickMaxMs"`
		Players      int     `json:"players"`
		Vehicles     int     `json:"vehicles"`
		SyncIn       uint64  `json:"syncIn"`
		SyncOut      uint64  `json:"syncOut"`
		SyncDeferred uint64  `json:"syncDeferred"`
		ShotsOK      uint64  `json:"shotsAccepted"`
		ShotsBad     uint64  `json:"shotsRejected"`
		HitsOK       uint64  `json:"hitsAccepted"`
		HitsBad      uint64  `json:"hitsRejected"`
		Deaths       uint64  `json:"deaths"`
		Violations   uint64  `json:"violations"`
		Corrections  uint64  `json:"corrections"`
		HostEvents   uint64  `json:"hostEvents"`
		HostOpsIn    uint64  `json:"hostOpsIn"`
		Net          struct {
			BytesOut uint64  `json:"BytesOut"`
			BytesIn  uint64  `json:"BytesIn"`
			Resends  uint64  `json:"Resends"`
			AvgRTTMs float64 `json:"AvgRTTMs"`
			AvgLoss  float64 `json:"AvgLoss"`
		} `json:"net"`
	} `json:"server"`
	Runtime struct {
		Goroutines   int     `json:"goroutines"`
		HeapMB       float64 `json:"heapMB"`
		RSSMB        float64 `json:"rssMB"`
		GCCount      uint32  `json:"gcCount"`
		GCPauseP99Ms float64 `json:"gcPauseP99Ms"`
		CPUSeconds   float64 `json:"cpuSeconds"`
	} `json:"runtime"`
}

func fetchMetrics(base string) (serverMetrics, error) {
	var m serverMetrics
	res, err := http.Get(base + "/metrics.json")
	if err != nil {
		return m, err
	}
	defer res.Body.Close()
	return m, json.NewDecoder(res.Body).Decode(&m)
}

// ------------------------------------------------------------------ bots

type kind int

const (
	walker kind = iota
	driver
	shooter
)

func parseMix(s string) (w, d, sh int) {
	for _, part := range strings.Split(s, ",") {
		k, v, _ := strings.Cut(strings.TrimSpace(part), "=")
		var n int
		fmt.Sscanf(v, "%d", &n)
		switch k {
		case "walkers":
			w = n
		case "drivers":
			d = n
		case "shooters":
			sh = n
		}
	}
	return
}

// lazyHome starts a behaviour once the bot has spawned, anchored at its spawn point.
type lazyHome struct {
	kind  kind
	seed  uint64
	inner bot.Behavior
}

func (l *lazyHome) Tick(b *bot.Bot, now time.Time, dt float64) {
	if l.inner == nil {
		var spawned bool
		var pos proto.Vec3
		b.View(func(x *bot.Bot) { spawned, pos = x.Spawned, x.Pos })
		if !spawned {
			return
		}
		switch l.kind {
		case walker:
			l.inner = bot.NewWalker(pos, 60, l.seed)
		case driver:
			l.inner = bot.NewDriver(pos, 40+float32(l.seed%40), 12+float32(l.seed%10), "/veh sultan", l.seed)
		case shooter:
			l.inner = bot.NewShooter(pos, 30, l.seed)
		}
	}
	l.inner.Tick(b, now, dt)
}

type fleet struct {
	mu          sync.Mutex
	bots        []*bot.Bot
	connectErrs map[string]int
	disconnects map[string]int
	connected   atomic.Int64
	pedLatency  hist
	vehLatency  hist
	messages    atomic.Uint64
}

func (f *fleet) start(ctx context.Context, o options, addr string) {
	w, d, sh := parseMix(o.mix)
	total := max(1, w+d+sh)
	interval := o.ramp / time.Duration(max(1, o.bots))
	var wg sync.WaitGroup
	for i := range o.bots {
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
		wg.Go(func() {
			k := walker
			switch slot := i * 100 / o.bots % 100; {
			case slot < w*100/total:
				k = walker
			case slot < (w+d)*100/total:
				k = driver
			default:
				k = shooter
			}
			f.runBot(ctx, o, addr, i, k)
		})
	}
	wg.Wait()
}

func (f *fleet) runBot(ctx context.Context, o options, addr string, i int, k kind) {
	cfg := bot.Config{Server: addr, Name: fmt.Sprintf("bot%04d", i), Serial: fmt.Sprintf("stress-%d", i), ConnectTimeout: 15 * time.Second}
	if o.loss > 0 || o.latency > 0 || o.jitter > 0 {
		uc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
		if err != nil {
			f.connectErr(err.Error())
			return
		}
		defer uc.Close()
		cfg.Conn = faultnet.Wrap(uc, faultnet.Config{Loss: o.loss, Latency: o.latency, Jitter: o.jitter, Seed: uint64(i + 1)})
	}
	b, err := bot.Connect(ctx, cfg)
	if err != nil {
		f.connectErr(err.Error())
		fmt.Printf("bot %s: connect failed after %v: %v\n", cfg.Name, cfg.ConnectTimeout, err)
		return
	}
	// Sample one in eight messages: the shared histogram must not become the
	// bottleneck of a process running 1000 bots.
	var seen uint64
	b.SetLatencySink(func(kind proto.MsgID, lat time.Duration) {
		seen++
		if seen%8 != 0 {
			return
		}
		f.messages.Add(8)
		if kind == proto.MsgPlayerSyncOut {
			f.pedLatency.add(lat)
		} else {
			f.vehLatency.add(lat)
		}
	})
	f.mu.Lock()
	f.bots = append(f.bots, b)
	f.mu.Unlock()
	f.connected.Add(1)
	b.Ready()
	err = b.Run(ctx, &lazyHome{kind: k, seed: uint64(i)*7919 + 17}, 30)
	f.connected.Add(-1)
	var de *bot.DisconnectedError
	if errors.As(err, &de) {
		f.mu.Lock()
		f.disconnects[de.Reason]++
		f.mu.Unlock()
	}
	b.Close()
}

func (f *fleet) connectErr(e string) {
	f.mu.Lock()
	f.connectErrs[e]++
	f.mu.Unlock()
}

// ------------------------------------------------------------------ report

type report struct {
	Started       time.Time          `json:"started"`
	Options       map[string]any     `json:"options"`
	Host          map[string]any     `json:"host"`
	Connected     int64              `json:"connectedAtEnd"`
	ConnectErrors map[string]int     `json:"connectErrors"`
	Disconnects   map[string]int     `json:"disconnects"`
	Server        map[string]float64 `json:"server"`
	Latency       map[string]float64 `json:"syncLatencyMs"`
	Bots          map[string]float64 `json:"bots"`
	Checks        []check            `json:"checks"`
	Passed        bool               `json:"passed"`
}

type check struct {
	Name   string  `json:"name"`
	Value  float64 `json:"value"`
	Limit  float64 `json:"limit"`
	Passed bool    `json:"passed"`
}

func run(o options) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	addr := o.server
	admin := o.admin
	var srv *exec.Cmd
	if addr == "" {
		var dir string
		var err error
		srvCtx, cancelSrv := context.WithCancel(context.Background())
		defer cancelSrv()
		srv, dir, err = launchServer(srvCtx, o)
		if err != nil {
			return err
		}
		fmt.Printf("launched server (logs: %s)\n", filepath.Join(dir, "server.log"))
		addr = fmt.Sprintf("127.0.0.1:%d", o.port)
		admin = fmt.Sprintf("http://127.0.0.1:%d", o.port+5)
		defer func() {
			cancelSrv()
			_ = srv.Wait()
		}()
	}
	if admin != "" {
		deadline := time.Now().Add(30 * time.Second)
		for {
			m, err := fetchMetrics(admin)
			if err == nil && m.Server.Ticks > 0 {
				break
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("server admin endpoint %s not ready: %v", admin, err)
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	// Give the Node host time to load packages (the core rejects players before that).
	time.Sleep(2 * time.Second)
	if o.isolate {
		// Only this process (the bots) is affected; the server keeps its priority.
		if err := lowerPriority(); err != nil {
			fmt.Println("warning: cannot lower bot priority:", err)
		}
	}

	f := &fleet{connectErrs: map[string]int{}, disconnects: map[string]int{}}
	botCtx, stopBots := context.WithCancel(ctx)
	var fleetDone sync.WaitGroup
	fleetDone.Go(func() { f.start(botCtx, o, addr) })
	started := time.Now()
	fmt.Printf("connecting %d bots over %v (profile %s, mix %s)\n", o.bots, o.ramp, o.profile, o.mix)
	progress := time.NewTicker(5 * time.Second)
	defer progress.Stop()
	waitUntil := func(d time.Duration, label string) bool {
		end := time.Now().Add(d)
		for time.Now().Before(end) {
			select {
			case <-ctx.Done():
				return false
			case <-progress.C:
				line := fmt.Sprintf("[%s] connected=%d", label, f.connected.Load())
				if admin != "" {
					if m, err := fetchMetrics(admin); err == nil {
						line += fmt.Sprintf(" tick p50=%.2fms p99=%.2fms max=%.2fms players=%d vehicles=%d",
							m.Server.TickP50Ms, m.Server.TickP99Ms, m.Server.TickMaxMs, m.Server.Players, m.Server.Vehicles)
					}
				}
				fmt.Println(line)
			case <-time.After(100 * time.Millisecond):
			}
		}
		return true
	}
	if !waitUntil(o.ramp+o.warmup, "ramp") {
		stopBots()
		fleetDone.Wait()
		return ctx.Err()
	}
	f.pedLatency.reset()
	f.vehLatency.reset()
	var before serverMetrics
	if admin != "" {
		_, _ = http.Post(admin+"/metrics/reset", "text/plain", nil)
		before, _ = fetchMetrics(admin)
	}
	measureStart := time.Now()
	fmt.Printf("measuring for %v\n", o.duration)
	waitUntil(o.duration, "measure")
	elapsed := time.Since(measureStart).Seconds()
	var after serverMetrics
	if admin != "" {
		after, _ = fetchMetrics(admin)
	}
	// Bot-side transport stats.
	f.mu.Lock()
	var rtt, loss float64
	var resends uint64
	n := 0
	for _, b := range f.bots {
		st := b.Stats()
		rtt += float64(st.RTT.Microseconds()) / 1000
		loss += st.PacketLoss
		resends += st.Resends
		n++
	}
	f.mu.Unlock()
	connected := f.connected.Load()
	stopBots()
	fleetDone.Wait()

	rep := report{
		Started:       started,
		ConnectErrors: f.connectErrs,
		Disconnects:   f.disconnects,
		Connected:     connected,
		Options: map[string]any{"bots": o.bots, "profile": o.profile, "mix": o.mix, "duration": o.duration.String(),
			"loss": o.loss, "latency": o.latency.String(), "jitter": o.jitter.String(), "encryption": o.encryption, "isolate": o.isolate},
		Host: map[string]any{"os": runtime.GOOS, "arch": runtime.GOARCH, "cpus": runtime.NumCPU(), "go": runtime.Version()},
		Latency: map[string]float64{
			"ped_p50": f.pedLatency.quantile(0.5), "ped_p95": f.pedLatency.quantile(0.95), "ped_p99": f.pedLatency.quantile(0.99),
			"ped_max": float64(time.Duration(f.pedLatency.max.Load()).Microseconds()) / 1000,
			"veh_p50": f.vehLatency.quantile(0.5), "veh_p99": f.vehLatency.quantile(0.99),
			"samples": float64(f.pedLatency.count.Load() + f.vehLatency.count.Load()),
		},
		Bots: map[string]float64{"avgRttMs": rtt / float64(max(1, n)), "avgLoss": loss / float64(max(1, n)), "resends": float64(resends),
			"syncMsgsPerBotPerSec": float64(f.messages.Load()) / elapsed / float64(max(1, n))},
	}
	if admin != "" {
		s, r := after.Server, after.Runtime
		cpu := (r.CPUSeconds - before.Runtime.CPUSeconds) / elapsed
		players := float64(max(1, s.Players))
		rep.Server = map[string]float64{
			"players": float64(s.Players), "vehicles": float64(s.Vehicles),
			"tickP50Ms": s.TickP50Ms, "tickP99Ms": s.TickP99Ms, "tickMaxMs": s.TickMaxMs,
			"cpuCores": cpu, "heapMB": r.HeapMB, "rssMB": r.RSSMB, "gcPauseP99Ms": r.GCPauseP99Ms, "goroutines": float64(r.Goroutines),
			"syncInPerSec":       float64(s.SyncIn-before.Server.SyncIn) / elapsed,
			"syncOutPerSec":      float64(s.SyncOut-before.Server.SyncOut) / elapsed,
			"syncDeferredPerSec": float64(s.SyncDeferred-before.Server.SyncDeferred) / elapsed,
			"kbOutPerPlayerSec":  float64(s.Net.BytesOut-before.Server.Net.BytesOut) / elapsed / players / 1024,
			"kbInPerPlayerSec":   float64(s.Net.BytesIn-before.Server.Net.BytesIn) / elapsed / players / 1024,
			"shotsPerSec":        float64(s.ShotsOK-before.Server.ShotsOK) / elapsed,
			"hitsPerSec":         float64(s.HitsOK-before.Server.HitsOK) / elapsed,
			"deaths":             float64(s.Deaths - before.Server.Deaths),
			"violations":         float64(s.Violations - before.Server.Violations),
			"hostEventsPerSec":   float64(s.HostEvents-before.Server.HostEvents) / elapsed,
			"hostCommandsPerSec": float64(s.HostOpsIn-before.Server.HostOpsIn) / elapsed,
		}
		rep.Checks = append(rep.Checks,
			check{Name: "tick p99 ms", Value: s.TickP99Ms, Limit: 10},
			check{Name: "tick max ms (budget 33.3)", Value: s.TickMaxMs, Limit: 33.3},
		)
	}
	rep.Checks = append(rep.Checks,
		check{Name: "connected bots", Value: float64(connected), Limit: float64(o.bots)},
		// Up to two 33 ms frames (server tick + client frame) plus scheduling slack;
		// isolated bots run on slower cores and receive later.
		check{Name: "ped sync latency p99 ms", Value: rep.Latency["ped_p99"], Limit: latencyLimit(o)},
	)
	rep.Passed = true
	for i := range rep.Checks {
		c := &rep.Checks[i]
		if c.Name == "connected bots" {
			c.Passed = c.Value >= c.Limit
		} else {
			c.Passed = c.Value <= c.Limit
		}
		rep.Passed = rep.Passed && c.Passed
	}
	return writeReport(o, rep)
}

func latencyLimit(o options) float64 {
	limit := 100.0
	if o.isolate {
		limit = 150
	}
	return limit + 2*float64(o.latency.Milliseconds()+o.jitter.Milliseconds())
}

func writeReport(o options, rep report) error {
	if err := os.MkdirAll(o.reportDir, 0o755); err != nil {
		return err
	}
	name := fmt.Sprintf("stress-%s-%s-%d", rep.Started.Format("20060102-150405"), o.profile, o.bots)
	if o.label != "" {
		name += "-" + o.label
	}
	js, _ := json.MarshalIndent(rep, "", "  ")
	if err := os.WriteFile(filepath.Join(o.reportDir, name+".json"), js, 0o644); err != nil {
		return err
	}
	var md bytes.Buffer
	fmt.Fprintf(&md, "# Стресс-тест GoMP: %d ботов, профиль %s\n\n", o.bots, o.profile)
	fmt.Fprintf(&md, "- Дата: %s\n- Машина: %v\n- Параметры: %v\n\n", rep.Started.Format(time.RFC3339), rep.Host, rep.Options)
	fmt.Fprintf(&md, "## Проверки\n\n| Метрика | Значение | Порог | Итог |\n|---|---:|---:|---|\n")
	for _, c := range rep.Checks {
		res := "✅"
		if !c.Passed {
			res = "❌"
		}
		fmt.Fprintf(&md, "| %s | %.2f | %.2f | %s |\n", c.Name, c.Value, c.Limit, res)
	}
	section := func(title string, m map[string]float64) {
		if len(m) == 0 {
			return
		}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		fmt.Fprintf(&md, "\n## %s\n\n| Метрика | Значение |\n|---|---:|\n", title)
		for _, k := range keys {
			fmt.Fprintf(&md, "| %s | %.2f |\n", k, m[k])
		}
	}
	section("Сервер", rep.Server)
	section("Задержка синхронизации бот→бот (мс)", rep.Latency)
	section("Боты", rep.Bots)
	if len(rep.ConnectErrors)+len(rep.Disconnects) > 0 {
		fmt.Fprintf(&md, "\n## Ошибки\n\n- Подключение: %v\n- Отключения: %v\n", rep.ConnectErrors, rep.Disconnects)
	}
	path := filepath.Join(o.reportDir, name+".md")
	if err := os.WriteFile(path, md.Bytes(), 0o644); err != nil {
		return err
	}
	fmt.Print(md.String())
	fmt.Printf("\nreport: %s\n", path)
	if !rep.Passed {
		return errors.New("some checks failed")
	}
	return nil
}
