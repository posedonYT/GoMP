package world

import (
	"math"

	"gomp/wire/proto"
)

// ShapeKind enumerates colshape geometries (RAGE.MP ColshapeType names).
type ShapeKind uint8

const (
	ShapeCircle    ShapeKind = iota // 2D circle, infinite height
	ShapeSphere                     // 3D sphere
	ShapeTube                       // vertical cylinder from Z to Z+Height
	ShapeRectangle                  // 2D rectangle centred on (X, Y)
	ShapeCuboid                     // box centred on (X, Y, Z)
	ShapePolygon                    // 2D polygon with min/max Z
)

var shapeNames = [...]string{"circle", "sphere", "tube", "rectangle", "cuboid", "polygon"}

func (k ShapeKind) String() string {
	if int(k) < len(shapeNames) {
		return shapeNames[k]
	}
	return "unknown"
}

// Colshape is a server-side trigger volume. Players entering or leaving it
// fire playerEnterColshape / playerExitColshape.
type Colshape struct {
	EntityBase
	Kind   ShapeKind
	Radius float32
	Width  float32 // X extent (rectangle, cuboid)
	Depth  float32 // Y extent (rectangle, cuboid)
	Height float32 // Z extent (tube, cuboid)
	MinZ   float32 // polygon
	MaxZ   float32 // polygon
	Points []proto.Vec3
	Inside map[uint16]bool // player ids currently inside
}

// Contains reports whether p lies within the shape.
func (c *Colshape) Contains(p proto.Vec3) bool {
	o := c.Pos
	switch c.Kind {
	case ShapeCircle:
		return p.Dist2DSq(o) <= c.Radius*c.Radius
	case ShapeSphere:
		return p.DistSq(o) <= c.Radius*c.Radius
	case ShapeTube:
		return p.Dist2DSq(o) <= c.Radius*c.Radius && p.Z >= o.Z && p.Z <= o.Z+c.Height
	case ShapeRectangle:
		return abs32(p.X-o.X) <= c.Width/2 && abs32(p.Y-o.Y) <= c.Depth/2
	case ShapeCuboid:
		return abs32(p.X-o.X) <= c.Width/2 && abs32(p.Y-o.Y) <= c.Depth/2 && abs32(p.Z-o.Z) <= c.Height/2
	case ShapePolygon:
		return p.Z >= c.MinZ && p.Z <= c.MaxZ && pointInPolygon(p, c.Points)
	}
	return false
}

// BoundingRadius returns a horizontal radius that encloses the shape around
// Pos, used for spatial indexing. Circles have no vertical bound.
func (c *Colshape) BoundingRadius() float32 {
	switch c.Kind {
	case ShapeCircle, ShapeSphere, ShapeTube:
		return c.Radius
	case ShapeRectangle, ShapeCuboid:
		return float32(math.Hypot(float64(c.Width/2), float64(c.Depth/2)))
	case ShapePolygon:
		var r float32
		for _, pt := range c.Points {
			if d := float32(math.Sqrt(float64(pt.Dist2DSq(c.Pos)))); d > r {
				r = d
			}
		}
		return r
	}
	return 0
}

func abs32(f float32) float32 {
	if f < 0 {
		return -f
	}
	return f
}

// pointInPolygon is the even-odd rule in the XY plane.
func pointInPolygon(p proto.Vec3, poly []proto.Vec3) bool {
	in := false
	for i, j := 0, len(poly)-1; i < len(poly); j, i = i, i+1 {
		a, b := poly[i], poly[j]
		if (a.Y > p.Y) != (b.Y > p.Y) && p.X < (b.X-a.X)*(p.Y-a.Y)/(b.Y-a.Y)+a.X {
			in = !in
		}
	}
	return in
}
