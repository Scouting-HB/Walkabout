<script>
  // One line of a route's turn-by-turn list, with the street name in bold.
  import { instruction } from './directions.js';
  let { s, prev } = $props();
  const t = $derived(instruction(s, prev));
</script>

{t.lead}{t.lead && t.name ? ' ' : ''}{#if t.name}<strong>{t.name}</strong>{/if}{t.tail}
