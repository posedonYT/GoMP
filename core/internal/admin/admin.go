// Package admin serves operational endpoints: Prometheus metrics, a JSON
// metrics snapshot (used by the stress tool), pprof and a health check.
package admin

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/pprof"
	"runtime"
	"runtime/metrics"
	"strings"
	"syscall"
	"time"

	"gomp/core/internal/server"
)

// Runtime describes the Go process.
type Runtime struct {
	Goroutines   int     `json:"goroutines"`
	HeapMB       float64 `json:"heapMB"`
	RSSMB        float64 `json:"rssMB"`
	GCCount      uint32  `json:"gcCount"`
	GCPauseP99Ms float64 `json:"gcPauseP99Ms"`
	CPUSeconds   float64 `json:"cpuSeconds"`
	UptimeSec    float64 `json:"uptimeSec"`
}

// Report is the /metrics.json document.
type Report struct {
	Server  server.Snapshot `json:"server"`
	Runtime Runtime         `json:"runtime"`
}

var started = time.Now()

func readRuntime() Runtime {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	rt := Runtime{
		Goroutines: runtime.NumGoroutine(),
		HeapMB:     float64(ms.HeapAlloc) / (1 << 20),
		GCCount:    ms.NumGC,
		UptimeSec:  time.Since(started).Seconds(),
	}
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) == nil {
		rt.CPUSeconds = float64(ru.Utime.Sec+ru.Stime.Sec) + float64(ru.Utime.Usec+ru.Stime.Usec)/1e6
		rss := float64(ru.Maxrss)
		if runtime.GOOS == "darwin" {
			rss /= 1 << 20 // bytes on macOS
		} else {
			rss /= 1 << 10 // kilobytes on Linux
		}
		rt.RSSMB = rss
	}
	sample := []metrics.Sample{{Name: "/sched/pauses/total/gc:seconds"}}
	metrics.Read(sample)
	if sample[0].Value.Kind() == metrics.KindFloat64Histogram {
		rt.GCPauseP99Ms = histQuantile(sample[0].Value.Float64Histogram(), 0.99) * 1000
	}
	return rt
}

func histQuantile(h *metrics.Float64Histogram, q float64) float64 {
	var total uint64
	for _, c := range h.Counts {
		total += c
	}
	if total == 0 {
		return 0
	}
	target := uint64(float64(total) * q)
	var acc uint64
	for i, c := range h.Counts {
		acc += c
		if acc >= target {
			return h.Buckets[i+1]
		}
	}
	return h.Buckets[len(h.Buckets)-1]
}

// Handler returns the admin HTTP handler.
func Handler(m *server.Metrics) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, "ok") })
	mux.HandleFunc("/metrics.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(Report{Server: m.Snapshot(), Runtime: readRuntime()})
	})
	mux.HandleFunc("/metrics/reset", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		m.ResetTickMax()
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		writeProm(w, m.Snapshot(), readRuntime())
	})
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	return mux
}

func writeProm(w http.ResponseWriter, s server.Snapshot, rt Runtime) {
	var b strings.Builder
	g := func(name, help string, v float64) {
		fmt.Fprintf(&b, "# HELP gomp_%s %s\n# TYPE gomp_%s gauge\ngomp_%s %g\n", name, help, name, name, v)
	}
	c := func(name, help string, v uint64) {
		fmt.Fprintf(&b, "# HELP gomp_%s %s\n# TYPE gomp_%s counter\ngomp_%s %d\n", name, help, name, name, v)
	}
	g("players", "Connected players.", float64(s.Players))
	g("vehicles", "Vehicles in the world.", float64(s.Vehicles))
	g("tick_p50_ms", "Median tick duration over the last 1024 ticks.", s.TickP50Ms)
	g("tick_p99_ms", "99th percentile tick duration over the last 1024 ticks.", s.TickP99Ms)
	g("tick_max_ms", "Maximum tick duration since start or reset.", s.TickMaxMs)
	c("ticks_total", "Ticks executed.", s.Ticks)
	c("sync_in_total", "Accepted sync messages.", s.SyncIn)
	c("sync_out_total", "Sync messages sent.", s.SyncOut)
	c("sync_deferred_total", "Sync updates deferred by the bandwidth budget.", s.SyncDeferred)
	c("shots_accepted_total", "Validated shots.", s.ShotsOK)
	c("shots_rejected_total", "Rejected shots.", s.ShotsBad)
	c("hits_accepted_total", "Validated hits.", s.HitsOK)
	c("hits_rejected_total", "Rejected hits.", s.HitsBad)
	c("deaths_total", "Player deaths.", s.Deaths)
	c("violations_total", "Anti-cheat violations.", s.Violations)
	c("corrections_total", "Position corrections sent.", s.Corrections)
	c("host_events_total", "Events sent to script hosts.", s.HostEvents)
	c("host_ops_in_total", "Commands received from script hosts.", s.HostOpsIn)
	c("net_bytes_out_total", "Bytes sent to players.", s.Net.BytesOut)
	c("net_bytes_in_total", "Bytes received from players.", s.Net.BytesIn)
	c("net_resends_total", "Reliable retransmissions.", s.Net.Resends)
	g("net_rtt_avg_ms", "Average round-trip time.", s.Net.AvgRTTMs)
	g("net_loss_avg", "Average packet loss ratio.", s.Net.AvgLoss)
	g("go_goroutines", "Goroutines.", float64(rt.Goroutines))
	g("go_heap_mb", "Heap in use (MiB).", rt.HeapMB)
	g("process_rss_max_mb", "Peak resident set size (MiB).", rt.RSSMB)
	g("process_cpu_seconds", "CPU time consumed.", rt.CPUSeconds)
	g("go_gc_pause_p99_ms", "99th percentile GC pause.", rt.GCPauseP99Ms)
	_, _ = w.Write([]byte(b.String()))
}

// Serve starts the admin server on addr ("" disables it).
func Serve(addr string, m *server.Metrics) (net.Addr, func() error, error) {
	if addr == "" {
		return nil, func() error { return nil }, nil
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, nil, err
	}
	srv := &http.Server{Handler: Handler(m), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	return ln.Addr(), srv.Close, nil
}
