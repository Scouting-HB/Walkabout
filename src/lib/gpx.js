const esc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** One GPX file holding a track (and start/end waypoints) per walker. */
export function toGpx(walkers, title = 'Walkabout routes') {
  const wpts = [];
  const trks = [];
  for (const w of walkers) {
    if (w.start) wpts.push(`<wpt lat="${w.start[0]}" lon="${w.start[1]}"><name>${esc(w.label)} start</name></wpt>`);
    if (w.end) wpts.push(`<wpt lat="${w.end[0]}" lon="${w.end[1]}"><name>${esc(w.label)} end</name></wpt>`);
    const pts = [];
    for (const p of w.pieces) {
      for (const [i, [lat, lon]] of p.coords.entries()) {
        if (pts.length && i === 0) continue; // pieces share their joining point
        pts.push(`<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`);
      }
    }
    trks.push(`<trk><name>${esc(w.label)}</name><trkseg>${pts.join('')}</trkseg></trk>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Walkabout" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${esc(title)}</name></metadata>
${wpts.join('\n')}
${trks.join('\n')}
</gpx>
`;
}

export function download(filename, text, type = 'application/gpx+xml') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
