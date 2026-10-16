import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat, utimes } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDeltaStore } from './delta-store.mjs';
import { metadata, rewriteMetadata, makeLegacy, digest } from './metadata-test-helpers.mjs';

const scratch = resolve(import.meta.dirname, '../../.tmp');
const frozenV1Path = join(scratch, 'garrison-real-data/metadata-before-0zafg7n7/module/delta-store.mjs');
let frozenV1;
try { frozenV1 = await import(frozenV1Path); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const point = i => [{ marker: i, text: 'synthetic'.repeat(100), arbitrary: [null, false, -0] }];
async function seeded(t, count = 35) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'metadata-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openDeltaStore(directory);
  t.after(() => store.close());
  for (let i = 0; i < count; i++) await store.append(point(i));
  return { directory, store };
}
const operations = (directory, store) => [
  () => store.list(), () => store.restore(34), () => store.append(point(35)),
  () => store.retain([34]), () => store.inspect(), () => store.collectGarbage(),
  async () => { const other = await openDeltaStore(directory); await other.close(); },
];

test('all operations freshly hash every referenced historical index segment', async t => {
  const { directory, store } = await seeded(t), value = await metadata(directory);
  assert.ok(value.nodes.length >= 2);
  for (const { ref } of value.nodes) {
    const path = join(directory, ref.file), original = await readFile(path), attributes = await stat(path);
    await store.restore(34);
    const changed = Buffer.from(original); changed[changed.length - 2] ^= 1;
    await writeFile(path, changed); await utimes(path, attributes.atime, attributes.mtime);
    for (const operation of operations(directory, store)) await assert.rejects(operation);
    await writeFile(path, original);
  }
  assert.deepEqual(await store.restore(34), point(34));
});

test('missing referenced segments fail closed on existing handles and reopen', async t => {
  const { directory, store } = await seeded(t), value = await metadata(directory);
  const path = join(directory, value.nodes.at(-1).ref.file), bytes = await readFile(path);
  await rm(path);
  for (const operation of operations(directory, store)) await assert.rejects(operation);
  await writeFile(path, bytes);
  assert.equal((await store.list()).length, 35);
});

test('rehashed invalid segment and manifest structures fail closed', async t => {
  for (const [name, mutate] of [
    ['duplicate ID', v => { v.nodes[0].node.entries[0].id = 0; }],
    ['wrong index', v => { v.nodes[0].node.entries[0].index = 900; }],
    ['empty node', v => { v.nodes[0].node.entries = []; }],
    ['oversized node', v => { v.nodes[0].node.entries = Array.from({ length: 33 }, () => v.entries[0]); }],
    ['node version', v => { v.nodes[0].node.version = 1; }],
    ['entry count', v => { v.manifest.entryCount++; }],
    ['next ID', v => { v.manifest.nextId = 1; }],
    ['unsafe entry count', v => { v.manifest.entryCount = Number.MAX_SAFE_INTEGER + 1; }],
    ['wrong interval', v => { v.manifest.checkpointInterval++; }],
    ['oversized segment bytes', v => { v.nodes[0].node.padding = 'x'.repeat(65537); }],
    ['unsafe generation', v => { v.manifest.generation = Number.MAX_SAFE_INTEGER + 1; }],
    ['unsafe entry ID', v => { v.nodes[0].node.entries[0].id = Number.MAX_SAFE_INTEGER + 1; }],
    ['duplicate frame', v => { v.nodes[0].node.entries[0].file = v.entries[0].file; }],
    ['frame path escape', v => { v.nodes[0].node.entries[0].file = '../outside.bin'; }],
  ]) await t.test(name, async sub => {
    const { directory, store } = await seeded(sub), value = await metadata(directory);
    mutate(value); await rewriteMetadata(directory, value);
    for (const operation of operations(directory, store)) await assert.rejects(operation);
  });
});

test('cycle-shaped index references terminate with failure', { timeout: 10000 }, async t => {
  const { directory, store } = await seeded(t), value = await metadata(directory);
  const { node, ref } = value.nodes[0];
  node.previous = { file: ref.file, sha256: ref.sha256 };
  const bytes = Buffer.from(JSON.stringify(node));
  await writeFile(join(directory, ref.file), bytes);
  value.manifest.indexRoot.sha256 = digest(bytes);
  const manifest = Buffer.from(JSON.stringify(value.manifest));
  await writeFile(join(directory, value.pointer.manifest), manifest);
  value.pointer.sha256 = digest(manifest);
  await writeFile(join(directory, 'CURRENT'), JSON.stringify(value.pointer));
  for (const operation of operations(directory, store)) await assert.rejects(operation);
});

test('combined manifest and index bytes have a hard 64 MiB load budget', { timeout: 30000 }, async t => {
  const { directory, store } = await seeded(t, 0), value = await metadata(directory);
  let previous = null;
  for (let index = 0; index < 1025; index++) {
    const file = `index-${randomUUID()}.json`;
    const node = { version: 2, entries: [{ id: index, index, file: 'frame-00000000-0000-4000-8000-000000000000.bin', sha256: '0'.repeat(64) }], previous, padding: '' };
    node.padding = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(node)));
    const bytes = Buffer.from(JSON.stringify(node));
    assert.equal(bytes.length, 65536);
    await writeFile(join(directory, file), bytes);
    previous = { file, sha256: digest(bytes) };
  }
  value.manifest.indexRoot = previous;
  value.manifest.entryCount = value.manifest.nextId = 1025;
  const bytes = Buffer.from(JSON.stringify(value.manifest));
  await writeFile(join(directory, value.pointer.manifest), bytes);
  value.pointer.sha256 = digest(bytes);
  await writeFile(join(directory, 'CURRENT'), JSON.stringify(value.pointer));
  await assert.rejects(() => store.list(), /Metadata byte limit exceeded/);
  await assert.rejects(() => openDeltaStore(directory), /Metadata byte limit exceeded/);
});

test('segment boundaries, arbitrary and empty retention keep IDs and all state', async t => {
  const { directory, store } = await seeded(t, 67);
  const before = await metadata(directory);
  assert.ok(before.nodes.length >= 3);
  assert.ok(before.nodes.every(({ node }) => node.entries.length > 0 && node.entries.length <= 32));
  await store.retain([66, 0, 31, 32, 64]);
  assert.deepEqual(await store.list(), [0, 31, 32, 64, 66]);
  for (const id of await store.list()) assert.deepEqual(await store.restore(id), point(id));
  await store.collectGarbage();
  await store.retain([]);
  assert.deepEqual(await store.list(), []);
  const empty = await metadata(directory);
  assert.equal(empty.manifest.indexRoot, null);
  assert.equal(empty.manifest.entryCount, 0);
  await store.collectGarbage();
  assert.equal(await store.append(point(67)), 67);
  assert.deepEqual(await store.restore(67), point(67));
});

test('legacy reads and explicit migration preserve frame bytes, IDs and points', async t => {
  const { directory, store } = await seeded(t);
  await store.close(); await makeLegacy(directory);
  const prior = await metadata(directory), hashes = new Map();
  for (const entry of prior.entries) hashes.set(entry.file, digest(await readFile(join(directory, entry.file))));
  const legacy = await openDeltaStore(directory);
  t.after(() => legacy.close());
  assert.deepEqual(await legacy.list(), Array.from({ length: 35 }, (_, i) => i));
  assert.deepEqual(await legacy.restore(34), point(34));
  await assert.rejects(() => legacy.append(point(35)), /migrat/i);
  await assert.rejects(() => legacy.retain([34]), /migrat/i);
  await legacy.migrateMetadata();
  assert.equal((await metadata(directory)).manifest.version, 2);
  for (const [file, hash] of hashes) assert.equal(digest(await readFile(join(directory, file))), hash);
  for (let id = 0; id < 35; id++) assert.deepEqual(await legacy.restore(id), point(id));
  await legacy.collectGarbage();
  assert.equal(await legacy.append(point(35)), 35);
  await legacy.migrateMetadata();
  assert.deepEqual(await legacy.restore(35), point(35));
});

test('migration reads independent frozen v1 writer output without rewriting frames', { skip: !frozenV1 }, async t => {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'metadata-frozen-v1-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = await frozenV1.openDeltaStore(directory);
  for (let id = 0; id < 35; id++) await old.append(point(id));
  await old.close();
  const before = await metadata(directory), hashes = new Map();
  for (const entry of before.entries) hashes.set(entry.file, digest(await readFile(join(directory, entry.file))));
  const current = await openDeltaStore(directory);
  try {
    for (let id = 0; id < 35; id++) assert.deepEqual(await current.restore(id), point(id));
    await current.migrateMetadata();
    for (const [file, hash] of hashes) assert.equal(digest(await readFile(join(directory, file))), hash);
    for (let id = 0; id < 35; id++) assert.deepEqual(await current.restore(id), point(id));
    await current.collectGarbage();
    assert.equal(await current.append(point(35)), 35);
  } finally { await current.close(); }
});
