// Package gamedata holds static GTA V data the server needs to validate
// clients: weapon damage and fire rates, vehicle seats and speed classes,
// ped bone groups. Values approximate GTA V Legacy weapons.meta and can be
// overridden with a JSON file (gomp.weapons-file).
package gamedata

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"gomp/wire/proto"
)

// WeaponGroup classifies weapons.
type WeaponGroup string

const (
	GroupMelee   WeaponGroup = "melee"
	GroupPistol  WeaponGroup = "pistol"
	GroupSMG     WeaponGroup = "smg"
	GroupRifle   WeaponGroup = "rifle"
	GroupMG      WeaponGroup = "mg"
	GroupShotgun WeaponGroup = "shotgun"
	GroupSniper  WeaponGroup = "sniper"
	GroupHeavy   WeaponGroup = "heavy"
	GroupThrown  WeaponGroup = "thrown"
	GroupStun    WeaponGroup = "stun"
)

// Weapon describes one weapon.
type Weapon struct {
	Name           string      `json:"name"` // without the "weapon_" prefix
	Hash           uint32      `json:"-"`
	Group          WeaponGroup `json:"group"`
	Damage         int         `json:"damage"`         // per pellet, in RAGE health units (0..100)
	Pellets        int         `json:"pellets"`        // projectiles per shot
	FireIntervalMs int         `json:"fireIntervalMs"` // minimum time between shots
	Range          float32     `json:"range"`          // metres
	ClipSize       int         `json:"clipSize"`
}

// IsMelee reports whether hits are melee attacks.
func (w *Weapon) IsMelee() bool { return w.Group == GroupMelee }

// UsesAmmo reports whether firing consumes ammunition.
func (w *Weapon) UsesAmmo() bool { return w.Group != GroupMelee && w.Group != GroupStun }

// Unarmed is the hash of the empty-hands weapon.
var Unarmed = proto.Joaat("weapon_unarmed")

var defaultWeapons = []Weapon{
	// Melee
	{Name: "unarmed", Group: GroupMelee, Damage: 10, FireIntervalMs: 400, Range: 2.5},
	{Name: "knife", Group: GroupMelee, Damage: 45, FireIntervalMs: 500, Range: 2.5},
	{Name: "dagger", Group: GroupMelee, Damage: 45, FireIntervalMs: 500, Range: 2.5},
	{Name: "switchblade", Group: GroupMelee, Damage: 45, FireIntervalMs: 500, Range: 2.5},
	{Name: "machete", Group: GroupMelee, Damage: 45, FireIntervalMs: 600, Range: 2.8},
	{Name: "hatchet", Group: GroupMelee, Damage: 50, FireIntervalMs: 600, Range: 2.8},
	{Name: "battleaxe", Group: GroupMelee, Damage: 50, FireIntervalMs: 700, Range: 3},
	{Name: "stone_hatchet", Group: GroupMelee, Damage: 50, FireIntervalMs: 700, Range: 3},
	{Name: "nightstick", Group: GroupMelee, Damage: 35, FireIntervalMs: 600, Range: 2.8},
	{Name: "hammer", Group: GroupMelee, Damage: 40, FireIntervalMs: 600, Range: 2.8},
	{Name: "bat", Group: GroupMelee, Damage: 40, FireIntervalMs: 700, Range: 3},
	{Name: "golfclub", Group: GroupMelee, Damage: 40, FireIntervalMs: 700, Range: 3},
	{Name: "crowbar", Group: GroupMelee, Damage: 40, FireIntervalMs: 700, Range: 3},
	{Name: "poolcue", Group: GroupMelee, Damage: 40, FireIntervalMs: 700, Range: 3},
	{Name: "wrench", Group: GroupMelee, Damage: 40, FireIntervalMs: 700, Range: 3},
	{Name: "bottle", Group: GroupMelee, Damage: 10, FireIntervalMs: 500, Range: 2.5},
	{Name: "knuckle", Group: GroupMelee, Damage: 30, FireIntervalMs: 400, Range: 2.5},
	{Name: "flashlight", Group: GroupMelee, Damage: 30, FireIntervalMs: 600, Range: 2.8},
	// Pistols
	{Name: "pistol", Group: GroupPistol, Damage: 26, Pellets: 1, FireIntervalMs: 150, Range: 120, ClipSize: 12},
	{Name: "pistol_mk2", Group: GroupPistol, Damage: 32, Pellets: 1, FireIntervalMs: 150, Range: 120, ClipSize: 12},
	{Name: "combatpistol", Group: GroupPistol, Damage: 27, Pellets: 1, FireIntervalMs: 150, Range: 120, ClipSize: 12},
	{Name: "appistol", Group: GroupPistol, Damage: 28, Pellets: 1, FireIntervalMs: 60, Range: 120, ClipSize: 18},
	{Name: "pistol50", Group: GroupPistol, Damage: 51, Pellets: 1, FireIntervalMs: 250, Range: 120, ClipSize: 9},
	{Name: "snspistol", Group: GroupPistol, Damage: 28, Pellets: 1, FireIntervalMs: 180, Range: 120, ClipSize: 6},
	{Name: "heavypistol", Group: GroupPistol, Damage: 40, Pellets: 1, FireIntervalMs: 200, Range: 120, ClipSize: 18},
	{Name: "vintagepistol", Group: GroupPistol, Damage: 34, Pellets: 1, FireIntervalMs: 180, Range: 120, ClipSize: 7},
	{Name: "revolver", Group: GroupPistol, Damage: 110, Pellets: 1, FireIntervalMs: 500, Range: 120, ClipSize: 6},
	{Name: "doubleaction", Group: GroupPistol, Damage: 110, Pellets: 1, FireIntervalMs: 300, Range: 120, ClipSize: 6},
	{Name: "marksmanpistol", Group: GroupPistol, Damage: 150, Pellets: 1, FireIntervalMs: 1000, Range: 120, ClipSize: 1},
	{Name: "ceramicpistol", Group: GroupPistol, Damage: 20, Pellets: 1, FireIntervalMs: 150, Range: 120, ClipSize: 12},
	{Name: "navyrevolver", Group: GroupPistol, Damage: 40, Pellets: 1, FireIntervalMs: 500, Range: 120, ClipSize: 6},
	{Name: "flaregun", Group: GroupPistol, Damage: 50, Pellets: 1, FireIntervalMs: 1000, Range: 60, ClipSize: 1},
	{Name: "stungun", Group: GroupStun, Damage: 0, Pellets: 1, FireIntervalMs: 1500, Range: 10, ClipSize: 1},
	// SMGs
	{Name: "microsmg", Group: GroupSMG, Damage: 21, Pellets: 1, FireIntervalMs: 50, Range: 120, ClipSize: 16},
	{Name: "smg", Group: GroupSMG, Damage: 22, Pellets: 1, FireIntervalMs: 60, Range: 120, ClipSize: 30},
	{Name: "smg_mk2", Group: GroupSMG, Damage: 25, Pellets: 1, FireIntervalMs: 60, Range: 120, ClipSize: 30},
	{Name: "assaultsmg", Group: GroupSMG, Damage: 23, Pellets: 1, FireIntervalMs: 60, Range: 120, ClipSize: 30},
	{Name: "combatpdw", Group: GroupSMG, Damage: 28, Pellets: 1, FireIntervalMs: 75, Range: 120, ClipSize: 30},
	{Name: "machinepistol", Group: GroupSMG, Damage: 20, Pellets: 1, FireIntervalMs: 60, Range: 120, ClipSize: 12},
	{Name: "minismg", Group: GroupSMG, Damage: 22, Pellets: 1, FireIntervalMs: 50, Range: 120, ClipSize: 20},
	{Name: "gusenberg", Group: GroupMG, Damage: 34, Pellets: 1, FireIntervalMs: 80, Range: 150, ClipSize: 30},
	// Rifles
	{Name: "assaultrifle", Group: GroupRifle, Damage: 30, Pellets: 1, FireIntervalMs: 90, Range: 250, ClipSize: 30},
	{Name: "assaultrifle_mk2", Group: GroupRifle, Damage: 35, Pellets: 1, FireIntervalMs: 90, Range: 250, ClipSize: 30},
	{Name: "carbinerifle", Group: GroupRifle, Damage: 32, Pellets: 1, FireIntervalMs: 100, Range: 250, ClipSize: 30},
	{Name: "carbinerifle_mk2", Group: GroupRifle, Damage: 33, Pellets: 1, FireIntervalMs: 100, Range: 250, ClipSize: 30},
	{Name: "advancedrifle", Group: GroupRifle, Damage: 34, Pellets: 1, FireIntervalMs: 80, Range: 250, ClipSize: 30},
	{Name: "specialcarbine", Group: GroupRifle, Damage: 32, Pellets: 1, FireIntervalMs: 100, Range: 250, ClipSize: 30},
	{Name: "bullpuprifle", Group: GroupRifle, Damage: 32, Pellets: 1, FireIntervalMs: 100, Range: 250, ClipSize: 30},
	{Name: "compactrifle", Group: GroupRifle, Damage: 34, Pellets: 1, FireIntervalMs: 100, Range: 250, ClipSize: 30},
	{Name: "militaryrifle", Group: GroupRifle, Damage: 34, Pellets: 1, FireIntervalMs: 100, Range: 250, ClipSize: 30},
	// Machine guns
	{Name: "mg", Group: GroupMG, Damage: 40, Pellets: 1, FireIntervalMs: 130, Range: 250, ClipSize: 54},
	{Name: "combatmg", Group: GroupMG, Damage: 45, Pellets: 1, FireIntervalMs: 100, Range: 250, ClipSize: 100},
	{Name: "combatmg_mk2", Group: GroupMG, Damage: 47, Pellets: 1, FireIntervalMs: 100, Range: 250, ClipSize: 100},
	{Name: "minigun", Group: GroupHeavy, Damage: 30, Pellets: 1, FireIntervalMs: 20, Range: 200, ClipSize: 15000},
	// Shotguns
	{Name: "pumpshotgun", Group: GroupShotgun, Damage: 29, Pellets: 8, FireIntervalMs: 800, Range: 35, ClipSize: 8},
	{Name: "pumpshotgun_mk2", Group: GroupShotgun, Damage: 32, Pellets: 8, FireIntervalMs: 800, Range: 35, ClipSize: 8},
	{Name: "sawnoffshotgun", Group: GroupShotgun, Damage: 40, Pellets: 8, FireIntervalMs: 800, Range: 25, ClipSize: 8},
	{Name: "assaultshotgun", Group: GroupShotgun, Damage: 32, Pellets: 6, FireIntervalMs: 250, Range: 35, ClipSize: 8},
	{Name: "bullpupshotgun", Group: GroupShotgun, Damage: 14, Pellets: 8, FireIntervalMs: 300, Range: 35, ClipSize: 14},
	{Name: "heavyshotgun", Group: GroupShotgun, Damage: 117, Pellets: 1, FireIntervalMs: 500, Range: 50, ClipSize: 6},
	{Name: "musket", Group: GroupShotgun, Damage: 165, Pellets: 1, FireIntervalMs: 1500, Range: 120, ClipSize: 1},
	// Snipers
	{Name: "sniperrifle", Group: GroupSniper, Damage: 101, Pellets: 1, FireIntervalMs: 1000, Range: 1000, ClipSize: 10},
	{Name: "heavysniper", Group: GroupSniper, Damage: 216, Pellets: 1, FireIntervalMs: 1500, Range: 1500, ClipSize: 6},
	{Name: "heavysniper_mk2", Group: GroupSniper, Damage: 216, Pellets: 1, FireIntervalMs: 1500, Range: 1500, ClipSize: 6},
	{Name: "marksmanrifle", Group: GroupSniper, Damage: 65, Pellets: 1, FireIntervalMs: 400, Range: 750, ClipSize: 8},
	// Explosive / thrown: damage arrives as environment (explosion) damage.
	{Name: "rpg", Group: GroupHeavy, Damage: 0, Pellets: 1, FireIntervalMs: 1000, Range: 1000, ClipSize: 1},
	{Name: "grenadelauncher", Group: GroupHeavy, Damage: 0, Pellets: 1, FireIntervalMs: 500, Range: 300, ClipSize: 10},
	{Name: "grenade", Group: GroupThrown, Damage: 0, Pellets: 1, FireIntervalMs: 800, Range: 60, ClipSize: 1},
	{Name: "stickybomb", Group: GroupThrown, Damage: 0, Pellets: 1, FireIntervalMs: 800, Range: 60, ClipSize: 1},
	{Name: "molotov", Group: GroupThrown, Damage: 0, Pellets: 1, FireIntervalMs: 800, Range: 60, ClipSize: 1},
	{Name: "smokegrenade", Group: GroupThrown, Damage: 0, Pellets: 1, FireIntervalMs: 800, Range: 60, ClipSize: 1},
	{Name: "petrolcan", Group: GroupThrown, Damage: 0, Pellets: 1, FireIntervalMs: 50, Range: 5, ClipSize: 4500},
}

// Weapons is a lookup table by hash.
type Weapons struct {
	byHash map[uint32]*Weapon
}

// DefaultWeapons returns the built-in table.
func DefaultWeapons() *Weapons {
	t := &Weapons{byHash: make(map[uint32]*Weapon, len(defaultWeapons))}
	for i := range defaultWeapons {
		w := defaultWeapons[i]
		t.add(&w)
	}
	return t
}

func (t *Weapons) add(w *Weapon) {
	w.Name = strings.TrimPrefix(strings.ToLower(w.Name), "weapon_")
	w.Hash = proto.Joaat("weapon_" + w.Name)
	if w.Pellets <= 0 && !w.IsMelee() {
		w.Pellets = 1
	}
	t.byHash[w.Hash] = w
}

// Get returns the weapon for hash, or nil if unknown.
func (t *Weapons) Get(hash uint32) *Weapon { return t.byHash[hash] }

// ByName looks a weapon up by name ("pistol" or "weapon_pistol").
func (t *Weapons) ByName(name string) *Weapon {
	return t.byHash[proto.Joaat("weapon_"+strings.TrimPrefix(strings.ToLower(name), "weapon_"))]
}

// Len returns the number of known weapons.
func (t *Weapons) Len() int { return len(t.byHash) }

// LoadOverrides merges weapons from a JSON array file (same fields as Weapon).
func (t *Weapons) LoadOverrides(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var list []Weapon
	if err := json.Unmarshal(data, &list); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	for i := range list {
		w := list[i]
		if w.Name == "" {
			return fmt.Errorf("%s: weapon #%d has no name", path, i)
		}
		if w.Group == "" {
			if old := t.ByName(w.Name); old != nil {
				w.Group = old.Group
			} else {
				w.Group = GroupPistol
			}
		}
		t.add(&w)
	}
	return nil
}
