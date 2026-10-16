import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function metadata(directory) {
  const pointer = JSON.parse(await readFile(join(directory, 'CURRENT')));
  const manifest = JSON.parse(await readFile(join(directory, pointer.manifest)));
  const nodes = [];
  for (let ref = manifest.indexRoot; ref; ) {
    const node = JSON.parse(await readFile(join(directory, ref.file)));
    nodes.push({ ref, node }); ref = node.previous;
  }
  return { pointer, manifest, nodes, entries: manifest.entries ?? nodes.toReversed().flatMap(({ node }) => node.entries) };
}
export async function rewriteMetadata(directory, value) {
  // Rehash the complete reference chain so semantic tests cannot pass solely on
  // an outer digest mismatch. Nodes are held newest first.
  let previous = null;
  for (const { ref, node } of value.nodes.toReversed()) {
    node.previous = previous;
    const bytes = Buffer.from(JSON.stringify(node));
    await writeFile(join(directory, ref.file), bytes);
    ref.sha256 = digest(bytes); previous = { ...ref };
  }
  if (value.manifest.version === 2) value.manifest.indexRoot = previous;
  const bytes = Buffer.from(JSON.stringify(value.manifest));
  await writeFile(join(directory, value.pointer.manifest), bytes);
  value.pointer.sha256 = digest(bytes);
  await writeFile(join(directory, 'CURRENT'), JSON.stringify(value.pointer));
}
export async function makeLegacy(directory) {
  const value = await metadata(directory);
  value.manifest = {
    version: 1, generation: value.manifest.generation, nextId: value.manifest.nextId,
    checkpointInterval: value.manifest.checkpointInterval, entries: value.entries,
  };
  value.nodes = [];
  await rewriteMetadata(directory, value);
  await writeFile(join(directory, 'FORMAT'), 'tabwerk-delta-store-v1\n');
}
