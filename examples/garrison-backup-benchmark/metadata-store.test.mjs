import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { openDeltaStore } from './delta-store.mjs';

const point = index => [{ id: 'metadata-synthetic', counter: index, value: -0 }];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function privateDirectory(t) {
  const scratch = resolve(import.meta.dirname, '../../.tmp');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(`${scratch}/metadata-store-test-`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function manifestAt(directory) {
  const reference = JSON.parse(await readFile(`${directory}/CURRENT`));
  const bytes = await readFile(`${directory}/${reference.manifest}`);
  assert.equal(digest(bytes), reference.sha256);
  return JSON.parse(bytes);
}

test('v2 append writes one bounded immutable segment and constant-size manifests', async t => {
  const directory = await privateDirectory(t), store = await openDeltaStore(directory);
  t.after(() => store.close());
  assert.equal(await readFile(`${directory}/FORMAT`, 'utf8'), 'tabwerk-delta-store-v2\n');
  const batches = [];
  let previousWritten = 0;
  for (let index = 0; index < 96; index++) {
    await store.append(point(index));
    if ((index + 1) % 32 === 0) {
      const info = await store.inspect();
      batches.push(info.counters.indexBytesWritten - previousWritten);
      previousWritten = info.counters.indexBytesWritten;
      assert.equal(info.counters.indexWrites, index + 1);
      assert.equal(info.counters.manifestWrites, index + 2);
      assert.equal(info.counters.pointerWrites, index + 2);
      assert.equal(info.accounting.totalFileBytes, info.accounting.referencedBytes + info.accounting.orphanBytes + info.accounting.otherBytes);
    }
  }
  // Drei gleich große Append-Blöcke schreiben gleich große Indexdaten, statt
  // mit der gesamten bisherigen History zu wachsen. Zweistellige IDs zählen mit.
  assert.ok(Math.max(...batches) / Math.min(...batches) < 1.1);
  for (const file of await readdir(directory)) {
    if (file.startsWith('manifest-')) {
      const bytes = await readFile(`${directory}/${file}`), manifest = JSON.parse(bytes);
      assert.equal(manifest.version, 2);
      assert.equal('entries' in manifest, false);
      assert.ok(bytes.length < 600);
    } else if (file.startsWith('index-')) {
      const bytes = await readFile(`${directory}/${file}`), index = JSON.parse(bytes);
      assert.ok(index.entries.length >= 1 && index.entries.length <= 32);
      assert.ok(bytes.length <= 64 * 1024);
    }
  }
  const manifest = await manifestAt(directory);
  assert.equal(manifest.entryCount, 96);
  let reference = manifest.indexRoot, segments = 0;
  while (reference) {
    const bytes = await readFile(`${directory}/${reference.file}`);
    assert.equal(digest(bytes), reference.sha256);
    const segment = JSON.parse(bytes);
    assert.equal(segment.entries.length, 32);
    segments++;
    reference = segment.previous;
  }
  assert.equal(segments, 3);
});

test('tail replacement preserves full block references and GC keeps shared live blocks', async t => {
  const directory = await privateDirectory(t), store = await openDeltaStore(directory);
  t.after(() => store.close());
  for (let index = 0; index < 32; index++) await store.append(point(index));
  const fullRoot = (await manifestAt(directory)).indexRoot;
  await store.append(point(32));
  const firstTail = (await manifestAt(directory)).indexRoot;
  await store.append(point(33));
  const secondTail = (await manifestAt(directory)).indexRoot;
  assert.notEqual(firstTail.file, secondTail.file);
  const node = JSON.parse(await readFile(`${directory}/${secondTail.file}`));
  assert.deepEqual(node.previous, fullRoot);
  assert.equal(node.entries.length, 2);
  await store.collectGarbage();
  assert.ok((await readFile(`${directory}/${fullRoot.file}`)).length > 0);
  await assert.rejects(readFile(`${directory}/${firstTail.file}`), { code: 'ENOENT' });
  const info = await store.inspect();
  assert.equal(info.accounting.orphanFiles, 0);
  assert.equal(info.accounting.referencedIndexBytes, (await readFile(`${directory}/${fullRoot.file}`)).length + (await readFile(`${directory}/${secondTail.file}`)).length);
  for (const id of [0, 31, 32, 33]) assert.deepEqual(await store.restore(id), point(id));
  assert.deepEqual(await store.migrateMetadata(), { migrated: false, version: 2 });
});
