// Elevation lookup via the Open-Meteo elevation API (Copernicus 90 m DEM).
// Points are bucketed to a ~50 m grid so nearby vertices share one sample.

const API = 'https://api.open-meteo.com/v1/elevation';
const GRID = 0.0008; // ~90 m, the DEM's own resolution
const STORE = 'walkabout:elev:v1';
const cache = new Map();
try {
  for (const [k, v] of JSON.parse(localStorage.getItem(STORE) ?? '[]')) cache.set(k, v);
} catch {}
function persist() {
  try {
    const entries = [...cache].slice(-60000);
    localStorage.setItem(STORE, JSON.stringify(entries));
  } catch {}
}

const key = (lat, lon) => `${Math.round(lat / GRID)},${Math.round(lon / GRID)}`;

async function fetchBatch(keys, signal, onWait) {
  const pts = keys.map((k) => k.split(',').map((v) => (+v * GRID).toFixed(5)));
  const url = `${API}?latitude=${pts.map((p) => p[0]).join(',')}&longitude=${pts.map((p) => p[1]).join(',')}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal });
    if (res.ok) {
      const { elevation } = await res.json();
      keys.forEach((k, i) => cache.set(k, elevation[i]));
      return;
    }
    if (attempt >= 3 || (res.status !== 429 && res.status < 500)) {
      throw new Error(`Elevation service error ${res.status}`);
    }
    // Open-Meteo's free tier is rate limited per minute; wait it out.
    const wait = Math.min(65, +(res.headers.get('Retry-After') ?? 0) || 5 * 2 ** attempt);
    onWait?.(wait);
    await new Promise((r, j) => {
      const t = setTimeout(r, wait * 1000);
      signal?.addEventListener('abort', () => { clearTimeout(t); j(signal.reason); }, { once: true });
    });
  }
}

/** Remove elevations so the planner treats the area as flat. */
export function clearElevations(graph) {
  for (const e of graph.edges) delete e.elev;
}

/** Adds `elev` arrays (one value per coordinate) to every edge in place. */
export async function addElevations(graph, { signal, onStatus } = {}) {
  const need = new Set();
  for (const e of graph.edges) for (const [lat, lon] of e.coords) {
    const k = key(lat, lon);
    if (!cache.has(k)) need.add(k);
  }
  const todo = [...need];
  const batches = [];
  for (let i = 0; i < todo.length; i += 100) batches.push(todo.slice(i, i + 100));
  const total = batches.length;
  for (let i = 0; i < total; i++) {
    onStatus?.(`Looking up elevation… ${Math.round((i / total) * 100)}%`);
    await fetchBatch(batches[i], signal, (s) => onStatus?.(`Elevation service is busy, retrying in ${s}s…`));
    persist();
  }
  for (const e of graph.edges) {
    e.elev = e.coords.map(([lat, lon]) => cache.get(key(lat, lon)) ?? 0);
  }
}
