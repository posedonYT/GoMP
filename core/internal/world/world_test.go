package world

import (
	"math/rand/v2"
	"testing"

	"gomp/wire/proto"
)

func TestPoolAllocFreeGenerations(t *testing.T) {
	p := NewPool[int](3)
	a, b, c := 1, 2, 3
	ida, _ := p.Alloc(&a)
	idb, _ := p.Alloc(&b)
	idc, _ := p.Alloc(&c)
	if ida != 0 || idb != 1 || idc != 2 {
		t.Fatalf("ids %d %d %d", ida, idb, idc)
	}
	if _, err := p.Alloc(&a); err != ErrPoolFull {
		t.Fatal("pool not full")
	}
	g := p.Gen(1)
	p.Free(1)
	if p.Get(1) != nil || p.Gen(1) != g+1 || p.Len() != 2 {
		t.Fatal("free")
	}
	if p.GetGen(0, 0) == nil || p.GetGen(1, g) != nil {
		t.Fatal("GetGen")
	}
	id, _ := p.Alloc(&b)
	if id != 1 {
		t.Fatalf("reused id %d", id)
	}
}

func TestPoolAllocAt(t *testing.T) {
	p := NewPool[int](10)
	x := 7
	if !p.AllocAt(3, &x) || p.AllocAt(3, &x) || p.AllocAt(10, &x) {
		t.Fatal("AllocAt")
	}
	seen := map[uint16]bool{}
	for {
		id, err := p.Alloc(&x)
		if err != nil {
			break
		}
		if seen[id] || id == 3 {
			t.Fatalf("id %d handed out twice", id)
		}
		seen[id] = true
	}
	if p.Len() != 10 || len(seen) != 9 {
		t.Fatalf("len %d seen %d", p.Len(), len(seen))
	}
}

func TestPoolRandomOps(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 1))
	p := NewPool[int](64)
	live := map[uint16]*int{}
	for i := range 20000 {
		switch rng.IntN(3) {
		case 0, 1:
			v := i
			if id, err := p.Alloc(&v); err == nil {
				if live[id] != nil {
					t.Fatalf("id %d handed out twice", id)
				}
				live[id] = &v
			}
		case 2:
			for id := range live {
				p.Free(id)
				delete(live, id)
				break
			}
		}
		if p.Len() != len(live) {
			t.Fatalf("len %d vs %d", p.Len(), len(live))
		}
	}
	for id, v := range live {
		if p.Get(id) != v {
			t.Fatalf("id %d mismatch", id)
		}
	}
}

func TestWorldAddResolveRemove(t *testing.T) {
	w := New(10)
	v := NewVehicle(proto.Joaat("adder"), proto.Vec3{1, 2, 3}, 90, 2)
	if err := w.Add(v, -1); err != nil {
		t.Fatal(err)
	}
	ref := v.Ref()
	if w.Resolve(ref) != v || w.Get(proto.EntityVehicle, v.ID) != v {
		t.Fatal("resolve")
	}
	w.Remove(v)
	if !v.Destroyed || w.Resolve(ref) != nil {
		t.Fatal("remove")
	}
	v2 := NewVehicle(1, proto.Vec3{}, 0, 4)
	_ = w.Add(v2, -1)
	if v2.ID != ref.ID || v2.Gen == ref.Gen || w.Resolve(ref) != nil {
		t.Fatal("stale ref resolved after id reuse")
	}
	o := &Object{}
	if err := w.Add(o, 500); err != nil || o.ID != 500 || o.Type != proto.EntityObject {
		t.Fatalf("add at: %v %+v", err, o.EntityBase)
	}
	if err := w.Add(&Object{}, 500); err == nil {
		t.Fatal("double use of id")
	}
	count := 0
	w.Each(proto.EntityObject, func(Entity) { count++ })
	if count != 1 {
		t.Fatal("Each")
	}
}

func TestVehicleSeats(t *testing.T) {
	v := NewVehicle(1, proto.Vec3{}, 0, 3)
	p := &Player{}
	if s, ok := v.FirstFreeSeat(); !ok || s != 0 {
		t.Fatal("first free seat")
	}
	v.Occupants[0] = p
	v.Reserved[1] = p
	if s, ok := v.FirstFreeSeat(); !ok || s != 2 {
		t.Fatalf("seat %d", s)
	}
	if v.SeatFree(5) || v.Driver() != p || v.NumOccupants() != 1 {
		t.Fatal("seat queries")
	}
	if h := NewVehicle(1, proto.Vec3{}, 270, 1).Heading(); h < 269.9 || h > 270.1 {
		t.Fatalf("heading %v", h)
	}
}

func TestColshapes(t *testing.T) {
	at := func(x, y, z float32) proto.Vec3 { return proto.Vec3{X: x, Y: y, Z: z} }
	cases := []struct {
		c   Colshape
		in  []proto.Vec3
		out []proto.Vec3
	}{
		{Colshape{EntityBase: EntityBase{Pos: at(0, 0, 0)}, Kind: ShapeCircle, Radius: 5},
			[]proto.Vec3{at(3, 4, 1000)}, []proto.Vec3{at(4, 4, 0)}},
		{Colshape{EntityBase: EntityBase{Pos: at(0, 0, 0)}, Kind: ShapeSphere, Radius: 5},
			[]proto.Vec3{at(0, 0, 5)}, []proto.Vec3{at(3, 4, 1)}},
		{Colshape{EntityBase: EntityBase{Pos: at(0, 0, 10)}, Kind: ShapeTube, Radius: 2, Height: 3},
			[]proto.Vec3{at(1, 1, 12)}, []proto.Vec3{at(1, 1, 9), at(1, 1, 13.5), at(2, 2, 11)}},
		{Colshape{EntityBase: EntityBase{Pos: at(10, 10, 0)}, Kind: ShapeRectangle, Width: 4, Depth: 2},
			[]proto.Vec3{at(12, 11, -50)}, []proto.Vec3{at(12.1, 10, 0), at(10, 11.1, 0)}},
		{Colshape{EntityBase: EntityBase{Pos: at(0, 0, 0)}, Kind: ShapeCuboid, Width: 2, Depth: 2, Height: 2},
			[]proto.Vec3{at(1, -1, 1)}, []proto.Vec3{at(0, 0, 1.1)}},
		{Colshape{EntityBase: EntityBase{Pos: at(0, 0, 0)}, Kind: ShapePolygon, MinZ: 0, MaxZ: 10,
			Points: []proto.Vec3{at(0, 0, 0), at(10, 0, 0), at(10, 10, 0), at(0, 10, 0)}},
			[]proto.Vec3{at(5, 5, 5)}, []proto.Vec3{at(11, 5, 5), at(5, 5, 11)}},
	}
	for _, tc := range cases {
		for _, p := range tc.in {
			if !tc.c.Contains(p) {
				t.Errorf("%s should contain %v", tc.c.Kind, p)
			}
		}
		for _, p := range tc.out {
			if tc.c.Contains(p) {
				t.Errorf("%s should not contain %v", tc.c.Kind, p)
			}
		}
		if tc.c.BoundingRadius() <= 0 {
			t.Errorf("%s bounding radius", tc.c.Kind)
		}
	}
}
