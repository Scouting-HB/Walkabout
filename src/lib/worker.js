import { plan } from './planner.js';

self.onmessage = (ev) => {
  const { graph, opts } = ev.data;
  try {
    const result = plan(graph, opts, (p) => self.postMessage({ type: 'progress', ...p }));
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
