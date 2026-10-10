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
var sessionFiles = []string{"ScriptHookV.dll", "dinput8.dll", "xinput1_4.dll", "args.txt", "gomp.asi", "RageOpenV.asi"}

// Optional session files: the session works without them.
var optionalFiles = map[string]bool{"xinput1_4.dll": true, "RageOpenV.asi": true}

// Folders the launcher puts into the game folder (icons and other client data).
var sessionDirs = []string{"gomp"}

// Files created by the session itself (logs, config) that are removed afterwards.
var generatedFiles = []string{"gomp.json", "gomp.log", "gomp-boot.log", "ScriptHookV.log", "asiloader.log", "RageOpenV.ini", "RageOpenV.log"}

type installed struct {
	Name   string `json:"name"`
	Backup string `json:"backup,omitempty"` // original file renamed aside
	Dir    bool   `json:"dir,omitempty"`
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
	// The local add-on packs and the packs of the server (a server pack of the same name wins).
	installAddons(game.dir, strings.Join(nonEmpty(filepath.Join(dist, "addons"), serverResources(server)), ";"))
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
	// Logs and configs of the user's own ScriptHookV/RageOpenV setup are set aside
	// so the session's ones can be removed afterwards.
	for _, f := range generatedFiles {
		dst := filepath.Join(gameDir, f)
		if _, err := os.Stat(dst); err != nil {
			continue
		}
		entry := installed{Name: f, Backup: f + ".gomp-backup"}
		if err := os.Rename(dst, filepath.Join(gameDir, entry.Backup)); err != nil {
			return err
		}
		m.Files = append(m.Files, entry)
		if err := save(); err != nil {
			return err
		}
	}
	for _, f := range sessionFiles {
		src := filepath.Join(dist, f)
		data, err := os.ReadFile(src)
		if err != nil {
			if optionalFiles[f] {
				continue
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
	for _, d := range sessionDirs {
		src := filepath.Join(dist, d)
		if st, err := os.Stat(src); err != nil || !st.IsDir() {
			continue
		}
		dst := filepath.Join(gameDir, d)
		entry := installed{Name: d, Dir: true}
		if _, err := os.Stat(dst); err == nil {
			entry.Backup = d + ".gomp-backup"
			if err := os.Rename(dst, filepath.Join(gameDir, entry.Backup)); err != nil {
				return err
			}
		}
		m.Files = append(m.Files, entry)
		if err := save(); err != nil {
			return err
		}
		if err := os.CopyFS(dst, os.DirFS(src)); err != nil {
			return err
		}
	}
	cfg := map[string]any{"server": server, "name": name, "interpolationDelayMs": 100}
	// GOMP_PROBE=houses makes the client check the house interiors and doors (tools/addons/testpack.sh).
	if probe := os.Getenv("GOMP_PROBE"); probe != "" {
		cfg["probe"] = probe
	}
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
	restored := map[string]bool{}
	for _, f := range m.Files {
		dst := filepath.Join(gameDir, f.Name)
		remove := removeRetry
		if f.Dir {
			remove = removeAllRetry
		}
		if err := remove(dst); err != nil {
			return err
		}
		if f.Backup != "" {
			if err := os.Rename(filepath.Join(gameDir, f.Backup), dst); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			restored[f.Name] = true
		}
	}
	for _, f := range generatedFiles {
		if !restored[f] {
			_ = removeRetry(filepath.Join(gameDir, f))
		}
	}
	return os.Remove(path)
}

// nonEmpty drops empty strings.
func nonEmpty(s ...string) []string {
	var out []string
	for _, x := range s {
		if x != "" {
			out = append(out, x)
		}
	}
	return out
}

// installAddons keeps the add-on packs of the folders (separated by ";") in the game's mods
// folder (tools/addons). The mods folder is only read while RageOpenV.asi is in
// the game folder, i.e. during GoMP sessions.
func installAddons(gameDir, packs string) {
	found := false
	for _, d := range strings.Split(packs, ";") {
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			found = true
		}
	}
	if !found {
		return
	}
	exe, _ := os.Executable()
	tool := filepath.Join(filepath.Dir(exe), "addons", "gomp-addons.exe")
	if _, err := os.Stat(tool); err != nil {
		fmt.Println("add-on vehicles skipped:", tool, "not found (build tools/addons)")
		return
	}
	cmd := exec.Command(tool, "install", "--game", gameDir, "--packs", packs)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Println("add-on vehicles not installed:", err)
	}
}

// keepLog copies the session logs next to the launcher before the session files
// are removed: the client log and, for crashes before the client starts, the
// logs of ScriptHookV, the ASI loader and RageOpenV.
func keepLog(gameDir string) {
	exe, _ := os.Executable()
	dir := filepath.Join(filepath.Dir(exe), "logs")
	stamp := time.Now().Format("20060102-150405")
	logs := map[string]string{
		"gomp.log":        "gomp-client-" + stamp + ".log",
		"gomp-boot.log":   "gomp-boot-" + stamp + ".log",
		"ScriptHookV.log": "scripthookv-" + stamp + ".log",
		"asiloader.log":   "asiloader-" + stamp + ".log",
		"RageOpenV.log":   "rageopenv-" + stamp + ".log",
	}
	for src, dst := range logs {
		data, err := os.ReadFile(filepath.Join(gameDir, src))
		if err != nil {
			continue
		}
		_ = os.MkdirAll(dir, 0o755)
		_ = os.WriteFile(filepath.Join(dir, dst), data, 0o644)
	}
}

// removeAllRetry deletes a folder, waiting while the exiting game still holds its files.
func removeAllRetry(path string) error {
	deadline := time.Now().Add(2 * time.Minute)
	for {
		err := os.RemoveAll(path)
		if err == nil || time.Now().After(deadline) {
			return err
		}
		time.Sleep(time.Second)
	}
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
