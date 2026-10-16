import { createBrowserDeltaStore } from './browser-delta-store.mjs';
import { createBrowserDurableIncrementalExporter } from './browser-incremental-export.mjs';

self.onmessage = async ({ data }) => {
  let sender, store;
  try {
    store = await createBrowserDeltaStore({ name: data.sourceName, checkpointInterval: 5 });
    sender = await createBrowserDurableIncrementalExporter({ name: data.name, checkpointInterval: 5,
      fault: (phase, context) => {
        if (phase !== data.phase || context.operation !== data.operation) return;
        self.postMessage({ phase, operation: context.operation, committed: context.committed });
        return new Promise(() => {});
      },
    });
    if (data.operation === 'prepare') await sender.prepare(store);
    else await sender.acknowledge(data.receipt);
    self.postMessage({ complete: true });
  } catch (error) { self.postMessage({ error: error.name }); }
  finally { await sender?.close(); store?.close(); }
};
