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

// RAGE.MP's own settings GoMP has no use for are kept quietly; csharp switches the .NET host.
func TestRageServerKeysAndCSharp(t *testing.T) {
	c, err := Parse([]byte(`{"csharp": "enabled", "fqdn": "rp.example", "resource-scan-thread-limit": 0, "node-commandline-flags": "--inspect",
		"allow-cef-debugging": false, "gomp": {"dotnet-path": "C:/dotnet/dotnet.exe", "dotnet-host": "host/GoMP.Host.dll"}}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range c.Warnings {
		if strings.Contains(w, "fqdn") || strings.Contains(w, "resource-scan") || strings.Contains(w, "node-commandline") || strings.Contains(w, "csharp") {
			t.Errorf("unexpected warning %q", w)
		}
	}
	if c.Raw["fqdn"] != "rp.example" {
		t.Fatal("the value stays in mp.config")
	}
	if !Enabled(c.CSharp) || c.GoMP.DotnetPath != "C:/dotnet/dotnet.exe" || c.GoMP.DotnetHost != "host/GoMP.Host.dll" {
		t.Fatalf("csharp %q, dotnet %q %q", c.CSharp, c.GoMP.DotnetPath, c.GoMP.DotnetHost)
	}
	for v, want := range map[string]bool{"enabled": true, "true": true, " Enabled ": true, "disabled": false, "": false, "false": false} {
		if Enabled(v) != want {
			t.Errorf("Enabled(%q) = %v", v, !want)
		}
	}
	if Default().GoMP.DotnetPath != "dotnet" {
		t.Fatal("dotnet from PATH by default")
	}
}
