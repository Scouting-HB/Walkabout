// Route planner: split the streets that must be canvassed among N walkers so
// their routes are as even as possible in length and climbing.
//
// 1. Balanced k-means groups the required street segments into N areas.
// 2. Start/end points are matched to areas (Hungarian assignment).
// 3. Each area gets a covering walk: follow unwalked streets where possible,
//    otherwise take the cheapest path to the nearest unwalked street.
// 4. Refinement repeatedly hands boundary streets from the busiest walker to a
//    lighter neighbour while that lowers the busiest walker's effort.
//
// "Effort" is metres walked plus `climbWeight` metres per metre climbed
// (Naismith's rule is roughly 8).

import { haversine, makeProjector } from './geo.js';

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Min-cost assignment of rows to distinct columns (rows <= cols). Returns col per row. */
export function hungarian(cost) {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  const INF = Infinity;
  const u = new Float64Array(n + 1), v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1), way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(INF);
    const used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const res = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) res[p[j] - 1] = j - 1;
  return res;
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  clear() { this.k.length = 0; this.v.length = 0; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const topV = v[0], topK = k[0];
    const lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    this.lastKey = topK;
    return topV;
  }
}

export function plan(graph, opts = {}, onProgress = () => {}) {
  const {
    walkers = 1,
    climbWeight = 8,
    starts = [],
    ends = [],
    paired = false,
    returnToStart = false,
    countTravel = true,
    timeBudgetMs = 6000,
    seed = 1,
  } = opts;
  const { nodes, edges } = graph;
  const V = nodes.length, E = edges.length;
  const warnings = [];
  const t0 = Date.now();

  // ---- edge costs -------------------------------------------------------
  const len = new Float64Array(E), upF = new Float64Array(E), upB = new Float64Array(E);
  const costF = new Float64Array(E), costB = new Float64Array(E);
  for (let i = 0; i < E; i++) {
    const e = edges[i];
    len[i] = e.length;
    if (e.elev) {
      for (let j = 1; j < e.elev.length; j++) {
        const d = e.elev[j] - e.elev[j - 1];
        if (d > 0) upF[i] += d; else upB[i] -= d;
      }
    }
    costF[i] = len[i] + climbWeight * upF[i];
    costB[i] = len[i] + climbWeight * upB[i];
  }

  // ---- adjacency (CSR) --------------------------------------------------
  const deg = new Int32Array(V);
  for (const e of edges) { deg[e.a]++; deg[e.b]++; }
  const adjStart = new Int32Array(V + 1);
  for (let i = 0; i < V; i++) adjStart[i + 1] = adjStart[i] + deg[i];
  const fill = adjStart.slice(0, V);
  const adjEdge = new Int32Array(2 * E), adjTo = new Int32Array(2 * E), adjDir = new Uint8Array(2 * E);
  edges.forEach((e, i) => {
    let s = fill[e.a]++; adjEdge[s] = i; adjTo[s] = e.b; adjDir[s] = 0;
    s = fill[e.b]++; adjEdge[s] = i; adjTo[s] = e.a; adjDir[s] = 1;
  });

  // ---- shortest paths ---------------------------------------------------
  const dist = new Float64Array(V);
  const prevEdge = new Int32Array(V), prevDir = new Uint8Array(V);
  const stamp = new Int32Array(V);
  let curStamp = 0;
  const heap = new Heap();
  let lastSrc = -1;
  function dijkstra(src, isTarget) {
    curStamp++;
    lastSrc = src;
    heap.clear();
    stamp[src] = curStamp; dist[src] = 0; prevEdge[src] = -1;
    heap.push(0, src);
    while (heap.size) {
      const u = heap.pop();
      const d = heap.lastKey;
      if (d > dist[u]) continue;
      if (isTarget(u)) return u;
      for (let s = adjStart[u]; s < adjStart[u + 1]; s++) {
        const v = adjTo[s], ei = adjEdge[s];
        const nd = d + (adjDir[s] ? costB[ei] : costF[ei]);
        if (stamp[v] !== curStamp || nd < dist[v]) {
          stamp[v] = curStamp; dist[v] = nd; prevEdge[v] = ei; prevDir[v] = adjDir[s];
          heap.push(nd, v);
        }
      }
    }
    return -1;
  }
  function pathSteps(t) {
    const out = [];
    let x = t;
    while (x !== lastSrc) {
      const ei = prevEdge[x], dir = prevDir[x];
      out.push({ e: ei, dir, kind: 'walk' });
      x = dir ? edges[ei].b : edges[ei].a;
    }
    return out.reverse();
  }

  // ---- components & snapping -------------------------------------------
  const comp = new Int32Array(V).fill(-1);
  const compReq = [];
  for (let s = 0; s < V; s++) {
    if (comp[s] >= 0) continue;
    const c = compReq.length;
    compReq.push(0);
    const stack = [s];
    comp[s] = c;
    while (stack.length) {
      const u = stack.pop();
      for (let k = adjStart[u]; k < adjStart[u + 1]; k++) {
        const v = adjTo[k];
        if (comp[v] < 0) { comp[v] = c; stack.push(v); }
      }
    }
  }
  const req = [];
  edges.forEach((e, i) => { if (e.need > 0) { req.push(i); compReq[comp[e.a]] += len[i] * e.need; } });
  if (!req.length) {
    return { walkers: [], warnings: ['No streets to canvass were found inside the regions.'], stats: null };
  }
  let mainComp = 0;
  compReq.forEach((v, c) => { if (v > compReq[mainComp]) mainComp = c; });
  const snap = (p) => {
    let best = -1, bd = Infinity;
    for (let i = 0; i < V; i++) {
      if (comp[i] !== mainComp) continue;
      const d = haversine(p, [nodes[i].lat, nodes[i].lon]);
      if (d < bd) { bd = d; best = i; }
    }
    if (bd > 400) warnings.push(`A start/end point is ${Math.round(bd)} m from the nearest mapped street.`);
    return best;
  };

  // ---- clustering -------------------------------------------------------
  const nU = req.length;
  const k = Math.max(1, Math.min(walkers, nU));
  if (walkers > nU) warnings.push(`Only ${nU} street segments to cover, so only ${nU} walkers get a route.`);
  const allPts = [];
  for (const i of req) allPts.push(...edges[i].coords);
  const origin = [allPts.reduce((s, p) => s + p[0], 0) / allPts.length, allPts.reduce((s, p) => s + p[1], 0) / allPts.length];
  const proj = makeProjector(origin);
  const nodeXY = nodes.map((n) => proj([n.lat, n.lon]));
  const ux = new Float64Array(nU), uy = new Float64Array(nU), uw = new Float64Array(nU);
  req.forEach((ei, j) => {
    const c = edges[ei].coords;
    const [x, y] = proj(c[c.length >> 1]);
    const [x0, y0] = proj(c[0]);
    const [x1, y1] = proj(c[c.length - 1]);
    ux[j] = (x + x0 + x1) / 3; uy[j] = (y + y0 + y1) / 3;
    uw[j] = (len[ei] + climbWeight * (upF[ei] + upB[ei]) / 2) * edges[ei].need + 1;
  });

  const rnd = mulberry32(seed);
  const cx = new Float64Array(k), cy = new Float64Array(k);
  {
    // weighted k-means++ seeding
    const total = uw.reduce((a, b) => a + b, 0);
    let r = rnd() * total, j = 0;
    while (j < nU - 1 && (r -= uw[j]) > 0) j++;
    cx[0] = ux[j]; cy[0] = uy[j];
    const d2 = new Float64Array(nU).fill(Infinity);
    for (let c = 1; c < k; c++) {
      let sum = 0;
      for (let i = 0; i < nU; i++) {
        const d = (ux[i] - cx[c - 1]) ** 2 + (uy[i] - cy[c - 1]) ** 2;
        if (d < d2[i]) d2[i] = d;
        sum += d2[i] * uw[i];
      }
      let rr = rnd() * sum, pick = 0;
      for (let i = 0; i < nU; i++) { rr -= d2[i] * uw[i]; if (rr <= 0) { pick = i; break; } }
      cx[c] = ux[pick]; cy[c] = uy[pick];
    }
  }
  const assign = new Int32Array(nU);
  {
    const total = uw.reduce((a, b) => a + b, 0);
    const target = total / k;
    let mx = 0, my = 0;
    for (let i = 0; i < nU; i++) { mx += ux[i]; my += uy[i]; }
    mx /= nU; my /= nU;
    let spread = 0;
    for (let i = 0; i < nU; i++) spread += (ux[i] - mx) ** 2 + (uy[i] - my) ** 2;
    const scale = Math.sqrt(spread / nU) / Math.sqrt(k) + 1;
    const bias = new Float64Array(k);
    const load = new Float64Array(k);
    for (let it = 0; it < 120; it++) {
      load.fill(0);
      for (let i = 0; i < nU; i++) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const d = Math.hypot(ux[i] - cx[c], uy[i] - cy[c]) + bias[c];
          if (d < bd) { bd = d; best = c; }
        }
        assign[i] = best; load[best] += uw[i];
      }
      const step = 0.5 * scale * (1 - it / 140);
      for (let c = 0; c < k; c++) bias[c] += step * (load[c] - target) / target;
      if (it % 3 === 2 && it < 100) {
        const sx = new Float64Array(k), sy = new Float64Array(k), sw = new Float64Array(k);
        for (let i = 0; i < nU; i++) { const c = assign[i]; sx[c] += ux[i] * uw[i]; sy[c] += uy[i] * uw[i]; sw[c] += uw[i]; }
        for (let c = 0; c < k; c++) {
          if (sw[c] > 0) { cx[c] = sx[c] / sw[c]; cy[c] = sy[c] / sw[c]; } else {
            const i = Math.floor(rnd() * nU); cx[c] = ux[i]; cy[c] = uy[i]; bias[c] = 0;
          }
        }
      }
    }
    // never leave a walker with nothing
    for (let c = 0; c < k; c++) {
      if (!assign.some((a) => a === c)) {
        let best = 0, bd = Infinity;
        for (let i = 0; i < nU; i++) { const d = Math.hypot(ux[i] - cx[c], uy[i] - cy[c]); if (d < bd) { bd = d; best = i; } }
        assign[best] = c;
      }
    }
  }
  onProgress({ phase: 'Grouping streets', pct: 20 });

  const centroid = (c) => {
    let sx = 0, sy = 0, sw = 0;
    for (let i = 0; i < nU; i++) if (assign[i] === c) { sx += ux[i] * uw[i]; sy += uy[i] * uw[i]; sw += uw[i]; }
    return sw ? [sx / sw, sy / sw] : [cx[c], cy[c]];
  };

  // ---- start / end assignment ------------------------------------------
  const sNodes = starts.map(snap), eNodes = ends.map(snap);
  const cent = Array.from({ length: k }, (_, c) => centroid(c));
  const dPt = (node, c) => (node < 0 ? 0 : Math.hypot(nodeXY[node][0] - cent[c][0], nodeXY[node][1] - cent[c][1]));
  const startOf = new Int32Array(k).fill(-1), endOf = new Int32Array(k).fill(-1);
  const pick = (count, costFn) => {
    if (!count) return new Array(k).fill(-1);
    if (count >= k) {
      return hungarian(Array.from({ length: k }, (_, c) => Array.from({ length: count }, (_, j) => costFn(c, j))));
    }
    return Array.from({ length: k }, (_, c) => {
      let best = 0;
      for (let j = 1; j < count; j++) if (costFn(c, j) < costFn(c, best)) best = j;
      return best;
    });
  };
  if (paired) {
    const n = Math.min(sNodes.length, eNodes.length);
    if (sNodes.length !== eNodes.length) warnings.push(`Pairing uses ${n} start/end pairs; unpaired points were ignored.`);
    const choice = pick(n, (c, j) => dPt(sNodes[j], c) + dPt(eNodes[j], c));
    choice.forEach((j, c) => { if (j >= 0) { startOf[c] = sNodes[j]; endOf[c] = eNodes[j]; } });
  } else {
    pick(sNodes.length, (c, j) => dPt(sNodes[j], c)).forEach((j, c) => { if (j >= 0) startOf[c] = sNodes[j]; });
    pick(eNodes.length, (c, j) => dPt(eNodes[j], c)).forEach((j, c) => { if (j >= 0) endOf[c] = eNodes[j]; });
  }
  const loop = returnToStart && !ends.length;

  // ---- covering walk ----------------------------------------------------
  const remAt = new Int32Array(V);
  const remE = new Int32Array(E);
  const reqAt = new Map();
  for (const ei of req) for (const n of [edges[ei].a, edges[ei].b]) {
    if (!reqAt.has(n)) reqAt.set(n, []);
    reqAt.get(n).push(ei);
  }
  const unitOfEdge = new Map(req.map((ei, j) => [ei, j]));

  function buildRoute(c) {
    const mine = [];
    for (let j = 0; j < nU; j++) if (assign[j] === c) mine.push(req[j]);
    let left = 0;
    for (const ei of mine) {
      const need = edges[ei].need;
      remE[ei] = need; remAt[edges[ei].a] += need; remAt[edges[ei].b] += need; left += need;
    }
    let cur = startOf[c];
    const t = endOf[c];
    if (cur < 0) {
      // Begin at the far side from the end point, or at an outer odd-degree corner.
      const cc = cent[c];
      const ref = t >= 0 ? nodeXY[t] : cc;
      let best = -1, bd = -1;
      for (const odd of [true, false]) {
        for (const ei of mine) for (const n of [edges[ei].a, edges[ei].b]) {
          if (odd && t < 0 && remAt[n] % 2 === 0) continue;
          const d = Math.hypot(nodeXY[n][0] - ref[0], nodeXY[n][1] - ref[1]);
          if (d > bd) { bd = d; best = n; }
        }
        if (best >= 0) break;
      }
      cur = best;
    }
    const first = cur;
    const steps = [];
    const hasWork = (u) => remAt[u] > 0;
    while (left > 0) {
      let take = -1, score = -Infinity;
      if (remAt[cur] > 0) {
        for (const ei of reqAt.get(cur) ?? []) {
          if (remE[ei] <= 0) continue;
          const e = edges[ei];
          const other = e.a === cur ? e.b : e.a;
          const s = deg[other] === 1 ? 1e9 : remAt[other] - (other === cur ? 2 : 1);
          if (s > score) { score = s; take = ei; }
        }
      }
      if (take >= 0) {
        const e = edges[take];
        const dir = e.a === cur ? 0 : 1;
        steps.push({ e: take, dir, kind: 'work' });
        remE[take]--; remAt[e.a]--; remAt[e.b]--; left--;
        cur = dir ? e.a : e.b;
        continue;
      }
      const tgt = dijkstra(cur, hasWork);
      if (tgt >= 0) {
        steps.push(...pathSteps(tgt));
        cur = tgt;
      } else {
        // No mapped path: hop straight to the nearest remaining street.
        let best = -1, bd = Infinity;
        for (const ei of mine) if (remE[ei] > 0) for (const n of [edges[ei].a, edges[ei].b]) {
          const d = Math.hypot(nodeXY[n][0] - nodeXY[cur][0], nodeXY[n][1] - nodeXY[cur][1]);
          if (d < bd) { bd = d; best = n; }
        }
        steps.push({ kind: 'gap', from: cur, to: best });
        cur = best;
      }
    }
    const finish = loop ? first : t;
    if (finish >= 0 && finish !== cur) {
      const tgt = dijkstra(cur, (u) => u === finish);
      if (tgt >= 0) steps.push(...pathSteps(tgt));
      else steps.push({ kind: 'gap', from: cur, to: finish });
      cur = finish;
    }
    // reset scratch state (all counts are back to 0 already, but be safe)
    for (const ei of mine) { remE[ei] = 0; remAt[edges[ei].a] = 0; remAt[edges[ei].b] = 0; }
    return { start: first, end: cur, steps, ...measure(steps) };
  }

  function measure(steps) {
    let length = 0, work = 0, up = 0, down = 0, workUp = 0, gap = 0;
    for (const s of steps) {
      if (s.kind === 'gap') {
        const d = haversine([nodes[s.from].lat, nodes[s.from].lon], [nodes[s.to].lat, nodes[s.to].lon]);
        length += d; gap += d;
        continue;
      }
      const u = s.dir ? upB[s.e] : upF[s.e];
      const dn = s.dir ? upF[s.e] : upB[s.e];
      length += len[s.e]; up += u; down += dn;
      if (s.kind === 'work') { work += len[s.e]; workUp += u; }
    }
    const effort = countTravel ? length + climbWeight * up : work + climbWeight * workUp;
    return { length, work, up, down, gap, effort };
  }

  let routes = Array.from({ length: k }, (_, c) => buildRoute(c));
  onProgress({ phase: 'Balancing routes', pct: 30 });

  // ---- refinement -------------------------------------------------------
  const frozen = new Uint8Array(k);
  let moves = 0;
  const budgetEnd = t0 + timeBudgetMs;
  while (k > 1 && Date.now() < budgetEnd) {
    let h = -1;
    for (let c = 0; c < k; c++) if (!frozen[c] && (h < 0 || routes[c].effort > routes[h].effort)) h = c;
    if (h < 0) break;
    const hUnits = [];
    for (let j = 0; j < nU; j++) if (assign[j] === h) hUnits.push(j);
    if (hUnits.length < 2) { frozen[h] = 1; continue; }
    const hc = centroid(h);
    const cands = new Map();
    for (const j of hUnits) {
      const e = edges[req[j]];
      for (const n of [e.a, e.b]) for (const ei of reqAt.get(n)) {
        const c = assign[unitOfEdge.get(ei)];
        if (c !== h && routes[c].effort < routes[h].effort) {
          const key = j * k + c;
          if (!cands.has(key)) cands.set(key, { j, c, d: Math.hypot(ux[j] - hc[0], uy[j] - hc[1]) });
        }
      }
    }
    if (!cands.size) {
      // Isolated area: offer the lightest walker the unit nearest to them.
      for (let c = 0; c < k; c++) {
        if (c === h || routes[c].effort >= routes[h].effort) continue;
        const cc = centroid(c);
        let best = -1, bd = Infinity;
        for (const j of hUnits) { const d = Math.hypot(ux[j] - cc[0], uy[j] - cc[1]); if (d < bd) { bd = d; best = j; } }
        cands.set(best * k + c, { j: best, c, d: -bd });
      }
    }
    const list = [...cands.values()].sort((a, b) => routes[a.c].effort - routes[b.c].effort || b.d - a.d).slice(0, 8);
    let improved = false;
    for (const { j, c } of list) {
      assign[j] = c;
      const nh = buildRoute(h), nc = buildRoute(c);
      if (Math.max(nh.effort, nc.effort) < routes[h].effort - 1) {
        routes[h] = nh; routes[c] = nc;
        improved = true; moves++;
        break;
      }
      assign[j] = h;
    }
    if (improved) frozen.fill(0); else frozen[h] = 1;
    if (moves % 10 === 0) {
      const eff = routes.map((r) => r.effort);
      onProgress({
        phase: 'Balancing routes',
        pct: 30 + Math.min(65, ((Date.now() - t0) / timeBudgetMs) * 65),
        spread: (Math.max(...eff) - Math.min(...eff)) / Math.max(...eff),
      });
    }
  }

  // ---- output -----------------------------------------------------------
  const out = routes.map((r) => describe(r));
  const eff = routes.map((r) => r.effort);
  return {
    walkers: out,
    warnings,
    stats: {
      moves,
      maxEffort: Math.max(...eff),
      minEffort: Math.min(...eff),
      totalWork: routes.reduce((s, r) => s + r.work, 0),
      ms: Date.now() - t0,
    },
  };

  function describe(r) {
    // Polyline pieces grouped by kind, plus a street-by-street list.
    const pieces = [];
    const streets = [];
    const ll = (n) => [nodes[n].lat, nodes[n].lon];
    for (const s of r.steps) {
      let coords, name, kind = s.kind, meters, climb = 0;
      if (kind === 'gap') {
        coords = [ll(s.from), ll(s.to)];
        name = '';
        meters = haversine(coords[0], coords[1]);
      } else {
        const e = edges[s.e];
        coords = s.dir ? [...e.coords].reverse() : e.coords;
        name = e.name;
        meters = len[s.e];
        climb = s.dir ? upB[s.e] : upF[s.e];
      }
      const last = pieces[pieces.length - 1];
      if (last && last.kind === kind) last.coords.push(...coords.slice(1));
      else pieces.push({ kind, coords: [...coords] });
      const ls = streets[streets.length - 1];
      if (ls && ls.kind === kind && ls.name === name) { ls.meters += meters; ls.climb += climb; }
      else streets.push({ kind, name, meters, climb });
    }
    return {
      start: r.start >= 0 ? ll(r.start) : null,
      end: r.end >= 0 ? ll(r.end) : null,
      pieces,
      streets,
      length: r.length,
      work: r.work,
      up: r.up,
      down: r.down,
      gap: r.gap,
      effort: r.effort,
    };
  }
}
