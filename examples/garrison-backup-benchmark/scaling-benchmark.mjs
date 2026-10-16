import { mkdir, mkdtemp, chmod, readFile, writeFile, readdir, stat, cp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { cpus, platform, release, arch } from 'node:os';
import { loadPrepared } from './real-input.mjs';

// Fehler und Reports enthalten keine Sessionwerte. Alle Dateien bleiben lokal.
const check = (condition, label) => { if (!condition) throw new Error(label); };
const exact = (actual, expected, label) => check(isDeepStrictEqual(actual, expected), label);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
const round = value => Math.round(value * 1000) / 1000;
const uuid = (category, index) => {
  const value = hash(`${category}:${index}`);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
};
const privateWrite = (path, bytes) => writeFile(path, bytes, { flag: 'wx', mode: 0o600 });

export function hashScalingHistory(history) {
  const digest = createHash('sha256').update('[');
  for (const [index, point] of history.entries()) {
    if (index) digest.update(',');
    digest.update(JSON.stringify(point));
  }
  return digest.update(']').digest('hex');
}

export function summarizeScalingSamples(samples) {
  check(samples.length > 0 && samples.every(x => Number.isFinite(x) && x >= 0), 'Invalid samples');
  const sorted = [...samples].sort((a, b) => a - b), middle = Math.floor(samples.length / 2);
  return { samplesMs: samples.map(round), count: samples.length,
    medianMs: round(samples.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2),
    p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]), minMs: round(sorted[0]), maxMs: round(sorted.at(-1)) };
}

export async function inventoryScalingStore(directory) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), info = await stat(path);
    check(info.isFile(), 'Unexpected store filesystem entry');
    files.push({ name, bytes: info.size, allocatedBytes: info.blocks * 512, sha256: hash(await readFile(path)) });
  }
  return { files, fileCount: files.length, bytes: files.reduce((n, file) => n + file.bytes, 0),
    allocatedBytes: files.reduce((n, file) => n + file.allocatedBytes, 0), sha256: hash(encode(files.map(({ allocatedBytes, ...file }) => file))) };
}

// Seed entspricht dem v2-Dateiformat einschließlich jedes historischen Commits.
// Das ist KEIN öffentlicher API-Aufbau und keine Messung seiner Laufzeit.
export async function seedScalingStore(directory, history, checkpointInterval, codec) {
  check(Array.isArray(history) && history.length > 0, 'Nonempty history required');
  await mkdir(directory, { mode: 0o700 });
  const writer = codec.createDeltaArchive({ checkpointInterval });
  const validator = codec.createDeltaHistoryValidator({ checkpointInterval });
  let previous, latest, indexRoot = null, indexRootPrevious = null, tail = [], frameBytes = 0, manifestBytes = 0, indexBytes = 0, pointerWritesBytes = 0;
  const entries = [], frameKinds = { checkpoint: 0, delta: 0, scheduledCheckpoints: 0, fallbackCheckpoints: 0 };
  let sinceCheckpoint = checkpointInterval;
  const commit = async generation => {
    const manifest = { version: 2, generation, nextId: generation, checkpointInterval, entryCount: entries.length, indexRoot,
      ...(previous ? { previous } : {}) };
    const name = `manifest-${uuid('manifest', generation)}.json`, bytes = encode(manifest);
    await privateWrite(join(directory, name), bytes);
    latest = { manifest: name, sha256: hash(bytes) }; previous = latest;
    manifestBytes += bytes.length; pointerWritesBytes += encode(latest).length;
  };
  await commit(0);
  for (let index = 0; index < history.length; index++) {
    const bytes = writer.append(history[index]), digest = hash(bytes);
    const validated = validator.append(bytes, { expectedFrameHash: digest });
    exact(validated.point, history[index], 'Seed reconstructed fields differ');
    frameKinds[validated.metadata.kind]++;
    if (validated.metadata.kind === 'checkpoint') {
      frameKinds[sinceCheckpoint + 1 >= checkpointInterval ? 'scheduledCheckpoints' : 'fallbackCheckpoints']++;
      sinceCheckpoint = 0;
    } else sinceCheckpoint++;
    const file = `frame-${uuid('frame', index)}.bin`;
    await privateWrite(join(directory, file), bytes);
    frameBytes += bytes.length;
    entries.push({ id: index, index, file, sha256: digest });
    if (tail.length === 32) tail = [];
    const priorRoot = indexRoot;
    tail.push(entries.at(-1));
    const previousIndex = tail.length === 1 ? priorRoot : indexRootPrevious;
    const node = { version: 2, entries: tail, previous: previousIndex };
    const indexFile = `index-${uuid('index', index)}.json`, indexData = encode(node);
    await privateWrite(join(directory, indexFile), indexData);
    indexBytes += indexData.length;
    indexRoot = { file: indexFile, sha256: hash(indexData) };
    indexRootPrevious = previousIndex;
    await commit(index + 1);
  }
  const marker = Buffer.from('tabwerk-delta-store-v2\n');
  await privateWrite(join(directory, 'FORMAT'), marker);
  await privateWrite(join(directory, 'CURRENT'), encode(latest));
  // Der lock-Inode gehört auch zu einem regulär geöffneten Store.
  await privateWrite(join(directory, '.writer.lock'), Buffer.alloc(0));
  return { method: 'deterministic-v2-seed-with-all-append-manifests-and-indexes', points: history.length, checkpointInterval,
    frameKinds, frameBytes, historicAndCurrentManifestBytes: manifestBytes, historicAndCurrentIndexBytes: indexBytes,
    historicAndCurrentMetadataBytes: manifestBytes + indexBytes,
    equivalentApiCommittedBytes: marker.length + frameBytes + manifestBytes + indexBytes + pointerWritesBytes,
    note: 'Modeled logical API writes, not measured SSD writes or measured API runtime.' };
}

export async function verifyScalingStore(directory, history, ids, checkpointInterval, codec) {
  const ref = JSON.parse(await readFile(join(directory, 'CURRENT'), 'utf8'));
  const bytes = await readFile(join(directory, ref.manifest));
  check(hash(bytes) === ref.sha256, 'Manifest hash differs');
  const manifest = await readManifest(directory), validator = codec.createDeltaHistoryValidator({ checkpointInterval });
  exact(manifest.entries.map(entry => entry.id), ids, 'Committed IDs differ');
  check(history.length === ids.length, 'Expected point count differs');
  for (const [index, entry] of manifest.entries.entries()) {
    const frame = await readFile(join(directory, entry.file));
    exact(validator.append(frame, { expectedFrameHash: entry.sha256 }).point, history[index], 'Committed restored fields differ');
  }
  return { pointsVerified: ids.length };
}

async function snapshotModules(destination) {
  await mkdir(destination, { mode: 0o700 });
  const hashes = {};
  for (const file of ['delta-store.mjs', 'delta-archive.mjs', 'scaling-fixtures.mjs', 'fixtures.mjs', 'scaling-benchmark.mjs', 'real-input.mjs']) {
    const bytes = await readFile(join(import.meta.dirname, file));
    await privateWrite(join(destination, file), bytes); hashes[file] = hash(bytes);
  }
  return hashes;
}

export async function runScalingBenchmark({ preparedPath, levels = [10, 100, 300, 1000], rounds = 5, smoke = false,
  kinds = ['tsm-cycle', 'synthetic-sparse', 'synthetic-churn'], outputRoot = resolve(import.meta.dirname, '../../.tmp/garrison-real-data'),
  apiBuildMaxPoints = 100, retentionLevels = [10, 1000] } = {}) {
  check(Number.isSafeInteger(rounds) && rounds >= (smoke ? 1 : 5), 'At least five measured rounds required');
  check(levels.length > 0 && levels.every(n => Number.isSafeInteger(n) && n >= 2), 'Invalid scaling levels');
  const preparedBytes = await readFile(preparedPath), prepared = await loadPrepared(preparedPath);
  check(prepared.history.length === 10, 'Exactly ten real source points required');
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await chmod(outputRoot, 0o700);
  const output = await mkdtemp(join(outputRoot, 'scaling-benchmark-'));
  await chmod(output, 0o700);
  const moduleDirectory = join(output, 'module'), moduleSha256 = await snapshotModules(moduleDirectory);
  const api = await import(pathToFileURL(join(moduleDirectory, 'delta-store.mjs')).href);
  const codec = await import(pathToFileURL(join(moduleDirectory, 'delta-archive.mjs')).href);
  const { buildScalingHistory } = await import(pathToFileURL(join(moduleDirectory, 'scaling-fixtures.mjs')).href);
  const generated = [{ id: 'real10', description: 'Ten unchanged supplied TSM snapshots', history: prepared.history,
    appendHistory: [...prepared.history.slice(0, 5)], metadata: { kind: 'real10', points: 10, extrapolated: false, measuredPoints: 10 },
    probeMetadata: { points: 5, provenance: 'controlled-repeat-of-first-five-source-snapshots', extrapolated: true, observedFollowupAutosaves: false } }];
  for (const kind of kinds) for (const points of levels) {
    generated.push({ kind, points });
  }
  const report = { version: 2, createdAt: new Date().toISOString(), smoke, rounds, moduleSha256,
    input: { preparedSha256: hash(preparedBytes), preparedBytes: preparedBytes.length, realPoints: prepared.history.length },
    environment: { node: process.version, platform: platform(), release: release(), architecture: arch(), logicalCpuCount: cpus().length, cpuModel: cpus()[0]?.model },
    protocol: {
      comparison: 'Same pinned optimized store and unchanged complete read validation; checkpointInterval 5 versus 1.',
      preparation: 'Deterministic v2 on-disk seed, all original frame fields, complete historic append manifests and index nodes. Seed runtime excluded from API timing. Small boundary-spanning API/seed equivalence tested separately.',
      apiBuild: `Separate fresh public append builds up to ${apiBuildMaxPoints} points. Never extrapolated from seed preparation.`,
      pairing: 'Sequential paired variants in one process, checkpoint5/1 then checkpoint1/5 on alternating rounds; one unreported full warmup per variant.',
      read: 'Open, list, early restore, latest restore through the same public API. OS caches are not flushed.',
      append: 'Fresh baseline copy each round, five consecutive appends covering one scheduled checkpoint interval. Actual frame kinds and per-offset timings reported; five-point sum describes this fixed sequence only.',
      retention: 'Fresh independent baseline copy, retain latest min(10,N-1) points, exact all-field validation, public restore of first/latest retained points.',
      correctness: 'Every seed and mutation is fully frame-reconstructed and deep-compared outside timings. Public list checks all IDs; public early/latest restores deep-compared.',
      bytes: 'File sizes include FORMAT, CURRENT, frame bytes, current and historic manifests and index nodes, lock. Allocated bytes are filesystem-specific, separate from logical sizes.',
      memory: 'Process memory before/after API workload; process high-water RSS spans preceding work and input fixture. Not an isolated operation peak or variant comparison.',
      timings: 'Wall clock including Python helper, lock, complete validation and fsync. Copy, seed, exact equality checks, inventories and report writes excluded.',
      p95: 'Empirical nearest-rank p95; with five samples this is the maximum and not a stable tail estimate.',
    }, cases: [], complete: false };
  await privateWrite(join(output, 'protocol.json'), encode(report));
  const reportPath = join(output, 'report.json');
  for (const definition of generated) {
    let fixture = definition;
    if (definition.kind) {
      const built = buildScalingHistory({ kind: definition.kind, points: definition.points + 5, realHistory: prepared.history });
      const metadata = { ...built.metadata, points: definition.points };
      if (metadata.cycleLength) {
        metadata.completedCycles = Math.floor(definition.points / metadata.cycleLength);
        metadata.trailingCyclePoints = definition.points % metadata.cycleLength;
        metadata.repeatedSessionIds = metadata.repeatedSourceTimestamps = definition.points > metadata.cycleLength;
      }
      if (metadata.restartEverySteps) metadata.restartCount = Math.floor((definition.points - 1) / metadata.restartEverySteps);
      fixture = { ...built, id: `${definition.kind}-${definition.points}`, history: built.history.slice(0, definition.points),
        appendHistory: built.history.slice(definition.points), metadata,
        probeMetadata: { generatedHistoryMetadata: built.metadata, points: 5, startsAtOrdinal: definition.points,
          provenance: built.metadata.provenance, observedFollowupAutosaves: false } };
    }
    const caseDirectory = join(output, fixture.id); await mkdir(caseDirectory, { mode: 0o700 });
    const ids = fixture.history.map((_, id) => id), results = {};
    const measuredRetention = fixture.id === 'real10' || retentionLevels.includes(fixture.history.length);
    const measuredBuild = fixture.history.length <= apiBuildMaxPoints;
    for (const checkpointInterval of [5, 1]) {
      const name = `checkpoint${checkpointInterval}`, directory = join(caseDirectory, name);
      const before = performance.now();
      const seed = await seedScalingStore(directory, fixture.history, checkpointInterval, codec);
      const preparationMs = performance.now() - before;
      const handle = await api.openDeltaStore(directory, { checkpointInterval });
      exact(await handle.list(), ids, 'Seed public IDs differ');
      for (const id of [0, ids.at(-1)]) exact(await handle.restore(id), fixture.history[id], 'Seed public restore differs');
      const inspection = await handle.inspect(); await handle.close();
      const disk = await inventoryScalingStore(directory);
      check(inspection.accounting.totalFileBytes === disk.bytes, 'Baseline disk accounting differs');
      results[name] = { checkpointInterval, seed: { ...seed, preparationMs: round(preparationMs) },
        baseline: { accounting: inspection.accounting, disk }, timings: {}, rounds: [], apiBuild: [], directory };
    }
    async function workload(name, iteration, measured) {
      const result = results[name], checkpointInterval = result.checkpointInterval;
      const sample = { iteration, operations: {}, memoryBefore: process.memoryUsage() };
      const time = async (operation, task) => { const begin = performance.now(); const value = await task(); sample.operations[operation] = performance.now() - begin; return value; };
      let handle = await time('open', () => api.openDeltaStore(result.directory, { checkpointInterval }));
      exact(await time('list', () => handle.list()), ids, 'Timed list differs');
      exact(await time('restoreEarly', () => handle.restore(0)), fixture.history[0], 'Timed early restore differs');
      exact(await time('restoreLatest', () => handle.restore(ids.at(-1))), fixture.history.at(-1), 'Timed latest restore differs');
      await handle.close();
      const appendDirectory = join(caseDirectory, `append-${name}-${iteration}`);
      await cp(result.directory, appendDirectory, { recursive: true, force: false, errorOnExist: true });
      exact((await inventoryScalingStore(appendDirectory)).sha256, result.baseline.disk.sha256, 'Append copy differs');
      handle = await api.openDeltaStore(appendDirectory, { checkpointInterval });
      const appendBefore = await handle.inspect();
      for (let offset = 0; offset < fixture.appendHistory.length; offset++) {
        const id = await time(`appendOffset${offset}`, () => handle.append(fixture.appendHistory[offset]));
        exact(id, ids.length + offset, 'Appended ID differs');
      }
      sample.operations.appendFiveTotal = fixture.appendHistory.reduce((sum, _, offset) => sum + sample.operations[`appendOffset${offset}`], 0);
      const afterAppend = await handle.inspect(), appendedIds = [...ids, ...fixture.appendHistory.map((_, index) => ids.length + index)];
      exact(await handle.list(), appendedIds, 'Appended public IDs differ');
      exact(await handle.restore(appendedIds.at(-1)), fixture.appendHistory.at(-1), 'Appended public restore differs');
      await verifyScalingStore(appendDirectory, [...fixture.history, ...fixture.appendHistory], appendedIds, checkpointInterval, codec);
      sample.append = { writtenTransactionBytes: afterAppend.counters.bytesWritten - appendBefore.counters.bytesWritten,
        writtenFrameBytes: afterAppend.accounting.referencedFrameBytes - appendBefore.accounting.referencedFrameBytes,
        writtenMetadataAndPointerBytes: afterAppend.counters.bytesWritten - appendBefore.counters.bytesWritten - (afterAppend.accounting.referencedFrameBytes - appendBefore.accounting.referencedFrameBytes),
        indexWrites: afterAppend.counters.indexWrites - appendBefore.counters.indexWrites,
        writtenIndexBytes: afterAppend.counters.indexBytesWritten - appendBefore.counters.indexBytesWritten,
        manifestWrites: afterAppend.counters.manifestWrites - appendBefore.counters.manifestWrites,
        pointerWrites: afterAppend.counters.pointerWrites - appendBefore.counters.pointerWrites,
        frameWrites: afterAppend.counters.frameWrites - appendBefore.counters.frameWrites,
        fileFsyncs: afterAppend.counters.fileFsyncs - appendBefore.counters.fileFsyncs,
        directoryFsyncs: afterAppend.counters.directoryFsyncs - appendBefore.counters.directoryFsyncs,
        phases: afterAppend.entries.slice(-5).map((entry, offset) => ({ offset, index: entry.index, kind: entry.kind, bytes: entry.byteLength,
          position: offset === 0 ? 'boundary-position' : `following-position-${offset}` })),
        accounting: afterAppend.accounting };
      await handle.close(); await rm(appendDirectory, { recursive: true });
      if (measuredRetention) {
        const retentionDirectory = join(caseDirectory, `retain-${name}-${iteration}`);
        await cp(result.directory, retentionDirectory, { recursive: true, force: false, errorOnExist: true });
        exact((await inventoryScalingStore(retentionDirectory)).sha256, result.baseline.disk.sha256, 'Retention copy differs');
        handle = await api.openDeltaStore(retentionDirectory, { checkpointInterval });
        const beforeRetention = await handle.inspect(), keepCount = Math.min(10, ids.length - 1), keep = ids.slice(-keepCount);
        const retained = await time('retainLatest', () => handle.retain(keep));
        exact(retained.retainedIds, keep, 'Retention IDs differ');
        exact(retained.removedIds, ids.slice(0, -keepCount), 'Removed IDs differ');
        const afterRetention = await handle.inspect();
        exact(await handle.list(), keep, 'Retained public IDs differ');
        for (const id of [keep[0], keep.at(-1)]) exact(await handle.restore(id), fixture.history[id], 'Retained public restore differs');
        await verifyScalingStore(retentionDirectory, fixture.history.slice(-keepCount), keep, checkpointInterval, codec);
        sample.retention = { keepCount, writtenTransactionBytes: afterRetention.counters.bytesWritten - beforeRetention.counters.bytesWritten,
          accountingBeforeGc: afterRetention.accounting };
        const garbage = await time('retentionGc', () => handle.collectGarbage());
        const afterGc = await handle.inspect(), disk = await inventoryScalingStore(retentionDirectory);
        check(disk.bytes === afterGc.accounting.totalFileBytes, 'Post-GC bytes differ');
        exact(await handle.list(), keep, 'GC public IDs differ');
        for (const id of [keep[0], keep.at(-1)]) exact(await handle.restore(id), fixture.history[id], 'GC public restore differs');
        await verifyScalingStore(retentionDirectory, fixture.history.slice(-keepCount), keep, checkpointInterval, codec);
        sample.retention = { ...sample.retention, garbage, accountingAfterGc: afterGc.accounting, diskAfterGc: disk };
        await handle.close(); await rm(retentionDirectory, { recursive: true });
      }
      if (measuredBuild) {
        const directory = join(caseDirectory, `api-build-${name}-${iteration}`);
        handle = await api.openDeltaStore(directory, { checkpointInterval });
        const begin = performance.now();
        for (const point of fixture.history) await handle.append(point);
        sample.operations.apiAppendAll = performance.now() - begin;
        const inspection = await handle.inspect(), disk = await inventoryScalingStore(directory);
        check(disk.bytes === inspection.accounting.totalFileBytes, 'API-built bytes differ');
        check(disk.bytes === result.baseline.disk.bytes, 'Seed/API store byte size differs');
        check(inspection.counters.bytesWritten === result.seed.equivalentApiCommittedBytes, 'Seed/API logical write model differs');
        exact(inspection.entries.map(entry => entry.sha256), (await readManifest(result.directory)).entries.map(entry => entry.sha256), 'Seed/API frame bytes differ');
        exact(await handle.list(), ids, 'API-built public IDs differ');
        await verifyScalingStore(directory, fixture.history, ids, checkpointInterval, codec);
        sample.apiBuild = { accounting: inspection.accounting, counters: inspection.counters, disk };
        await handle.close(); await rm(directory, { recursive: true });
      }
      sample.memoryAfter = process.memoryUsage(); sample.processHighWaterRssKiB = process.resourceUsage().maxRSS;
      if (measured) {
        result.rounds.push(sample);
        for (const [operation, value] of Object.entries(sample.operations)) (result.timings[operation] ??= []).push(value);
      }
    }
    for (const name of ['checkpoint5', 'checkpoint1']) await workload(name, 'warmup', false);
    for (let iteration = 0; iteration < rounds; iteration++) {
      const order = iteration % 2 ? ['checkpoint1', 'checkpoint5'] : ['checkpoint5', 'checkpoint1'];
      for (const name of order) await workload(name, iteration, true);
    }
    for (const result of Object.values(results)) {
      exact((await inventoryScalingStore(result.directory)).sha256, result.baseline.disk.sha256, 'Fixed baseline changed');
      result.timings = Object.fromEntries(Object.entries(result.timings).map(([operation, values]) => [operation, summarizeScalingSamples(values)]));
      delete result.directory;
    }
    report.cases.push({ id: fixture.id, metadata: fixture.metadata, probeMetadata: fixture.probeMetadata, points: fixture.history.length,
      historySha256: hashScalingHistory(fixture.history), appendProbeSha256: hashScalingHistory(fixture.appendHistory),
      measuredRetention, measuredBuild, variants: results });
    await privateWrite(join(caseDirectory, 'result.json'), encode(report.cases.at(-1)));
    console.log(JSON.stringify({ completedCase: fixture.id, points: fixture.history.length, rounds }));
  }
  report.complete = true;
  await privateWrite(reportPath, Buffer.from(JSON.stringify(report, null, 2) + '\n'));
  return { output, reportPath, report };
}

async function readManifest(directory) {
  const ref = JSON.parse(await readFile(join(directory, 'CURRENT'), 'utf8'));
  const bytes = await readFile(join(directory, ref.manifest));
  check(hash(bytes) === ref.sha256, 'Manifest hash differs');
  const manifest = JSON.parse(bytes);
  if (manifest.version === 1) return manifest;
  check(manifest.version === 2, 'Unsupported manifest version');
  let nodeRef = manifest.indexRoot;
  const segments = [], seen = new Set();
  while (nodeRef) {
    check(!seen.has(nodeRef.file), 'Index cycle'); seen.add(nodeRef.file);
    const nodeBytes = await readFile(join(directory, nodeRef.file));
    check(hash(nodeBytes) === nodeRef.sha256, 'Index hash differs');
    const node = JSON.parse(nodeBytes);
    check(node.version === 2 && Array.isArray(node.entries) && node.entries.length > 0 && node.entries.length <= 32, 'Invalid index node');
    segments.push(node.entries); nodeRef = node.previous;
  }
  const entries = segments.reverse().flat();
  check(entries.length === manifest.entryCount, 'Index count differs');
  return { ...manifest, entries };
}

async function main() {
  const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const smoke = args.includes('--smoke'), preparedPath = option('--prepared');
  check(typeof preparedPath === 'string', '--prepared required');
  const levels = option('--levels', smoke ? '10' : '10,100,300,1000').split(',').map(Number);
  const rounds = Number(option('--rounds', smoke ? '1' : '5'));
  const result = await runScalingBenchmark({ preparedPath: resolve(preparedPath), levels, rounds, smoke,
    ...(args.includes('--kinds') ? { kinds: option('--kinds').split(',') } : {}),
    apiBuildMaxPoints: Number(option('--api-build-max', smoke ? '10' : '100')),
    retentionLevels: option('--retention-levels', smoke ? String(levels.at(-1)) : '10,1000').split(',').map(Number) });
  console.log(JSON.stringify({ output: result.output, reportPath: result.reportPath, cases: result.report.cases.length, complete: true }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch(() => { console.error('Scaling benchmark failed; private local artifacts retained for inspection.'); process.exitCode = 1; });
}
