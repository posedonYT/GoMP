// Command gomp-launcher starts GTA V (Legacy) connected to a GoMP server.
//
// The game folder stays clean: ScriptHookV, the ASI loader and gomp.asi are
// copied into it only for the session and removed when the game exits, so a
// normal launch of GTA V (story mode, GTA Online) has no mods at all. Files
// that already existed are backed up and restored. A session manifest in the
// game folder lets the next run finish a cleanup interrupted by a crash.
//
//	gomp-launcher -server 127.0.0.1:22005
//	gomp-launcher -clean            # only remove leftovers of a previous session
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const manifestName = "gomp-session.json"

// Files the launcher puts into the game folder (from the dist folder).
var sessionFiles = []string{"ScriptHookV.dll", "dinput8.dll", "xinput1_4.dll", "args.txt", "gomp.asi"}

// Files created by the session itself (logs, config) that are removed afterwards.
var generatedFiles = []string{"gomp.json", "gomp.log", "ScriptHookV.log", "asiloader.log"}

type installed struct {
	Name   string `json:"name"`
	Backup string `json:"backup,omitempty"` // original file renamed aside
}

type manifest struct {
	Started time.Time   `json:"started"`
	Files   []installed `json:"files"`
}

func main() {
	gameDir := flag.String("game", "", "GTA V folder (default: detected from the Epic Games Launcher)")
	server := flag.String("server", "127.0.0.1:22005", "GoMP server address")
	name := flag.String("name", os.Getenv("USERNAME"), "connection name (the in-game name comes from the character)")
	dist := flag.String("dist", "", "folder with ScriptHookV.dll, dinput8.dll, args.txt and gomp.asi (default: client-dist next to the launcher or the repository)")
	clean := flag.Bool("clean", false, "only remove files left by a previous session and exit")
	flag.Parse()

	if err := run(*gameDir, *server, *name, *dist, *clean); err != nil {
		fmt.Fprintln(os.Stderr, "gomp-launcher:", err)
		os.Exit(1)
	}
}

func run(gameDir, server, name, dist string, cleanOnly bool) error {
	game, err := findGame(gameDir)
	if err != nil {
		return err
	}
	fmt.Println("game folder:", game.dir)
	if gameRunning() {
		return errors.New("GTA V is already running; close it first")
	}
	if err := cleanup(game.dir); err != nil {
		return fmt.Errorf("cleanup of a previous session: %w", err)
	}
	if cleanOnly {
		fmt.Println("game folder is clean")
		return nil
	}
	if dist == "" {
		dist = findDist()
	}
	if err := install(game.dir, dist, server, name); err != nil {
		_ = cleanup(game.dir)
		return err
	}
	// Ctrl+C in the launcher still cleans up once the game is gone.
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt)

	fmt.Println("starting GTA V, server", server)
	if err := game.launch(); err != nil {
		_ = cleanup(game.dir)
		return err
	}
	if !waitFor(func() bool { return gameRunning() }, 5*time.Minute, interrupt) {
		fmt.Println("the game did not start")
		return cleanup(game.dir)
	}
	fmt.Println("game running; mods are removed when it exits")
	waitFor(func() bool { return !gameRunning() }, 0, nil)
	fmt.Println("game closed, cleaning up")
	if err := cleanup(game.dir); err != nil {
		return err
	}
	fmt.Println("game folder is clean")
	return nil
}

// ------------------------------------------------------------------ install / cleanup

func install(gameDir, dist, server, name string) error {
	m := manifest{Started: time.Now()}
	save := func() error { return writeJSON(filepath.Join(gameDir, manifestName), m) }
	// The manifest is written before any file is touched.
	if err := save(); err != nil {
		return err
	}
	for _, f := range sessionFiles {
		src := filepath.Join(dist, f)
		data, err := os.ReadFile(src)
		if err != nil {
			if f == "xinput1_4.dll" {
				continue // optional part of the ScriptHookV distribution
			}
			return fmt.Errorf("%s: %w (see client-dist/README.md)", src, err)
		}
		dst := filepath.Join(gameDir, f)
		entry := installed{Name: f}
		if old, err := os.ReadFile(dst); err == nil {
			if bytes.Equal(old, data) {
				// Identical file already present (e.g. the user's own ScriptHookV): leave it alone.
				continue
			}
			entry.Backup = f + ".gomp-backup"
			if err := os.Rename(dst, filepath.Join(gameDir, entry.Backup)); err != nil {
				return err
			}
		}
		m.Files = append(m.Files, entry)
		if err := save(); err != nil {
			return err
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return err
		}
	}
	cfg := map[string]any{"server": server, "name": name, "interpolationDelayMs": 100}
	return writeJSON(filepath.Join(gameDir, "gomp.json"), cfg)
}

func cleanup(gameDir string) error {
	path := filepath.Join(gameDir, manifestName)
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	keepLog(gameDir)
	for _, f := range m.Files {
		dst := filepath.Join(gameDir, f.Name)
		if err := removeRetry(dst); err != nil {
			return err
		}
		if f.Backup != "" {
			if err := os.Rename(filepath.Join(gameDir, f.Backup), dst); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	for _, f := range generatedFiles {
		_ = removeRetry(filepath.Join(gameDir, f))
	}
	return os.Remove(path)
}

// keepLog copies the client log next to the launcher before the session files are removed.
func keepLog(gameDir string) {
	data, err := os.ReadFile(filepath.Join(gameDir, "gomp.log"))
	if err != nil {
		return
	}
	exe, _ := os.Executable()
	dir := filepath.Join(filepath.Dir(exe), "logs")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "gomp-client-"+time.Now().Format("20060102-150405")+".log"), data, 0o644)
}

// removeRetry deletes a file, waiting while the exiting game still holds it.
func removeRetry(path string) error {
	deadline := time.Now().Add(2 * time.Minute)
	for {
		err := os.Remove(path)
		if err == nil || errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if time.Now().After(deadline) {
			return err
		}
		time.Sleep(time.Second)
	}
}

func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

func findDist() string {
	exe, _ := os.Executable()
	dir := filepath.Dir(exe)
	for _, c := range []string{filepath.Join(dir, "client-dist"), filepath.Join(dir, "..", "client-dist"), "client-dist"} {
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			return c
		}
	}
	return "client-dist"
}

// ------------------------------------------------------------------ game discovery

type gameInstall struct {
	dir    string
	epicID string // namespace:catalogItem:appName, empty if not an Epic install
}

func (g gameInstall) launch() error {
	if g.epicID != "" {
		uri := "com.epicgames.launcher://apps/" + strings.ReplaceAll(g.epicID, ":", "%3A") + "?action=launch&silent=true"
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", uri).Start()
	}
	cmd := exec.Command(filepath.Join(g.dir, "PlayGTAV.exe"))
	cmd.Dir = g.dir
	return cmd.Start()
}

type epicItem struct {
	DisplayName      string
	InstallLocation  string
	LaunchExecutable string
	CatalogNamespace string
	CatalogItemId    string
	AppName          string
}

func findGame(dir string) (gameInstall, error) {
	items, _ := filepath.Glob(filepath.Join(os.Getenv("ProgramData"), "Epic", "EpicGamesLauncher", "Data", "Manifests", "*.item"))
	for _, path := range items {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var it epicItem
		if json.Unmarshal(raw, &it) != nil || !strings.EqualFold(it.LaunchExecutable, "PlayGTAV.exe") {
			continue
		}
		if dir != "" && !strings.EqualFold(filepath.Clean(dir), filepath.Clean(it.InstallLocation)) {
			continue
		}
		return gameInstall{dir: it.InstallLocation, epicID: it.CatalogNamespace + ":" + it.CatalogItemId + ":" + it.AppName}, nil
	}
	if dir == "" {
		return gameInstall{}, errors.New("GTA V not found in the Epic Games Launcher; pass -game <folder>")
	}
	if _, err := os.Stat(filepath.Join(dir, "GTA5.exe")); err != nil {
		return gameInstall{}, fmt.Errorf("%s does not contain GTA5.exe", dir)
	}
	return gameInstall{dir: dir}, nil
}

// ------------------------------------------------------------------ processes

func gameRunning() bool {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if strings.EqualFold(windows.UTF16ToString(e.ExeFile[:]), "GTA5.exe") {
			return true
		}
	}
	return false
}

// waitFor polls cond every two seconds; timeout 0 waits forever. False on timeout or interrupt.
func waitFor(cond func() bool, timeout time.Duration, interrupt <-chan os.Signal) bool {
	var deadline <-chan time.Time
	if timeout > 0 {
		deadline = time.After(timeout)
	}
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for !cond() {
		select {
		case <-tick.C:
		case <-deadline:
			return false
		case <-interrupt:
			return false
		}
	}
	return true
}
