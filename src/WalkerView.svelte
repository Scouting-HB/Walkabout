<script>
  // Read-only view of one walker's route, opened from a #walk=… share link.
  import { onDestroy } from 'svelte';
  import MapView from './lib/MapView.svelte';
  import Step from './lib/Step.svelte';
  import { toGpx, download } from './lib/gpx.js';
  import { routeColor } from './lib/palette.js';
  import { unpack, walkerFromPayload } from './lib/share.js';
  import { miles, kms, dist, short, minutes, hm } from './lib/units.js';

  let { data } = $props();

  let route = $state.raw(null);
  let error = $state('');
  let me = $state(null);
  let locating = $state(false);
  let locError = $state('');
  let fitKey = $state(0);
  let watchId = null;
  let mapView;
  let hl = $state(-1); // highlighted step
  let hlFrom = 'list';
  $effect(() => {
    if (hl < 0 || hlFrom !== 'map') return;
    const k = hl;
    requestAnimationFrame(() => document.querySelector(`.checklist [data-step="${k}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  });

  // Ticked-off streets are remembered on this phone, per link.
  const doneKey = `walkabout:done:${hash(data)}`;
  let done = $state(readDone());
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function readDone() {
    try { return JSON.parse(localStorage.getItem(doneKey) ?? '[]'); } catch { return []; }
  }
  $effect(() => {
    const v = JSON.stringify(done);
    try { localStorage.setItem(doneKey, v); } catch {}
  });

  unpack(data)
    .then((d) => {
      const r = walkerFromPayload(d);
      r.walker.color = routeColor(r.index ?? 0);
      route = r;
      document.title = `${r.walker.label}${r.title ? ` · ${r.title}` : ''} · Walkabout`;
      fitKey++;
    })
    .catch((err) => (error = err.message?.includes('version') ? err.message : 'This route link is incomplete or damaged. Ask for it to be sent again.'));

  const w = $derived(route?.walker);
  const work = $derived(w ? w.streets.map((s, i) => [s, i]).filter(([s]) => s.kind === 'work') : []);
  const doneCount = $derived(work.filter(([, i]) => done.includes(i)).length);


  function toggleDone(i) {
    done = done.includes(i) ? done.filter((x) => x !== i) : [...done, i];
  }

  function locate() {
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      me = null;
      locating = false;
      return;
    }
    if (!navigator.geolocation) { locError = 'This browser cannot share your location.'; return; }
    locating = true;
    locError = '';
    let first = true;
    watchId = navigator.geolocation.watchPosition(
      ({ coords }) => {
        me = { lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy };
        if (first) { first = false; focus = { center: [me.lat, me.lon], zoom: 17 }; }
      },
      (err) => {
        locError = err.code === 1 ? 'Location permission was denied.' : 'Could not find your location.';
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
        locating = false;
      },
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
  }
  let focus = $state(null);
  onDestroy(() => watchId != null && navigator.geolocation.clearWatch(watchId));

  const fileBase = $derived(((route?.title ? `${route.title}-` : '') + (w?.label ?? 'route')).replace(/[^\w-]+/g, '-').toLowerCase());
  const plannerUrl = `${location.origin}${location.pathname}`;
</script>

<div class="app">
  <aside class="panel">
    <header class="brand">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="34" height="34"><circle cx="16" cy="16" r="15" fill="var(--cub-yellow)" /><path d="M8 23c2-6 7-2 9-7s5-6 7-7" stroke="var(--cub-blue)" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-dasharray="3 3" /><circle cx="8" cy="23" r="2.6" fill="var(--webelos)" /><circle cx="24" cy="9" r="2.6" fill="var(--wolf)" /></svg>
      </div>
      <div>
        <h1>{w ? w.label : 'Walkabout'}</h1>
        <p>{route?.title || 'Your flyer & food-pickup route'}</p>
      </div>
    </header>

    <div class="scroll">
      {#if error}
        <p class="error" role="alert">{error}</p>
        <p class="hint"><a href={plannerUrl}>Open the Walkabout planner</a></p>
      {:else if !w}
        <p class="status">Opening route…</p>
      {:else}
        <section>
          <div class="whead">
            <span class="swatch big" style:background={w.color}>{route.index + 1}</span>
            <div class="wstats">
              <strong>{miles(w.length)}</strong> <span>({kms(w.length)})</span>
              <span>↑{short(w.up)}</span>
              <span>≈ {hm(minutes(w))}</span>
            </div>
          </div>
          <div class="row actions">
            <button class="btn" class:primary={locating} onclick={locate}>{locating ? 'Stop showing me' : '📍 Show where I am'}</button>
            <button class="btn" onclick={() => (fitKey++, (focus = null))}>Whole route</button>
            <button class="btn" onclick={() => download(`${fileBase}.gpx`, toGpx([w], w.label))}>GPX</button>
            <button class="btn" onclick={() => window.print()}>Print</button>
          </div>
          {#if locError}<p class="error">{locError}</p>{/if}
        </section>

        <section>
          <h2>Streets <small>{doneCount} of {work.length} done</small></h2>
          <ol class="streets checklist">
            {#each w.streets as s, i}
              <li
                class={s.kind}
                class:done={done.includes(i)}
                class:hl={hl === i}
                data-step={i}
                onmouseenter={() => (hl = i, (hlFrom = 'list'))}
                onmouseleave={() => (hl = -1)}
              >
                {#if s.kind === 'work'}
                  <input type="checkbox" checked={done.includes(i)} onchange={() => toggleDone(i)} aria-label="Done" />
                {/if}
                <button class="what" onclick={() => { hl = i; hlFrom = 'list'; mapView?.showStep(0, i); }} title="Show on the map">
                  <Step {s} prev={w.streets[i - 1]} />
                </button>
                <span class="len">{short(s.meters)}</span>
              </li>
            {/each}
          </ol>
          <p class="hint">
            Solid line: hand out flyers. A line drawn beside a street means just that side; down the middle means both sides.
            Dashed: just walking. {#if w.start}S is the start{#if w.end}, E is the end{/if}.{/if}
          </p>
        </section>
        <p class="hint"><a href={plannerUrl}>Open the Walkabout planner</a></p>
      {/if}
    </div>
  </aside>

  <main class="mapcol">
    <MapView
      bind:this={mapView}
      highlight={hl >= 0 ? { w: 0, k: hl } : null}
      onHoverStep={(_, k) => { hl = k; hlFrom = 'map'; }}
      onPickStep={(_, k) => { hl = k; hlFrom = 'map'; }}
      walkers={w ? [w] : []}
      starts={w?.start ? [w.start] : []}
      ends={w?.end ? [w.end] : []}
      editable={false}
      {fitKey}
      {focus}
      {me}
    />
  </main>
</div>

{#if w}
  <div class="print-sheets">
    <article class="sheet">
      <h1><span class="swatch big" style:background={w.color}>{route.index + 1}</span> {route.title || 'Walkabout'} · {w.label}</h1>
      <p>{dist(w.length)} · climb {short(w.up)} · about {hm(minutes(w))}</p>
      <ol class="streets">
        {#each w.streets as s, k}
          <li class={s.kind}>
            {#if s.kind === 'work'}☐ {/if}<Step {s} prev={w.streets[k - 1]} />
            <span>{short(s.meters)}</span>
          </li>
        {/each}
      </ol>
    </article>
  </div>
{/if}

<style>
  .actions { margin-top: 10px; }
  .checklist { padding-left: 0; list-style: none; font-size: 0.92rem; }
  .checklist li { padding: 5px 0; border-bottom: 1px solid var(--line); display: flex; gap: 6px; align-items: baseline; }
  .checklist input { transform: scale(1.3); margin: 0 4px; }
  .checklist .what { flex: 1; background: none; border: 0; padding: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; }
  .checklist .len { color: var(--muted); white-space: nowrap; }
  .checklist li { padding-left: 4px; padding-right: 4px; border-radius: 4px; }
  .checklist li.walk, .checklist li.gap { padding-left: 30px; }
  .checklist li.done .what { text-decoration: line-through; color: var(--muted); }
  h2 small { font-weight: 400; color: var(--muted); font-size: 0.8rem; margin-left: 6px; }
</style>
