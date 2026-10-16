import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadPrepared } from '../real-input.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const repo = resolve(source, '../../..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { original: { type: 'string' }, prepared: { type: 'string' } } });
if (positionals.length !== 2 || !values.original || !values.prepared) throw new Error('Use capture-evidence.mjs /path/run before|after --original /path/export.json --prepared /path/prepared.json');
const target = resolve(positionals[0]);
const stage = positionals[1];
if (!['before', 'after'].includes(stage)) throw new Error('Use before or after');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function collect(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await collect(path));
    else if (entry.isFile()) result[relative(repo, path)] = sha(await readFile(path));
  }
  return result;
}
const modules = await collect(source);
const reference = await collect(resolve(repo, '.tmp/garrison-browser-reference/runtime'));
const originalBytes = await readFile(resolve(values.original));
const preparedBytes = await readFile(resolve(values.prepared));
const prepared = await loadPrepared(resolve(values.prepared));
if (sha(originalBytes) !== prepared.summary.originalExportSha256) throw new Error('Original input hash does not match prepared provenance');
const evidence = { modules, reference, originalSha256: sha(originalBytes), preparedSha256: sha(preparedBytes) };
if (stage === 'after') {
  const before = JSON.parse(await readFile(resolve(target, 'before.json')));
  if (JSON.stringify(before) !== JSON.stringify(evidence)) throw new Error('Source or input changed during browser verification');
}
await writeFile(resolve(target, `${stage}.json`), JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ stage, sourceFiles: Object.keys(modules).length, referenceFiles: Object.keys(reference).length, unchanged: stage === 'after' }));
