// Command mapcheck checks that a GoMP server streams the objects of a map made
// in GoMP Studio (server-files/maps/<name>.json): a headless bot joins as a
// local guest, goes to the objects with /tp and compares what the server sends
// (model, position, rotation) with the map file.
//
//	go run ./tools/mapcheck -map server-files/maps/square.json
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"strings"
	"time"

	"gomp/tools/bot"
	"gomp/wire/proto"
)

type mapObject struct {
	ID        string          `json:"id"`
	Model     json.RawMessage `json:"model"`
	Pos       [3]float64      `json:"pos"`
	Rot       [3]float64      `json:"rot"`
	Dimension uint32          `json:"dimension"`
	hash      uint32
}

func main() {
	server := flag.String("server", "127.0.0.1:22005", "server address")
	file := flag.String("map", "", "map file (server-files/maps/<name>.json)")
	wait := flag.Duration("wait", 3*time.Second, "how long to wait at each place for the objects")
	flag.Parse()
	objs, err := load(*file)
	if err != nil {
		fmt.Fprintln(os.Stderr, "mapcheck:", err)
		os.Exit(2)
	}
	missing, err := check(*server, objs, *wait)
	if err != nil {
		fmt.Fprintln(os.Stderr, "mapcheck:", err)
		os.Exit(2)
	}
	if len(missing) > 0 {
		fmt.Printf("FAIL: %d of %d objects not streamed as in the map:\n", len(missing), len(objs))
		for _, m := range missing {
			fmt.Println("  " + m)
		}
		os.Exit(1)
	}
	fmt.Printf("OK: the server streams all %d objects as in the map\n", len(objs))
}

func load(path string) ([]*mapObject, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Enabled *bool        `json:"enabled"`
		Objects []*mapObject `json:"objects"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	if doc.Enabled != nil && !*doc.Enabled {
		return nil, fmt.Errorf("%s is switched off (enabled: false)", path)
	}
	var out []*mapObject
	for _, o := range doc.Objects {
		var name string
		var num uint32
		switch {
		case json.Unmarshal(o.Model, &name) == nil:
			o.hash = proto.Joaat(strings.ToLower(strings.TrimSpace(name)))
		case json.Unmarshal(o.Model, &num) == nil:
			o.hash = num
		default:
			return nil, fmt.Errorf("object %s: model %s", o.ID, o.Model)
		}
		if o.Dimension != 0 {
			fmt.Printf("skipped %s: dimension %d (the bot is in dimension 0)\n", o.ID, o.Dimension)
			continue
		}
		out = append(out, o)
	}
	return out, nil
}

func check(server string, objs []*mapObject, wait time.Duration) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute+time.Duration(len(objs))*wait)
	defer cancel()
	b, err := bot.Connect(ctx, bot.Config{Server: server, Name: "mapcheck", Serial: "cli-mapcheck"})
	if err != nil {
		return nil, err
	}
	defer b.Close()
	b.Ready()
	step := func(d time.Duration) {
		end := time.Now().Add(d)
		for time.Now().Before(end) {
			now := time.Now()
			b.Pump(now)
			b.SendPedSync(now)
			b.Flush(now)
			time.Sleep(33 * time.Millisecond)
		}
	}
	for spawned := false; !spawned; {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("the bot was not spawned (is the server running?)")
		}
		step(100 * time.Millisecond)
		b.View(func(x *bot.Bot) { spawned = x.Spawned })
	}

	found := map[*mapObject]bool{}
	for _, o := range objs {
		if found[o] {
			continue
		}
		b.Say(fmt.Sprintf("/tp %.2f %.2f %.2f", o.Pos[0], o.Pos[1], o.Pos[2]+1))
		step(wait)
		b.View(func(x *bot.Bot) {
			for _, other := range objs {
				if !found[other] && matches(other, x.Others) {
					found[other] = true
				}
			}
		})
	}
	var missing []string
	for _, o := range objs {
		if !found[o] {
			missing = append(missing, fmt.Sprintf("%s (%s at %.2f %.2f %.2f)", o.ID, string(o.Model), o.Pos[0], o.Pos[1], o.Pos[2]))
		}
	}
	return missing, nil
}

// An object the server sent with this model, place and rotation.
func matches(o *mapObject, others map[proto.EntityRef]*proto.EntityCreate) bool {
	for ref, c := range others {
		if ref.Type != proto.EntityObject || c.Model != o.hash {
			continue
		}
		p := [3]float64{float64(c.Pos.X), float64(c.Pos.Y), float64(c.Pos.Z)}
		r := [3]float64{float64(c.Rot.X), float64(c.Rot.Y), float64(c.Rot.Z)}
		if near(p, o.Pos, 0.01) && near(r, o.Rot, 0.01) {
			return true
		}
	}
	return false
}

func near(a, b [3]float64, eps float64) bool {
	for i := range a {
		if math.Abs(a[i]-b[i]) > eps {
			return false
		}
	}
	return true
}
