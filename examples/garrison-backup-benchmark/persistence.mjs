import { open, rename, unlink, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Nur lokale Vergleichsartefakte. Kein transaktionaler Browser-Blockstore.
export async function saveArchive(path, archive, { beforeRename } = {}) {
  const stage = `${path}.stage-${randomUUID()}`;
  let handle;
  try {
    handle = await open(stage, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(archive));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await beforeRename?.();
    await rename(stage, path);
  } finally {
    await handle?.close();
    await unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function loadArchive(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
