import assert from 'node:assert/strict';
import { mkdir, mkdtemp, chmod, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { loadPrepared } from './real-input.mjs';
import { openDeltaStore } from './delta-store.mjs';

const position = process.argv.indexOf('--prepared');
if (position < 0 || !process.argv[position + 1]) throw new Error('--prepared erforderlich');
const source = resolve(process.argv[position + 1]);
const prepared = await loadPrepared(source);
const history = prepared.history;
assert.ok(history.length >= 2, 'At least two real points needed');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHash = hash(await readFile(source));
const root = resolve(import.meta.dirname, '../../.tmp/garrison-real-data');
await mkdir(root, { recursive: true, mode: 0o700 });
const output = await mkdtemp(join(root, 'transactional-real-'));
await chmod(output, 0o700);
const round = value => Math.round(value * 1000) / 1000;
async function diskInventory(directory) {
  let files = 0, bytes = 0, allocatedBytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const sub = await diskInventory(path); files += sub.files; bytes += sub.bytes; allocatedBytes += sub.allocatedBytes;
    } else if (entry.isFile()) {
      const info = await stat(path); files++; bytes += info.size; allocatedBytes += info.blocks * 512;
    } else throw new Error('Unexpected filesystem entry in private test store');
  }
  return { files, bytes, allocatedBytes };
}
async function verify(store, expected) {
  assert.deepEqual(await store.list(), [...expected.keys()]);
  const times = [];
  for (const [id, point] of expected) {
    const begin = performance.now();
    const restored = await store.restore(id);
    times.push(round(performance.now() - begin));
    assert.ok(isDeepStrictEqual(restored, point), `Real point ${id} differs`);
  }
  return times;
}
function verifyAccounting(inspection, disk) {
  const a = inspection.accounting;
  assert.equal(disk.bytes, a.totalFileBytes, 'inventory matches reported file bytes');
  assert.equal(a.referencedBytes + a.orphanBytes + a.otherBytes, a.totalFileBytes, 'all byte categories accounted');
}
const report = {
  version: 1, createdAt: new Date().toISOString(), node: process.version,
  inputSummary: prepared.summary, sourcePreparedSha256: sourceHash,
  scope: 'Actual local filesystem transactions on supplied TSM points. No browser or hardware power-loss test. Values never included in report.',
  timing: 'Wall clock includes local helper, lock, validation, file writes and fsync. Not directly comparable to previous RAM-only CPU benchmarks.',
  rounds: [], checkpointOnlyRounds: [], retention: [],
};
for (let iteration = 0; iteration < 3; iteration++) {
  const directory = join(output, `full-${iteration}`);
  let store = await openDeltaStore(directory, { checkpointInterval: 5 });
  const appendMs = [], expected = new Map(), inspections = [];
  for (let i = 0; i < history.length; i++) {
    const begin = performance.now();
    const id = await store.append(history[i]);
    appendMs.push(round(performance.now() - begin));
    assert.equal(id, i); expected.set(id, history[i]);
    inspections.push(await store.inspect());
  }
  const restoreMs = await verify(store, expected);
  const beforeClose = await store.inspect();
  await store.close();
  const begin = performance.now();
  store = await openDeltaStore(directory);
  const reopenMs = round(performance.now() - begin);
  const reopenedRestoreMs = await verify(store, expected);
  const inspection = await store.inspect();
  const diskBeforeGc = await diskInventory(directory);
  verifyAccounting(inspection, diskBeforeGc);
  const gcStart = performance.now();
  const garbageCollection = await store.collectGarbage();
  const gcMs = round(performance.now() - gcStart);
  await verify(store, expected);
  const afterGc = await store.inspect();
  verifyAccounting(afterGc, await diskInventory(directory));
  await store.close();
  report.rounds.push({ appendMs, totalAppendMs: round(appendMs.reduce((a, b) => a + b, 0)), restoreMs, reopenMs, reopenedRestoreMs, beforeClose, inspection, inspections, diskBeforeGc, garbageCollection, gcMs, afterGc, disk: await diskInventory(directory) });
}

// Gleicher transaktionaler Store, aber jeder Zeitpunkt als voller Checkpoint.
// Damit bleiben Locking, Hashprüfung, Manifest und fsync im Vergleich identisch.
for (let iteration = 0; iteration < 3; iteration++) {
  const directory = join(output, `checkpoint-only-${iteration}`);
  const store = await openDeltaStore(directory, { checkpointInterval: 1 });
  const appendMs = [], expected = new Map();
  for (let i = 0; i < history.length; i++) {
    const start = performance.now();
    const id = await store.append(history[i]);
    appendMs.push(round(performance.now() - start));
    assert.equal(id, i); expected.set(id, history[i]);
    await store.inspect();
  }
  const restoreMs = await verify(store, expected);
  const beforeGc = await store.inspect();
  const diskBeforeGc = await diskInventory(directory);
  verifyAccounting(beforeGc, diskBeforeGc);
  const garbageCollection = await store.collectGarbage();
  const afterGc = await store.inspect();
  await verify(store, expected);
  const disk = await diskInventory(directory);
  verifyAccounting(afterGc, disk);
  await store.close();
  report.checkpointOnlyRounds.push({ appendMs, totalAppendMs: round(appendMs.reduce((a, b) => a + b, 0)), restoreMs, beforeGc, diskBeforeGc, garbageCollection, afterGc, disk });
}

const directory = join(output, 'retention');
let store = await openDeltaStore(directory, { checkpointInterval: 5 });
const expected = new Map();
for (let i = 0; i < history.length; i++) expected.set(await store.append(history[i]), history[i]);
// Beliebige, nicht zusammenhängende Punkte; der ursprüngliche Checkpoint fehlt.
const keep = [...new Set([1, Math.floor(history.length / 3), Math.floor(2 * history.length / 3), history.length - 1])].sort((a, b) => a - b);
const retentionStart = performance.now();
await store.retain(keep);
const retentionMs = round(performance.now() - retentionStart);
for (const id of [...expected.keys()]) if (!keep.includes(id)) expected.delete(id);
await store.close(); store = await openDeltaStore(directory);
await verify(store, expected);
report.retention.push({ kind: 'arbitrary-subset-after-reopen', keptIds: keep, retentionMs, inspection: await store.inspect(), disk: await diskInventory(directory) });
const sentinelPath = join(directory, 'unrelated-user-file.txt');
const sentinel = 'Unrelated file must remain unchanged.';
await writeFile(sentinelPath, sentinel, { flag: 'wx', mode: 0o600 });
const subsetGc = await store.collectGarbage();
await verify(store, expected);
assert.equal(await readFile(sentinelPath, 'utf8'), sentinel);
report.retention.push({ kind: 'arbitrary-subset-after-gc', garbageCollection: subsetGc, inspection: await store.inspect(), disk: await diskInventory(directory) });

// Unveränderter letzter Punkt wird für diesen API-Test erneut angehängt.
const nextId = await store.append(history.at(-1));
assert.equal(nextId, history.length); expected.set(nextId, history.at(-1));
await verify(store, expected);
report.retention.push({ kind: 'append-after-retention', appendedId: nextId, inspection: await store.inspect() });
await store.retain([]); expected.clear();
await store.close(); store = await openDeltaStore(directory);
await verify(store, expected);
report.retention.push({ kind: 'empty-after-reopen', inspection: await store.inspect(), disk: await diskInventory(directory) });
const emptyGc = await store.collectGarbage();
await verify(store, expected);
assert.equal(await readFile(sentinelPath, 'utf8'), sentinel);
report.retention.push({ kind: 'empty-after-gc', garbageCollection: emptyGc, inspection: await store.inspect(), disk: await diskInventory(directory) });
const afterEmpty = await store.append(history[0]);
assert.equal(afterEmpty, history.length + 1); expected.set(afterEmpty, history[0]);
await store.close(); store = await openDeltaStore(directory);
await verify(store, expected);
report.retention.push({ kind: 'append-after-empty-and-reopen', appendedId: afterEmpty, inspection: await store.inspect(), disk: await diskInventory(directory) });
await store.close();

// Neustart nach jedem Commit prüft die Fortsetzung der bestehenden Delta-Kette.
const reopenDir = join(output, 'reopen-every-append');
const reopenTimes = [];
for (let i = 0; i < history.length; i++) {
  const start = performance.now();
  const writer = await openDeltaStore(reopenDir);
  assert.equal(await writer.append(history[i]), i);
  await writer.close(); reopenTimes.push(round(performance.now() - start));
}
store = await openDeltaStore(reopenDir);
await verify(store, new Map(history.map((point, i) => [i, point])));
report.reopenEveryAppend = { transactionMs: reopenTimes, inspection: await store.inspect(), disk: await diskInventory(reopenDir) };
verifyAccounting(report.reopenEveryAppend.inspection, report.reopenEveryAppend.disk);
assert.equal(report.reopenEveryAppend.inspection.accounting.referencedFrameBytes, report.rounds[0].inspection.accounting.referencedFrameBytes, 'restart preserves delta frame footprint');
await store.close();
assert.equal(hash(await readFile(source)), sourceHash, 'prepared input unchanged');
report.allRestoresExact = true;
await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
console.log(`RESULTS ${join(output, 'results.json')}`);
