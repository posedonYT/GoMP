// Package combat implements server-authoritative damage: per-bone damage,
// armour absorption, fire-rate limits and the shot history used to validate
// hit claims.
package combat

import (
	"math"
	"time"

	"gomp/core/internal/gamedata"
	"gomp/wire/proto"
)

// Config holds damage multipliers.
type Config struct {
	HeadMultiplier float32
	LimbMultiplier float32
}

// DamagePerHit returns the health damage of one projectile (or melee blow) hitting bone.
func DamagePerHit(w *gamedata.Weapon, bone uint16, cfg Config) int {
	mul := float32(1)
	switch gamedata.BoneGroupOf(bone) {
	case gamedata.BoneHead:
		mul = cfg.HeadMultiplier
	case gamedata.BoneLimb:
		mul = cfg.LimbMultiplier
	}
	return int(math.Round(float64(float32(w.Damage) * mul)))
}

// Apply subtracts dmg from armour first, then health. Health never drops below 0.
func Apply(health, armour, dmg int) (newHealth, newArmour, healthLoss, armourLoss int) {
	if dmg <= 0 {
		return health, armour, 0, 0
	}
	armourLoss = min(armour, dmg)
	newArmour = armour - armourLoss
	healthLoss = min(health, dmg-armourLoss)
	newHealth = health - healthLoss
	return newHealth, newArmour, healthLoss, armourLoss
}

// Reject explains why a shot or hit was refused.
type Reject uint8

const (
	OK Reject = iota
	RejectUnknownWeapon
	RejectWeaponNotOwned
	RejectNoAmmo
	RejectFireRate
	RejectNoShot
	RejectTooFar
	RejectBadTarget
	RejectDead
	RejectHitMismatch
)

var rejectNames = [...]string{"ok", "unknown weapon", "weapon not owned", "no ammo", "fire rate", "no matching shot",
	"out of range", "invalid target", "shooter dead", "hit position mismatch"}

func (r Reject) String() string {
	if int(r) < len(rejectNames) {
		return rejectNames[r]
	}
	return "unknown"
}

// Shot is a recorded shot awaiting hit claims.
type Shot struct {
	Seq      uint16
	Weapon   uint32
	At       time.Time
	Origin   proto.Vec3
	HitsLeft int
}

// ShotWindow is how long after a shot hit claims are accepted.
const ShotWindow = 1500 * time.Millisecond

// fireRateTolerance accepts shots this fraction of the nominal interval
// apart, absorbing network jitter that bunches packets together.
const fireRateTolerance = 0.5

// History tracks one player's recent shots and fire timing.
type History struct {
	shots    [64]Shot
	next     int
	lastFire map[uint32]time.Time
	burst    map[uint32]int
}

// FireAllowed reports whether a new shot of w at now respects the fire rate.
// Jittered packets may arrive close together; a small burst allowance absorbs it.
func (h *History) FireAllowed(w *gamedata.Weapon, now time.Time) bool {
	if h.lastFire == nil {
		h.lastFire = make(map[uint32]time.Time)
		h.burst = make(map[uint32]int)
	}
	last, ok := h.lastFire[w.Hash]
	h.lastFire[w.Hash] = now
	if !ok {
		return true
	}
	interval := time.Duration(w.FireIntervalMs) * time.Millisecond
	gap := now.Sub(last)
	if gap >= time.Duration(float64(interval)*fireRateTolerance) {
		if gap >= interval {
			h.burst[w.Hash] = 0
		}
		return true
	}
	// Allow up to 3 bunched shots, then require the real cadence again.
	h.burst[w.Hash]++
	return h.burst[w.Hash] <= 3
}

// Record stores a validated shot.
func (h *History) Record(seq uint16, w *gamedata.Weapon, origin proto.Vec3, now time.Time) {
	h.shots[h.next] = Shot{Seq: seq, Weapon: w.Hash, At: now, Origin: origin, HitsLeft: max(w.Pellets, 1)}
	h.next = (h.next + 1) % len(h.shots)
}

// Claim finds the recorded shot seq of weapon and consumes one hit from it.
func (h *History) Claim(seq uint16, weapon uint32, now time.Time) (Shot, bool) {
	for i := range h.shots {
		s := &h.shots[i]
		if s.HitsLeft > 0 && s.Seq == seq && s.Weapon == weapon && now.Sub(s.At) <= ShotWindow {
			s.HitsLeft--
			return *s, true
		}
	}
	return Shot{}, false
}

// Reset forgets every shot (respawn, weapon removal).
func (h *History) Reset() {
	h.shots = [64]Shot{}
	h.next = 0
}
