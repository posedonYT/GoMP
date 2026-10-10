// The rules of streaming the world, apart from three.js so they can be tested:
// how many requests the world may have running, which models to fetch next and
// the URL of a model.

// Browsers keep about six connections per server. The world takes five at most,
// so whatever the user asks for (a vehicle, a model from the catalog, a form)
// always finds one free and never waits behind the streaming.
export const BROWSER_CONNECTIONS = 6;
export const WORLD_REQUESTS = 5;  // cells and models together
export const CELLS_AT_ONCE = 2;

// How many models may be fetched now: what the cells leave of the world's share
// (once the cells around are in, all five go to models).
export function modelSlots(cellsLoading, modelsLoading) {
  return Math.max(0, WORLD_REQUESTS - cellsLoading - modelsLoading);
}

// low: a model for the world around the camera; the server serves it after the
// user's own requests (ExportSlots.cs). The value must be a boolean the server can
// bind ("true"): "1" made every world model fail with 400.
export function modelUrl(model, lod = 'high', tex = 512, low = false) {
  return `/api/models/${encodeURIComponent(model)}.glb?lod=${lod}&tex=${tex}${low ? '&low=true' : ''}`;
}

// The models to fetch now: queued ones that are visible from where the camera is,
// the nearest first. A model queued at a place the camera has left waits: after a
// jump (a house picked in the list) the new place loads first.
export function nextModels(archetypes, visible, free) {
  if (free <= 0) return [];
  const list = [];
  for (const a of archetypes.values()) if (a.state === 'queued' && visible.has(a.hash)) list.push(a);
  list.sort((x, y) => x.nearest - y.nearest);
  return list.slice(0, free);
}

// Whether the world streams now: not while it is switched off, the game is not
// loaded, or another scene is shown (the vehicle showroom has the view to itself).
export function streaming({ enabled, ready, otherScene }) {
  return !!enabled && !!ready && !otherScene;
}
