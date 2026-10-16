import { mkdir, mkdtemp, chmod, readFile, writeFile, readdir, stat, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { cpus, platform, release, arch } from 'node:os';
import { loadPrepared } from './real-input.mjs';

// Nur lokale Daten. Assertion-Fehler und stdout enthalten keine Sessionwerte.
const BASELINE_SHA256 = '40122ab34eb21093d2ef561f2ea875b8d4af1f86f79fa3fe087b7fc9e0e3f6ad';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, label) => { if (!condition) throw new Error(label); };
const exact = (actual, expected, label) => check(isDeepStrictEqual(actual, expected), label);
const round = number => Math.round(number * 1000) / 1000;

export function summarizeSamples(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  check(sorted.length > 0 && sorted.every(x => Number.isFinite(x) && x >= 0), 'Invalid timing samples');
  const middle = Math.floor(sorted.length / 2);
  return {
    samples: samples.map(round), count: samples.length,
    medianMs: round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2),
    p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    minMs: round(sorted[0]), maxMs: round(sorted.at(-1)),
  };
}

async function inventory(directory) {
  const files = [];
  async function visit(path, prefix = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(path, entry.name), `${name}/`);
      else {
        check(entry.isFile(), 'Unexpected store filesystem entry');
        const bytes = await readFile(join(path, entry.name));
        files.push({ file: name, bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  }
  await visit(directory);
  return { files, fileCount: files.length, bytes: files.reduce((n, entry) => n + entry.bytes, 0), sha256: hash(JSON.stringify(files)) };
}

async function findBaseline(root) {
  const candidates = [];
  for (const name of await readdir(root)) {
    if (!name.startsWith('validation-before-')) continue;
    const path = join(root, name);
    try {
      if (hash(await readFile(join(path, 'delta-store.mjs'))) === BASELINE_SHA256) candidates.push({ path, mtime: (await stat(path)).mtimeMs });
    } catch { /* Unvollständige fremde Arbeitsstände überspringen. */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  check(candidates.length > 0, 'Pinned baseline not found');
  return candidates[0].path;
}

async function snapshotModules(source, destination) {
  await mkdir(destination, { mode: 0o700 });
  const result = {};
  for (const file of ['delta-store.mjs', 'delta-archive.mjs']) {
    const bytes = await readFile(join(source, file));
    await writeFile(join(destination, file), bytes, { mode: 0o600, flag: 'wx' });
    result[file] = hash(bytes);
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const source = option('--prepared');
  check(typeof source === 'string', '--prepared required');
  const smoke = args.includes('--smoke');
  const rounds = Number(option('--rounds', smoke ? 1 : 5));
  check(Number.isSafeInteger(rounds) && rounds >= (smoke ? 1 : 5), 'At least five measured rounds required');
  const preparedPath = resolve(source), preparedBytes = await readFile(preparedPath);
  const preparedHash = hash(preparedBytes), prepared = await loadPrepared(preparedPath);
  const history = prepared.history;
  check(history.length >= 3, 'At least three prepared points required');
  const root = resolve(import.meta.dirname, '../../.tmp/garrison-real-data');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(join(root, 'validation-benchmark-'));
  await chmod(output, 0o700);
  const baseline = option('--baseline', await findBaseline(root));
  const newSource = import.meta.dirname;
  const modules = {};
  modules.old = await snapshotModules(resolve(baseline), join(output, 'old-module'));
  check(modules.old['delta-store.mjs'] === BASELINE_SHA256, 'Wrong baseline module');
  modules.new = await snapshotModules(newSource, join(output, 'new-module'));
  const variants = {};
  for (const name of ['old', 'new']) variants[name] = {
    store: await import(pathToFileURL(join(output, `${name}-module/delta-store.mjs`)).href),
    codec: await import(pathToFileURL(join(output, `${name}-module/delta-archive.mjs`)).href),
  };
  check(typeof variants.new.codec.createDeltaHistoryValidator === 'function', 'Incremental validator API required');
  const checkpointInterval = 5, ids = history.map((_, id) => id);
  const selected = [...new Set([0, Math.floor(history.length / 2), history.length - 1])];
  const report = {
    version: 1, createdAt: new Date().toISOString(), node: process.version, smoke, rounds, checkpointInterval,
    environment: { platform: platform(), release: release(), architecture: arch(), logicalCpuCount: cpus().length, cpuModel: cpus()[0]?.model },
    input: { sha256: preparedHash, bytes: preparedBytes.length, points: history.length, pointFields: 'All original fields retained and deep-compared; no field selection or transformation.' },
    moduleSha256: modules,
    protocol: {
      pairing: 'Both variants run sequentially in one process; order alternates old/new then new/old each round.',
      warmup: 'One unreported full workload round per variant before measured rounds.',
      coldOpen: 'New store handle plus restore of latest point. OS page cache and module/JIT cache are not flushed.',
      fixedStore: 'A single OLD-generated store is copied byte-for-byte before every independent workload. Hash inventories exclude no files.',
      freshAppend: 'New empty store, append all prepared points in order. Open and correctness verification excluded from append timing.',
      timings: 'Wall-clock milliseconds; Python helper, locking, validation, IO/fsync included in store API timings. Assertions and directory copying excluded.',
      inProcess: 'Preloaded identical frames, complete history validation only, no Python/helper/IO; OLD repeats inspect+restore, NEW uses one sequential validator.',
      p95: 'Nearest-rank empirical p95. With five rounds this is the maximum, not a reliable tail-latency estimate.',
      locality: 'No network, publication, source-data mutation or session values in report.',
    },
    correctness: { exactFieldComparison: true, verifiedRestores: 0, fixedBytesIdentical: true },
    fixedStore: {}, timings: {}, freshStoreSizes: {}, fixedWorkloadSizes: {},
  };
  const raw = Object.fromEntries(['old', 'new'].map(name => [name, {}]));
  function record(name, operation, elapsed, measured) {
    if (measured) (raw[name][operation] ??= []).push(elapsed);
  }
  async function time(name, operation, task, measured) {
    const start = performance.now();
    const result = await task();
    record(name, operation, performance.now() - start, measured);
    return result;
  }
  async function verify(store, expectedIds = ids, expectedPoints = history) {
    exact(await store.list(), expectedIds, 'Restored IDs differ');
    for (let i = 0; i < expectedIds.length; i++) {
      exact(await store.restore(expectedIds[i]), expectedPoints[i], 'Restored fields differ');
      report.correctness.verifiedRestores++;
    }
  }
  const fixed = join(output, 'fixed-source');
  let store = await variants.old.store.openDeltaStore(fixed, { checkpointInterval });
  for (let i = 0; i < history.length; i++) exact(await store.append(history[i]), i, 'Baseline ID differs');
  await verify(store);
  await store.close();
  report.fixedStore.before = await inventory(fixed);
  const pointer = JSON.parse(await readFile(join(fixed, 'CURRENT'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(fixed, pointer.manifest), 'utf8'));
  const frames = await Promise.all(manifest.entries.map(entry => readFile(join(fixed, entry.file))));
  async function copyFixed(label) {
    const directory = join(output, label);
    await cp(fixed, directory, { recursive: true, errorOnExist: true, force: false });
    exact(await inventory(directory), report.fixedStore.before, 'Copied store bytes differ');
    return directory;
  }
  async function workload(name, iteration, measured) {
    const api = variants[name], tag = `${iteration}-${name}`;
    const directory = await copyFixed(`fixed-${tag}`);
    let handle = await api.store.openDeltaStore(directory, { checkpointInterval });
    exact(await time(name, 'warmList', () => handle.list(), measured), ids, 'List differs');
    for (const [label, id] of [['Early', selected[0]], ['Middle', selected[1]], ['Latest', selected.at(-1)]]) {
      exact(await time(name, `warmRestore${label}`, () => handle.restore(id), measured), history[id], 'Warm restore differs');
      report.correctness.verifiedRestores++;
    }
    await handle.close();
    let restored;
    await time(name, 'coldOpenAndRestoreLatest', async () => {
      handle = await api.store.openDeltaStore(directory, { checkpointInterval });
      restored = await handle.restore(ids.at(-1));
    }, measured);
    exact(restored, history.at(-1), 'Cold restore differs');
    report.correctness.verifiedRestores++;
    await handle.close();
    exact(await inventory(directory), report.fixedStore.before, 'Read workloads changed bytes');

    // Die letzten zwei Appends verwenden denselben Handle. Beim letzten Append
    // nutzt OLD seinen bisherigen Writer-Cache; NEW rekonstruiert frisch.
    const fresh = join(output, `fresh-${tag}`);
    handle = await api.store.openDeltaStore(fresh, { checkpointInterval });
    const appendTimes = [], appendedIds = [];
    await time(name, 'freshAppendAll', async () => {
      for (let i = 0; i < history.length; i++) {
        const start = performance.now();
        const id = await handle.append(history[i]);
        appendTimes.push(performance.now() - start);
        appendedIds.push(id);
      }
    }, measured);
    exact(appendedIds, ids, 'Fresh append IDs differ');
    record(name, 'warmAppendLatest', appendTimes.at(-1), measured);
    await verify(handle);
    await handle.close();
    const freshInventory = await inventory(fresh);
    if (measured) (report.freshStoreSizes[name] ??= []).push({ bytes: freshInventory.bytes, files: freshInventory.fileCount });

    // Separater Store-Snapshot: Append auf einer bestehenden History ohne
    // vorherigen Writer-Cache, unabhängig vom frischen Append-Workload.
    const appendDirectory = await copyFixed(`existing-append-${tag}`);
    handle = await api.store.openDeltaStore(appendDirectory, { checkpointInterval });
    exact(await time(name, 'existingAppend', () => handle.append(history.at(-1)), measured), history.length, 'Existing append ID differs');
    await verify(handle, [...ids, history.length], [...history, history.at(-1)]);
    await handle.close();

    const retainedDirectory = await copyFixed(`retention-${tag}`);
    handle = await api.store.openDeltaStore(retainedDirectory, { checkpointInterval });
    const retention = await time(name, 'retainThreePoints', () => handle.retain(selected), measured);
    exact(retention.retainedIds, selected, 'Retained IDs differ');
    exact(retention.removedIds, ids.filter(id => !selected.includes(id)), 'Removed IDs differ');
    await verify(handle, selected, selected.map(id => history[id]));
    await handle.close();
    if (measured) {
      const retained = await inventory(retainedDirectory), appended = await inventory(appendDirectory);
      (report.fixedWorkloadSizes[name] ??= []).push({ appendBytes: appended.bytes, appendFiles: appended.fileCount, retainedBytes: retained.bytes, retainedFiles: retained.fileCount });
    }

    let validated;
    await time(name, 'inProcessFullValidation', () => {
      validated = [];
      if (name === 'old') {
        for (let i = 0; i < frames.length; i++) {
          const metadata = api.codec.inspectDeltaFrame(frames[i]);
          check(hash(frames[i]) === manifest.entries[i].sha256 && metadata.index === i && metadata.checkpointInterval === checkpointInterval, 'Old frame integrity differs');
          validated.push(api.codec.restoreDeltaPoint(frames.slice(0, i + 1), i));
        }
      } else {
        const validator = api.codec.createDeltaHistoryValidator({ checkpointInterval });
        for (let i = 0; i < frames.length; i++) {
          const { metadata, point } = validator.append(frames[i]);
          check(metadata.frameHash === manifest.entries[i].sha256 && metadata.index === i && metadata.checkpointInterval === checkpointInterval, 'New frame integrity differs');
          validated.push(point);
        }
      }
    }, measured);
    exact(validated, history, 'In-process restored fields differ');
    report.correctness.verifiedRestores += validated.length;
  }
  console.log(JSON.stringify({ phase: 'warmup', output, measuredRounds: rounds }));
  for (let iteration = -1; iteration < rounds; iteration++) {
    const order = iteration % 2 === 0 ? ['old', 'new'] : ['new', 'old'];
    for (const name of order) await workload(name, iteration < 0 ? 'warmup' : iteration, iteration >= 0);
    console.log(JSON.stringify({ phase: iteration < 0 ? 'warmup-complete' : 'round-complete', round: iteration < 0 ? undefined : iteration + 1 }));
  }
  report.fixedStore.after = await inventory(fixed);
  exact(report.fixedStore.after, report.fixedStore.before, 'Fixed source store changed');
  exact(hash(await readFile(preparedPath)), preparedHash, 'Prepared source changed');
  for (const name of ['old', 'new']) {
    report.timings[name] = Object.fromEntries(Object.entries(raw[name]).map(([operation, samples]) => [operation, summarizeSamples(samples)]));
    for (const file of ['delta-store.mjs', 'delta-archive.mjs']) {
      exact(hash(await readFile(join(output, `${name}-module`, file))), modules[name][file], 'Frozen module changed');
    }
  }
  exact(report.freshStoreSizes.old, report.freshStoreSizes.new, 'Fresh store sizes differ');
  exact(report.fixedWorkloadSizes.old, report.fixedWorkloadSizes.new, 'Existing workload sizes differ');
  report.comparison = Object.fromEntries(Object.keys(report.timings.old).map(operation => {
    const before = report.timings.old[operation], after = report.timings.new[operation];
    return [operation, { oldMedianMs: before.medianMs, newMedianMs: after.medianMs, medianSpeedup: round(before.medianMs / after.medianMs), oldP95Ms: before.p95Ms, newP95Ms: after.p95Ms }];
  }));
  report.completedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ phase: 'complete', report: join(output, 'report.json'), smoke, correctness: report.correctness, comparison: report.comparison }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('Validation benchmark failed; no session values emitted.'); process.exitCode = 1; });
}
