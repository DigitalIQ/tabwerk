import { openDeltaStore } from './delta-store.mjs';
import { readdir } from 'node:fs/promises';

const config = JSON.parse(process.argv[2]);
let occurrence = 0;
let initialIndexFiles;
const store = await openDeltaStore(config.directory, {
  faultInjector: async (phase, context) => {
    if (phase === config.phase && context.operation === config.operation) {
      if (config.indexDeletes) {
        const current = new Set(await readdir(config.directory));
        if (initialIndexFiles.filter(name => !current.has(name)).length < config.indexDeletes) return;
      }
      if (++occurrence < (config.occurrence ?? 1)) return;
      process.send({ type: 'boundary', phase, context });
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
  },
});
initialIndexFiles = (await readdir(config.directory)).filter(name => name.startsWith('index-') && name.endsWith('.json'));

try {
  const start = new Promise(resolve => process.once('message', resolve));
  process.send({ type: 'ready' });
  const input = await start;
  if (config.operation === 'append') {
    const ids = [];
    for (const point of input.points) ids.push(await store.append(point));
    process.send({ type: 'done', ids });
  } else if (config.operation === 'collectGarbage') {
    process.send({ type: 'done', result: await store.collectGarbage() });
  } else if (config.operation === 'migrateMetadata') {
    process.send({ type: 'done', result: await store.migrateMetadata() });
  } else {
    process.send({ type: 'done', result: await store.retain(config.ids) });
  }
  await store.close();
  process.disconnect();
} catch (error) {
  process.send({ type: 'failure', message: error.stack });
  await store.close().catch(() => {});
  process.exitCode = 1;
  process.disconnect();
}
