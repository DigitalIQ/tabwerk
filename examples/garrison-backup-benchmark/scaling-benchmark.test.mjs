import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { seedScalingStore, verifyScalingStore, inventoryScalingStore, summarizeScalingSamples, hashScalingHistory } from './scaling-benchmark.mjs';
import * as codec from './delta-archive.mjs';
import { openDeltaStore } from './delta-store.mjs';

const root = resolve(import.meta.dirname, '../../.tmp/garrison-real-data');
const history = Array.from({ length: 8 }, (_, n) => [{ sequence: n, preserved: { nested: ['stable', null, true] }, tabs: Array.from({ length: 20 }, (_, id) => ({ id, url: `https://synthetic.test/${id}?v=${id === n ? n : 0}` })) }]);

test('v2 seed matches public API frames, complete metadata history, logical bytes and all restored fields', async () => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'scaling-harness-test-'));
  try {
    for (const checkpointInterval of [1, 5]) {
      const seeded = join(directory, `seed-${checkpointInterval}`), normal = join(directory, `api-${checkpointInterval}`);
      const seed = await seedScalingStore(seeded, history, checkpointInterval, codec);
      const api = await openDeltaStore(normal, { checkpointInterval });
      for (const point of history) await api.append(point);
      const actual = await api.inspect(); await api.close();
      const seedApi = await openDeltaStore(seeded, { checkpointInterval }), expected = await seedApi.inspect();
      assert.deepEqual(expected.ids, actual.ids);
      assert.equal(expected.nextId, actual.nextId); assert.equal(expected.generation, actual.generation);
      assert.deepEqual(expected.entries.map(({ file, ...entry }) => entry), actual.entries.map(({ file, ...entry }) => entry));
      assert.deepEqual(expected.accounting, actual.accounting);
      assert.equal(seed.equivalentApiCommittedBytes, actual.counters.bytesWritten);
      assert.equal(seed.historicAndCurrentIndexBytes, actual.counters.indexBytesWritten);
      const a = await inventoryScalingStore(seeded), b = await inventoryScalingStore(normal);
      assert.equal(a.bytes, b.bytes); assert.equal(a.fileCount, b.fileCount);
      assert.equal(a.files.filter(file => file.name.startsWith('manifest-')).length, history.length + 1);
      assert.equal(a.files.filter(file => file.name.startsWith('index-')).length, history.length);
      assert.equal((await stat(seeded)).mode & 0o777, 0o700);
      for (const file of a.files) assert.equal((await stat(join(seeded, file.name))).mode & 0o077, 0);
      await verifyScalingStore(seeded, history, history.map((_, id) => id), checkpointInterval, codec);
      for (let id = 0; id < history.length; id++) assert.deepEqual(await seedApi.restore(id), history[id]);
      assert.deepEqual((await seedApi.retain([3, 5, 7])).retainedIds, [3, 5, 7]);
      await verifyScalingStore(seeded, [history[3], history[5], history[7]], [3, 5, 7], checkpointInterval, codec);
      await seedApi.collectGarbage();
      assert.deepEqual(await seedApi.list(), [3, 5, 7]);
      assert.deepEqual(await seedApi.restore(5), history[5]); await seedApi.close();
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('v2 seed matches actual API across two 32-entry index boundaries and GC provenance', async () => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'scaling-boundary-test-'));
  const points = Array.from({ length: 65 }, (_, sequence) => [{ sequence, nested: { preserved: [null, true, 'stable'] } }]);
  try {
    const seeded = join(directory, 'seed'), normal = join(directory, 'api');
    const seed = await seedScalingStore(seeded, points, 5, codec);
    const actualApi = await openDeltaStore(normal, { checkpointInterval: 5 });
    for (const point of points) await actualApi.append(point);
    const seedApi = await openDeltaStore(seeded, { checkpointInterval: 5 });
    const actual = await actualApi.inspect(), expected = await seedApi.inspect();
    assert.deepEqual(expected.accounting, actual.accounting);
    assert.equal(seed.equivalentApiCommittedBytes, actual.counters.bytesWritten);
    assert.equal(seed.historicAndCurrentIndexBytes, actual.counters.indexBytesWritten);
    assert.equal((await inventoryScalingStore(seeded)).fileCount, (await inventoryScalingStore(normal)).fileCount);
    await verifyScalingStore(seeded, points, points.map((_, id) => id), 5, codec);
    for (const api of [actualApi, seedApi]) await api.retain([31, 32, 33, 63, 64]);
    const actualGc = await actualApi.collectGarbage(), seededGc = await seedApi.collectGarbage();
    assert.deepEqual(seededGc, actualGc);
    assert.deepEqual((await seedApi.inspect()).accounting, (await actualApi.inspect()).accounting);
    assert.deepEqual(await seedApi.restore(32), points[32]);
    assert.deepEqual(await actualApi.restore(64), points[64]);
    await verifyScalingStore(seeded, [31, 32, 33, 63, 64].map(id => points[id]), [31, 32, 33, 63, 64], 5, codec);
    await actualApi.close(); await seedApi.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('seed validation and public list reject damaged unselected historical frame', async () => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'scaling-harness-test-'));
  try {
    const seeded = join(directory, 'seed'); await seedScalingStore(seeded, history, 5, codec);
    const api = await openDeltaStore(seeded);
    const inspection = await api.inspect(), entry = inspection.entries[2];
    const bytes = await readFile(join(seeded, entry.file)); bytes[bytes.length - 1] ^= 1;
    await writeFile(join(seeded, entry.file), bytes);
    await assert.rejects(verifyScalingStore(seeded, history, history.map((_, id) => id), 5, codec));
    await assert.rejects(api.list(), /Committed frame hash mismatch/);
    await api.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sample summaries retain paired order and explicitly empirical p95', () => {
  const summary = summarizeScalingSamples([5, 1, 4, 2, 3]);
  assert.deepEqual(summary.samplesMs, [5, 1, 4, 2, 3]);
  assert.equal(summary.medianMs, 3); assert.equal(summary.p95Ms, 5);
  assert.throws(() => summarizeScalingSamples([NaN]), /Invalid samples/);
  assert.throws(() => summarizeScalingSamples([]), /Invalid samples/);
});

test('pointwise history hash equals complete JSON byte hash without allocating full history JSON', () => {
  for (const points of [[], history, [[{ unicode: 'Größe', escaped: '\n', empty: {}, nested: [null, false, 0] }]]]) {
    assert.equal(hashScalingHistory(points), createHash('sha256').update(JSON.stringify(points)).digest('hex'));
  }
});
