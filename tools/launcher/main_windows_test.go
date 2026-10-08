package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return string(b)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// A dist folder with the session files (no optional ones) and a client data folder.
func newDist(t *testing.T) string {
	dist := t.TempDir()
	for _, f := range []string{"ScriptHookV.dll", "dinput8.dll", "args.txt", "gomp.asi"} {
		writeFile(t, filepath.Join(dist, f), "gomp "+f)
	}
	writeFile(t, filepath.Join(dist, "gomp", "icons", "medkit.png"), "png")
	return dist
}

func TestSessionLeavesTheGameFolderAsItWas(t *testing.T) {
	game, dist := t.TempDir(), newDist(t)
	// The user's own ScriptHookV with its config, and an identical asi loader.
	writeFile(t, filepath.Join(game, "ScriptHookV.dll"), "user's scripthook")
	writeFile(t, filepath.Join(game, "RageOpenV.ini"), "user's settings")
	writeFile(t, filepath.Join(game, "dinput8.dll"), "gomp dinput8.dll")

	if err := install(game, dist, "127.0.0.1:22005", "Tester"); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(game, "ScriptHookV.dll")); got != "gomp ScriptHookV.dll" {
		t.Fatalf("session ScriptHookV.dll = %q", got)
	}
	if exists(filepath.Join(game, "RageOpenV.ini")) {
		t.Fatal("the user's RageOpenV.ini must be set aside during the session")
	}
	if !exists(filepath.Join(game, "gomp", "icons", "medkit.png")) || !exists(filepath.Join(game, "gomp.json")) {
		t.Fatal("client data and config are installed")
	}

	// The session writes its own logs and config.
	writeFile(t, filepath.Join(game, "RageOpenV.ini"), "session settings")
	writeFile(t, filepath.Join(game, "gomp.log"), "client log")
	writeFile(t, filepath.Join(game, "ScriptHookV.log"), "shv log")

	if err := cleanup(game); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(game, "ScriptHookV.dll")); got != "user's scripthook" {
		t.Fatalf("restored ScriptHookV.dll = %q", got)
	}
	if got := readFile(t, filepath.Join(game, "RageOpenV.ini")); got != "user's settings" {
		t.Fatalf("restored RageOpenV.ini = %q", got)
	}
	if got := readFile(t, filepath.Join(game, "dinput8.dll")); got != "gomp dinput8.dll" {
		t.Fatalf("an identical file is left alone, got %q", got)
	}
	for _, f := range []string{"gomp.asi", "args.txt", "gomp.json", "gomp.log", "ScriptHookV.log", "gomp", manifestName} {
		if exists(filepath.Join(game, f)) {
			t.Errorf("%s left in the game folder", f)
		}
	}
	for _, f := range []string{"ScriptHookV.dll.gomp-backup", "RageOpenV.ini.gomp-backup"} {
		if exists(filepath.Join(game, f)) {
			t.Errorf("%s left in the game folder", f)
		}
	}
}

func TestCleanupWithoutSessionIsHarmless(t *testing.T) {
	game := t.TempDir()
	writeFile(t, filepath.Join(game, "gomp.log"), "someone's file")
	if err := cleanup(game); err != nil {
		t.Fatal(err)
	}
	if !exists(filepath.Join(game, "gomp.log")) {
		t.Fatal("without a session manifest nothing is removed")
	}
}

func TestInstallFailsWithoutTheClient(t *testing.T) {
	game, dist := t.TempDir(), newDist(t)
	if err := os.Remove(filepath.Join(dist, "gomp.asi")); err != nil {
		t.Fatal(err)
	}
	if err := install(game, dist, "127.0.0.1:22005", "Tester"); err == nil {
		t.Fatal("install must fail without gomp.asi")
	}
	if err := cleanup(game); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"ScriptHookV.dll", "dinput8.dll", manifestName} {
		if exists(filepath.Join(game, f)) {
			t.Errorf("%s left after a failed install", f)
		}
	}
}
