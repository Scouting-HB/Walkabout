// Small geodesy helpers. Points are [lat, lon] in degrees throughout.

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Ray-casting point-in-polygon. `ring` is an array of [lat, lon]. */
export function pointInRing(p, ring) {
  let inside = false;
  const [y, x] = p;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Index of the first region containing p, or -1. */
export function regionOf(p, regions) {
  for (let i = 0; i < regions.length; i++) {
    if (regions[i].ring.length >= 3 && pointInRing(p, regions[i].ring)) return i;
  }
  return -1;
}

/** Local equirectangular projection to metres around an origin. */
export function makeProjector([lat0, lon0]) {
  const kx = (Math.PI / 180) * R * Math.cos(rad(lat0));
  const ky = (Math.PI / 180) * R;
  return (p) => [(p[1] - lon0) * kx, (p[0] - lat0) * ky];
}

export function bboxOf(points) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [lat, lon] of points) {
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    if (lon < w) w = lon;
    if (lon > e) e = lon;
  }
  return { s, w, n, e };
}

/** Grow a bbox by `m` metres on every side. */
export function padBbox({ s, w, n, e }, m) {
  const dLat = m / 111320;
  const dLon = m / (111320 * Math.cos(rad((s + n) / 2)));
  return { s: s - dLat, w: w - dLon, n: n + dLat, e: e + dLon };
}

export function ringAreaM2(ring) {
  if (ring.length < 3) return 0;
  const proj = makeProjector(ring[0]);
  const pts = ring.map(proj);
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  }
  return Math.abs(a / 2);
}
