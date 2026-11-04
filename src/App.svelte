<script>
  import MapView from './lib/MapView.svelte';
  import { fetchOsm, buildGraph, STREET_TYPES, BUSY_TYPES } from './lib/osm.js';
  import { addElevations, clearElevations } from './lib/elevation.js';
  import { bboxOf, padBbox, ringAreaM2 } from './lib/geo.js';
  import { toGpx, download } from './lib/gpx.js';
  import { REGION_COLORS, routeColor } from './lib/palette.js';

  const STORE = 'walkabout:project:v1';
  const defaults = {
    regions: [],
    starts: [],
    ends: [],
    paired: false,
    returnToStart: true,
    walkers: 4,
    climbWeight: 8,
    countTravel: true,
    sideTypes: [...BUSY_TYPES],
    useElevation: true,
    coverTypes: STREET_TYPES.filter((t) => t.default).map((t) => t.key),
    title: '',
  };
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}');
      delete saved.bothSidesBusy; // replaced by sideTypes
      return { ...defaults, ...saved };
    } catch {
      return { ...defaults };
    }
  }
  let p = $state(load());
  $effect(() => {
    const snapshot = JSON.stringify(p);
    try { localStorage.setItem(STORE, snapshot); } catch {}
  });

  let mode = $state('none');
  let selectedRegion = $state(-1);
  let status = $state('');
  let error = $state('');
  let busy = $state(false);
  let progress = $state(0);
  const RESULT_STORE = 'walkabout:result:v1';
  let result = $state.raw(loadResult());
  function loadResult() {
    try { return JSON.parse(localStorage.getItem(RESULT_STORE) ?? 'null'); } catch { return null; }
  }
  $effect(() => {
    try {
      if (result) localStorage.setItem(RESULT_STORE, JSON.stringify(result));
      else localStorage.removeItem(RESULT_STORE);
    } catch {}
  });
  let preview = $state.raw([]);
  let hidden = $state([]);
  let focusWalker = $state(-1);
  let openWalker = $state(-1);
  let fitKey = $state(0);
  let focus = $state(null);
  let search = $state('');
  let searchResults = $state([]);
  let abort = null;
  let worker = null;

  // Cached street graph, keyed by what it depends on.
  let graphCache = { key: '', graph: null, elevated: false };
  let osmCache = { key: '', data: null };

  const graphKey = $derived(JSON.stringify([p.regions.map((r) => r.ring), [...p.coverTypes].sort(), [...p.sideTypes].sort()]));
  $effect(() => {
    graphKey;
    // Regions or street types changed: the old plan no longer matches.
    if (result && result.key !== graphKey) { result = null; preview = []; }
  });

  const sideMode = $derived.by(() => {
    const set = new Set(p.sideTypes);
    if (!set.size) return 'none';
    if (STREET_TYPES.every((t) => set.has(t.key))) return 'all';
    if (set.size === BUSY_TYPES.length && BUSY_TYPES.every((t) => set.has(t))) return 'busy';
    return 'custom';
  });
  const walkerCount = $derived(Math.max(1, Math.min(60, Math.round(+p.walkers || 1))));

  function addRegion(ring) {
    const n = p.regions.length;
    p.regions.push({ id: crypto.randomUUID?.() ?? String(Date.now()), name: `Region ${n + 1}`, ring, color: REGION_COLORS[n % REGION_COLORS.length] });
    mode = 'none';
  }
  function removeRegion(i) {
    p.regions.splice(i, 1);
    if (selectedRegion === i) selectedRegion = -1;
  }
  function addPoint(kind, pt) {
    (kind === 'start' ? p.starts : p.ends).push(pt);
  }
  function movePoint(kind, i, pt) {
    (kind === 'start' ? p.starts : p.ends)[i] = pt;
  }
  function setMode(m) {
    mode = mode === m ? 'none' : m;
    selectedRegion = -1;
  }

  const km = (m) => (m / 1000).toFixed(m < 10000 ? 2 : 1);
  const ft = (m) => Math.round(m * 3.28084);
  const mi = (m) => (m / 1609.344).toFixed(2);
  // Rough time: door-to-door at 2.5 km/h, walking between at 4.5 km/h, +1 min per 10 m climbed.
  const minutes = (w) => Math.round(((w.work / 2500) + ((w.length - w.work) / 4500)) * 60 + w.up / 10);
  const hm = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`);
  const label = (i) => `Walker ${i + 1}`;

  async function getGraph(signal) {
    if (graphCache.key === graphKey && graphCache.graph) return graphCache.graph;
    const bbox = padBbox(bboxOf(p.regions.flatMap((r) => r.ring)), 500);
    const okey = JSON.stringify(bbox);
    if (osmCache.key !== okey) {
      osmCache = { key: okey, data: await fetchOsm(bbox, { signal, onStatus: (s) => (status = s) }) };
    }
    status = 'Building street network…';
    const graph = buildGraph(osmCache.data, p.regions, { coverTypes: new Set(p.coverTypes), sideTypes: new Set(p.sideTypes) });
    graphCache = { key: graphKey, graph, elevated: false };
    return graph;
  }

  async function run() {
    error = '';
    result = null;
    if (!p.regions.length) { error = 'Draw at least one region first.'; return; }
    busy = true;
    progress = 5;
    abort = new AbortController();
    const signal = abort.signal;
    const warnings = [];
    try {
      const graph = await getGraph(signal);
      const req = graph.edges.filter((e) => e.need > 0);
      preview = req.map((e) => e.coords);
      if (!req.length) throw new Error('No streets of the selected types are inside your regions.');
      progress = 15;
      if (p.useElevation && !graphCache.elevated) {
        try {
          await addElevations(graph, { signal, onStatus: (s) => (status = s) });
          graphCache.elevated = true;
        } catch (err) {
          if (signal.aborted) throw err;
          clearElevations(graph);
          warnings.push(`Elevation lookup failed (${err.message}); routes were balanced on distance only.`);
        }
      }
      progress = 30;
      status = 'Planning routes…';
      const g = p.useElevation ? graph : { nodes: graph.nodes, edges: graph.edges.map(({ elev, ...e }) => e) };
      const res = await planInWorker(g, {
        walkers: walkerCount,
        climbWeight: p.useElevation ? +p.climbWeight : 0,
        starts: $state.snapshot(p.starts),
        ends: $state.snapshot(p.ends),
        paired: p.paired,
        returnToStart: p.returnToStart,
        countTravel: p.countTravel,
        timeBudgetMs: 8000,
      });
      res.warnings = [...warnings, ...res.warnings];
      res.walkers.forEach((w, i) => (w.label = label(i)));
      res.key = graphKey;
      result = res;
      hidden = [];
      focusWalker = -1;
      openWalker = -1;
      fitKey++;
      status = '';
    } catch (err) {
      if (!signal.aborted) error = err.message;
      status = '';
    } finally {
      busy = false;
      abort = null;
    }
  }

  function planInWorker(graph, opts) {
    return new Promise((resolve, reject) => {
      worker?.terminate();
      worker = new Worker(new URL('./lib/worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          progress = Math.max(progress, data.pct);
          status = data.spread != null ? `${data.phase}… (spread ${(data.spread * 100).toFixed(1)}%)` : `${data.phase}…`;
        } else {
          worker.terminate();
          worker = null;
          data.type === 'done' ? resolve(data.result) : reject(new Error(data.message));
        }
      };
      worker.onerror = (e) => { worker?.terminate(); worker = null; reject(new Error(e.message || 'Planner crashed')); };
      abort.signal.addEventListener('abort', () => { worker?.terminate(); worker = null; reject(new Error('Cancelled')); });
      worker.postMessage({ graph, opts });
    });
  }

  function cancel() {
    abort?.abort();
    busy = false;
    status = '';
  }

  const spread = $derived(result?.walkers.length ? (result.stats.maxEffort - result.stats.minEffort) / result.stats.maxEffort : 0);
  const fileBase = $derived((p.title || 'walkabout').replace(/[^\w-]+/g, '-').toLowerCase());

  function toggleHidden(i) {
    hidden = hidden.includes(i) ? hidden.filter((x) => x !== i) : [...hidden, i];
  }

  async function doSearch(e) {
    e.preventDefault();
    if (!search.trim()) return;
    searchResults = [];
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(search)}`);
      searchResults = await res.json();
      if (!searchResults.length) error = `No places found for “${search}”.`;
      else if (searchResults.length === 1) goTo(searchResults[0]);
    } catch {
      error = 'Place search is unavailable right now.';
    }
  }
  function goTo(r) {
    const [s, n, w, e] = r.boundingbox.map(Number);
    focus = { bounds: [[s, w], [n, e]] };
    searchResults = [];
  }

  function exportProject() {
    download(`${fileBase}.walkabout.json`, JSON.stringify($state.snapshot(p), null, 2), 'application/json');
  }
  function importFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    file.text().then((text) => {
      try {
        const data = JSON.parse(text);
        if (data.type === 'FeatureCollection' || data.type === 'Feature' || data.type === 'Polygon' || data.type === 'MultiPolygon') {
          importGeoJson(data);
        } else if (Array.isArray(data.regions)) {
          p = { ...defaults, ...data };
          result = null;
          fitKey++;
        } else throw new Error('Not a Walkabout project or GeoJSON file.');
      } catch (err) {
        error = `Could not import: ${err.message}`;
      }
    });
  }
  function importGeoJson(gj) {
    const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [{ geometry: gj, properties: {} }];
    let added = 0;
    for (const f of feats) {
      const g = f.geometry;
      const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) {
        const ring = poly[0].map(([lon, lat]) => [lat, lon]);
        if (ring.length > 3 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
        addRegion(ring);
        if (f.properties?.name) p.regions.at(-1).name = String(f.properties.name);
        added++;
      }
    }
    if (!added) throw new Error('No polygons found in that GeoJSON.');
    fitKey++;
  }
  function exportGeoJson() {
    const fc = {
      type: 'FeatureCollection',
      features: [
        ...p.regions.map((r) => ({
          type: 'Feature',
          properties: { name: r.name, kind: 'region' },
          geometry: { type: 'Polygon', coordinates: [[...r.ring, r.ring[0]].map(([la, lo]) => [lo, la])] },
        })),
        ...(result?.walkers ?? []).map((w, i) => ({
          type: 'Feature',
          properties: { name: w.label, kind: 'route', stroke: routeColor(i), length_m: Math.round(w.length), climb_m: Math.round(w.up) },
          geometry: { type: 'MultiLineString', coordinates: w.pieces.map((pc) => pc.coords.map(([la, lo]) => [lo, la])) },
        })),
      ],
    };
    download(`${fileBase}.geojson`, JSON.stringify(fc), 'application/geo+json');
  }
  function clearAll() {
    if (!confirm('Clear all regions, points and routes?')) return;
    p = { ...defaults, coverTypes: [...defaults.coverTypes] };
    result = null;
    preview = [];
  }
</script>

<div class="app">
  <aside class="panel">
    <header class="brand">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="34" height="34"><circle cx="16" cy="16" r="15" fill="var(--cub-yellow)" /><path d="M8 23c2-6 7-2 9-7s5-6 7-7" stroke="var(--cub-blue)" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-dasharray="3 3" /><circle cx="8" cy="23" r="2.6" fill="var(--webelos)" /><circle cx="24" cy="9" r="2.6" fill="var(--wolf)" /></svg>
      </div>
      <div>
        <h1>Walkabout</h1>
        <p>Even flyer &amp; food-pickup routes for your scouts</p>
      </div>
    </header>

    <div class="scroll">
      <form class="search" onsubmit={doSearch}>
        <input type="search" placeholder="Find a town, neighborhood or address" bind:value={search} aria-label="Search for a place" />
        <button class="btn">Go</button>
      </form>
      {#if searchResults.length > 1}
        <ul class="results">
          {#each searchResults as r}
            <li><button class="linkish" onclick={() => goTo(r)}>{r.display_name}</button></li>
          {/each}
        </ul>
      {/if}

      <section>
        <h2><span class="num">1</span> Regions to canvass</h2>
        <div class="row">
          <button class="btn" class:primary={mode === 'region'} onclick={() => setMode('region')}>
            {mode === 'region' ? 'Drawing…' : '+ Draw region'}
          </button>
          <label class="btn file">Import<input type="file" accept=".json,.geojson,application/json" onchange={importFile} hidden /></label>
        </div>
        {#if !p.regions.length}
          <p class="hint">Draw one or more areas on the map. Every street of the chosen types inside them gets covered.</p>
        {/if}
        <ul class="items">
          {#each p.regions as r, i (r.id)}
            <li class:sel={selectedRegion === i}>
              <span class="swatch" style:background={r.color}></span>
              <input class="name" bind:value={r.name} aria-label="Region name" />
              <span class="meta">{(ringAreaM2(r.ring) / 1e6).toFixed(2)} km²</span>
              <button class="icon" title="Edit corners on the map" onclick={() => (selectedRegion = selectedRegion === i ? -1 : i)}>✎</button>
              <button class="icon" title="Delete region" onclick={() => removeRegion(i)}>✕</button>
            </li>
          {/each}
        </ul>
        {#if selectedRegion >= 0}<p class="hint">Drag the white squares on the map to reshape the region.</p>{/if}
      </section>

      <section>
        <h2><span class="num">2</span> Start &amp; end points <small>optional</small></h2>
        <div class="row">
          <button class="btn" class:primary={mode === 'start'} onclick={() => setMode('start')}>+ Start</button>
          <button class="btn" class:primary={mode === 'end'} onclick={() => setMode('end')}>+ End</button>
        </div>
        <label class="check"><input type="checkbox" bind:checked={p.paired} /> Starts and ends are pairs (start 1 goes with end 1…)</label>
        {#if !p.ends.length}
          <label class="check"><input type="checkbox" bind:checked={p.returnToStart} /> Walkers return to where they started</label>
        {/if}
        <p class="hint">
          With fewer points than walkers, walkers share the nearest one (e.g. everyone leaves from the den's meeting place).
          With none, each route starts and ends wherever works best.
        </p>
        {#if p.starts.length || p.ends.length}
          <div class="pts">
            {#each [['start', p.starts], ['end', p.ends]] as [kind, list]}
              {#each list as pt, i}
                <span class="chip {kind}">
                  {kind === 'start' ? 'Start' : 'End'} {i + 1}
                  <button class="icon" title="Remove" onclick={() => list.splice(i, 1)}>✕</button>
                </span>
              {/each}
            {/each}
          </div>
        {/if}
      </section>

      <section>
        <h2><span class="num">3</span> Walkers</h2>
        <label class="field">
          Number of walkers (or walking groups)
          <input type="number" min="1" max="60" bind:value={p.walkers} />
        </label>
        <label class="check"><input type="checkbox" bind:checked={p.useElevation} /> Balance hills as well as distance</label>
        {#if p.useElevation}
          <label class="field">
            <span>1 m of climb counts as <strong>{p.climbWeight} m</strong> of walking</span>
            <input type="range" min="0" max="20" step="1" bind:value={p.climbWeight} />
          </label>
        {/if}
        <div class="field">
          <span>Sides of the street</span>
          <div class="seg" role="group" aria-label="Which streets are walked one side at a time">
            <button class="btn small" class:primary={sideMode === 'none'} onclick={() => (p.sideTypes = [])}>Criss-cross all</button>
            <button class="btn small" class:primary={sideMode === 'busy'} onclick={() => (p.sideTypes = [...BUSY_TYPES])}>Busy roads two-sided</button>
            <button class="btn small" class:primary={sideMode === 'all'} onclick={() => (p.sideTypes = STREET_TYPES.map((t) => t.key))}>All two-sided</button>
          </div>
          <span class="hint">
            Criss-cross streets are covered both sides in one pass. Two-sided streets are walked one side at a time,
            and each side can go to a different walker; a walker with both goes down one side and back the other.
            {#if sideMode === 'custom'}(Custom mix, see More options.){/if}
          </span>
        </div>
        <details>
          <summary>More options</summary>
          <label class="check"><input type="checkbox" bind:checked={p.countTravel} /> Count walking to, between and from streets when balancing</label>
          <table class="types">
            <thead><tr><th>Street type</th><th>Cover</th><th title="Each side is its own pass, which can go to a different walker">Sides separately</th></tr></thead>
            <tbody>
              {#each STREET_TYPES as t}
                <tr>
                  <td>{t.label}</td>
                  <td><input type="checkbox" value={t.key} bind:group={p.coverTypes} aria-label="Cover {t.label}" /></td>
                  <td><input type="checkbox" value={t.key} bind:group={p.sideTypes} aria-label="Walk each side of {t.label} separately" /></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </details>
      </section>

      <section class="go">
        {#if busy}
          <div class="progress" aria-label="Progress"><div style:width="{progress}%"></div></div>
          <p class="status">{status}</p>
          <button class="btn" onclick={cancel}>Cancel</button>
        {:else}
          <button class="btn primary big" onclick={run} disabled={!p.regions.length}>Plan {walkerCount} route{walkerCount === 1 ? '' : 's'}</button>
        {/if}
        {#if error}<p class="error" role="alert">{error}</p>{/if}
      </section>

      {#if result}
        <section class="results-panel">
          <h2>Routes</h2>
          {#each result.warnings as w}<p class="warn">{w}</p>{/each}
          {#if result.walkers.length}
            <p class="summary">
              {result.walkers.length} routes · {km(result.stats.totalWork)} km of canvassing ·
              hardest and easiest differ by <strong>{(spread * 100).toFixed(1)}%</strong>
            </p>
            <div class="row">
              <button class="btn" onclick={() => download(`${fileBase}-all.gpx`, toGpx(result.walkers, p.title || 'Walkabout routes'))}>All routes (GPX)</button>
              <button class="btn" onclick={() => window.print()}>Print route sheets</button>
              <button class="btn" onclick={exportGeoJson}>GeoJSON</button>
            </div>
            <ul class="walkers">
              {#each result.walkers as w, i}
                <li
                  onmouseenter={() => (focusWalker = i)}
                  onmouseleave={() => (focusWalker = -1)}
                  class:off={hidden.includes(i)}
                >
                  <div class="whead">
                    <button class="swatch big" style:background={routeColor(i)} title={hidden.includes(i) ? 'Show on map' : 'Hide on map'} onclick={() => toggleHidden(i)}>{i + 1}</button>
                    <div class="wstats">
                      <strong>{km(w.length)} km</strong> <span>({mi(w.length)} mi)</span>
                      <span>↑{Math.round(w.up)} m ↓{Math.round(w.down)} m</span>
                      <span>≈ {hm(minutes(w))}</span>
                    </div>
                    <button class="icon" title="Download GPX" onclick={() => download(`${fileBase}-walker-${i + 1}.gpx`, toGpx([w], w.label))}>⤓</button>
                    <button class="icon" title="Street list" onclick={() => (openWalker = openWalker === i ? -1 : i)}>{openWalker === i ? '▴' : '▾'}</button>
                  </div>
                  <div class="bar"><div style:width="{(w.effort / result.stats.maxEffort) * 100}%" style:background={routeColor(i)}></div></div>
                  {#if openWalker === i}
                    <ol class="streets">
                      {#each w.streets as s}
                        <li class={s.kind}>
                          {#if s.kind === 'work'}<strong>{s.name || 'Unnamed street'}</strong>{#if s.side}&nbsp;· {s.side} side{/if}
                          {:else if s.kind === 'walk'}Walk via {s.name || 'path'}
                          {:else}Cut across (no mapped path){/if}
                          <span>{Math.round(s.meters)} m</span>
                        </li>
                      {/each}
                    </ol>
                  {/if}
                </li>
              {/each}
            </ul>
            <p class="hint">Solid lines: hand out flyers (lines drawn beside a street cover just that side). Dashed: just walking. Hover a route to highlight it; click its number to hide it.</p>
          {/if}
        </section>
      {/if}

      <section class="project">
        <label class="field">Project name <input bind:value={p.title} placeholder="e.g. Pack 42 food drive 2026" /></label>
        <div class="row">
          <button class="btn" onclick={exportProject}>Save project file</button>
          <label class="btn file">Open project<input type="file" accept=".json" onchange={importFile} hidden /></label>
          <button class="btn danger" onclick={clearAll}>Clear</button>
        </div>
        <p class="hint">Your work is kept in this browser automatically. Streets © OpenStreetMap contributors; elevation by Open-Meteo.</p>
      </section>
    </div>
  </aside>

  <main class="mapcol">
    <MapView
      {mode}
      regions={p.regions}
      starts={p.starts}
      ends={p.ends}
      paired={p.paired}
      {selectedRegion}
      {preview}
      walkers={result?.walkers ?? []}
      {focusWalker}
      {hidden}
      {fitKey}
      {focus}
      onRegionDone={addRegion}
      onRegionEdit={(i, ring) => (p.regions[i].ring = ring)}
      onSelectRegion={(i) => (selectedRegion = i)}
      onAddPoint={addPoint}
      onMovePoint={movePoint}
      onCancelMode={() => (mode = 'none')}
    />
  </main>
</div>

{#if result?.walkers.length}
  <div class="print-sheets">
    {#each result.walkers as w, i}
      <article class="sheet">
        <h1><span class="swatch big" style:background={routeColor(i)}>{i + 1}</span> {p.title || 'Walkabout'} · {w.label}</h1>
        <p>
          {km(w.length)} km ({mi(w.length)} mi) · climb {Math.round(w.up)} m ({ft(w.up)} ft) · about {hm(minutes(w))}
          {#if w.start}<br />Start: {w.start[0].toFixed(5)}, {w.start[1].toFixed(5)}{/if}
          {#if w.end}· End: {w.end[0].toFixed(5)}, {w.end[1].toFixed(5)}{/if}
        </p>
        <ol class="streets">
          {#each w.streets as s}
            <li class={s.kind}>
              {#if s.kind === 'work'}☐ <strong>{s.name || 'Unnamed street'}</strong> — {s.side ? `${s.side} side` : 'both sides'}
              {:else if s.kind === 'walk'}Walk via {s.name || 'path'}
              {:else}Cut across (no mapped path){/if}
              <span>{Math.round(s.meters)} m</span>
            </li>
          {/each}
        </ol>
      </article>
    {/each}
  </div>
{/if}
