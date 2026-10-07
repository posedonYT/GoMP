package gamedata

import (
	"os"
	"path/filepath"
	"testing"

	"gomp/wire/proto"
)

func TestWeapons(t *testing.T) {
	w := DefaultWeapons()
	p := w.Get(0x1B06D571) // WEAPON_PISTOL
	if p == nil || p.Name != "pistol" || p.Damage != 26 || p.Pellets != 1 {
		t.Fatalf("pistol: %+v", p)
	}
	if w.ByName("WEAPON_PumpShotgun").Pellets != 8 {
		t.Fatal("pump pellets")
	}
	if u := w.Get(Unarmed); u == nil || !u.IsMelee() || u.UsesAmmo() {
		t.Fatalf("unarmed: %+v", u)
	}
	if w.Get(12345) != nil {
		t.Fatal("unknown hash resolved")
	}
	for h, wp := range w.byHash {
		if wp.FireIntervalMs <= 0 || wp.Range <= 0 {
			t.Errorf("%s: interval %d range %v", wp.Name, wp.FireIntervalMs, wp.Range)
		}
		if h != proto.Joaat("weapon_"+wp.Name) {
			t.Errorf("%s: hash mismatch", wp.Name)
		}
	}
}

func TestWeaponOverrides(t *testing.T) {
	path := filepath.Join(t.TempDir(), "weapons.json")
	_ = os.WriteFile(path, []byte(`[{"name":"weapon_pistol","damage":50,"pellets":1,"fireIntervalMs":100,"range":100},
		{"name":"custom_gun","group":"rifle","damage":10,"fireIntervalMs":10,"range":50}]`), 0o644)
	w := DefaultWeapons()
	if err := w.LoadOverrides(path); err != nil {
		t.Fatal(err)
	}
	if w.ByName("pistol").Damage != 50 || w.ByName("pistol").Group != GroupPistol {
		t.Fatalf("override: %+v", w.ByName("pistol"))
	}
	if c := w.ByName("custom_gun"); c == nil || c.Group != GroupRifle {
		t.Fatalf("custom: %+v", c)
	}
	_ = os.WriteFile(path, []byte(`[{"damage":1}]`), 0o644)
	if err := w.LoadOverrides(path); err == nil {
		t.Fatal("nameless weapon accepted")
	}
}

func TestVehicles(t *testing.T) {
	v := DefaultVehicles()
	if v.Len() < 250 {
		t.Fatalf("only %d vehicles", v.Len())
	}
	adder := v.Get(proto.Joaat("adder"))
	if adder == nil || adder.Class != ClassSuper || adder.Seats != 2 {
		t.Fatalf("adder: %+v", adder)
	}
	if v.Seats(proto.Joaat("bus")) != 16 || v.Seats(proto.Joaat("bmx")) != 1 || v.Seats(proto.Joaat("kuruma")) != 4 {
		t.Fatal("seat counts")
	}
	if v.Seats(1) != DefaultSeats || v.MaxSpeed(1) != ClassPlane.MaxSpeed() {
		t.Fatal("unknown model defaults")
	}
	if v.Get(proto.Joaat("policeb")).Class != ClassMotorcycle {
		t.Fatal("policeb class")
	}
}

func TestBones(t *testing.T) {
	if BoneGroupOf(BoneSkelHead) != BoneHead || BoneGroupOf(BoneSkelLFoot) != BoneLimb || BoneGroupOf(0) != BoneTorso {
		t.Fatal("bone groups")
	}
}
