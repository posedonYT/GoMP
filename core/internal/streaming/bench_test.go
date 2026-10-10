package streaming

import (
	"math/rand"
	"testing"

	"gomp/wire/proto"
)

// A crowd (a hub of 250 m in the mixed stress profile): more players near the
// receiver than the cap, everyone moving a little between stream updates.
func crowd(n int, r *rand.Rand) []Candidate {
	cands := make([]Candidate, n)
	for i := range cands {
		cands[i] = Candidate{Key: Key{Type: proto.EntityPlayer, ID: uint16(i + 1)}, Gen: 1, DistSq: r.Float32() * 300 * 300}
	}
	return cands
}

func benchDiff(b *testing.B, n int, caps map[proto.EntityType]int) {
	r := rand.New(rand.NewSource(1))
	cands := crowd(n, r)
	lim := Limits{EnterSq: 300 * 300, LeaveSq: 330 * 330, Caps: caps}
	set := NewSet()
	var added []Candidate
	var removed []Key
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for j := range cands {
			cands[j].DistSq += (r.Float32() - 0.5) * 400
			if cands[j].DistSq < 0 {
				cands[j].DistSq = 0
			}
		}
		added, removed = DiffInto(set, cands, lim, added[:0], removed[:0])
		for _, k := range removed {
			set.Remove(k)
		}
		for _, c := range added {
			set.Add(c)
		}
	}
}

func BenchmarkDiffUnderCap(b *testing.B) {
	benchDiff(b, 100, map[proto.EntityType]int{proto.EntityPlayer: 128})
}
func BenchmarkDiffOverCap(b *testing.B) {
	benchDiff(b, 300, map[proto.EntityType]int{proto.EntityPlayer: 128})
}
