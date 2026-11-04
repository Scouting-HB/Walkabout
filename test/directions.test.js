import { test, expect } from 'bun:test';
import { junction, instruction } from '../src/lib/directions.js';

// A crossroads at (0, 0): Main St runs north-south, Oak Ave east-west. ~1e-4° ≈ 10 m.
const O = [38, -78];
const P = (dy, dx) => [O[0] + dy * 1e-4, O[1] + dx * 1e-4 / Math.cos((38 * Math.PI) / 180)];
const arm = (dy, dx, name, highway = 'residential') => ({ coords: [O, P(dy * 3, dx * 3)], name, highway });
const ARMS = [arm(-1, 0, 'Main St'), arm(1, 0, 'Main St'), arm(0, 1, 'Oak Ave'), arm(0, -1, 'Oak Ave')];
const south = [P(-3, 0), O], north = [O, P(3, 0)], east = [O, P(0, 3)], west = [O, P(0, -3)];
const backSouth = [O, P(-3, 0)];

test('straight on, same side, crosses the side street on that side only', () => {
  // Heading north on the west side (left, +1): crosses Oak Ave's west arm.
  expect(junction({ inCoords: south, inOffset: 1, outCoords: north, outOffset: 1, arms: ARMS })).toEqual({ turn: 'straight', cross: ['Oak Ave'] });
  // T junction with Oak only to the east: the west side has nothing to cross.
  const T = ARMS.filter((a) => a.coords[1][1] >= O[1] - 1e-9 || a.name === 'Main St');
  expect(junction({ inCoords: south, inOffset: 1, outCoords: north, outOffset: 1, arms: T.filter((a) => !(a.name === 'Oak Ave' && a.coords[1][1] < O[1])) }).cross).toEqual([]);
});

test('turns', () => {
  // North on the east side (right, -1), turn right onto Oak's south side (right, -1): stay on the corner.
  expect(junction({ inCoords: south, inOffset: -1, outCoords: east, outOffset: -1, arms: ARMS })).toEqual({ turn: 'right', cross: [] });
  // ...onto Oak's north side instead: cross Oak.
  expect(junction({ inCoords: south, inOffset: -1, outCoords: east, outOffset: 1, arms: ARMS })).toEqual({ turn: 'right', cross: ['Oak Ave'] });
  // West side heading north, turn right onto the north side of Oak: opposite corner, cross both.
  expect(junction({ inCoords: south, inOffset: 1, outCoords: east, outOffset: 1, arms: ARMS }).cross.sort()).toEqual(['Main St', 'Oak Ave']);
  expect(junction({ inCoords: south, inOffset: 1, outCoords: west, outOffset: 1, arms: ARMS })).toEqual({ turn: 'left', cross: [] }); // south side of Oak
  expect(junction({ inCoords: south, inOffset: 1, outCoords: west, outOffset: -1, arms: ARMS })).toEqual({ turn: 'left', cross: ['Oak Ave'] }); // north side
});

test('doubling back crosses the street itself; a dead end does not', () => {
  expect(junction({ inCoords: south, inOffset: 1, outCoords: backSouth, outOffset: 1, arms: ARMS })).toEqual({ turn: 'around', cross: ['Main St'] });
  expect(junction({ inCoords: south, inOffset: 1, outCoords: backSouth, outOffset: 1, arms: [ARMS[0]] })).toEqual({ turn: 'around', cross: [] });
});

test('criss-cross passes only mention busy roads walked over', () => {
  const busy = [arm(-1, 0, 'Main St'), arm(1, 0, 'Main St'), arm(0, 1, 'Route 33', 'primary'), arm(0, -1, 'Route 33', 'primary')];
  busy[0].walked = busy[1].walked = true;
  expect(junction({ inCoords: south, inOffset: 0, outCoords: north, outOffset: 0, arms: busy }).cross).toEqual(['Route 33']);
  busy[1].walked = false; busy[2].walked = true; // turning onto Route 33
  expect(junction({ inCoords: south, inOffset: 0, outCoords: east, outOffset: 0, arms: busy }).cross).toEqual([]);
});

test('wording', () => {
  const t = (s, prev) => { const r = instruction(s, prev); return `${r.lead} ${r.name}${r.tail}`.trim(); };
  expect(t({ kind: 'work', name: 'Main St', side: 'west', turn: 'start', heading: 'north' })).toBe('Head north on Main St, west side');
  expect(t({ kind: 'work', name: 'Oak Ave', side: 'north', turn: 'right', crossBefore: ['Oak Ave'], crossing: ['Elm St', 'Oak Ave'] }, { name: 'Main St' }))
    .toBe('Cross Oak Ave, then turn right onto Oak Ave, north side, crossing Elm St');
  expect(t({ kind: 'work', name: 'Main St', side: 'east', turn: 'around', crossBefore: ['Main St'] }, { name: 'Main St' })).toBe('Cross Main St and come back along the east side');
  expect(t({ kind: 'walk', name: '', turn: 'slight-left' }, { name: 'Main St' })).toBe('Bear left onto the path (just walking)');
  expect(t({ kind: 'work', name: 'Old Rd' })).toBe('Old Rd, both sides'); // results saved before directions existed
});
