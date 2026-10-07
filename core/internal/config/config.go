// Package config loads conf.json. All RAGE.MP keys are accepted with their
// RAGE meaning; GoMP-specific settings live under the "gomp" key.
package config

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
)

// Config is the effective server configuration.
type Config struct {
	// RAGE.MP keys.
	MaxPlayers                       int     `rage:"maxplayers"`
	Name                             string  `rage:"name"`
	GameMode                         string  `rage:"gamemode"`
	StreamDistance                   float64 `rage:"stream-distance"`
	Announce                         bool    `rage:"announce"`
	Bind                             string  `rage:"bind"`
	Port                             int     `rage:"port"`
	Encryption                       bool    `rage:"encryption"`
	SyncRate                         int     `rage:"sync-rate"`
	CSharp                           string  `rage:"csharp"`
	EnableNodeJS                     bool    `rage:"enable-nodejs"`
	URL                              string  `rage:"url"`
	Language                         string  `rage:"language"`
	MaxPing                          int     `rage:"max-ping"`
	MinFPS                           int     `rage:"min-fps"`
	MaxPacketLoss                    float64 `rage:"max-packet-loss"`
	DisallowMultipleConnectionsPerIP bool    `rage:"disallow-multiple-connections-per-ip"`
	LimitTimeOfConnectionsPerIP      int     `rage:"limit-time-of-connections-per-ip"`
	AllowCEFDebugging                bool    `rage:"allow-cef-debugging"`
	EnableHTTPSecurity               bool    `rage:"enable-http-security"`
	VoiceChat                        bool    `rage:"voice-chat"`
	AllowVoiceChatInput              int     `rage:"allow-voice-chat-input"`
	VoiceChatSampleRate              int     `rage:"voice-chat-sample-rate"`
	FastDLHost                       string  `rage:"fastdl-host"`
	CreateFastDLSnapshot             bool    `rage:"create-fastdl-snapshot"`
	ResourceScanThreadLimit          int     `rage:"resource-scan-thread-limit"`

	// GoMP extensions ("gomp" object).
	GoMP GoMP

	// Raw holds every top-level key as parsed, exposed to scripts as mp.config.
	Raw map[string]any
	// Warnings lists unknown or unsupported keys.
	Warnings []string
}

// GoMP holds settings that RAGE.MP does not have.
type GoMP struct {
	TickRate            int     `gomp:"tick-rate"`
	StreamUpdateRate    int     `gomp:"stream-update-rate"`
	MaxStreamedPlayers  int     `gomp:"max-streamed-players"`
	MaxStreamedVehicles int     `gomp:"max-streamed-vehicles"`
	MaxStreamedObjects  int     `gomp:"max-streamed-objects"`
	MaxStreamedOther    int     `gomp:"max-streamed-other"`
	BandwidthPerPlayer  int     `gomp:"bandwidth-per-player"`
	ConnectionTimeoutMs int     `gomp:"connection-timeout-ms"`
	AutoSpawn           bool    `gomp:"auto-spawn"`
	SpawnX              float64 `gomp:"spawn-x"`
	SpawnY              float64 `gomp:"spawn-y"`
	SpawnZ              float64 `gomp:"spawn-z"`
	SpawnHeading        float64 `gomp:"spawn-heading"`
	AdminBind           string  `gomp:"admin-bind"`
	NodePath            string  `gomp:"node-path"`
	NodeArgs            string  `gomp:"node-args"`
	HostRestart         bool    `gomp:"host-restart"`
	HostWatchdogMs      int     `gomp:"host-watchdog-ms"`
	HostScript          string  `gomp:"host-script"`
	PackagesDir         string  `gomp:"packages-dir"`
	ClientPackagesDir   string  `gomp:"client-packages-dir"`
	WeaponsFile         string  `gomp:"weapons-file"`
	LogLevel            string  `gomp:"log-level"`

	// Combat
	HeadshotMultiplier float64 `gomp:"headshot-multiplier"`
	LimbMultiplier     float64 `gomp:"limb-multiplier"`

	// Anti-cheat
	AnticheatEnabled    bool    `gomp:"anticheat"`
	MaxFootSpeed        float64 `gomp:"max-foot-speed"`
	MaxVehicleSpeed     float64 `gomp:"max-vehicle-speed"`
	SpeedTolerance      float64 `gomp:"speed-tolerance"`
	MaxViolations       int     `gomp:"max-violations"`
	KickOnViolations    bool    `gomp:"kick-on-violations"`
	MaxSelfHealthPerSec float64 `gomp:"max-environment-damage-per-sec"`
}

// Default returns the configuration used when keys are missing.
func Default() Config {
	return Config{
		MaxPlayers:     100,
		Name:           "GoMP Server",
		GameMode:       "freeroam",
		StreamDistance: 500,
		Bind:           "0.0.0.0",
		Port:           22005,
		SyncRate:       40,
		CSharp:         "disabled",
		EnableNodeJS:   true,
		Language:       "en",
		MaxPing:        0,
		MaxPacketLoss:  0,
		GoMP: GoMP{
			TickRate:            30,
			StreamUpdateRate:    4,
			MaxStreamedPlayers:  128,
			MaxStreamedVehicles: 128,
			MaxStreamedObjects:  256,
			MaxStreamedOther:    256,
			BandwidthPerPlayer:  128 * 1024,
			ConnectionTimeoutMs: 10000,
			AutoSpawn:           true,
			SpawnX:              -425.517,
			SpawnY:              1123.620,
			SpawnZ:              325.8544,
			NodePath:            "node",
			HostRestart:         true,
			HostWatchdogMs:      10000,
			PackagesDir:         "packages",
			ClientPackagesDir:   "client_packages",
			LogLevel:            "info",
			HeadshotMultiplier:  2.0,
			LimbMultiplier:      0.75,
			AnticheatEnabled:    true,
			MaxFootSpeed:        12,
			MaxVehicleSpeed:     0, // 0 = per-model limits from gamedata
			SpeedTolerance:      1.25,
			MaxViolations:       5,
			KickOnViolations:    false,
			MaxSelfHealthPerSec: 120,
		},
	}
}

// Load reads path. A missing file yields the defaults.
func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			c := Default()
			c.Raw = c.rawMap()
			return c, nil
		}
		return Config{}, err
	}
	return Parse(data)
}

// Parse decodes conf.json content leniently: numbers and booleans may be
// given as strings, as many RAGE.MP configs in the wild do.
func Parse(data []byte) (Config, error) {
	var raw map[string]any
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return Config{}, fmt.Errorf("conf.json: %w", err)
	}
	c := Default()
	if err := applyRage(&c, raw); err != nil {
		return Config{}, err
	}
	if g, ok := raw["gomp"]; ok {
		gm, ok := g.(map[string]any)
		if !ok {
			return Config{}, fmt.Errorf("conf.json: \"gomp\" must be an object")
		}
		if err := applyGoMP(&c.GoMP, gm, &c.Warnings); err != nil {
			return Config{}, err
		}
	}
	if err := c.Validate(); err != nil {
		return Config{}, err
	}
	c.Raw = c.rawMap()
	for k, v := range raw {
		if k == "gomp" {
			continue
		}
		if _, known := c.Raw[k]; !known {
			c.Raw[k] = normalizeJSON(v)
		}
	}
	return c, nil
}

// unsupported keys are accepted but have no effect yet.
var unsupported = map[string]string{
	"announce":            "GoMP has no public master list; ignored",
	"voice-chat":          "voice chat is not implemented yet",
	"csharp":              "the C# host arrives in phase 3",
	"allow-cef-debugging": "CEF arrives in phase 2",
}

func applyRage(c *Config, raw map[string]any) error {
	fields := rageFields(c)
	keys := make([]string, 0, len(raw))
	for k := range raw {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if k == "gomp" {
			continue
		}
		f, ok := fields[k]
		if !ok {
			c.Warnings = append(c.Warnings, fmt.Sprintf("unknown key %q kept in mp.config", k))
			continue
		}
		if err := f(raw[k]); err != nil {
			return fmt.Errorf("conf.json: %q: %w", k, err)
		}
		if msg, ok := unsupported[k]; ok && truthy(raw[k]) {
			c.Warnings = append(c.Warnings, fmt.Sprintf("%q: %s", k, msg))
		}
	}
	return nil
}

func rageFields(c *Config) map[string]func(any) error {
	return map[string]func(any) error{
		"maxplayers":                           intSetter(&c.MaxPlayers),
		"name":                                 strSetter(&c.Name),
		"gamemode":                             strSetter(&c.GameMode),
		"stream-distance":                      floatSetter(&c.StreamDistance),
		"announce":                             boolSetter(&c.Announce),
		"bind":                                 strSetter(&c.Bind),
		"port":                                 intSetter(&c.Port),
		"encryption":                           boolSetter(&c.Encryption),
		"sync-rate":                            intSetter(&c.SyncRate),
		"csharp":                               strSetter(&c.CSharp),
		"enable-nodejs":                        boolSetter(&c.EnableNodeJS),
		"url":                                  strSetter(&c.URL),
		"language":                             strSetter(&c.Language),
		"max-ping":                             intSetter(&c.MaxPing),
		"min-fps":                              intSetter(&c.MinFPS),
		"max-packet-loss":                      floatSetter(&c.MaxPacketLoss),
		"disallow-multiple-connections-per-ip": boolSetter(&c.DisallowMultipleConnectionsPerIP),
		"limit-time-of-connections-per-ip":     intSetter(&c.LimitTimeOfConnectionsPerIP),
		"allow-cef-debugging":                  boolSetter(&c.AllowCEFDebugging),
		"enable-http-security":                 boolSetter(&c.EnableHTTPSecurity),
		"voice-chat":                           boolSetter(&c.VoiceChat),
		"allow-voice-chat-input":               intSetter(&c.AllowVoiceChatInput),
		"voice-chat-sample-rate":               intSetter(&c.VoiceChatSampleRate),
		"fastdl-host":                          strSetter(&c.FastDLHost),
		"create-fastdl-snapshot":               boolSetter(&c.CreateFastDLSnapshot),
		"resource-scan-thread-limit":           intSetter(&c.ResourceScanThreadLimit),
	}
}

func applyGoMP(g *GoMP, raw map[string]any, warnings *[]string) error {
	fields := map[string]func(any) error{
		"tick-rate":                      intSetter(&g.TickRate),
		"stream-update-rate":             intSetter(&g.StreamUpdateRate),
		"max-streamed-players":           intSetter(&g.MaxStreamedPlayers),
		"max-streamed-vehicles":          intSetter(&g.MaxStreamedVehicles),
		"max-streamed-objects":           intSetter(&g.MaxStreamedObjects),
		"max-streamed-other":             intSetter(&g.MaxStreamedOther),
		"bandwidth-per-player":           intSetter(&g.BandwidthPerPlayer),
		"connection-timeout-ms":          intSetter(&g.ConnectionTimeoutMs),
		"auto-spawn":                     boolSetter(&g.AutoSpawn),
		"spawn-x":                        floatSetter(&g.SpawnX),
		"spawn-y":                        floatSetter(&g.SpawnY),
		"spawn-z":                        floatSetter(&g.SpawnZ),
		"spawn-heading":                  floatSetter(&g.SpawnHeading),
		"admin-bind":                     strSetter(&g.AdminBind),
		"node-path":                      strSetter(&g.NodePath),
		"node-args":                      strSetter(&g.NodeArgs),
		"host-restart":                   boolSetter(&g.HostRestart),
		"host-watchdog-ms":               intSetter(&g.HostWatchdogMs),
		"host-script":                    strSetter(&g.HostScript),
		"packages-dir":                   strSetter(&g.PackagesDir),
		"client-packages-dir":            strSetter(&g.ClientPackagesDir),
		"weapons-file":                   strSetter(&g.WeaponsFile),
		"log-level":                      strSetter(&g.LogLevel),
		"headshot-multiplier":            floatSetter(&g.HeadshotMultiplier),
		"limb-multiplier":                floatSetter(&g.LimbMultiplier),
		"anticheat":                      boolSetter(&g.AnticheatEnabled),
		"max-foot-speed":                 floatSetter(&g.MaxFootSpeed),
		"max-vehicle-speed":              floatSetter(&g.MaxVehicleSpeed),
		"speed-tolerance":                floatSetter(&g.SpeedTolerance),
		"max-violations":                 intSetter(&g.MaxViolations),
		"kick-on-violations":             boolSetter(&g.KickOnViolations),
		"max-environment-damage-per-sec": floatSetter(&g.MaxSelfHealthPerSec),
	}
	keys := make([]string, 0, len(raw))
	for k := range raw {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		f, ok := fields[k]
		if !ok {
			*warnings = append(*warnings, fmt.Sprintf("unknown key gomp.%s ignored", k))
			continue
		}
		if err := f(raw[k]); err != nil {
			return fmt.Errorf("conf.json: gomp.%s: %w", k, err)
		}
	}
	return nil
}

// Validate checks ranges.
func (c *Config) Validate() error {
	switch {
	case c.MaxPlayers < 1 || c.MaxPlayers > 65000:
		return fmt.Errorf("maxplayers must be in 1..65000, got %d", c.MaxPlayers)
	case c.Port < 1 || c.Port > 65534:
		return fmt.Errorf("port must be in 1..65534, got %d", c.Port)
	case c.StreamDistance <= 0 || c.StreamDistance > 10000:
		return fmt.Errorf("stream-distance must be in (0, 10000], got %v", c.StreamDistance)
	case c.GoMP.TickRate < 5 || c.GoMP.TickRate > 128:
		return fmt.Errorf("gomp.tick-rate must be in 5..128, got %d", c.GoMP.TickRate)
	case c.GoMP.StreamUpdateRate < 1 || c.GoMP.StreamUpdateRate > c.GoMP.TickRate:
		return fmt.Errorf("gomp.stream-update-rate must be in 1..tick-rate, got %d", c.GoMP.StreamUpdateRate)
	case c.GoMP.BandwidthPerPlayer < 8*1024:
		return fmt.Errorf("gomp.bandwidth-per-player must be >= 8192, got %d", c.GoMP.BandwidthPerPlayer)
	case c.GoMP.MaxStreamedPlayers < 1 || c.GoMP.MaxStreamedVehicles < 1:
		return fmt.Errorf("gomp.max-streamed-* must be positive")
	case c.GoMP.SpeedTolerance < 1:
		return fmt.Errorf("gomp.speed-tolerance must be >= 1")
	}
	return nil
}

// ListenAddr returns bind:port.
func (c *Config) ListenAddr() string {
	return fmt.Sprintf("%s:%d", c.Bind, c.Port)
}

// rawMap exposes the effective RAGE keys with their RAGE names.
func (c *Config) rawMap() map[string]any {
	return map[string]any{
		"maxplayers":                           c.MaxPlayers,
		"name":                                 c.Name,
		"gamemode":                             c.GameMode,
		"stream-distance":                      c.StreamDistance,
		"announce":                             c.Announce,
		"bind":                                 c.Bind,
		"port":                                 c.Port,
		"encryption":                           c.Encryption,
		"sync-rate":                            c.SyncRate,
		"csharp":                               c.CSharp,
		"enable-nodejs":                        c.EnableNodeJS,
		"url":                                  c.URL,
		"language":                             c.Language,
		"max-ping":                             c.MaxPing,
		"min-fps":                              c.MinFPS,
		"max-packet-loss":                      c.MaxPacketLoss,
		"disallow-multiple-connections-per-ip": c.DisallowMultipleConnectionsPerIP,
		"limit-time-of-connections-per-ip":     c.LimitTimeOfConnectionsPerIP,
		"allow-cef-debugging":                  c.AllowCEFDebugging,
		"enable-http-security":                 c.EnableHTTPSecurity,
		"voice-chat":                           c.VoiceChat,
		"allow-voice-chat-input":               c.AllowVoiceChatInput,
		"voice-chat-sample-rate":               c.VoiceChatSampleRate,
		"fastdl-host":                          c.FastDLHost,
		"create-fastdl-snapshot":               c.CreateFastDLSnapshot,
		"resource-scan-thread-limit":           c.ResourceScanThreadLimit,
	}
}

func normalizeJSON(v any) any {
	switch x := v.(type) {
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return i
		}
		f, _ := x.Float64()
		return f
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = normalizeJSON(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = normalizeJSON(e)
		}
		return out
	}
	return v
}

func truthy(v any) bool {
	b, err := toBool(v)
	return err == nil && b
}

func toBool(v any) (bool, error) {
	switch x := v.(type) {
	case bool:
		return x, nil
	case json.Number:
		f, err := x.Float64()
		return f != 0, err
	case string:
		switch strings.ToLower(strings.TrimSpace(x)) {
		case "true", "1", "yes", "on", "enabled":
			return true, nil
		case "false", "0", "no", "off", "disabled", "":
			return false, nil
		}
	}
	return false, fmt.Errorf("expected boolean, got %v", v)
}

func toFloat(v any) (float64, error) {
	switch x := v.(type) {
	case json.Number:
		return x.Float64()
	case string:
		return strconv.ParseFloat(strings.TrimSpace(x), 64)
	case bool:
		if x {
			return 1, nil
		}
		return 0, nil
	}
	return 0, fmt.Errorf("expected number, got %v", v)
}

func boolSetter(p *bool) func(any) error {
	return func(v any) error {
		b, err := toBool(v)
		if err == nil {
			*p = b
		}
		return err
	}
}

func intSetter(p *int) func(any) error {
	return func(v any) error {
		f, err := toFloat(v)
		if err != nil {
			return err
		}
		if f != math.Trunc(f) || math.Abs(f) > math.MaxInt32 {
			return fmt.Errorf("expected integer, got %v", v)
		}
		*p = int(f)
		return nil
	}
}

func floatSetter(p *float64) func(any) error {
	return func(v any) error {
		f, err := toFloat(v)
		if err == nil {
			*p = f
		}
		return err
	}
}

func strSetter(p *string) func(any) error {
	return func(v any) error {
		switch x := v.(type) {
		case string:
			*p = x
		case json.Number:
			*p = x.String()
		case bool:
			*p = strconv.FormatBool(x)
		default:
			return fmt.Errorf("expected string, got %v", v)
		}
		return nil
	}
}
