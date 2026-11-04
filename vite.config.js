import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  // Relative base so the build works from the GitHub Pages project path (/Walkabout/).
  base: './',
  plugins: [svelte()],
  worker: { format: 'es' },
});
