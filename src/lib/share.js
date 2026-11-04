// Share links. Everything lives in the URL fragment (after #), so it never reaches a
// server: the data is JSON, deflate-compressed and base64url-encoded.
//   #walk=…   one walker's finished route, shown read-only (no replanning)
//   #setup=…  regions, points and settings, loaded into the planner

const KINDS = ['work', 'walk', 'gap'];

// Google's encoded polyline format (1e-5 degrees, ~1 m), about 5 characters per point.
export function encodePolyline(coords) {
  let out = '', pla = 0, plo = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    out += String.fromCharCode(v + 63);
  };
  for (const [la, lo] of coords) {
    const a = Math.round(la * 1e5), o = Math.round(lo * 1e5);
    enc(a - pla); enc(o - plo);
    pla = a; plo = o;
  }
  return out;
}

export function decodePolyline(str) {
  const coords = [];
  let i = 0, la = 0, lo = 0;
  const dec = () => {
    let r = 0, s = 0, b;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20 && i <= str.length);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < str.length) {
    la += dec(); lo += dec();
    coords.push([la / 1e5, lo / 1e5]);
  }
  return coords;
}

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
function toB64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
export async function pack(obj) {
  return toB64url(await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream('deflate-raw')));
}
export async function unpack(str) {
  return JSON.parse(new TextDecoder().decode(await pipe(fromB64url(str), new DecompressionStream('deflate-raw'))));
}

const r5 = (pt) => pt && [+pt[0].toFixed(5), +pt[1].toFixed(5)];
const r6 = (pt) => [+pt[0].toFixed(6), +pt[1].toFixed(6)];

/** Compact, self-contained copy of one walker's route. */
export function walkerPayload(w, index, title) {
  return {
    v: 1,
    t: title || '',
    i: index,
    lb: w.label,
    L: Math.round(w.length), W: Math.round(w.work), U: Math.round(w.up), D: Math.round(w.down),
    s: r5(w.start), e: r5(w.end),
    S: w.streets.map((s) => [KINDS.indexOf(s.kind), s.name || '', Math.round(s.meters), s.side || '', s.turn || '', s.heading || '', s.crossBefore ?? [], s.crossing ?? [], s.seg ?? null]),
    P: w.pieces.map((p) => [KINDS.indexOf(p.kind), p.offset || 0, encodePolyline(p.coords)]),
  };
}

/** Rebuilds the walker object the map and GPX export expect. */
export function walkerFromPayload(d) {
  if (d?.v !== 1 || !Array.isArray(d.P)) throw new Error('This route link is damaged or from a newer version.');
  return {
    title: d.t,
    index: d.i,
    walker: {
      label: d.lb || `Walker ${d.i + 1}`,
      length: d.L, work: d.W, up: d.U, down: d.D,
      start: d.s ?? null, end: d.e ?? null,
      streets: d.S.map(([k, name, meters, side, turn, heading, crossBefore, crossing, seg]) => ({ kind: KINDS[k], name, meters, side, turn, heading, crossBefore, crossing, seg })),
      pieces: d.P.map(([k, offset, line]) => ({ kind: KINDS[k], offset, coords: decodePolyline(line) })),
    },
  };
}

const SETUP_KEYS = ['title', 'paired', 'returnToStart', 'walkers', 'climbWeight', 'countTravel', 'sideTypes', 'useElevation', 'coverTypes'];

export function setupPayload(p) {
  const out = { v: 1 };
  for (const k of SETUP_KEYS) out[k] = p[k];
  out.regions = p.regions.map((r) => ({ name: r.name, color: r.color, ring: r.ring.map(r6) }));
  out.starts = p.starts.map(r6);
  out.ends = p.ends.map(r6);
  return out;
}

export function setupFromPayload(d) {
  if (d?.v !== 1 || !Array.isArray(d.regions)) throw new Error('This setup link is damaged or from a newer version.');
  const out = {};
  for (const k of SETUP_KEYS) if (k in d) out[k] = d[k];
  out.regions = d.regions.map((r, i) => ({ id: `${Date.now()}-${i}`, name: String(r.name ?? `Region ${i + 1}`), color: r.color, ring: r.ring }));
  out.starts = d.starts ?? [];
  out.ends = d.ends ?? [];
  return out;
}

/** The page URL (without any fragment) plus a share fragment. */
export function shareUrl(kind, data) {
  return `${location.origin}${location.pathname}${location.search}#${kind}=${data}`;
}

/** Reads #walk=… or #setup=… from the current URL. */
export function readHash() {
  const m = /^#(walk|setup)=([\w-]+)$/.exec(location.hash);
  return m ? { kind: m[1], data: m[2] } : null;
}

/** Share sheet on phones, clipboard elsewhere. Resolves to what happened. */
export async function sendLink(url, title) {
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title, url });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }
  await navigator.clipboard.writeText(url);
  return 'copied';
}
