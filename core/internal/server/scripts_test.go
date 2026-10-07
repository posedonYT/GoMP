package server

import (
	"context"
	"strings"
	"testing"
	"time"

	"gomp/core/internal/hostbridge"
	"gomp/tools/bot"
	"gomp/wire/proto"
)

func TestScriptHostLifecycleAndAPI(t *testing.T) {
	fb := newFakeBridge()
	h := newHarness(t, nil, fb)
	const host = 1
	fb.hostUp(host)
	hello := fb.find(t, host, "hello", func(op hostbridge.Op) bool { return op[0] == hostbridge.OpHello })
	if hello[1] != int64(hostbridge.Version) {
		t.Fatalf("hello %v", hello)
	}
	if cfg := hello[2].(map[string]proto.Value); cfg["maxplayers"] != int64(64) {
		t.Fatalf("config in hello: %v", cfg)
	}
	fb.find(t, host, "ready", func(op hostbridge.Op) bool { return op[0] == hostbridge.OpReady })
	fb.cmd(host, hostbridge.Op{hostbridge.CmdLoaded, int64(1)})
	h.subscribe(fb, host, "playerJoin", "playerReady", "playerChat", "playerCommand", "clientPing", "playerQuit",
		"playerDeath", "playerEnterVehicle", "proc:getMoney")

	b := h.bot("Scripted")
	create := fb.find(t, host, "player create", func(op hostbridge.Op) bool {
		return op[0] == hostbridge.OpCreate && op[1] == int64(proto.EntityPlayer)
	})
	pid, gen := create[2].(int64), create[3].(int64)
	state := create[4].(map[string]proto.Value)
	if state["name"] != "Scripted" || state["serial"] != "serial-Scripted" || state["health"] != int64(100) {
		t.Fatalf("player state %v", state)
	}
	join := fb.find(t, host, "playerJoin", isEvent("playerJoin"))
	if ref := join[2].([]proto.Value)[0].(proto.EntityRef); ref.ID != uint16(pid) || ref.Type != proto.EntityPlayer {
		t.Fatalf("playerJoin args %v", join)
	}
	b.Ready()
	fb.find(t, host, "playerReady", isEvent("playerReady"))
	never(t, 300*time.Millisecond, "core auto-spawned although scripts are active", func() bool {
		s := false
		b.View(func(x *bot.Bot) { s = x.Spawned })
		return s
	})
	player := func(method string, a ...proto.Value) hostbridge.Op {
		return hostbridge.Op{hostbridge.CmdCall, int64(proto.EntityPlayer), pid, gen, method, a}
	}
	spawnAt := proto.Vec3{X: -425, Y: 1123, Z: 325}
	fb.cmd(host, player("spawn", spawnAt, 90.0))
	eventually(t, 2*time.Second, "spawned by script", func() bool {
		ok := false
		b.View(func(x *bot.Bot) { ok = x.Spawned && x.Pos == spawnAt && x.Heading == 90 })
		return ok
	})

	// Chat, commands and remote events.
	b.Say("hello world")
	chat := fb.find(t, host, "playerChat", isEvent("playerChat"))
	if chat[2].([]proto.Value)[1] != "hello world" {
		t.Fatalf("chat %v", chat)
	}
	b.Say("/veh adder")
	cmd := fb.find(t, host, "playerCommand", isEvent("playerCommand"))
	if cmd[2].([]proto.Value)[1] != "veh adder" {
		t.Fatalf("command %v", cmd)
	}
	b.CallRemote("playerDeath", int64(0)) // reserved: must not reach scripts
	b.CallRemote("clientPing", int64(1), "x")
	ping := fb.find(t, host, "clientPing", func(op hostbridge.Op) bool {
		if op[0] == hostbridge.OpEvent && op[1] == "playerDeath" {
			t.Fatal("client faked playerDeath")
		}
		return op[0] == hostbridge.OpEvent && op[1] == "clientPing"
	})
	if a := ping[2].([]proto.Value); len(a) != 3 || a[1] != int64(1) || a[2] != "x" {
		t.Fatalf("remote event args %v", a)
	}

	// Entity creation by script, with cosmetic props, then putIntoVehicle.
	fb.cmd(host, hostbridge.Op{hostbridge.CmdCreate, int64(proto.EntityVehicle), int64(5), map[string]proto.Value{
		"model": int64(proto.Joaat("adder")), "pos": proto.Vec3{X: -420, Y: 1123, Z: 325}, "heading": 45.0,
		"props": map[string]proto.Value{"32": "GOMP 01"}, "engine": true,
	}})
	eventually(t, 2*time.Second, "script vehicle streamed", func() bool {
		ok := false
		b.View(func(x *bot.Bot) {
			if v := x.Vehicles[5]; v != nil {
				ok = v.Props[proto.PropNumberPlate] == "GOMP 01" && v.Engine
			}
		})
		return ok
	})
	fb.cmd(host, player("putIntoVehicle", proto.EntityRef{Type: proto.EntityVehicle, ID: 5}, int64(-1)))
	eventually(t, 2*time.Second, "in script vehicle", func() bool {
		var v uint16
		b.View(func(x *bot.Bot) { v = x.VehicleID })
		return v == 5
	})
	enter := fb.find(t, host, "playerEnterVehicle", isEvent("playerEnterVehicle"))
	if a := enter[2].([]proto.Value); a[1] != (proto.EntityRef{Type: proto.EntityVehicle, ID: 5}) || a[2] != int64(0) {
		t.Fatalf("enter args %v", a)
	}

	// player.call, setters with mirror echo, shared data.
	fb.cmd(host, player("call", "client:notify", []proto.Value{"hi", int64(2)}))
	fb.cmd(host, hostbridge.Op{hostbridge.CmdSet, int64(proto.EntityPlayer), pid, gen, "health", int64(50)})
	fb.cmd(host, hostbridge.Op{hostbridge.CmdCall, int64(proto.EntityVehicle), int64(5), int64(0), "setVariable", []proto.Value{"fuel", 50.5}})
	eventually(t, 2*time.Second, "event, health and shared data", func() bool {
		ok := false
		b.View(func(x *bot.Bot) {
			gotEvent := len(x.Events) > 0 && x.Events[0].Name == "client:notify" && x.Events[0].Args[1] == int64(2)
			v := x.Vehicles[5]
			ok = gotEvent && x.Health == 50 && v != nil && v.Shared["fuel"] == 50.5
		})
		return ok
	})
	fb.find(t, host, "health mirrored back", func(op hostbridge.Op) bool {
		if op[0] != hostbridge.OpUpdate || op[1] != int64(proto.EntityPlayer) {
			return false
		}
		return op[3].(map[string]proto.Value)["health"] == int64(50)
	})

	// Client → server procedure.
	go func() {
		op := fb.find(t, host, "procReq", func(op hostbridge.Op) bool { return op[0] == hostbridge.OpProcReq })
		fb.cmd(host, hostbridge.Op{hostbridge.CmdProcResult, op[1], true, int64(1500)})
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	res, err := b.CallProc(ctx, "getMoney")
	if err != nil || res != int64(1500) {
		t.Fatalf("proc result %v %v", res, err)
	}
	if _, err := b.CallProc(ctx, "noSuchProc"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("unknown proc: %v", err)
	}

	// Server → client procedure (player.callProc).
	b.View(func(x *bot.Bot) {
		x.Procs["clientInfo"] = func(a []proto.Value) (proto.Value, error) { return "gta5-" + a[0].(string), nil }
	})
	fb.cmd(host, hostbridge.Op{hostbridge.CmdProcCall, int64(77), pid, gen, "clientInfo", []proto.Value{"legacy"}})
	pr := fb.find(t, host, "procRes", func(op hostbridge.Op) bool { return op[0] == hostbridge.OpProcRes && op[1] == int64(77) })
	if pr[2] != true || pr[3] != "gta5-legacy" {
		t.Fatalf("callProc result %v", pr)
	}

	// Errors are reported, not fatal.
	fb.cmd(host, hostbridge.Op{hostbridge.CmdSet, int64(proto.EntityPlayer), pid, gen, "bogus", int64(1)})
	fb.find(t, host, "error op", func(op hostbridge.Op) bool {
		return op[0] == hostbridge.OpError && strings.Contains(op[1].(string), "bogus")
	})
	// Commands on players that already left are ignored silently (RAGE.MP behaviour).
	fb.cmd(host, hostbridge.Op{hostbridge.CmdSet, int64(proto.EntityPlayer), pid, gen + 1, "health", int64(10)})
	fb.cmd(host, hostbridge.Op{"set", "garbage"})
	fb.find(t, host, "garbage error", func(op hostbridge.Op) bool {
		if op[0] == hostbridge.OpError && strings.Contains(op[1].(string), "stale") {
			t.Fatal("stale reference reported as an error")
		}
		return op[0] == hostbridge.OpError
	})
	h.exec(func(s *Server) {
		if p := s.world.Players.Get(uint16(pid)); p.Health != 50 {
			t.Errorf("stale reference changed health to %d", p.Health)
		}
	})

	// A crashed host loses everything it created (like a stopped resource).
	fb.hostDown(host)
	eventually(t, 2*time.Second, "script vehicle removed after host crash", func() bool {
		gone := false
		b.View(func(x *bot.Bot) { _, has := x.Vehicles[5]; gone = !has && x.VehicleID == proto.NoID })
		return gone
	})
	// The player is untouched and the core keeps running.
	if closed, _ := b.Closed(); closed {
		t.Fatal("player disconnected by host crash")
	}
	h.exec(func(s *Server) {
		if s.world.Vehicles.Len() != 0 || s.world.Players.Len() != 1 {
			t.Errorf("world after host crash: %d vehicles, %d players", s.world.Vehicles.Len(), s.world.Players.Len())
		}
	})
}

func TestHostRestartReceivesSnapshot(t *testing.T) {
	fb := newFakeBridge()
	h := newHarness(t, nil, fb)
	b := h.bot("Early")
	b.Ready()
	eventually(t, 2*time.Second, "auto-spawn without host", func() bool {
		ok := false
		b.View(func(x *bot.Bot) { ok = x.Spawned })
		return ok
	})
	fb.hostUp(9)
	fb.find(t, 9, "hello", func(op hostbridge.Op) bool { return op[0] == hostbridge.OpHello })
	create := fb.find(t, 9, "existing player in snapshot", func(op hostbridge.Op) bool { return op[0] == hostbridge.OpCreate })
	if st := create[4].(map[string]proto.Value); st["name"] != "Early" || st["spawned"] != true {
		t.Fatalf("snapshot state %v", st)
	}
	fb.find(t, 9, "ready", func(op hostbridge.Op) bool { return op[0] == hostbridge.OpReady })
}

func TestEventOrderingStateBeforeEvent(t *testing.T) {
	fb := newFakeBridge()
	h := newHarness(t, nil, fb)
	fb.hostUp(1)
	fb.find(t, 1, "ready", func(op hostbridge.Op) bool { return op[0] == hostbridge.OpReady })
	h.subscribe(fb, 1, "playerDamage", "playerDeath")
	v := h.bot("Victim")
	v.Ready()
	vid := botID(v)
	h.exec(func(s *Server) { s.spawnPlayer(s.world.Players.Get(vid), proto.Vec3{X: 10, Y: 10, Z: 10}, 0) })
	eventually(t, 2*time.Second, "spawned", func() bool {
		ok := false
		v.View(func(x *bot.Bot) { ok = x.Spawned })
		return ok
	})
	v.SelfDamage(proto.CauseFall, 100, 0)
	// The update with health 0 must precede playerDeath in the op stream.
	sawHealth := false
	fb.find(t, 1, "death", func(op hostbridge.Op) bool {
		if op[0] == hostbridge.OpUpdate {
			if st := op[3].(map[string]proto.Value); st["health"] == int64(0) {
				sawHealth = true
			}
		}
		return op[0] == hostbridge.OpEvent && op[1] == "playerDeath"
	})
	if !sawHealth {
		t.Fatal("playerDeath delivered before the health update")
	}
}
