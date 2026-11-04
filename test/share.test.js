import { test, expect } from 'bun:test';
import { encodePolyline, decodePolyline, pack, unpack, walkerPayload, walkerFromPayload, setupPayload, setupFromPayload } from '../src/lib/share.js';

test('polyline round trip to ~1 m', () => {
  const pts = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453], [-33.86785, 151.20732], [0, 0]];
  expect(encodePolyline(pts.slice(0, 3))).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@'); // Google's documented example
  decodePolyline(encodePolyline(pts)).forEach(([a, b], i) => {
    expect(Math.abs(a - pts[i][0])).toBeLessThan(1e-5);
    expect(Math.abs(b - pts[i][1])).toBeLessThan(1e-5);
  });
});

test('walker link round trip', async () => {
  const w = {
    label: 'Walker 2', length: 1234.5, work: 1000.2, up: 12.3, down: 11.9,
    start: [38.123456, -78.987654], end: null,
    streets: [{ kind: 'work', name: 'Main St', meters: 300.4, side: 'north' }, { kind: 'walk', name: '', meters: 20 }, { kind: 'work', name: 'Oak Ave', meters: 200 }],
    pieces: [{ kind: 'work', offset: 1, coords: [[38.1, -78.9], [38.101, -78.9]] }, { kind: 'walk', offset: 0, coords: [[38.101, -78.9], [38.102, -78.901]] }],
  };
  const s = await pack(walkerPayload(w, 1, 'Pack 42'));
  expect(s).toMatch(/^[\w-]+$/);
  const { title, index, walker } = walkerFromPayload(await unpack(s));
  expect(title).toBe('Pack 42');
  expect(index).toBe(1);
  expect(walker.streets.map((x) => [x.kind, x.name, x.side])).toEqual([['work', 'Main St', 'north'], ['walk', '', ''], ['work', 'Oak Ave', '']]);
  expect(walker.pieces.map((x) => [x.kind, x.offset, x.coords.length])).toEqual([['work', 1, 2], ['walk', 0, 2]]);
  expect(walker.start).toEqual([38.12346, -78.98765]);
  expect(walker.end).toBeNull();
});

test('setup link round trip', async () => {
  const p = { title: 'T', paired: true, returnToStart: false, walkers: 6, climbWeight: 5, countTravel: true, sideTypes: ['primary'], useElevation: false, coverTypes: ['residential'],
    regions: [{ id: 'x', name: 'North', color: '#fff', ring: [[38.1, -78.1], [38.2, -78.1], [38.2, -78.2]] }], starts: [[38.15, -78.15]], ends: [] };
  const back = setupFromPayload(await unpack(await pack(setupPayload(p))));
  const { regions, ...rest } = back;
  const { regions: r0, ...rest0 } = p;
  expect(rest).toEqual(rest0);
  expect(regions[0]).toMatchObject({ name: 'North', color: '#fff', ring: r0[0].ring });
  await expect(unpack('garbage')).rejects.toThrow();
});
