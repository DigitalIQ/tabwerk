import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, chmod, rm, readdir, symlink, stat, utimes } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { openDeltaStore, DELTA_STORE_FAULT_PHASES } from './delta-store.mjs';
import { metadata, rewriteMetadata } from './metadata-test-helpers.mjs';

// Nur synthetische Punkte; jeder Test besitzt sein eigenes privates Verzeichnis.
const scratch = resolve(import.meta.dirname, '../../.tmp');
const point = i => [{ id: 'synthetic-session', arbitrary: { negativeZero: -0, text: 'x'.repeat(2000), changed: i }, windows: [{ tabs: [{ url: 'https://example.invalid/', title: `Synthetic ${i}`, unknownField: [null, false, i] }] }] }];
async function privateDirectory(t) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(`${scratch}/delta-store-test-`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('append, reopen and restore preserve arbitrary JSON fields and -0', async t => {
  const directory = await privateDirectory(t);
  let store = await openDeltaStore(directory);
  for (let i = 0; i < 8; i++) assert.equal(await store.append(point(i)), i);
  const before = await store.inspect();
  assert.equal(before.counters.frameWrites, 8);
  assert.equal(before.counters.manifestWrites, 9); // Einschließlich leerem Genesis.
  assert.equal(before.counters.pointerWrites, 9);
  assert.ok(before.entries.some(entry => entry.kind === 'delta'));
  assert.equal(before.accounting.totalFileBytes, before.accounting.referencedBytes + before.accounting.orphanBytes + before.accounting.otherBytes);
  assert.ok(before.accounting.orphanBytes > 0);
  assert.equal(JSON.stringify(before).includes('unknownField'), false);
  await store.close();
  store = await openDeltaStore(directory);
  assert.deepEqual(await store.list(), Array.from({ length: 8 }, (_, i) => i));
  for (let i = 0; i < 8; i++) assert.deepEqual(await store.restore(i), point(i));
  assert.equal(await store.append(point(8)), 8);
  await store.close();
});

test('reopen resumes deterministic codec chain without extra checkpoint bytes', async t => {
  const directDirectory = await privateDirectory(t), reopenDirectory = await privateDirectory(t);
  const direct = await openDeltaStore(directDirectory);
  for (let i = 0; i < 8; i++) await direct.append(point(i));
  let reopened;
  for (let i = 0; i < 8; i++) {
    reopened = await openDeltaStore(reopenDirectory);
    await reopened.append(point(i));
    await reopened.close();
  }
  reopened = await openDeltaStore(reopenDirectory);
  const a = await direct.inspect(), b = await reopened.inspect();
  assert.deepEqual(a.entries.map(entry => entry.sha256), b.entries.map(entry => entry.sha256));
  assert.equal(a.accounting.referencedFrameBytes, b.accounting.referencedFrameBytes);
  await direct.close(); await reopened.close();
});

test('collectGarbage reclaims proven old objects, preserves current and unknown files', async t => {
  const directory = await privateDirectory(t);
  const store = await openDeltaStore(directory);
  for (let i = 0; i < 7; i++) await store.append(point(i));
  const foreignName = 'frame-00000000-0000-0000-0000-000000000000.bin';
  await writeFile(`${directory}/${foreignName}`, 'uncommitted or foreign');
  await writeFile(`${directory}/notes.txt`, 'keep');
  await store.retain([1, 5]);
  const before = await store.inspect();
  const result = await store.collectGarbage();
  const after = await store.inspect();
  assert.ok(result.deletedFiles > 7);
  assert.equal(before.accounting.totalFileBytes - after.accounting.totalFileBytes, result.reclaimedBytes);
  assert.ok(after.accounting.orphanBytes > 0); // Unbewiesene Datei bleibt erhalten.
  assert.equal(await readFile(`${directory}/${foreignName}`, 'utf8'), 'uncommitted or foreign');
  assert.equal(await readFile(`${directory}/notes.txt`, 'utf8'), 'keep');
  assert.deepEqual(await store.restore(1), point(1));
  assert.deepEqual(await store.restore(5), point(5));
  assert.deepEqual(await store.collectGarbage(), { deletedFiles: 0, reclaimedBytes: 0 });
  assert.equal(await store.append(point(7)), 7);
  await store.collectGarbage();
  await store.close();
  const recovered = await openDeltaStore(directory);
  assert.deepEqual(await recovered.list(), [1, 5, 7]);
  await recovered.close();
});

test('recovery completes interrupted genesis before exposing an initialized handle', async t => {
  const directory = await privateDirectory(t);
  await assert.rejects(openDeltaStore(directory, { faultInjector(phase, context) {
    if (context.operation === 'open' && phase === 'after-commit') throw new Error('Initialization interrupted');
  } }), /Initialization interrupted/);
  const recovered = await openDeltaStore(directory);
  assert.deepEqual(await recovered.list(), []);
  await recovered.close();
  await rm(`${directory}/CURRENT`);
  await assert.rejects(openDeltaStore(directory), /Missing committed CURRENT/);
});

test('unexpected helper death at pointer replacement reports unknown commit outcome', async t => {
  const directory = await privateDirectory(t);
  const initial = await openDeltaStore(directory);
  await initial.append(point(0)); await initial.close();
  const wrapper = `${directory}/kill-helper.py`;
  await writeFile(wrapper, `#!/usr/bin/env python3\nimport os, sys\nsource = sys.argv[3]\nneedle = "os.replace(plan['pointerFile'], 'CURRENT', src_dir_fd=root, dst_dir_fd=root)"\nsource = source.replace(needle, needle + "\\n        os._exit(137)")\nos.execvp('python3', ['python3', '-u', '-c', source, sys.argv[4]])\n`);
  await chmod(wrapper, 0o700);
  const store = await openDeltaStore(directory, { pythonExecutable: wrapper });
  await assert.rejects(store.append(point(1)), error => error.committed === null && error.commitUnknown === true && error.durable === false);
  await store.close();
  const recovered = await openDeltaStore(directory);
  assert.deepEqual(await recovered.list(), [0, 1]);
  assert.deepEqual(await recovered.restore(1), point(1));
  await recovered.close();
});

test('arbitrary retention rebases dependencies, keeps stable IDs and survives empty retention', async t => {
  const directory = await privateDirectory(t);
  const store = await openDeltaStore(directory);
  for (let i = 0; i < 10; i++) await store.append(point(i));
  const retained = await store.retain([9, 1, 6, 3]);
  assert.deepEqual(retained.retainedIds, [1, 3, 6, 9]);
  assert.deepEqual(await store.list(), [1, 3, 6, 9]);
  for (const id of retained.retainedIds) assert.deepEqual(await store.restore(id), point(id));
  await assert.rejects(store.restore(2), /outside retained/);
  await assert.rejects(store.retain([1, 7]), /missing/);
  assert.equal(await store.append(point(10)), 10);
  await store.retain([]);
  assert.deepEqual(await store.list(), []);
  await store.close();
  const reopened = await openDeltaStore(directory);
  assert.equal(await reopened.append(point(11)), 11);
  assert.deepEqual(await reopened.restore(11), point(11));
  await reopened.close();
});

test('stale handles and concurrent operations serialize without losing updates', async t => {
  const directory = await privateDirectory(t);
  const a = await openDeltaStore(directory), b = await openDeltaStore(directory);
  const ids = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).append(point(i))));
  assert.equal(new Set(ids).size, 12);
  assert.deepEqual(await a.list(), Array.from({ length: 12 }, (_, i) => i));
  for (const [i, id] of ids.entries()) assert.deepEqual(await b.restore(id), point(i));
  await a.retain([1, 4, 8]);
  assert.equal(await b.append(point(12)), 12);
  assert.deepEqual(await a.list(), [1, 4, 8, 12]);
  await a.close(); await b.close();
});

test('failure boundaries expose only a complete previous or complete next commit', async t => {
  for (const phase of DELTA_STORE_FAULT_PHASES.filter(phase => phase !== 'locked')) {
    await t.test(phase, async t => {
      const directory = await privateDirectory(t);
      const initial = await openDeltaStore(directory);
      await initial.append(point(0)); await initial.close();
      let fired = false;
      const store = await openDeltaStore(directory, { faultInjector(current, context) {
        if (context.operation === 'append' && current === phase) { fired = true; throw new Error('Injected failure'); }
      } });
      let failure;
      try { await store.append(point(1)); } catch (error) { failure = error; }
      assert.equal(fired, true);
      assert.match(failure.message, /Injected failure/);
      const afterCommit = ['after-commit', 'after-commit-fsync'].includes(phase);
      assert.equal(failure.committed, afterCommit);
      const recovered = await openDeltaStore(directory);
      assert.deepEqual(await recovered.list(), afterCommit ? [0, 1] : [0]);
      assert.deepEqual(await recovered.restore(0), point(0));
      if (afterCommit) assert.deepEqual(await recovered.restore(1), point(1));
      const nextId = await recovered.append(point(2));
      assert.equal(nextId, afterCommit ? 2 : 1);
      await recovered.close(); await store.close();
    });
  }
});

test('committed corruption fails closed rather than opening an older generation', async t => {
  const directory = await privateDirectory(t);
  const store = await openDeltaStore(directory);
  await store.append(point(0)); await store.append(point(1));
  const metadata = await store.inspect(); await store.close();
  const file = `${directory}/${metadata.entries[1].file}`, bytes = await readFile(file);
  bytes[bytes.length - 1] ^= 1; await writeFile(file, bytes);
  await assert.rejects(openDeltaStore(directory), /Committed frame hash mismatch/);
});

test('manifest invariants and missing CURRENT fail closed with sanitized errors', async t => {
  const directory = await privateDirectory(t);
  const store = await openDeltaStore(directory);
  await store.append(point(0)); await store.close();
  const value = await metadata(directory);
  value.entries[0].id = value.manifest.nextId;
  await rewriteMetadata(directory, value);
  await assert.rejects(openDeltaStore(directory), /Invalid committed entry/);
  await writeFile(`${directory}/CURRENT`, '{"sensitiveMarker": malformed');
  await assert.rejects(openDeltaStore(directory), error => error.message === 'Invalid store JSON' && !String(error.stack).includes('sensitiveMarker'));
  await rm(`${directory}/CURRENT`);
  await assert.rejects(openDeltaStore(directory), /Missing committed CURRENT/);
});

test('symlink store objects and lock files are rejected; orphans are ignored', async t => {
  const directory = await privateDirectory(t);
  const store = await openDeltaStore(directory);
  await store.append(point(0));
  await writeFile(`${directory}/frame-00000000-0000-0000-0000-000000000000.bin`, 'uncommitted');
  assert.deepEqual(await store.list(), [0]);
  const info = await store.inspect();
  assert.ok(info.accounting.orphanBytes >= 11);
  await store.close();
  await rm(`${directory}/.writer.lock`);
  await symlink('CURRENT', `${directory}/.writer.lock`);
  await assert.rejects(openDeltaStore(directory), /Unsafe|symbolic|Too many levels/);
  const other = await privateDirectory(t);
  const target = await privateDirectory(t);
  await symlink(target, `${other}/linked`);
  await assert.rejects(openDeltaStore(`${other}/linked`), /symlink/);
  assert.ok((await readdir(directory)).includes('CURRENT'));
});

test('every transaction rechecks same-size unrelated corruption without trusting unchanged file stats', async t => {
  const directory = await privateDirectory(t), store = await openDeltaStore(directory);
  t.after(() => store.close());
  for (let i = 0; i < 7; i++) await store.append(point(i));
  const info = await store.inspect(), path = `${directory}/${info.entries[1].file}`;
  const original = await readFile(path), attributes = await stat(path);
  // Bereits benutzter Handle und erfolgreiches Restore dürfen keinen Cache öffnen.
  assert.deepEqual(await store.restore(6), point(6));
  const corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
  await writeFile(path, corrupt); await utimes(path, attributes.atime, attributes.mtime);
  assert.equal((await stat(path)).size, attributes.size);
  for (const operation of [() => store.list(), () => store.restore(6), () => store.append(point(7)), () => store.retain([6]), () => store.inspect(), () => store.collectGarbage(), () => openDeltaStore(directory)]) {
    await assert.rejects(operation(), /Committed frame hash mismatch/);
  }
  await writeFile(path, original);
  const restored = await store.restore(6); restored[0].arbitrary.changed = 'outside';
  assert.deepEqual(await store.restore(6), point(6));
  assert.equal(await store.append(point(7)), 7);
});

test('rehashing committed historical frames cannot hide malformed patches or dependency and state changes', async t => {
  const directory = await privateDirectory(t), store = await openDeltaStore(directory);
  t.after(() => store.close());
  for (let i = 0; i < 7; i++) await store.append(point(i));
  const value = await metadata(directory);
  const path = `${directory}/${value.entries[1].file}`, original = await readFile(path);
  for (const mutate of [
    e => { e.payload = ['a', 1, [[0, ['invalid']]]]; },
    e => { e.baseHash = '0'.repeat(64); },
    e => { e.stateHash = '0'.repeat(64); },
    e => { e.base = 44; },
    e => { e.index = 44; },
    e => { e.checkpointInterval = 1; },
  ]) {
    const envelope = JSON.parse(gunzipSync(original.subarray(40))); mutate(envelope);
    const compressed = gzipSync(JSON.stringify(envelope)), header = Buffer.alloc(40);
    header.write('TJD1'); header.writeUInt32BE(compressed.length, 4);
    createHash('sha256').update(compressed).digest().copy(header, 8);
    const changed = Buffer.concat([header, compressed]); await writeFile(path, changed);
    value.entries[1].sha256 = createHash('sha256').update(changed).digest('hex');
    await rewriteMetadata(directory, value);
    for (const operation of [() => store.list(), () => store.restore(6), () => store.append(point(7)), () => store.retain([6]), () => store.inspect(), () => store.collectGarbage(), () => openDeltaStore(directory)]) {
      await assert.rejects(operation(), /Committed point validation failed/);
    }
  }
});
