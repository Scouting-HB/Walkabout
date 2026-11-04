// Turn-by-turn wording for routes.
//
// At every junction we work out, in a local metric frame centred on the node:
//  - the turn angle between the street arriving and the street leaving;
//  - which roads the walker has to cross. The roads leaving the junction split
//    it into corners. Someone canvassing one side is on a known corner just
//    before the junction and must reach a known corner just after it; going
//    round the junction the way with fewer roads in between, each of those
//    roads is crossed. That covers crossing a side street's mouth, switching
//    sides to come back along the other side, and turning onto the far side of
//    a new street. For criss-cross (both sides) passes and plain walking, where
//    the walker's side isn't fixed, only busy roads they go straight over are
//    mentioned.

const SIDE = 8;    // metres from the centreline to the sidewalk/front yards
const REACH = 14;  // how far before/after the junction to sample the walker
const ARM = 10;    // how far along each road to take its direction

const NOT_ROADS = new Set(['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'track', 'service', 'bridleway', 'corridor', 'elevator']);
const BUSY = new Set(['tertiary', 'secondary', 'primary', 'trunk', 'tertiary_link', 'secondary_link', 'primary_link', 'trunk_link']);

function frame([lat0, lon0]) {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320, ky = 110540;
  return ([lat, lon]) => [(lon - lon0) * kx, (lat - lat0) * ky];
}

// Point `d` metres along a polyline (local xy) from its first point.
function along(xy, d) {
  for (let i = 1; i < xy.length; i++) {
    const [ax, ay] = xy[i - 1], [bx, by] = xy[i];
    const l = Math.hypot(bx - ax, by - ay);
    if (l >= d) return [ax + ((bx - ax) * d) / l, ay + ((by - ay) * d) / l];
    d -= l;
  }
  return xy[xy.length - 1];
}
const ang = ([x, y]) => (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI);
const unit = ([x, y]) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
const left = ([x, y]) => [-y, x];

/**
 * One junction. `inCoords` ends at the junction, `outCoords` starts there (both in
 * walking order, [lat, lon]). Offsets: +1 walker on the left, -1 right, 0 either/both.
 * `arms`: every road leaving the junction (including the two being walked) as
 * { coords (starting at the junction), name, highway }.
 * Returns { turn, cross: [names] }.
 */
export function junction({ inCoords, inOffset, outCoords, outOffset, arms }) {
  const node = outCoords[0];
  const f = frame(node);
  const inXY = [...inCoords].reverse().map(f); // from the junction backwards
  const outXY = outCoords.map(f);
  const pIn = along(inXY, REACH), pOut = along(outXY, REACH);
  const hIn = unit([-pIn[0], -pIn[1]]), hOut = unit(pOut);
  const a = (Math.atan2(hIn[0] * hOut[1] - hIn[1] * hOut[0], hIn[0] * hOut[0] + hIn[1] * hOut[1]) * 180) / Math.PI; // + = left
  const abs = Math.abs(a);
  const dir = a > 0 ? 'left' : 'right';
  const turn = abs < 30 ? 'straight' : abs < 60 ? `slight-${dir}` : abs < 150 ? dir : 'around';

  let cross = [];
  if (inOffset && outOffset) {
    // Every road at the junction (paths too: a footpath between two corners
    // still has to be stepped over, but only named roads get mentioned).
    const all = arms.map((r) => ({ ...r, a: ang(along(r.coords.map(f), ARM)) }));
    const off = (p, h, o) => { const n = left(h); return [p[0] + n[0] * SIDE * o, p[1] + n[1] * SIDE * o]; };
    const a0 = ang(off(pIn, hIn, inOffset)), a1 = ang(off(pOut, hOut, outOffset));
    const ccw = (x) => (x - a0 + 2 * Math.PI) % (2 * Math.PI) < (a1 - a0 + 2 * Math.PI) % (2 * Math.PI);
    const one = all.filter((r) => ccw(r.a)), other = all.filter((r) => !ccw(r.a));
    const cost = (rs) => rs.filter((r) => !NOT_ROADS.has(r.highway)).length * 10 + rs.length + rs.filter((r) => BUSY.has(r.highway)).length * 0.5;
    cross = (cost(one) <= cost(other) ? one : other).filter((r) => r.name && !NOT_ROADS.has(r.highway)).map((r) => r.name);
  } else {
    // Side not fixed: flag busy roads the walker goes over, not the ones they walk along.
    const along2 = new Set(arms.filter((r) => r.walked).map((r) => r.name));
    for (const r of arms) if (r.name && BUSY.has(r.highway) && !r.walked && !along2.has(r.name)) cross.push(r.name);
  }
  return { turn, cross: [...new Set(cross)] };
}

const lower = (s) => s[0].toLowerCase() + s.slice(1);
const list = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/**
 * Wording for one line of a street list: { lead, name, tail }, so the street
 * name can be shown in bold. `prev` is the line before (or undefined).
 */
export function instruction(s, prev) {
  if (s.kind === 'gap') return { lead: 'Cut across to the next street', name: '', tail: ' (no mapped path)' };
  const name = s.name || (s.kind === 'walk' ? 'the path' : 'the unnamed street');
  const same = prev && prev.name && prev.name === s.name;
  const before = (s.crossBefore ?? []).filter(Boolean);
  let lead;
  switch (s.turn) {
    case 'left': case 'right': lead = `Turn ${s.turn} onto`; break;
    case 'slight-left': case 'slight-right': lead = `Bear ${s.turn.slice(7)} onto`; break;
    case 'straight': lead = same ? 'Keep going along' : 'Continue onto'; break;
    case 'around': lead = same ? 'Turn around and come back along' : 'Turn around onto'; break;
    case 'start': lead = s.heading ? `Head ${s.heading} on` : 'Start on'; break;
    default: lead = s.kind === 'walk' ? 'Walk via' : ''; // old links without directions
  }
  // Switching sides to double back: "Cross Main St and come back along its south side".
  if (s.turn === 'around' && same && before.includes(s.name)) {
    const rest = before.filter((n) => n !== s.name);
    return {
      lead: `${rest.length ? `Cross ${list(rest)}, then cross` : 'Cross'}`,
      name: s.name,
      tail: ` and come back along ${s.side ? `the ${s.side} side` : 'the other side'}${s.kind === 'walk' ? ' (just walking)' : ''}${crossing(s)}`,
    };
  }
  if (before.length) lead = `Cross ${list(before)}, then ${lead ? lower(lead) : 'go along'}`;
  const tail = s.kind === 'work' ? `, ${s.side ? `${s.side} side` : 'both sides'}` : ' (just walking)';
  return { lead, name, tail: tail + crossing(s) };
}
function crossing(s) {
  const c = (s.crossing ?? []).filter((n) => n && n !== s.name);
  return c.length ? `, crossing ${list([...new Set(c)])}` : '';
}
