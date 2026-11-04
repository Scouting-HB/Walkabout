<script>
  import L from 'leaflet';
  import 'leaflet/dist/leaflet.css';
  import { onMount } from 'svelte';
  import { DEN, routeColor } from './palette.js';
  import { offsetLine } from './geo.js';
  import { instruction } from './directions.js';

  let {
    mode = 'none',
    regions = [],
    starts = [],
    ends = [],
    paired = false,
    selectedRegion = -1,
    preview = [],
    walkers = [],
    focusWalker = -1,
    hidden = [],
    fitKey = 0,
    focus = null,
    me = null,
    editable = true,
    highlight = null, // { w, k }: walker w's step k
    onHoverStep = () => {}, // (w, k), k = -1 when the pointer leaves
    onPickStep = () => {}, // (w, k) on click/tap
    onRegionDone = () => {},
    onRegionEdit = () => {},
    onSelectRegion = () => {},
    onAddPoint = () => {},
    onMovePoint = () => {},
    onCancelMode = () => {},
  } = $props();

  let el;
  let map = $state(null);
  let layers = {};
  let draft = $state([]);
  let zoom = $state(14);

  onMount(() => {
    map = L.map(el, { zoomControl: true }).setView([38.4496, -78.8689], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    map.on('zoomend', () => (zoom = map.getZoom()));
    for (const k of ['preview', 'regions', 'routes', 'edit', 'draft', 'points', 'me', 'hl', 'hit']) layers[k] = L.layerGroup().addTo(map);

    map.on('click', (e) => {
      const p = [e.latlng.lat, e.latlng.lng];
      if (mode === 'region') addVertex(e);
      else if (mode === 'start' || mode === 'end') onAddPoint(mode, p);
    });
    map.on('dblclick', () => {
      if (mode === 'region') finish();
    });
    const key = (e) => {
      if (mode === 'none') return;
      if (e.key === 'Escape') { draft = []; onCancelMode(); }
      if (e.key === 'Enter' && mode === 'region') finish();
      if ((e.key === 'Backspace' || (e.key === 'z' && (e.ctrlKey || e.metaKey))) && mode === 'region' && draft.length && e.target === document.body) {
        draft = draft.slice(0, -1);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', key);
    if (regions.length) fitTo(regions.flatMap((r) => r.ring));
    return () => { window.removeEventListener('keydown', key); map.remove(); };
  });

  function addVertex(e) {
    const last = draft[draft.length - 1];
    if (last && map.latLngToContainerPoint(last).distanceTo(e.containerPoint) < 6) return;
    if (draft.length >= 3 && map.latLngToContainerPoint(draft[0]).distanceTo(e.containerPoint) < 12) return finish();
    draft = [...draft, [e.latlng.lat, e.latlng.lng]];
  }

  function finish() {
    if (draft.length >= 3) onRegionDone(draft);
    draft = [];
  }

  function fitTo(points) {
    if (map && points.length) map.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 17 });
  }

  // drawing modes
  $effect(() => {
    if (!map) return;
    const drawing = mode === 'region';
    map.getContainer().classList.toggle('placing', mode !== 'none');
    if (drawing) map.doubleClickZoom.disable(); else { map.doubleClickZoom.enable(); draft = []; }
  });

  // draft polygon
  $effect(() => {
    if (!map) return;
    const g = layers.draft;
    g.clearLayers();
    if (!draft.length) return;
    L.polyline(draft, { color: DEN.cubBlue, weight: 2, dashArray: '6 4' }).addTo(g);
    draft.forEach((p, i) =>
      L.circleMarker(p, { radius: i === 0 ? 7 : 4, color: DEN.cubBlue, fillColor: i === 0 ? DEN.cubYellow : '#fff', fillOpacity: 1, weight: 2 })
        .on('click', (e) => { if (i === 0) { L.DomEvent.stop(e); finish(); } })
        .addTo(g),
    );
  });

  // regions + vertex editing
  $effect(() => {
    if (!map) return;
    const g = layers.regions, ed = layers.edit;
    g.clearLayers();
    ed.clearLayers();
    regions.forEach((r, i) => {
      const sel = i === selectedRegion;
      const poly = L.polygon(r.ring, {
        color: sel ? DEN.cubBlue : r.color,
        weight: sel ? 3 : 2,
        fillColor: r.color,
        fillOpacity: walkers.length ? 0.12 : 0.25,
      })
        .bindTooltip(r.name, { sticky: true })
        .on('click', (e) => { if (mode === 'none') { L.DomEvent.stop(e); onSelectRegion(sel ? -1 : i); } })
        .addTo(g);
      if (!sel) return;
      r.ring.forEach((p, vi) => {
        const m = L.marker(p, {
          draggable: true,
          icon: L.divIcon({ className: 'vertex-handle', iconSize: [14, 14] }),
        }).addTo(ed);
        m.on('drag', () => {
          const ring = r.ring.map((q, k) => (k === vi ? [m.getLatLng().lat, m.getLatLng().lng] : q));
          poly.setLatLngs(ring);
        });
        m.on('dragend', () => {
          const ll = m.getLatLng();
          onRegionEdit(i, r.ring.map((q, k) => (k === vi ? [ll.lat, ll.lng] : q)));
        });
      });
    });
  });

  // start / end markers
  $effect(() => {
    if (!map) return;
    const g = layers.points;
    g.clearLayers();
    const add = (kind, p, i) => {
      const label = !editable ? (kind === "start" ? "S" : "E") : paired ? `${i + 1}` : `${kind === "start" ? "S" : "E"}${i + 1}`;
      const m = L.marker(p, {
        draggable: editable,
        icon: L.divIcon({
          className: `pt-marker pt-${kind}`,
          html: `<span>${label}</span>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
        title: `${kind === 'start' ? 'Start' : 'End'}${editable ? ` ${i + 1} (drag to move)` : ''}`,
      }).addTo(g);
      m.on('dragend', () => { const ll = m.getLatLng(); onMovePoint(kind, i, [ll.lat, ll.lng]); });
    };
    starts.forEach((p, i) => add('start', p, i));
    ends.forEach((p, i) => add('end', p, i));
  });

  // streets to canvass (before planning)
  $effect(() => {
    if (!map) return;
    const g = layers.preview;
    g.clearLayers();
    if (walkers.length) return;
    for (const line of preview) L.polyline(line, { color: DEN.cubBlue, weight: 3, opacity: 0.7, interactive: false }).addTo(g);
  });

  // Side-of-street passes are drawn a few pixels off the centreline, on their side.
  const drawn = (p, z) => {
    if (p.kind !== 'work' || !p.offset) return p.coords;
    const mPerPx = (156543.03 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** z;
    return offsetLine(p.coords, p.offset * 4.5 * mPerPx);
  };

  // Which step of walker w a point on piece pi belongs to (nearest segment of the drawn line).
  function stepAt(w, pi, coords, latlng) {
    const pt = map.latLngToLayerPoint(latlng);
    let best = 0, bd = Infinity;
    for (let j = 1; j < coords.length; j++) {
      const d = L.LineUtil.pointToSegmentDistance(pt, map.latLngToLayerPoint(coords[j - 1]), map.latLngToLayerPoint(coords[j]));
      if (d < bd) { bd = d; best = j - 1; }
    }
    return w.streets.findIndex((s) => s.seg && s.seg[0] === pi && s.seg[1] <= best && best < s.seg[2]);
  }
  const stepText = (w, k) => {
    if (k < 0) return '';
    const t = instruction(w.streets[k], w.streets[k - 1]);
    return `${t.lead}${t.lead && t.name ? ' ' : ''}${t.name}${t.tail}`;
  };

  // planned routes
  $effect(() => {
    if (!map) return;
    const g = layers.routes, hit = layers.hit;
    g.clearLayers();
    hit.clearLayers();
    walkers.forEach((w, i) => {
      if (hidden.includes(i)) return;
      const faded = focusWalker >= 0 && focusWalker !== i;
      const color = w.color ?? routeColor(i);
      w.pieces.forEach((p, pi) => {
        const coords = drawn(p, zoom);
        // Wide invisible line on top for hovering/tapping a leg of the route.
        if (w.streets.some((s) => s.seg)) {
          const tip = walkers.length > 1 ? `${w.label ?? `Walker ${i + 1}`}: ` : '';
          L.polyline(coords, { color: '#000', opacity: 0, weight: 16 })
            .bindTooltip('', { sticky: true, className: 'step-tip' })
            .on('mousemove', function (e) {
              const k = stepAt(w, pi, coords, e.latlng);
              this.setTooltipContent(tip + (stepText(w, k) || 'Walker ' + (i + 1)));
              onHoverStep(i, k);
            })
            .on('mouseout', () => onHoverStep(i, -1))
            .on('click', (e) => onPickStep(i, stepAt(w, pi, coords, e.latlng)))
            .addTo(hit);
        }
        if (p.kind === 'work') {
          const wgt = p.offset ? 4 : 5;
          L.polyline(coords, { color: '#1b1b1b', weight: wgt + 3, opacity: faded ? 0.08 : 0.55, interactive: false }).addTo(g);
          const line = L.polyline(coords, { color, weight: wgt, opacity: faded ? 0.25 : 1, interactive: !w.streets.some((s) => s.seg) }).addTo(g);
          if (!w.streets.some((s) => s.seg)) line.bindTooltip(`Walker ${i + 1}`, { sticky: true });
        } else {
          L.polyline(p.coords, {
            color: p.kind === 'gap' ? '#555' : color,
            weight: 3,
            opacity: faded ? 0.2 : 0.9,
            dashArray: p.kind === 'gap' ? '2 6' : '7 6',
            interactive: false,
          }).addTo(g);
        }
      });
    });
  });

  // the highlighted step
  $effect(() => {
    if (!map) return;
    const g = layers.hl;
    g.clearLayers();
    const w = highlight && walkers[highlight.w];
    const s = w?.streets[highlight.k];
    if (!s?.seg || hidden.includes(highlight.w)) return;
    const p = w.pieces[s.seg[0]];
    const coords = drawn(p, zoom).slice(s.seg[1], s.seg[2] + 1);
    L.polyline(coords, { color: DEN.cubYellow, weight: 14, opacity: 0.85, interactive: false }).addTo(g);
    L.polyline(coords, { color: w.color ?? routeColor(highlight.w), weight: 5, opacity: 1, dashArray: p.kind === 'work' ? null : '7 6', interactive: false }).addTo(g);
    L.circleMarker(coords[0], { radius: 5, color: '#1b1b1b', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(g);
  });

  /** Pan/zoom to show walker w's step k. */
  export function showStep(w, k) {
    const s = walkers[w]?.streets[k];
    if (!map || !s?.seg) return;
    const coords = walkers[w].pieces[s.seg[0]].coords.slice(s.seg[1], s.seg[2] + 1);
    const b = L.latLngBounds(coords);
    if (!map.getBounds().pad(-0.15).contains(b)) map.fitBounds(b, { padding: [40, 40], maxZoom: Math.max(map.getZoom(), 17) });
  }

  // the viewer's own position ({ lat, lon, accuracy } from the Geolocation API)
  $effect(() => {
    if (!map) return;
    const g = layers.me;
    g.clearLayers();
    if (!me) return;
    const ll = [me.lat, me.lon];
    if (me.accuracy > 15) L.circle(ll, { radius: me.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(g);
    L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1, interactive: false }).addTo(g);
  });

  $effect(() => {
    fitKey;
    if (!map || !fitKey) return;
    const pts = walkers.length ? walkers.flatMap((w) => w.pieces.flatMap((p) => p.coords)) : regions.flatMap((r) => r.ring);
    fitTo(pts);
  });

  $effect(() => {
    if (!map || !focus) return;
    if (focus.bounds) map.fitBounds(focus.bounds, { maxZoom: 17 });
    else map.setView(focus.center, focus.zoom ?? 16);
  });
</script>

<div class="map-wrap">
  <div class="map" bind:this={el}></div>
  {#if mode !== 'none'}
    <div class="map-hint" role="status">
      {#if mode === 'region'}
        <span>Click to add corners. Click the first (yellow) corner, double-click or press Enter to finish.</span>
        <button class="btn small primary" disabled={draft.length < 3} onclick={finish}>Finish region</button>
        <button class="btn small" disabled={!draft.length} onclick={() => (draft = draft.slice(0, -1))}>Undo corner</button>
      {:else}
        <span>Click the map to place {mode === 'start' ? 'a start' : 'an end'} point.</span>
      {/if}
      <button class="btn small" onclick={() => { draft = []; onCancelMode(); }}>Done</button>
    </div>
  {/if}
</div>

<style>
  .map-wrap { position: relative; height: 100%; min-height: 320px; }
  .map { position: absolute; inset: 0; }
  .map-hint {
    position: absolute; z-index: 1000; top: 10px; left: 50%; transform: translateX(-50%);
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: center;
    max-width: calc(100% - 100px);
    background: var(--cub-blue); color: #fff; padding: 8px 12px; border-radius: 8px;
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.3); font-size: 0.9rem;
  }
  :global(.map.placing) { cursor: crosshair; }
  :global(.map.placing .leaflet-interactive) { cursor: crosshair; }
  :global(.step-tip) { width: max-content; max-width: 260px; white-space: normal; }
  :global(.vertex-handle) { background: #fff; border: 2px solid var(--cub-blue); border-radius: 3px; }
  :global(.pt-marker) {
    display: grid; place-items: center; border-radius: 50%; border: 2px solid #fff;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.5); font: 700 12px/1 system-ui, sans-serif;
  }
  :global(.pt-start) { background: var(--webelos); color: #fff; }
  :global(.pt-end) { background: var(--wolf); color: #fff; border-radius: 4px; }
</style>
