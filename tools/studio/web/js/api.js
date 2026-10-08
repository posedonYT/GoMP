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
  catalog: (q, limit = 80) => call('GET', `/api/catalog?q=${enc(q)}&limit=${limit}`),
  model: (model) => call('GET', `/api/catalog/${enc(model)}`),
};

// Server-sent events: fn(type, data) for gta, cursor and maps.
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
