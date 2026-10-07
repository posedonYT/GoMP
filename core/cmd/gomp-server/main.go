// Command gomp-server runs the GoMP game server from a RAGE.MP-style server
// directory (conf.json, packages/, client_packages/).
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"gomp/core/internal/admin"
	"gomp/core/internal/config"
	"gomp/core/internal/fastdl"
	"gomp/core/internal/hostbridge"
	"gomp/core/internal/server"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "gomp-server:", err)
		os.Exit(1)
	}
}

func run() error {
	dir := flag.String("dir", ".", "server directory containing conf.json, packages/ and client_packages/")
	confName := flag.String("config", "conf.json", "configuration file, relative to -dir")
	nodeHost := flag.String("node-host", "", "path to runtimes/node/host.js (default: gomp.host-script or auto-detected)")
	flag.Parse()

	root, err := filepath.Abs(*dir)
	if err != nil {
		return err
	}
	cfg, err := config.Load(filepath.Join(root, *confName))
	if err != nil {
		return err
	}
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: parseLevel(cfg.GoMP.LogLevel)}))

	var bridge *hostbridge.Bridge
	if cfg.EnableNodeJS {
		var script string
		switch {
		case *nodeHost != "": // command line: relative to the working directory
			script, _ = filepath.Abs(*nodeHost)
		case cfg.GoMP.HostScript != "": // conf.json: relative to the server directory
			script = cfg.GoMP.HostScript
			if !filepath.IsAbs(script) {
				script = filepath.Join(root, script)
			}
		default:
			script = findNodeHost(root)
		}
		if script == "" {
			return fmt.Errorf("enable-nodejs is set but runtimes/node/host.js was not found; pass -node-host")
		}
		args := strings.Fields(cfg.GoMP.NodeArgs)
		args = append(args, script)
		bridge, err = hostbridge.Start(hostbridge.Config{
			Command:  cfg.GoMP.NodePath,
			Args:     args,
			Dir:      root,
			Env:      []string{"GOMP_PACKAGES=" + filepath.Join(root, cfg.GoMP.PackagesDir), "GOMP_ROOT=" + root},
			Watchdog: time.Duration(cfg.GoMP.HostWatchdogMs) * time.Millisecond,
			Restart:  cfg.GoMP.HostRestart,
			Logger:   log.With("component", "node"),
		})
		if err != nil {
			return fmt.Errorf("script bridge: %w", err)
		}
		log.Info("starting Node.js script host", "script", script)
	}

	opts := server.Options{Config: cfg, Logger: log}
	if bridge != nil {
		opts.Scripts = bridge
		opts.WaitForScripts = 60 * time.Second
	}
	srv, err := server.New(opts)
	if err != nil {
		if bridge != nil {
			bridge.Close()
		}
		return err
	}
	if addr, stop, err := admin.Serve(cfg.GoMP.AdminBind, srv.Metrics()); err != nil {
		return fmt.Errorf("admin: %w", err)
	} else if addr != nil {
		defer stop()
		log.Info("admin endpoint", "addr", addr.String())
	}
	fdlAddr := fmt.Sprintf("%s:%d", cfg.Bind, cfg.Port+1)
	if addr, stop, err := fastdl.Serve(fdlAddr, filepath.Join(root, cfg.GoMP.ClientPackagesDir)); err != nil {
		log.Warn("client_packages HTTP server disabled", "err", err)
	} else {
		defer stop()
		log.Info("client_packages HTTP", "addr", addr.String())
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return srv.Run(ctx)
}

// findNodeHost looks for the Node runtime next to the server directory or the binary.
func findNodeHost(root string) string {
	var candidates []string
	if env := os.Getenv("GOMP_NODE_HOST"); env != "" {
		candidates = append(candidates, env)
	}
	candidates = append(candidates,
		filepath.Join(root, "runtimes", "node", "host.js"),
		filepath.Join(root, "..", "runtimes", "node", "host.js"),
	)
	if exe, err := os.Executable(); err == nil {
		d := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(d, "runtimes", "node", "host.js"),
			filepath.Join(d, "..", "runtimes", "node", "host.js"))
	}
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			abs, _ := filepath.Abs(c)
			return abs
		}
	}
	return ""
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	}
	return slog.LevelInfo
}
