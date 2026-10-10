package server

import (
	"testing"
	"time"

	"gomp/core/internal/world"
	"gomp/wire/proto"
)

// With thousands of colshapes a player's exits and his quit look only at the
// shapes he is in (not every shape of the world), and stay correct.
func TestColshapesAmongThousands(t *testing.T) {
	h := newHarness(t, nil, nil)
	b := h.spawned("walker")
	id := botID(b)
	var zone uint16
	h.exec(func(s *Server) {
		for i := range 5000 {
			cs := &world.Colshape{Kind: world.ShapeSphere, Radius: 3}
			cs.Type = proto.EntityColshape
			cs.Pos = proto.Vec3{X: float32(1000 + (i%100)*20), Y: float32(1000 + (i/100)*20), Z: 30}
			if err := s.world.Add(cs, -1); err != nil {
				t.Fatal(err)
			}
			s.indexEntity(cs)
		}
		cs := &world.Colshape{Kind: world.ShapeSphere, Radius: 6}
		cs.Type = proto.EntityColshape
		cs.Pos = proto.Vec3{X: 100, Y: 100, Z: 30}
		if err := s.world.Add(cs, -1); err != nil {
			t.Fatal(err)
		}
		s.indexEntity(cs)
		zone = cs.ID
	})
	inZone := func() bool {
		in := false
		h.exec(func(s *Server) {
			cs := s.world.Colshapes.Get(zone)
			c := s.byID[id]
			_, tracked := c.shapesIn[cs.Key()]
			in = cs.Inside[id] && tracked
		})
		return in
	}
	h.teleportBot(b, proto.Vec3{X: 100, Y: 100, Z: 30})
	eventually(t, 3*time.Second, "inside the zone", inZone)

	h.teleportBot(b, proto.Vec3{X: 400, Y: 400, Z: 30})
	eventually(t, 3*time.Second, "out of the zone", func() bool {
		out := false
		h.exec(func(s *Server) {
			out = !s.world.Colshapes.Get(zone).Inside[id] && len(s.byID[id].shapesIn) == 0
		})
		return out
	})

	// Back in, then a quit: the shape forgets him.
	h.teleportBot(b, proto.Vec3{X: 100, Y: 100, Z: 30})
	eventually(t, 3*time.Second, "inside again", inZone)
	b.Close()
	eventually(t, 15*time.Second, "forgotten after the quit", func() bool {
		gone := false
		h.exec(func(s *Server) { gone = !s.world.Colshapes.Get(zone).Inside[id] })
		return gone
	})
}
