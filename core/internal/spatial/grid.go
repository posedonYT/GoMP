// Package spatial is a uniform hash grid per dimension used for streaming
// and range queries. Positions are bucketed in the XY plane; queries use
// full 3D distance.
package spatial

import (
	"math"

	"gomp/wire/proto"
)

// Key identifies an indexed entity.
type Key = proto.EntityRef

type item struct {
	key Key
	pos proto.Vec3
}

type loc struct {
	dim  uint32
	cell uint64
	idx  int
}

type dimGrid struct {
	cells map[uint64][]item
	count int
}

// Grid indexes entity positions.
type Grid struct {
	size  float32
	inv   float32
	dims  map[uint32]*dimGrid
	index map[Key]loc
}

// New creates a grid with square cells of cellSize metres.
func New(cellSize float32) *Grid {
	if cellSize <= 0 {
		cellSize = 100
	}
	return &Grid{size: cellSize, inv: 1 / cellSize, dims: make(map[uint32]*dimGrid), index: make(map[Key]loc)}
}

func (g *Grid) cellCoord(v float32) int32 {
	return int32(math.Floor(float64(v * g.inv)))
}

func pack(cx, cy int32) uint64 { return uint64(uint32(cx))<<32 | uint64(uint32(cy)) }

func (g *Grid) cellOf(p proto.Vec3) uint64 { return pack(g.cellCoord(p.X), g.cellCoord(p.Y)) }

// Len returns the number of indexed entities.
func (g *Grid) Len() int { return len(g.index) }

// Upsert inserts k or updates its dimension and position.
func (g *Grid) Upsert(k Key, dim uint32, pos proto.Vec3) {
	c := g.cellOf(pos)
	if l, ok := g.index[k]; ok {
		if l.dim == dim && l.cell == c {
			g.dims[dim].cells[c][l.idx].pos = pos
			return
		}
		g.remove(k, l)
	}
	d := g.dims[dim]
	if d == nil {
		d = &dimGrid{cells: make(map[uint64][]item)}
		g.dims[dim] = d
	}
	items := d.cells[c]
	g.index[k] = loc{dim: dim, cell: c, idx: len(items)}
	d.cells[c] = append(items, item{key: k, pos: pos})
	d.count++
}

// Remove deletes k if present.
func (g *Grid) Remove(k Key) {
	if l, ok := g.index[k]; ok {
		g.remove(k, l)
	}
}

func (g *Grid) remove(k Key, l loc) {
	d := g.dims[l.dim]
	items := d.cells[l.cell]
	last := len(items) - 1
	if l.idx != last {
		moved := items[last]
		items[l.idx] = moved
		ml := g.index[moved.key]
		ml.idx = l.idx
		g.index[moved.key] = ml
	}
	items[last] = item{}
	items = items[:last]
	if len(items) == 0 {
		delete(d.cells, l.cell)
	} else {
		d.cells[l.cell] = items
	}
	d.count--
	if d.count == 0 {
		delete(g.dims, l.dim)
	}
	delete(g.index, k)
}

// Position returns the indexed position and dimension of k.
func (g *Grid) Position(k Key) (proto.Vec3, uint32, bool) {
	l, ok := g.index[k]
	if !ok {
		return proto.Vec3{}, 0, false
	}
	return g.dims[l.dim].cells[l.cell][l.idx].pos, l.dim, true
}

// Query calls fn for every entity within radius of center that is visible
// from dim: entities in dim itself and in proto.GlobalDimension.
func (g *Grid) Query(dim uint32, center proto.Vec3, radius float32, fn func(k Key, pos proto.Vec3, distSq float32)) {
	g.QueryDim(dim, center, radius, fn)
	if dim != proto.GlobalDimension {
		g.QueryDim(proto.GlobalDimension, center, radius, fn)
	}
}

// QueryDim is Query restricted to exactly one dimension.
func (g *Grid) QueryDim(dim uint32, center proto.Vec3, radius float32, fn func(k Key, pos proto.Vec3, distSq float32)) {
	d := g.dims[dim]
	if d == nil {
		return
	}
	r2 := radius * radius
	x0, x1 := g.cellCoord(center.X-radius), g.cellCoord(center.X+radius)
	y0, y1 := g.cellCoord(center.Y-radius), g.cellCoord(center.Y+radius)
	// Iterating occupied cells is cheaper than probing a huge empty range.
	if span := int64(x1-x0+1) * int64(y1-y0+1); span > int64(len(d.cells)) {
		for c, items := range d.cells {
			cx, cy := int32(uint32(c>>32)), int32(uint32(c))
			if cx < x0 || cx > x1 || cy < y0 || cy > y1 {
				continue
			}
			visit(items, center, r2, fn)
		}
		return
	}
	for cx := x0; cx <= x1; cx++ {
		for cy := y0; cy <= y1; cy++ {
			if items, ok := d.cells[pack(cx, cy)]; ok {
				visit(items, center, r2, fn)
			}
		}
	}
}

func visit(items []item, center proto.Vec3, r2 float32, fn func(Key, proto.Vec3, float32)) {
	for _, it := range items {
		if d2 := it.pos.DistSq(center); d2 <= r2 {
			fn(it.key, it.pos, d2)
		}
	}
}

// EachInDim calls fn for every entity in exactly dim.
func (g *Grid) EachInDim(dim uint32, fn func(k Key, pos proto.Vec3)) {
	d := g.dims[dim]
	if d == nil {
		return
	}
	for _, items := range d.cells {
		for _, it := range items {
			fn(it.key, it.pos)
		}
	}
}
