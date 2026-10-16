import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { openDeltaStore } from './delta-store.mjs';
import { metadata, makeLegacy } from './metadata-test-helpers.mjs';

const scratch = resolve(import.meta.dirname, '../../.tmp');
const worker = join(import.meta.dirname, 'delta-store-crash-worker.mjs');
const realHistory = process.env.TSM_PREPARED_PATH
  ? JSON.parse(await readFile(resolve(process.env.TSM_PREPARED_PATH))).history : null;
const point = id => realHistory ? structuredClone(realHistory[id % realHistory.length]) : [{ id, value: 'synthetic'.repeat(50), arbitrary: [null, -0] }];
async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'metadata-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function killAt(t, config, points) {
  const child = fork(worker, [JSON.stringify(config)], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Metadata boundary timeout')); }, 30000);
    child.on('message', message => {
      if (message.type === 'ready') child.send({ type: 'start', points });
      if (message.type === 'failure') { clearTimeout(timer); reject(new Error('Metadata worker failed before selected boundary')); }
      if (message.type === 'boundary') { clearTimeout(timer); child.kill('SIGKILL'); }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      signal === 'SIGKILL' ? resolvePromise() : reject(new Error('Worker exited without selected process kill'));
    });
  });
}
async function verify(directory, count, version) {
  const store = await openDeltaStore(directory);
  try {
    assert.deepEqual(await store.list(), Array.from({ length: count }, (_, id) => id));
    for (let id = 0; id < count; id++) assert.ok(isDeepStrictEqual(await store.restore(id), point(id)), 'Complete recovered point differs');
    if (version !== undefined) assert.equal((await metadata(directory)).manifest.version, version);
  } finally { await store.close(); }
}

test('process kill at index writes on both sides of a full segment preserves complete commits', { timeout: 180000 }, async t => {
  const root = await fixture(t), baseline = join(root, 'baseline'), seed = await openDeltaStore(baseline);
  for (let id = 0; id < 33; id++) await seed.append(point(id));
  await seed.close();
  for (const count of [32, 33]) {
    const source = join(root, `source-${count}`);
    await cp(baseline, source, { recursive: true });
    const store = await openDeltaStore(source);
    if (count === 32) await store.retain(Array.from({ length: 32 }, (_, id) => id));
    await store.close();
    for (const phase of ['before-index-write', 'after-index-write', 'after-index-fsync', 'after-manifest-fsync', 'before-commit', 'after-commit', 'after-commit-fsync']) {
      await t.test(`${count} / ${phase}`, async sub => {
        const directory = join(root, `append-${count}-${phase}`);
        await cp(source, directory, { recursive: true });
        await killAt(sub, { directory, operation: 'append', phase }, [point(33)]);
        const committed = phase === 'after-commit' || phase === 'after-commit-fsync';
        const recovered = await openDeltaStore(directory);
        try {
          const ids = await recovered.list();
          assert.deepEqual(ids, [...Array.from({ length: count }, (_, id) => id), ...(committed ? [33] : [])]);
          for (let id = 0; id < count; id++) assert.ok(isDeepStrictEqual(await recovered.restore(id), point(id)), 'Complete recovered history differs');
          if (committed) assert.ok(isDeepStrictEqual(await recovered.restore(33), point(33)), 'Complete appended point differs');
          assert.equal(await recovered.append(point(34)), committed ? 34 : 33);
        } finally { await recovered.close(); }
      });
    }
  }
});

test('process kill at every metadata migration persistence boundary keeps readable v1 or complete v2', { timeout: 300000 }, async t => {
  const root = await fixture(t), baseline = join(root, 'baseline'), seed = await openDeltaStore(baseline);
  for (let id = 0; id < 35; id++) await seed.append(point(id));
  await seed.close(); await makeLegacy(baseline);
  for (const phase of ['locked', 'before-index-write', 'after-index-write', 'after-index-fsync',
    'before-manifest-write', 'after-manifest-write', 'after-manifest-fsync', 'before-directory-fsync',
    'after-directory-fsync', 'before-pointer-write', 'after-pointer-write', 'after-pointer-fsync',
    'before-commit', 'after-commit', 'after-commit-fsync']) {
    for (const occurrence of phase.includes('index') ? [1, 2] : [1]) await t.test(`${phase} / ${occurrence}`, async sub => {
      const directory = join(root, `migrate-${phase}-${occurrence}`);
      await cp(baseline, directory, { recursive: true });
      await killAt(sub, { directory, operation: 'migrateMetadata', phase, occurrence });
      const committed = phase === 'after-commit' || phase === 'after-commit-fsync';
      await verify(directory, 35, committed ? 2 : 1);
      const store = await openDeltaStore(directory);
      try { await store.migrateMetadata(); await store.collectGarbage(); assert.equal(await store.append(point(35)), 35); }
      finally { await store.close(); }
      await verify(directory, 36, 2);
    });
  }
});

test('interrupted GC retains live index chain and preserves unproven index-shaped files', { timeout: 180000 }, async t => {
  const root = await fixture(t), baseline = join(root, 'baseline'), seed = await openDeltaStore(baseline);
  for (let id = 0; id < 67; id++) await seed.append(point(id));
  const retained = [...Array.from({ length: 34 }, (_, id) => id), 66];
  await seed.retain(retained); await seed.close();
  const foreign = 'index-00000000-0000-4000-8000-000000000000.json';
  await writeFile(join(baseline, foreign), '{"unproven":"synthetic"}');
  for (const config of [{ phase: 'before-gc-unlink' }, { phase: 'after-gc-unlink' },
    { phase: 'after-gc-unlink', indexDeletes: 2 }, { phase: 'after-gc-unlink', indexDeletes: 33 }, { phase: 'after-gc-fsync' }]) await t.test(JSON.stringify(config), async sub => {
    const directory = join(root, `${config.phase}-${config.indexDeletes ?? 0}`); await cp(baseline, directory, { recursive: true });
    await killAt(sub, { directory, operation: 'collectGarbage', ...config });
    const store = await openDeltaStore(directory);
    try {
      assert.deepEqual(await store.list(), retained);
      for (const id of await store.list()) assert.ok(isDeepStrictEqual(await store.restore(id), point(id)), 'Retained point differs after GC kill');
      await store.collectGarbage();
      assert.equal((await store.collectGarbage()).deletedFiles, 0);
      const after = await store.inspect();
      assert.equal(after.accounting.orphanFiles, 1, 'GC retry left proven obsolete objects behind');
      assert.equal(after.accounting.orphanBytes, Buffer.byteLength('{"unproven":"synthetic"}'));
      assert.equal(await readFile(join(directory, foreign), 'utf8'), '{"unproven":"synthetic"}');
      assert.equal(await store.append(point(67)), 67);
    } finally { await store.close(); }
  });
});

test('helper death after migration CURRENT rename reports unknown commit and recovers complete v2', { timeout: 30000 }, async t => {
  const root = await fixture(t), directory = join(root, 'store'), seed = await openDeltaStore(directory);
  for (let id = 0; id < 3; id++) await seed.append(point(id));
  await seed.close(); await makeLegacy(directory);
  const executable = join(root, 'kill-migration-helper.py');
  await writeFile(executable, `#!/usr/bin/env python3
import os, signal, sys
code, store = sys.argv[3], sys.argv[4]
replace = os.replace
def kill_after_replace(*args, **kwargs):
    result = replace(*args, **kwargs)
    if args[1] == 'CURRENT':
        os.kill(os.getpid(), signal.SIGKILL)
    return result
os.replace = kill_after_replace
sys.argv = ['helper', store]
exec(compile(code, '<migration-helper-kill>', 'exec'))
`, { flag: 'wx', mode: 0o700 });
  const store = await openDeltaStore(directory, { pythonExecutable: executable });
  try {
    await assert.rejects(() => store.migrateMetadata(), error => {
      assert.equal(error.committed, null);
      assert.equal(error.commitUnknown, true);
      return true;
    });
  } finally { await store.close(); }
  await verify(directory, 3, 2);
  const recovered = await openDeltaStore(directory);
  try { assert.equal(await recovered.append(point(3)), 3); }
  finally { await recovered.close(); }
  await verify(directory, 4, 2);
});
