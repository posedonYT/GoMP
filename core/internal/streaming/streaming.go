// Package streaming decides which entities each player has streamed in.
// Entities enter at the stream distance, leave beyond distance×hysteresis,
// and each entity type can be capped (nearest first). It also provides the
// distance-based update weights used by the sync priority accumulator.
package streaming

import (
	"slices"

	"gomp/wire/proto"
)

// Key identifies a streamed entity.
type Key = proto.EntityRef

// Entry is per (receiver, entity) state.
type Entry struct {
	Key     Key
	Gen     uint16
	DistSq  float32
	Acc     float32 // priority accumulator for unreliable sync updates
	LastSeq uint32  // last sync sequence sent to the receiver
	mark    uint32
	since   uint32 // stream update epoch when the entry was added
}

// Set is the stream set of one receiver. Entries live in a slice for fast
// iteration; an index map serves lookups. The map is keyed by the packed key:
// hashing a uint32 is several times cheaper than hashing the struct, and Diff
// looks up every candidate of every receiver several times a second.
type Set struct {
	list  []*Entry
	idx   map[uint32]int32
	epoch uint32

	// Scratch buffers reused by Diff.
	kept   []Candidate
	keptE  []*Entry // the current entry of each kept candidate (nil: not streamed)
	scored []scored
}

func pack(k Key) uint32 { return uint32(k.Type)<<16 | uint32(k.ID) }

// NewSet returns an empty set.
func NewSet() *Set { return &Set{idx: make(map[uint32]int32)} }

// Get returns the entry for k or nil.
func (s *Set) Get(k Key) *Entry {
	if i, ok := s.idx[pack(k)]; ok {
		return s.list[i]
	}
	return nil
}

// Has reports whether k is streamed.
func (s *Set) Has(k Key) bool { _, ok := s.idx[pack(k)]; return ok }

// Len returns the number of streamed entities.
func (s *Set) Len() int { return len(s.list) }

// Add inserts a candidate (replacing an existing entry for the same key).
func (s *Set) Add(c Candidate) *Entry {
	e := &Entry{Key: c.Key, Gen: c.Gen, DistSq: c.DistSq, Acc: 1, since: s.epoch}
	pk := pack(c.Key)
	if i, ok := s.idx[pk]; ok {
		s.list[i] = e
		return e
	}
	s.idx[pk] = int32(len(s.list))
	s.list = append(s.list, e)
	return e
}

// Remove deletes k.
func (s *Set) Remove(k Key) {
	pk := pack(k)
	i, ok := s.idx[pk]
	if !ok {
		return
	}
	last := len(s.list) - 1
	if int(i) != last {
		moved := s.list[last]
		s.list[i] = moved
		s.idx[pack(moved.Key)] = i
	}
	s.list[last] = nil
	s.list = s.list[:last]
	delete(s.idx, pk)
}

// Each visits every entry.
func (s *Set) Each(fn func(*Entry)) {
	for _, e := range s.list {
		fn(e)
	}
}

// Entries returns the entries; the slice is owned by the set and must not be
// modified or retained across Add/Remove.
func (s *Set) Entries() []*Entry { return s.list }

// Candidate is an entity near the receiver.
type Candidate struct {
	Key    Key
	Gen    uint16
	DistSq float32
	// Pinned entities are always streamed (own vehicle, co-passengers).
	Pinned bool
}

// Limits configure Diff.
type Limits struct {
	EnterSq float32
	LeaveSq float32
	// Caps limits streamed entities per type (missing or 0 = unlimited).
	Caps map[proto.EntityType]int
}

// At the cap boundary already-streamed entities are preferred, so moving
// crowds do not cause constant stream-in/out churn: a newcomer must be
// clearly closer (keepBonus on squared distance ≈ 30% in distance), and
// entries streamed in during the last minDwell updates are kept unless the
// newcomer is much closer still.
const (
	keepBonus  = 0.5
	dwellBonus = 0.1
	minDwell   = 8
)

type scored struct {
	c     Candidate
	e     *Entry
	score float32
}

// Diff computes stream-in and stream-out changes for cur given nearby candidates.
// Candidates must include everything within the leave distance plus pinned ones.
// The returned slices are appended to added and removed (which may be nil).
func Diff(cur *Set, cands []Candidate, lim Limits) (added []Candidate, removed []Key) {
	return DiffInto(cur, cands, lim, nil, nil)
}

// DiffInto is Diff appending into caller-provided buffers.
func DiffInto(cur *Set, cands []Candidate, lim Limits, added []Candidate, removed []Key) ([]Candidate, []Key) {
	cur.epoch++
	if cur.epoch == 0 {
		cur.epoch = 1
	}
	// Each candidate is looked up once; the entry travels with it.
	kept, keptE := cur.kept[:0], cur.keptE[:0]
	for _, c := range cands {
		e := cur.Get(c.Key)
		if e != nil && e.Gen != c.Gen {
			e = nil // another entity under a reused id: streamed anew
		}
		if c.Pinned || c.DistSq <= lim.EnterSq || (e != nil && c.DistSq <= lim.LeaveSq) {
			kept = append(kept, c)
			keptE = append(keptE, e)
		}
	}
	if len(lim.Caps) > 0 {
		kept, keptE = cur.applyCaps(kept, keptE, lim.Caps)
	}
	for i, c := range kept {
		if e := keptE[i]; e != nil {
			e.DistSq = c.DistSq
			e.mark = cur.epoch
		} else {
			added = append(added, c)
		}
	}
	for _, e := range cur.list {
		if e.mark != cur.epoch {
			removed = append(removed, e.Key)
		}
	}
	cur.kept, cur.keptE = kept, keptE
	return added, removed
}

func (cur *Set) applyCaps(kept []Candidate, keptE []*Entry, caps map[proto.EntityType]int) ([]Candidate, []*Entry) {
	// Count per type first; most updates are below every cap.
	var counts [proto.EntityTypeCount]int
	for _, c := range kept {
		if int(c.Key.Type) < len(counts) {
			counts[c.Key.Type]++
		}
	}
	var limits [proto.EntityTypeCount]int
	over := false
	for t, n := range counts {
		if limit := caps[proto.EntityType(t)]; limit > 0 && n > limit {
			limits[t] = limit
			over = true
		}
	}
	if !over {
		return kept, keptE
	}
	// Only the types over their cap are ranked; the rest pass as they are.
	sc := cur.scored[:0]
	n := 0
	for i, c := range kept {
		if int(c.Key.Type) >= len(limits) || limits[c.Key.Type] == 0 {
			kept[n], keptE[n] = c, keptE[i]
			n++
			continue
		}
		s := c.DistSq
		e := keptE[i]
		switch {
		case c.Pinned:
			s = -1
		case e != nil:
			if cur.epoch-e.since < minDwell {
				s *= dwellBonus
			} else {
				s *= keepBonus
			}
		}
		sc = append(sc, scored{c: c, e: e, score: s})
	}
	slices.SortFunc(sc, func(a, b scored) int {
		switch {
		case a.score < b.score:
			return -1
		case a.score > b.score:
			return 1
		}
		return 0
	})
	var taken [proto.EntityTypeCount]int
	out, outE := kept[:n], keptE[:n]
	for _, s := range sc {
		t := s.c.Key.Type
		if taken[t] >= limits[t] {
			continue
		}
		taken[t]++
		out = append(out, s.c)
		outE = append(outE, s.e)
	}
	cur.scored = sc
	return out, outE
}

// Distance tiers for sync update rates.
const (
	NearDist = 50
	MidDist  = 150
)

// SyncWeight returns how much of an update an entity at distSq earns per
// tick: 1 (every tick) when near, 1/2 at mid range and 1/5 beyond.
func SyncWeight(distSq float32) float32 {
	switch {
	case distSq <= NearDist*NearDist:
		return 1
	case distSq <= MidDist*MidDist:
		return 0.5
	default:
		return 0.2
	}
}
