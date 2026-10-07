package world

import "errors"

// ErrPoolFull is returned when no id is free.
var ErrPoolFull = errors.New("world: entity pool is full")

// Pool stores entities by a dense uint16 id. Every slot carries a generation
// counter that increments when the slot is freed, so stale references held
// by scripts (type, id, gen) can be detected after id reuse.
type Pool[T any] struct {
	items []*T
	gens  []uint16
	free  []uint16 // stack of free ids (initially lowest on top, then LIFO)
	count int
}

// NewPool creates a pool with ids 0..capacity-1.
func NewPool[T any](capacity int) *Pool[T] {
	if capacity > 0xFFFF {
		capacity = 0xFFFF // 0xFFFF is reserved as "no id"
	}
	p := &Pool[T]{
		items: make([]*T, capacity),
		gens:  make([]uint16, capacity),
		free:  make([]uint16, capacity),
	}
	for i := range capacity {
		p.free[i] = uint16(capacity - 1 - i)
	}
	return p
}

// Cap returns the pool capacity.
func (p *Pool[T]) Cap() int { return len(p.items) }

// Len returns the number of live entities.
func (p *Pool[T]) Len() int { return p.count }

// Get returns the entity with id or nil.
func (p *Pool[T]) Get(id uint16) *T {
	if int(id) >= len(p.items) {
		return nil
	}
	return p.items[id]
}

// Gen returns the current generation of id.
func (p *Pool[T]) Gen(id uint16) uint16 {
	if int(id) >= len(p.gens) {
		return 0
	}
	return p.gens[id]
}

// GetGen returns the entity only if its generation matches.
func (p *Pool[T]) GetGen(id, gen uint16) *T {
	if e := p.Get(id); e != nil && p.gens[id] == gen {
		return e
	}
	return nil
}

// Alloc stores e under the lowest free id.
func (p *Pool[T]) Alloc(e *T) (uint16, error) {
	for len(p.free) > 0 {
		id := p.free[len(p.free)-1]
		p.free = p.free[:len(p.free)-1]
		if p.items[id] != nil {
			continue // taken through AllocAt
		}
		p.items[id] = e
		p.count++
		return id, nil
	}
	return 0, ErrPoolFull
}

// AllocAt stores e under a specific free id (used for entities whose ids are
// chosen by a script host inside its assigned id range).
func (p *Pool[T]) AllocAt(id uint16, e *T) bool {
	if int(id) >= len(p.items) || p.items[id] != nil {
		return false
	}
	p.items[id] = e
	p.count++
	return true // a stale copy of id in the free list is skipped by Alloc
}

// Free removes the entity with id and bumps the slot generation.
func (p *Pool[T]) Free(id uint16) {
	if int(id) >= len(p.items) || p.items[id] == nil {
		return
	}
	p.items[id] = nil
	p.gens[id]++
	p.count--
	p.free = append(p.free, id)
}

// Each calls fn for every live entity in id order.
func (p *Pool[T]) Each(fn func(id uint16, e *T)) {
	for i, e := range p.items {
		if e != nil {
			fn(uint16(i), e)
		}
	}
}
