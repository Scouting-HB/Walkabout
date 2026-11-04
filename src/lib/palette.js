// Den colours from Scouting-HB/Den-Calendar-Composer src/app.css.
export const DEN = {
  lion: '#EEC250',
  tiger: '#DA834C',
  wolf: '#C6443F',
  bear: '#9FC2DC',
  webelos: '#8E9F63',
  arrowOfLight: '#E9D8C5',
  cubBlue: '#002F6D',
  cubYellow: '#FFCE04',
};

export const REGION_COLORS = [DEN.bear, DEN.webelos, DEN.tiger, DEN.lion, DEN.wolf, DEN.arrowOfLight];

const ROUTE_BASE = [DEN.wolf, DEN.cubBlue, DEN.webelos, DEN.tiger, DEN.bear, DEN.lion, DEN.cubYellow];

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s) => Math.round(((n >> s) & 255) * f);
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

/** Route colour for walker i: the den palette, then darker passes of it. */
export function routeColor(i) {
  const base = ROUTE_BASE[i % ROUTE_BASE.length];
  const round = Math.floor(i / ROUTE_BASE.length);
  return round ? shade(base, Math.max(0.35, 1 - 0.3 * round)) : base;
}
