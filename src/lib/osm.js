// Fetch walkable streets from OpenStreetMap (Overpass) and turn them into a
// routing graph whose edges run between intersections.

import { haversine, regionOf, pointInRing } from './geo.js';
import { OVERPASS_MIRROR, OVERPASS_PUBLIC, OVERPASS_MIRROR_COVERAGE } from './servers.js';

/** The mirror only holds its extract, so use it only when the whole bbox is inside. */
export function mirrorCovers({ s, w, n, e }) {
  return [[s, w], [s, e], [n, w], [n, e]].every((p) => pointInRing(p, OVERPASS_MIRROR_COVERAGE));
}

/** Highway types people might want to canvass, in display order. */
export const STREET_TYPES = [
  { key: 'residential', label: 'Residential streets', default: true },
  { key: 'living_street', label: 'Living streets', default: true },
  { key: 'unclassified', label: 'Unclassified / minor roads', default: true },
  { key: 'tertiary', label: 'Tertiary (collector) roads', default: true },
  { key: 'secondary', label: 'Secondary roads', default: true },
  { key: 'primary', label: 'Primary roads', default: false },
  { key: 'service', label: 'Service roads / alleys', default: false },
  { key: 'track', label: 'Tracks / gravel lanes', default: false },
];

/** Types busy enough that scouts shouldn't criss-cross them: each side is its own pass. */
export const BUSY_TYPES = ['tertiary', 'secondary', 'primary'];

const NOT_WALKABLE = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'construction',
  'proposed', 'abandoned', 'raceway', 'bus_guideway', 'escape', 'platform',
  'corridor', 'elevator', 'bridleway',
]);

function walkable(tags) {
  if (NOT_WALKABLE.has(tags.highway)) return false;
  if (tags.area === 'yes') return false;
  if (tags.foot === 'no' || tags.foot === 'private') return false;
  if ((tags.access === 'no' || tags.access === 'private') && !['yes', 'designated', 'permissive'].includes(tags.foot)) return false;
  return true;
}

function coverable(tags, coverTypes) {
  const t = tags.highway;
  if (!coverTypes.has(t)) return false;
  // Driveways and parking aisles have no doors to knock on.
  if (t === 'service' && ['driveway', 'parking_aisle', 'drive-through'].includes(tags.service)) return false;
  return true;
}

export async function fetchOsm(bbox, { signal, onStatus } = {}) {
  const { s, w, n, e } = bbox;
  const q = `[out:json][timeout:120];way["highway"](${s},${w},${n},${e});out body;>;out skel qt;`;
  let lastErr;
  const urls = mirrorCovers(bbox) ? [OVERPASS_MIRROR, ...OVERPASS_PUBLIC] : OVERPASS_PUBLIC;
  for (const url of urls) {
    try {
      onStatus?.(`Downloading streets from ${new URL(url).host}…`);
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: q }),
        signal,
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      // An empty answer from the mirror more likely means missing data than an empty area.
      if (url === OVERPASS_MIRROR && !data.elements?.length) throw new Error('mirror returned no data');
      return data;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw new Error(`Could not download streets from OpenStreetMap (${lastErr?.message ?? 'unknown error'}).`);
}

/**
 * Build a graph from an Overpass response.
 * Returns { nodes: [{id, lat, lon}], edges: [{a, b, coords, length, name, highway, need, sides, region}] }
 * where a/b index `nodes`, `need` is 1 if the street must be canvassed (0 = transit only),
 * `sides` means each side is a separate pass rather than one criss-cross pass, and
 * `region` is the region index the edge is in (-1 if outside).
 */
export function buildGraph(osm, regions, { coverTypes, sideTypes = new Set() }) {
  const coords = new Map();
  const ways = [];
  for (const el of osm.elements) {
    if (el.type === 'node') coords.set(el.id, [el.lat, el.lon]);
    else if (el.type === 'way' && el.tags && walkable(el.tags)) ways.push(el);
  }

  // A node is a junction if it is shared by ways or ends a way.
  const use = new Map();
  for (const w of ways) {
    w.nodes.forEach((id, i) => {
      const extra = i === 0 || i === w.nodes.length - 1 ? 2 : 1;
      use.set(id, (use.get(id) ?? 0) + extra);
    });
  }

  const nodeIndex = new Map();
  const nodes = [];
  const idx = (id) => {
    let i = nodeIndex.get(id);
    if (i === undefined) {
      const [lat, lon] = coords.get(id);
      i = nodes.length;
      nodes.push({ id, lat, lon });
      nodeIndex.set(id, i);
    }
    return i;
  };

  const edges = [];
  for (const w of ways) {
    const ids = w.nodes.filter((id) => coords.has(id));
    if (ids.length < 2) continue;
    const canCover = coverable(w.tags, coverTypes);
    const sides = canCover && sideTypes.has(w.tags.highway);
    const name = w.tags.name || w.tags.ref || '';

    // Classify each atomic segment by the region its midpoint falls in.
    const segRegion = [];
    for (let i = 0; i < ids.length - 1; i++) {
      const p = coords.get(ids[i]);
      const q = coords.get(ids[i + 1]);
      segRegion.push(canCover ? regionOf([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], regions) : -1);
    }

    let startI = 0;
    for (let i = 1; i < ids.length; i++) {
      const last = i === ids.length - 1;
      const split = last || use.get(ids[i]) > 1 || segRegion[i] !== segRegion[i - 1];
      if (!split) continue;
      const run = ids.slice(startI, i + 1);
      const c = run.map((id) => coords.get(id));
      let length = 0;
      for (let k = 1; k < c.length; k++) length += haversine(c[k - 1], c[k]);
      const region = segRegion[startI];
      edges.push({
        a: idx(run[0]),
        b: idx(run[run.length - 1]),
        coords: c,
        length,
        name,
        highway: w.tags.highway,
        need: region >= 0 ? 1 : 0,
        sides: region >= 0 && sides,
        region,
      });
      startI = i;
    }
  }
  return { nodes, edges };
}
