import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import WalkerView from './WalkerView.svelte';
import { readHash } from './lib/share.js';

// A #walk=… link shows just that route; anything else opens the planner
// (which picks up a #setup=… link itself).
const link = readHash();
const app = link?.kind === 'walk'
  ? mount(WalkerView, { target: document.getElementById('app'), props: { data: link.data } })
  : mount(App, { target: document.getElementById('app') });

// Pasting a different share link into the same tab only changes the hash.
addEventListener('hashchange', () => readHash() && location.reload());

export default app;
