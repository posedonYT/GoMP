package combat

import (
	"testing"
	"time"

	"gomp/core/internal/gamedata"
	"gomp/wire/proto"
)

var cfg = Config{HeadMultiplier: 2, LimbMultiplier: 0.75}

func TestDamagePerHit(t *testing.T) {
	w := gamedata.DefaultWeapons().ByName("pistol")
	if d := DamagePerHit(w, 0, cfg); d != 26 {
		t.Fatalf("torso %d", d)
	}
	if d := DamagePerHit(w, gamedata.BoneSkelHead, cfg); d != 52 {
		t.Fatalf("head %d", d)
	}
	if d := DamagePerHit(w, gamedata.BoneSkelLCalf, cfg); d != 20 { // 19.5 rounds to 20
		t.Fatalf("limb %d", d)
	}
}

func TestApplyArmourFirst(t *testing.T) {
	cases := []struct{ h, a, dmg, wh, wa, hl, al int }{
		{100, 0, 30, 70, 0, 30, 0},
		{100, 50, 30, 100, 20, 0, 30},
		{100, 20, 30, 90, 0, 10, 20},
		{10, 0, 30, 0, 0, 10, 0},
		{50, 50, 0, 50, 50, 0, 0},
		{50, 50, -5, 50, 50, 0, 0},
	}
	for _, c := range cases {
		h, a, hl, al := Apply(c.h, c.a, c.dmg)
		if h != c.wh || a != c.wa || hl != c.hl || al != c.al {
			t.Errorf("Apply(%d,%d,%d) = %d,%d,%d,%d", c.h, c.a, c.dmg, h, a, hl, al)
		}
	}
}

func TestFireRate(t *testing.T) {
	w := gamedata.DefaultWeapons().ByName("pistol") // 150 ms
	var h History
	t0 := time.Unix(0, 0)
	if !h.FireAllowed(w, t0) || !h.FireAllowed(w, t0.Add(150*time.Millisecond)) {
		t.Fatal("normal cadence rejected")
	}
	// Bunched packets: a few close shots are tolerated...
	at := t0.Add(300 * time.Millisecond)
	for i := range 3 {
		if !h.FireAllowed(w, at.Add(time.Duration(i)*time.Millisecond)) {
			t.Fatalf("burst shot %d rejected", i)
		}
	}
	// ...but a sustained rapid-fire hack is not.
	rejected := 0
	for i := range 20 {
		if !h.FireAllowed(w, at.Add(time.Duration(10+i*5)*time.Millisecond)) {
			rejected++
		}
	}
	if rejected < 15 {
		t.Fatalf("rapid fire mostly accepted (%d rejected)", rejected)
	}
}

func TestShotClaims(t *testing.T) {
	ws := gamedata.DefaultWeapons()
	pump := ws.ByName("pumpshotgun")
	var h History
	now := time.Unix(100, 0)
	h.Record(7, pump, proto.Vec3{}, now)
	for i := range 8 {
		if _, ok := h.Claim(7, pump.Hash, now); !ok {
			t.Fatalf("pellet %d rejected", i)
		}
	}
	if _, ok := h.Claim(7, pump.Hash, now); ok {
		t.Fatal("9th pellet accepted")
	}
	pistol := ws.ByName("pistol")
	h.Record(8, pistol, proto.Vec3{}, now)
	if _, ok := h.Claim(8, pump.Hash, now); ok {
		t.Fatal("weapon mismatch accepted")
	}
	if _, ok := h.Claim(8, pistol.Hash, now.Add(ShotWindow+time.Millisecond)); ok {
		t.Fatal("stale shot accepted")
	}
	h.Record(9, pistol, proto.Vec3{}, now)
	h.Reset()
	if _, ok := h.Claim(9, pistol.Hash, now); ok {
		t.Fatal("claim after reset")
	}
	if RejectFireRate.String() != "fire rate" {
		t.Fatal("reject names")
	}
}
