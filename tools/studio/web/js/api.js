// The Studio's HTTP API (tools/studio/GoMP.Studio/Api.cs).

export class ApiError extends Error {
  constructor(status, body) {
    super(body && body.error ? body.error : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const enc = encodeURIComponent;

export const api = {
  status: () => call('GET', '/api/status'),
  maps: () => call('GET', '/api/maps'),
  map: (name) => call('GET', `/api/maps/${enc(name)}`),
  saveMap: (name, doc) => call('PUT', `/api/maps/${enc(name)}`, doc),
  renameMap: (name, to) => call('POST', `/api/maps/${enc(name)}/rename?to=${enc(to)}`),
  deleteMap: (name) => call('DELETE', `/api/maps/${enc(name)}`),
  cursor: () => call('GET', '/api/cursor'),
  // { total, offset, items }: one page of the catalog; cat is a category id.
  catalog: (q, { cat = '', offset = 0, limit = 200 } = {}) =>
    call('GET', `/api/catalog?q=${enc(q)}&cat=${enc(cat)}&offset=${offset}&limit=${limit}`),
  categories: () => call('GET', '/api/catalog/categories'),
  model: (model) => call('GET', `/api/catalog/${enc(model)}`),
  // { doc, states, nextId, issues }; saving answers { saved, issues, nextId } or 400 { error, issues }.
  houses: () => call('GET', '/api/houses'),
  saveHouses: (doc) => call('PUT', '/api/houses', doc),
  // { mlos, entities } of the interior around a point (only='contains': the one that holds it).
  interiorGeometry: (x, y, z, r = 60, only = 'contains') =>
    call('GET', `/api/interiors/geometry?x=${x}&y=${y}&z=${z}&r=${r}&only=${enc(only)}`),
  // { nodes: [{ pos, headings, dist }], suggest: { pos, heading } | null }: the vehicle path
  // nodes around a point; 503 while the game loads, 404 on a Studio without road data.
  roadsNearest: (x, y, z, r = 60) => call('GET', `/api/roads/nearest?x=${x}&y=${y}&z=${z}&r=${r}`),
};

// Server-sent events: fn(type, data) for gta, cursor, maps and houses.
export function listen(fn) {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    try {
      const { type, data } = JSON.parse(e.data);
      fn(type, data);
    } catch {
      // not ours
    }
  };
  return es;
}
