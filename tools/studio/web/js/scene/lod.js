// Which entities of the world are drawn, like the game's levels of detail: an
// entity is drawn up to the distance where its parent (a lower-detail stand-in)
// hands over to it (u), and an entity with children is hidden where they take
// over (c). Entities come from /api/world/cell (WorldIndex.cs): l level, d lod
// distance, c child lod distance, u upper distance, k has children, p position.

export const HD = 0;
export const ORPHAN_HD = 5;

export function isDetailed(e) {
  return e.l === HD || e.l === ORPHAN_HD;
}

export function isVisible(e, distance) {
  const upper = e.u === undefined ? e.d : e.u;
  const children = e.k === undefined ? !isDetailed(e) : e.k;
  return distance <= upper && (!children || distance > e.c);
}

export function distanceTo(e, x, y, z) {
  return Math.hypot(e.p[0] - x, e.p[1] - y, e.p[2] - z);
}

// The visible entities grouped by archetype, each with its distance; the
// nearest distance per archetype tells which model to load first.
export function visibleByArchetype(entities, x, y, z) {
  const groups = new Map();
  for (const e of entities) {
    const d = distanceTo(e, x, y, z);
    if (!isVisible(e, d)) continue;
    let g = groups.get(e.a);
    if (!g) groups.set(e.a, (g = { entities: [], nearest: Infinity }));
    g.entities.push(e);
    if (d < g.nearest) g.nearest = d;
  }
  return groups;
}
