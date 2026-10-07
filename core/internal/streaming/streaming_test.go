package streaming

import (
	"testing"

	"gomp/wire/proto"
)

func key(t proto.EntityType, id uint16) Key { return Key{Type: t, ID: id} }

func apply(s *Set, added []Candidate, removed []Key) {
	for _, k := range removed {
		s.Remove(k)
	}
	for _, c := range added {
		s.Add(c)
	}
}

func lim(enter, leave float32) Limits {
	return Limits{EnterSq: enter * enter, LeaveSq: leave * leave}
}

func TestEnterLeaveHysteresis(t *testing.T) {
	s := NewSet()
	k := key(proto.EntityPlayer, 1)
	l := lim(100, 110)
	step := func(dist float32) (bool, bool) {
		a, r := Diff(s, []Candidate{{Key: k, DistSq: dist * dist}}, l)
		apply(s, a, r)
		return len(a) > 0, len(r) > 0
	}
	if added, _ := step(105); added {
		t.Fatal("streamed in beyond enter distance")
	}
	if added, _ := step(99); !added || !s.Has(k) {
		t.Fatal("not streamed in within enter distance")
	}
	if _, removed := step(108); removed {
		t.Fatal("streamed out inside hysteresis band")
	}
	// Beyond leave distance the grid query no longer returns it.
	a, r := Diff(s, nil, l)
	apply(s, a, r)
	if len(r) != 1 || s.Has(k) {
		t.Fatal("not streamed out")
	}
}

func TestPinnedAlwaysStreamed(t *testing.T) {
	s := NewSet()
	k := key(proto.EntityVehicle, 3)
	a, _ := Diff(s, []Candidate{{Key: k, DistSq: 1e9, Pinned: true}}, lim(10, 11))
	if len(a) != 1 {
		t.Fatal("pinned entity not added")
	}
}

func TestGenerationChangeRestreams(t *testing.T) {
	s := NewSet()
	k := key(proto.EntityVehicle, 3)
	s.Add(Candidate{Key: k, Gen: 1})
	a, r := Diff(s, []Candidate{{Key: k, Gen: 2, DistSq: 1}}, lim(10, 11))
	if len(a) != 1 || len(r) != 1 {
		t.Fatalf("added %v removed %v", a, r)
	}
	apply(s, a, r)
	if s.Get(k).Gen != 2 {
		t.Fatal("generation not updated")
	}
}

func TestCapsKeepNearestAndExisting(t *testing.T) {
	s := NewSet()
	l := lim(1000, 1100)
	l.Caps = map[proto.EntityType]int{proto.EntityPlayer: 3}
	var cands []Candidate
	for i := range 10 {
		cands = append(cands, Candidate{Key: key(proto.EntityPlayer, uint16(i)), DistSq: float32((10 - i) * (10 - i) * 100)})
	}
	cands = append(cands, Candidate{Key: key(proto.EntityVehicle, 0), DistSq: 1e5})
	a, r := Diff(s, cands, l)
	apply(s, a, r)
	if s.Len() != 4 {
		t.Fatalf("len %d", s.Len())
	}
	for _, id := range []uint16{7, 8, 9} {
		if !s.Has(key(proto.EntityPlayer, id)) {
			t.Fatalf("nearest player %d missing", id)
		}
	}
	// A slightly closer newcomer must not evict an existing entry (keep bonus).
	cands = append(cands, Candidate{Key: key(proto.EntityPlayer, 50), DistSq: s.Get(key(proto.EntityPlayer, 7)).DistSq * 0.95})
	a, r = Diff(s, cands, l)
	if len(a) != 0 || len(r) != 0 {
		t.Fatalf("cap boundary flapped: +%v -%v", a, r)
	}
}

func TestSyncWeight(t *testing.T) {
	if SyncWeight(10*10) != 1 || SyncWeight(100*100) != 0.5 || SyncWeight(400*400) != 0.2 {
		t.Fatal("tiers")
	}
}
