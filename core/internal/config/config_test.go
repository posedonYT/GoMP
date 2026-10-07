package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A typical RAGE.MP conf.json, including string-typed values seen in the wild.
const rageConf = `{
	"maxplayers": 1000,
	"name": "My RP Server",
	"gamemode": "roleplay",
	"stream-distance": 300.0,
	"announce": false,
	"bind": "127.0.0.1",
	"port": "22005",
	"encryption": "true",
	"csharp": "disabled",
	"enable-nodejs": true,
	"voice-chat": false,
	"fastdl-host": "http://cdn.example",
	"custom-key": {"a": 1, "b": [1, 2.5]},
	"gomp": {
		"tick-rate": 25,
		"max-streamed-players": 100,
		"auto-spawn": false,
		"unknown-gomp": 1
	}
}`

func TestParseRageConf(t *testing.T) {
	c, err := Parse([]byte(rageConf))
	if err != nil {
		t.Fatal(err)
	}
	if c.MaxPlayers != 1000 || c.Name != "My RP Server" || c.GameMode != "roleplay" || c.StreamDistance != 300 {
		t.Fatalf("basic keys: %+v", c)
	}
	if c.Port != 22005 || !c.Encryption || c.Bind != "127.0.0.1" {
		t.Fatalf("lenient parsing: port=%d enc=%v", c.Port, c.Encryption)
	}
	if c.GoMP.TickRate != 25 || c.GoMP.MaxStreamedPlayers != 100 || c.GoMP.AutoSpawn {
		t.Fatalf("gomp section: %+v", c.GoMP)
	}
	if c.GoMP.MaxStreamedVehicles != Default().GoMP.MaxStreamedVehicles {
		t.Fatal("defaults not kept for missing gomp keys")
	}
	if c.Raw["maxplayers"] != 1000 || c.Raw["stream-distance"] != 300.0 {
		t.Fatalf("raw: %#v", c.Raw)
	}
	custom, ok := c.Raw["custom-key"].(map[string]any)
	if !ok || custom["a"] != int64(1) {
		t.Fatalf("custom key not preserved: %#v", c.Raw["custom-key"])
	}
	joined := strings.Join(c.Warnings, "\n")
	for _, want := range []string{"custom-key", "gomp.unknown-gomp"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing warning for %s in:\n%s", want, joined)
		}
	}
	if c.ListenAddr() != "127.0.0.1:22005" {
		t.Fatal(c.ListenAddr())
	}
}

func TestValidation(t *testing.T) {
	bad := []string{
		`{"maxplayers": 0}`,
		`{"port": 70000}`,
		`{"stream-distance": -1}`,
		`{"gomp": {"tick-rate": 1000}}`,
		`{"gomp": {"bandwidth-per-player": 10}}`,
		`{"maxplayers": "lots"}`,
		`{"maxplayers": 1.5}`,
		`{"encryption": "maybe"}`,
		`{"gomp": 5}`,
		`not json`,
	}
	for _, b := range bad {
		if _, err := Parse([]byte(b)); err == nil {
			t.Errorf("accepted %s", b)
		}
	}
}

func TestLoadMissingFileUsesDefaults(t *testing.T) {
	c, err := Load(filepath.Join(t.TempDir(), "nope.json"))
	if err != nil {
		t.Fatal(err)
	}
	if c.MaxPlayers != 100 || c.Port != 22005 || c.Raw["port"] != 22005 {
		t.Fatalf("%+v", c)
	}
}

func TestLoadFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "conf.json")
	if err := os.WriteFile(p, []byte(`{"maxplayers": 50}`), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := Load(p)
	if err != nil || c.MaxPlayers != 50 {
		t.Fatalf("%v %d", err, c.MaxPlayers)
	}
}
