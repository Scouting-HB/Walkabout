<script>
  import L from 'leaflet';
  import 'leaflet/dist/leaflet.css';
  import { onMount } from 'svelte';
  import { DEN, routeColor } from './palette.js';
  import { offsetLine } from './geo.js';

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
    for (const k of ['preview', 'regions', 'routes', 'edit', 'draft', 'points']) layers[k] = L.layerGroup().addTo(map);

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
      const label = paired ? `${i + 1}` : `${kind === 'start' ? 'S' : 'E'}${i + 1}`;
      const m = L.marker(p, {
        draggable: true,
        icon: L.divIcon({
          className: `pt-marker pt-${kind}`,
          html: `<span>${label}</span>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
        title: `${kind === 'start' ? 'Start' : 'End'} ${i + 1} (drag to move)`,
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

  // planned routes
  $effect(() => {
    if (!map) return;
    const g = layers.routes;
    g.clearLayers();
    // Side-of-street passes are drawn a few pixels off the centreline, on their side.
    const lat = map.getCenter().lat;
    const mPerPx = (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
    walkers.forEach((w, i) => {
      if (hidden.includes(i)) return;
      const faded = focusWalker >= 0 && focusWalker !== i;
      const color = routeColor(i);
      for (const p of w.pieces) {
        if (p.kind === 'work') {
          const coords = p.offset ? offsetLine(p.coords, p.offset * 4.5 * mPerPx) : p.coords;
          const wgt = p.offset ? 4 : 5;
          L.polyline(coords, { color: '#1b1b1b', weight: wgt + 3, opacity: faded ? 0.08 : 0.55, interactive: false }).addTo(g);
          L.polyline(coords, { color, weight: wgt, opacity: faded ? 0.25 : 1 })
            .bindTooltip(`Walker ${i + 1}`, { sticky: true })
            .addTo(g);
        } else {
          L.polyline(p.coords, {
            color: p.kind === 'gap' ? '#555' : color,
            weight: 3,
            opacity: faded ? 0.2 : 0.9,
            dashArray: p.kind === 'gap' ? '2 6' : '7 6',
            interactive: false,
          }).addTo(g);
        }
      }
    });
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
  :global(.vertex-handle) { background: #fff; border: 2px solid var(--cub-blue); border-radius: 3px; }
  :global(.pt-marker) {
    display: grid; place-items: center; border-radius: 50%; border: 2px solid #fff;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.5); font: 700 12px/1 system-ui, sans-serif;
  }
  :global(.pt-start) { background: var(--webelos); color: #fff; }
  :global(.pt-end) { background: var(--wolf); color: #fff; border-radius: 4px; }
</style>
