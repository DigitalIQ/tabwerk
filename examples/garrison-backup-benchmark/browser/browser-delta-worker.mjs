import { createBrowserDeltaStore } from './browser-delta-store.mjs';

// Der Host bestätigt die erreichte Phase durch terminate(). Vor dem Commit
// wartet der Worker ohne offene Transaction; danach ist der Commit abgeschlossen.
self.onmessage = async ({ data }) => {
  try {
    const store = await createBrowserDeltaStore({
      name: data.name,
      checkpointInterval: data.checkpointInterval ?? 5,
      faultInjector(phase, context) {
        if (phase !== data.phase) return;
        self.postMessage({ phase, committed: context.committed });
        if (phase === 'before-commit' || phase === 'after-commit') return new Promise(() => {});
      },
    });
    const id = await store.append(data.point);
    store.close();
    self.postMessage({ complete: true, id });
  } catch {
    self.postMessage({ error: 'Worker operation failed' });
  }
};
