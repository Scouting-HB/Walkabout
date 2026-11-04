import { test, expect } from 'bun:test';
import { plan, hungarian } from '../src/lib/planner.js';
import { buildGraph } from '../src/lib/osm.js';

// A synthetic 8x8 street grid (~100 m blocks) with a hill on one side.
function grid(n = 8, step = 0.0009) {
  const elements = [];
  let wid = 1;
  const id = (r, c) => r * 100 + c + 1;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    elements.push({ type: 'node', id: id(r, c), lat: 38.44 + r * step, lon: -78.87 + c * step });
  }
  for (let r = 0; r < n; r++) {
    elements.push({ type: 'way', id: wid++, nodes: Array.from({ length: n }, (_, c) => id(r, c)), tags: { highway: 'residential', name: `Row ${r}` } });
    elements.push({ type: 'way', id: wid++, nodes: Array.from({ length: n }, (_, c) => id(c, r)), tags: { highway: 'residential', name: `Col ${r}` } });
  }
  return { elements };
}
const region = { ring: [[38.4395, -78.8705], [38.4395, -78.8630], [38.4465, -78.8630], [38.4465, -78.8705]] };

function graph(sideTypes = new Set()) {
  const g = buildGraph(grid(), [region], { coverTypes: new Set(['residential']), sideTypes });
  for (const e of g.edges) e.elev = e.coords.map(([, lon]) => (lon + 78.87) * 50000); // climbs eastward
  return g;
}

test('hungarian finds the optimal assignment', () => {
  expect(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]])).toEqual([1, 0, 2]);
});

test('graph splits ways at intersections and marks covered streets', () => {
  const g = graph();
  expect(g.edges.length).toBe(2 * 8 * 7);
  expect(g.edges.every((e) => e.need === 1 && e.region === 0 && !e.sides)).toBe(true);
  expect(graph(new Set(['residential'])).edges.every((e) => e.sides)).toBe(true);
});

test('every required street is walked and routes are balanced', () => {
  const g = graph();
  const res = plan(g, { walkers: 4, starts: [[38.443, -78.867]], returnToStart: true, timeBudgetMs: 2000 });
  expect(res.walkers.length).toBe(4);
  const totalWork = res.walkers.reduce((s, w) => s + w.work, 0);
  const required = g.edges.reduce((s, e) => s + e.length, 0);
  expect(Math.abs(totalWork - required)).toBeLessThan(1);
  const spread = (res.stats.maxEffort - res.stats.minEffort) / res.stats.maxEffort;
  expect(spread).toBeLessThan(0.15);
  for (const w of res.walkers) {
    expect(w.start).toEqual(w.end); // returned to start
    expect(w.up).toBeCloseTo(w.down, 5); // loop climbs what it descends
  }
});

test('paired start/end points are kept together', () => {
  const g = graph();
  const starts = [[38.4400, -78.8700], [38.4463, -78.8637]];
  const ends = [[38.4463, -78.8700], [38.4400, -78.8637]];
  const res = plan(g, { walkers: 2, starts, ends, paired: true, timeBudgetMs: 1000 });
  const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
  for (const w of res.walkers) {
    const j = starts.findIndex((s) => near(s, w.start));
    expect(j).toBeGreaterThanOrEqual(0);
    expect(near(ends[j], w.end)).toBe(true);
  }
});

test('more walkers than streets does not crash', () => {
  const g = buildGraph(grid(2), [region], { coverTypes: new Set(['residential']) });
  const res = plan(g, { walkers: 10, timeBudgetMs: 200 });
  expect(res.walkers.length).toBe(g.edges.filter((e) => e.need).length);
  expect(res.warnings.length).toBe(1);
});

test('two-sided streets: every side is walked exactly once, possibly by different walkers', () => {
  const g = graph(new Set(['residential']));
  const res = plan(g, { walkers: 3, starts: [[38.443, -78.867]], returnToStart: true, timeBudgetMs: 2000 });
  const required = g.edges.reduce((s, e) => s + e.length, 0);
  const totalWork = res.walkers.reduce((s, w) => s + w.work, 0);
  expect(Math.abs(totalWork - 2 * required)).toBeLessThan(1);
  const sides = res.walkers.flatMap((w) => w.streets.filter((s) => s.kind === 'work'));
  expect(sides.every((s) => ['north', 'south', 'east', 'west'].includes(s.side))).toBe(true);
});

test('a two-sided street is walked out on one side and back on the other, without retracing', () => {
  // One straight east-west street, three blocks, with side streets at each corner.
  const elements = [];
  for (let i = 0; i < 4; i++) {
    elements.push({ type: 'node', id: i + 1, lat: 38.44, lon: -78.87 + i * 0.001 });
    elements.push({ type: 'node', id: 100 + i, lat: 38.45, lon: -78.87 + i * 0.001 });
    elements.push({ type: 'way', id: 10 + i, nodes: [i + 1, 100 + i], tags: { highway: 'footway' } });
  }
  elements.push({ type: 'way', id: 1, nodes: [1, 2, 3, 4], tags: { highway: 'tertiary', name: 'Main St' } });
  const box = { ring: [[38.439, -78.8705], [38.439, -78.8665], [38.441, -78.8665], [38.441, -78.8705]] };
  const g = buildGraph({ elements }, [box], { coverTypes: new Set(['tertiary']), sideTypes: new Set(['tertiary']) });
  const res = plan(g, { walkers: 1, starts: [[38.44, -78.87]], returnToStart: true, timeBudgetMs: 200 });
  const w = res.walkers[0];
  const street = g.edges.filter((e) => e.need).reduce((s, e) => s + e.length, 0);
  expect(w.length).toBeCloseTo(2 * street, 3); // no extra walking at all
  expect(w.streets.map((s) => `${s.name} ${s.side}`)).toEqual(['Main St north', 'Main St south']);
});
