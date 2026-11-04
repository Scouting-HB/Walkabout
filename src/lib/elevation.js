// Elevation lookup. Inside the self-hosted mirror's area we use OpenTopoData
// (Copernicus 30 m DEM, sampled on a ~33 m grid); elsewhere, or if the mirror
// is unreachable, the Open-Meteo API (Copernicus 90 m, sampled on a ~90 m grid).
// Nearby vertices share one sample, and samples are cached in localStorage.

import { ELEVATION_MIRROR, ELEVATION_MIRROR_BOUNDS as MB } from './servers.js';

const OPEN_METEO = 'https://api.open-meteo.com/v1/elevation';
const GRID_MIRROR = 0.0003;
const GRID_PUBLIC = 0.0008;
const STORE = 'walkabout:elev:v2';
const cache = new Map();
try {
  for (const [k, v] of JSON.parse(localStorage.getItem(STORE) ?? '[]')) cache.set(k, v);
} catch {}
function persist() {
  try {
    localStorage.setItem(STORE, JSON.stringify([...cache].slice(-100000)));
  } catch {}
}

const inMirror = (lat, lon) => lat >= MB.s && lat < MB.n && lon >= MB.w && lon < MB.e;
const mKey = (lat, lon) => `m${Math.round(lat / GRID_MIRROR)},${Math.round(lon / GRID_MIRROR)}`;
const oKey = (lat, lon) => `o${Math.round(lat / GRID_PUBLIC)},${Math.round(lon / GRID_PUBLIC)}`;
const keyPoint = (k) => {
  const g = k[0] === 'm' ? GRID_MIRROR : GRID_PUBLIC;
  return k.slice(1).split(',').map((v) => (+v * g).toFixed(5));
};

const sleep = (s, signal) =>
  new Promise((r, j) => {
    const t = setTimeout(r, s * 1000);
    signal?.addEventListener('abort', () => { clearTimeout(t); j(signal.reason); }, { once: true });
  });

async function fetchMirror(keys, signal) {
  const res = await fetch(ELEVATION_MIRROR, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations: keys.map((k) => keyPoint(k).join(',')).join('|') }),
    signal,
  });
  if (!res.ok) throw new Error(`elevation mirror error ${res.status}`);
  const { results } = await res.json();
  keys.forEach((k, i) => {
    const v = results[i]?.elevation;
    cache.set(k, v == null ? null : Math.round(v * 10) / 10); // null = no tile here
  });
}

async function fetchOpenMeteo(keys, signal, onWait) {
  const pts = keys.map(keyPoint);
  const url = `${OPEN_METEO}?latitude=${pts.map((p) => p[0]).join(',')}&longitude=${pts.map((p) => p[1]).join(',')}`;
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
    await sleep(wait, signal);
  }
}

/** Remove elevations so the planner treats the area as flat. */
export function clearElevations(graph) {
  for (const e of graph.edges) delete e.elev;
}

/** Adds `elev` arrays (one value per coordinate) to every edge in place. */
export async function addElevations(graph, { signal, onStatus } = {}) {
  const coords = graph.edges.flatMap((e) => e.coords);

  // 1. Mirror, where it has coverage.
  let mirrorOk = true;
  const mNeed = [...new Set(coords.filter(([la, lo]) => inMirror(la, lo)).map(([la, lo]) => mKey(la, lo)))].filter((k) => !cache.has(k));
  for (let i = 0; i < mNeed.length && mirrorOk; i += 500) {
    onStatus?.(`Looking up elevation… ${Math.round((i / mNeed.length) * 100)}%`);
    try {
      await fetchMirror(mNeed.slice(i, i + 500), signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      mirrorOk = false; // fall back to the public service for the rest
    }
  }
  const fromMirror = (la, lo) => {
    if (!inMirror(la, lo)) return undefined;
    const v = cache.get(mKey(la, lo));
    return v == null ? undefined : v;
  };

  // 2. Open-Meteo for everything else.
  const oNeed = [...new Set(coords.filter(([la, lo]) => fromMirror(la, lo) === undefined).map(([la, lo]) => oKey(la, lo)))].filter((k) => !cache.has(k));
  const total = Math.ceil(oNeed.length / 100);
  for (let i = 0; i < total; i++) {
    onStatus?.(`Looking up elevation… ${Math.round((i / total) * 100)}%`);
    await fetchOpenMeteo(oNeed.slice(i * 100, i * 100 + 100), signal, (s) => onStatus?.(`Elevation service is busy, retrying in ${s}s…`));
    if (i % 5 === 4) persist();
  }
  persist();

  for (const e of graph.edges) {
    e.elev = e.coords.map(([la, lo]) => fromMirror(la, lo) ?? cache.get(oKey(la, lo)) ?? 0);
  }
}
