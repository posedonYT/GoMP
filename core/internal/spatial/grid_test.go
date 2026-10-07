package spatial

import (
	"math/rand/v2"
	"sort"
	"testing"

	"gomp/wire/proto"
)

type ent struct {
	key Key
	dim uint32
	pos proto.Vec3
}

func randPos(rng *rand.Rand, span float32) proto.Vec3 {
	return proto.Vec3{X: (rng.Float32()*2 - 1) * span, Y: (rng.Float32()*2 - 1) * span, Z: rng.Float32() * 100}
}

// TestQueryMatchesBruteForce is a property test: after random inserts, moves,
// dimension changes and removals, Query must return exactly what a linear scan returns.
func TestQueryMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewPCG(42, 7))
	g := New(100)
	ents := map[Key]*ent{}
	dims := []uint32{0, 1, 7, proto.GlobalDimension}
	for step := range 20000 {
		k := Key{Type: proto.EntityType(1 + rng.IntN(3)), ID: uint16(rng.IntN(400))}
		switch op := rng.IntN(10); {
		case op < 6: // upsert / move
			e := &ent{key: k, dim: dims[rng.IntN(len(dims))], pos: randPos(rng, 3000)}
			if old, ok := ents[k]; ok && rng.IntN(2) == 0 {
				// small move inside the same dimension
				e.dim = old.dim
				e.pos = old.pos.Add(proto.Vec3{X: rng.Float32()*20 - 10, Y: rng.Float32()*20 - 10})
			}
			ents[k] = e
			g.Upsert(k, e.dim, e.pos)
		case op < 8:
			delete(ents, k)
			g.Remove(k)
		default:
		}
		if g.Len() != len(ents) {
			t.Fatalf("step %d: len %d vs %d", step, g.Len(), len(ents))
		}
		if step%200 != 0 {
			continue
		}
		center := randPos(rng, 3000)
		radius := 50 + rng.Float32()*800
		dim := dims[rng.IntN(len(dims))]
		var got, want []Key
		g.Query(dim, center, radius, func(k Key, pos proto.Vec3, d2 float32) {
			if pos != ents[k].pos || d2 != pos.DistSq(center) {
				t.Fatalf("stale position for %v", k)
			}
			got = append(got, k)
		})
		for _, e := range ents {
			if (e.dim == dim || e.dim == proto.GlobalDimension) && e.pos.DistSq(center) <= radius*radius {
				want = append(want, e.key)
			}
		}
		sortKeys(got)
		sortKeys(want)
		if len(got) != len(want) {
			t.Fatalf("step %d: query returned %d, brute force %d", step, len(got), len(want))
		}
		for i := range got {
			if got[i] != want[i] {
				t.Fatalf("step %d: mismatch %v vs %v", step, got[i], want[i])
			}
		}
	}
	for k, e := range ents {
		pos, dim, ok := g.Position(k)
		if !ok || pos != e.pos || dim != e.dim {
			t.Fatalf("Position(%v)", k)
		}
	}
}

func sortKeys(ks []Key) {
	sort.Slice(ks, func(i, j int) bool {
		if ks[i].Type != ks[j].Type {
			return ks[i].Type < ks[j].Type
		}
		return ks[i].ID < ks[j].ID
	})
}

func TestNegativeCoordinatesAndHugeRadius(t *testing.T) {
	g := New(100)
	g.Upsert(Key{Type: 1, ID: 1}, 0, proto.Vec3{X: -0.5, Y: -0.5})
	g.Upsert(Key{Type: 1, ID: 2}, 0, proto.Vec3{X: 0.5, Y: 0.5})
	n := 0
	g.Query(0, proto.Vec3{}, 1, func(Key, proto.Vec3, float32) { n++ })
	if n != 2 {
		t.Fatalf("found %d", n)
	}
	n = 0
	g.Query(0, proto.Vec3{}, 1e6, func(Key, proto.Vec3, float32) { n++ }) // sparse-iteration path
	if n != 2 {
		t.Fatalf("huge radius found %d", n)
	}
	g.Remove(Key{Type: 1, ID: 1})
	g.Remove(Key{Type: 1, ID: 1})
	cnt := 0
	g.EachInDim(0, func(Key, proto.Vec3) { cnt++ })
	if cnt != 1 {
		t.Fatal("EachInDim")
	}
}

func BenchmarkQuery1000(b *testing.B) {
	rng := rand.New(rand.NewPCG(1, 2))
	g := New(100)
	for i := range 1000 {
		g.Upsert(Key{Type: 1, ID: uint16(i)}, 0, randPos(rng, 2000))
	}
	b.ReportAllocs()
	for b.Loop() {
		g.Query(0, randPos(rng, 2000), 300, func(Key, proto.Vec3, float32) {})
	}
}

func BenchmarkUpsertMove(b *testing.B) {
	g := New(100)
	for i := range 1000 {
		g.Upsert(Key{Type: 1, ID: uint16(i)}, 0, proto.Vec3{X: float32(i), Y: float32(i)})
	}
	i := 0
	b.ReportAllocs()
	for b.Loop() {
		k := Key{Type: 1, ID: uint16(i % 1000)}
		g.Upsert(k, 0, proto.Vec3{X: float32(i % 2000), Y: float32(i % 1500)})
		i++
	}
}
