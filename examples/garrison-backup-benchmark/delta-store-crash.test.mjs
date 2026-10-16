import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { openDeltaStore } from './delta-store.mjs';
import { metadata } from './metadata-test-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scratch = resolve(here, '../../.tmp');
const worker = join(here, 'delta-store-crash-worker.mjs');
const realHistory = process.env.TSM_PREPARED_PATH
  ? JSON.parse(await readFile(resolve(process.env.TSM_PREPARED_PATH), 'utf8')).history : null;
if (realHistory) assert.ok(realHistory.length >= 8, 'Real input needs at least eight original snapshots');
const point = value => {
  if (realHistory) {
    const index = typeof value === 'number' ? value : value === 'seed' ? 0 : Number(value.split(':')[0]) * 6 + Number(value.split(':')[1]) + 1;
    return structuredClone(realHistory[index % realHistory.length]);
  }
  return [{ value, tabs: Array.from({ length: 100 }, (_, id) => ({ id, text: `tab-${id}`, extra: [null, false, id] })) }];
};
const identical = (actual, expected) => assert.ok(isDeepStrictEqual(actual, expected), 'Recovered state differs from the complete expected state');
const phases = [
  'locked', 'before-frame-write', 'after-frame-write', 'after-frame-fsync',
  'before-index-write', 'after-index-write', 'after-index-fsync',
  'before-manifest-write', 'after-manifest-write', 'after-manifest-fsync',
  'before-directory-fsync', 'after-directory-fsync', 'before-pointer-write',
  'after-pointer-write', 'after-pointer-fsync', 'before-commit', 'after-commit', 'after-commit-fsync',
];

async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'delta-store-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function launch(t, config) {
  const { points, ...publicConfig } = config;
  const child = fork(worker, [JSON.stringify(publicConfig)], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = [], waiters = new Set();
  let exit, stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8000); });
  child.on('message', message => { messages.push(message); for (const wake of waiters) wake(); });
  child.on('exit', (code, signal) => { exit = { code, signal }; for (const wake of waiters) wake(); });
  child.on('error', error => { stderr += error.stack; for (const wake of waiters) wake(); });
  t.after(() => { if (!exit) child.kill('SIGKILL'); });
  function until(predicate, description) {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${description}: ${stderr}`)), 20000);
      const finish = (error, value) => { clearTimeout(timer); waiters.delete(check); error ? reject(error) : resolvePromise(value); };
      const check = () => {
        const failure = messages.find(message => message.type === 'failure');
        const result = predicate();
        if (failure) finish(new Error(failure.message));
        else if (result) finish(null, result);
        else if (exit) finish(new Error(`Child exited before ${description}: ${JSON.stringify(exit)} ${stderr}`));
      };
      waiters.add(check); check();
    });
  }
  return {
    child,
    message: type => until(() => messages.find(message => message.type === type), type),
    exited: () => until(() => exit, 'exit'),
    start: () => child.send({ type: 'start', points }),
  };
}

async function state(directory) {
  const store = await openDeltaStore(directory);
  try {
    const ids = await store.list();
    return { ids, points: await Promise.all(ids.map(id => store.restore(id))) };
  } finally { await store.close(); }
}

test('SIGKILL at every append and retention boundary exposes a complete committed state', { timeout: 180000 }, async t => {
  // SIGKILL checks process death and stale flock recovery. It does not emulate a power loss or storage cache failure.
  const directory = await fixture(t), baseline = join(directory, 'baseline');
  const seed = await openDeltaStore(baseline), ids = [], history = Array.from({ length: 7 }, (_, id) => point(id));
  try { for (const value of history) ids.push(await seed.append(value)); }
  finally { await seed.close(); }
  const oldState = { ids, points: history };
  for (const operation of ['append', 'retain-subset', 'retain-empty']) {
    for (const phase of phases) {
      if (operation === 'retain-empty' && phase.includes('frame')) continue;
      if (operation === 'retain-empty' && phase.includes('index')) continue;
      await t.test(`${operation} / ${phase}`, { timeout: 30000 }, async sub => {
        const target = join(directory, `${operation}-${phase}`);
        await cp(baseline, target, { recursive: true });
        const retained = operation === 'retain-empty' ? [] : [ids[2], ids[4], ids[6]];
        const actualOperation = operation === 'append' ? 'append' : 'retain';
        const process = launch(sub, { directory: target, operation: actualOperation, phase, points: [point(7)], ids: retained });
        await process.message('ready'); process.start();
        await process.message('boundary');
        assert.equal(process.child.kill('SIGKILL'), true);
        assert.deepEqual(await process.exited(), { code: null, signal: 'SIGKILL' });
        const committed = ['after-commit', 'after-commit-fsync'].includes(phase);
        const nextState = operation === 'append'
          ? { ids: [...ids, ids.at(-1) + 1], points: [...history, point(7)] }
          : { ids: retained, points: retained.map(id => history[ids.indexOf(id)]) };
        identical(await state(target), committed ? nextState : oldState);
        // A recovered writer must keep stable IDs even after all original frames were removed.
        const reopened = await openDeltaStore(target);
        try {
          const next = await reopened.append(point(99));
          assert.equal(next, ids.at(-1) + (operation === 'append' && committed ? 2 : 1));
          identical(await reopened.restore(next), point(99));
        } finally { await reopened.close(); }
        const afterAppend = await state(target), expected = committed ? nextState : oldState;
        identical(afterAppend.points, [...expected.points, point(99)]);
      });
    }
  }
});

test('concurrent stale handles in separate processes never lose committed appends', { timeout: 60000 }, async t => {
  const directory = await fixture(t), root = join(directory, 'store');
  const seed = await openDeltaStore(root);
  await seed.append(point('seed')); await seed.close();
  const workers = Array.from({ length: 4 }, (_, writer) => launch(t, {
    directory: root, operation: 'append', points: Array.from({ length: 6 }, (_, index) => point(`${writer}:${index}`)),
  }));
  await Promise.all(workers.map(process => process.message('ready')));
  workers.forEach(process => process.start());
  const committed = await Promise.all(workers.map(process => process.message('done')));
  const exits = await Promise.all(workers.map(process => process.exited()));
  assert.ok(exits.every(exit => exit.code === 0 && exit.signal === null));
  const committedIds = committed.flatMap(message => message.ids);
  assert.equal(new Set(committedIds).size, 24);
  const reopened = await state(root);
  assert.deepEqual(reopened.ids, Array.from({ length: 25 }, (_, id) => id));
  const expected = new Map([[0, point('seed')]]);
  committed.forEach((message, writer) => message.ids.forEach((id, index) => expected.set(id, point(`${writer}:${index}`))));
  identical(reopened.points, reopened.ids.map(id => expected.get(id)));
});

test('SIGKILL during the first append recovers an empty or complete initialized store', { timeout: 60000 }, async t => {
  const directory = await fixture(t);
  for (const phase of phases) {
    await t.test(phase, { timeout: 30000 }, async sub => {
      const root = join(directory, phase);
      const process = launch(sub, { directory: root, operation: 'append', phase, points: [point(0)] });
      await process.message('ready'); process.start(); await process.message('boundary');
      assert.equal(process.child.kill('SIGKILL'), true);
      assert.deepEqual(await process.exited(), { code: null, signal: 'SIGKILL' });
      const committed = ['after-commit', 'after-commit-fsync'].includes(phase);
      identical(await state(root), committed ? { ids: [0], points: [point(0)] } : { ids: [], points: [] });
      const reopened = await openDeltaStore(root);
      try { assert.equal(await reopened.append(point(1)), committed ? 1 : 0); }
      finally { await reopened.close(); }
      identical((await state(root)).points, committed ? [point(0), point(1)] : [point(1)]);
    });
  }
});

test('SIGKILL during genesis initialization recovers safely and detects a missing committed CURRENT', { timeout: 60000 }, async t => {
  const directory = await fixture(t);
  for (const phase of phases.filter(value => !value.includes('frame') && !value.includes('index'))) {
    await t.test(phase, { timeout: 30000 }, async sub => {
      const root = join(directory, phase);
      const process = launch(sub, { directory: root, operation: 'open', phase });
      // Genesis hooks run inside open(), before the child can announce readiness.
      await process.message('boundary');
      assert.equal(process.child.kill('SIGKILL'), true);
      assert.deepEqual(await process.exited(), { code: null, signal: 'SIGKILL' });
      if (['after-commit', 'after-commit-fsync'].includes(phase)) {
        const damaged = join(directory, `${phase}-missing-current`);
        await cp(root, damaged, { recursive: true });
        await rm(join(damaged, 'CURRENT'));
        await assert.rejects(() => state(damaged));
      }
      identical(await state(root), { ids: [], points: [] });
      const reopened = await openDeltaStore(root);
      try { assert.equal(await reopened.append(point(0)), 0); }
      finally { await reopened.close(); }
      identical(await state(root), { ids: [0], points: [point(0)] });
    });
  }
});

test('committed frame, manifest and CURRENT corruption fail closed despite older generations', { timeout: 60000 }, async t => {
  const directory = await fixture(t), baseline = join(directory, 'baseline');
  const seed = await openDeltaStore(baseline);
  try { for (let id = 0; id < 7; id++) await seed.append(point(id)); }
  finally { await seed.close(); }
  for (const kind of ['frame', 'manifest', 'pointer', 'missing-pointer']) {
    await t.test(kind, async sub => {
      const root = join(directory, kind); await cp(baseline, root, { recursive: true });
      const pointer = JSON.parse(await readFile(join(root, 'CURRENT'), 'utf8'));
      const manifest = await metadata(root);
      if (kind === 'missing-pointer') {
        await rm(join(root, 'CURRENT'));
        await assert.rejects(() => state(root));
        await assert.rejects(() => readFile(join(root, 'CURRENT')), { code: 'ENOENT' });
        return;
      }
      const target = join(root, kind === 'pointer' ? 'CURRENT' : kind === 'manifest' ? pointer.manifest : manifest.entries.at(-1).file);
      const bytes = await readFile(target);
      bytes[Math.floor(bytes.length / 2)] ^= 1;
      await writeFile(target, bytes);
      await assert.rejects(() => state(root));
      // A read failure must never repair the committed object by silently falling back.
      assert.deepEqual(await readFile(target), bytes);
    });
  }
});

test('SIGKILL around garbage unlink preserves retained state and unrelated files', { timeout: 60000 }, async t => {
  const directory = await fixture(t);
  for (const phase of ['before-gc-unlink', 'after-gc-unlink', 'after-gc-fsync']) {
    await t.test(phase, { timeout: 30000 }, async sub => {
      const root = join(directory, phase), store = await openDeltaStore(root);
      try {
        for (let index = 0; index < 7; index++) await store.append(point(index));
        await store.retain([2, 4, 6]);
      } finally { await store.close(); }
      const unknown = ['unrelated.keep', 'frame-00000000-0000-4000-8000-000000000000.bin'];
      for (const name of unknown) await writeFile(join(root, name), 'unrelated synthetic sentinel', { flag: 'wx' });
      const process = launch(sub, { directory: root, operation: 'collectGarbage', phase });
      await process.message('ready'); process.start(); await process.message('boundary');
      assert.equal(process.child.kill('SIGKILL'), true);
      assert.deepEqual(await process.exited(), { code: null, signal: 'SIGKILL' });
      const expected = { ids: [2, 4, 6], points: [point(2), point(4), point(6)] };
      identical(await state(root), expected);
      const reopened = await openDeltaStore(root);
      try {
        await reopened.collectGarbage();
        assert.equal((await reopened.collectGarbage()).deletedFiles, 0);
        assert.equal(await reopened.append(point(7)), 7);
      } finally { await reopened.close(); }
      identical(await state(root), { ids: [2, 4, 6, 7], points: [...expected.points, point(7)] });
      for (const name of unknown) assert.equal(await readFile(join(root, name), 'utf8'), 'unrelated synthetic sentinel');
    });
  }
});

test('helper SIGKILL after CURRENT rename reports an unknown commit and recovers the complete new state', { timeout: 30000 }, async t => {
  const directory = await fixture(t), root = join(directory, 'store');
  const seed = await openDeltaStore(root);
  try { await seed.append(point(0)); }
  finally { await seed.close(); }
  const executable = join(directory, 'kill-helper-after-rename.py');
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
exec(compile(code, '<helper-kill-test>', 'exec'))
`, { flag: 'wx', mode: 0o700 });
  const store = await openDeltaStore(root, { pythonExecutable: executable });
  try {
    await assert.rejects(() => store.append(point(1)), error => {
      assert.equal(error.committed, null);
      assert.equal(error.commitUnknown, true);
      return true;
    });
  } finally { await store.close(); }
  identical(await state(root), { ids: [0, 1], points: [point(0), point(1)] });
  const reopened = await openDeltaStore(root);
  try { assert.equal(await reopened.append(point(2)), 2); }
  finally { await reopened.close(); }
  identical(await state(root), { ids: [0, 1, 2], points: [point(0), point(1), point(2)] });
});
