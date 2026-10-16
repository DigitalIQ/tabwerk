import { mkdir, mkdtemp, chmod, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { cpus, platform, release, arch } from 'node:os';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const exact = (a, b, message) => check(isDeepStrictEqual(a, b), message);
const encode = value => Buffer.from(JSON.stringify(value));
const privateWrite = (path, bytes) => writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
const milestones = [10, 31, 32, 33, 63, 64, 65, 100, 300, 1000];
const moduleFiles = ['delta-store.mjs', 'delta-archive.mjs', 'scaling-benchmark.mjs', 'scaling-fixtures.mjs', 'fixtures.mjs', 'real-input.mjs', 'metadata-benchmark.mjs'];

async function pinModules(source, destination, files) {
  await mkdir(destination, { mode: 0o700 });
  const hashes = {};
  for (const file of files) {
    const bytes = await readFile(join(source, file));
    await privateWrite(join(destination, file), bytes); hashes[file] = hash(bytes);
  }
  return hashes;
}

async function diskSummary(directory) {
  const result = { frameBytes: 0, manifestBytes: 0, indexBytes: 0, otherBytes: 0, frameFiles: 0, manifestFiles: 0, indexFiles: 0 };
  for (const name of await readdir(directory)) {
    const size = (await stat(join(directory, name))).size;
    const category = name.startsWith('frame-') ? 'frame' : name.startsWith('manifest-') ? 'manifest' : name.startsWith('index-') ? 'index' : 'other';
    result[`${category}Bytes`] += size;
    if (category !== 'other') result[`${category}Files`]++;
  }
  result.metadataBytes = result.manifestBytes + result.indexBytes;
  result.totalBytes = result.frameBytes + result.metadataBytes + result.otherBytes;
  return result;
}

async function buildActual(api, directory, history, maximum, validate) {
  const handle = await api.openDeltaStore(directory, { checkpointInterval: 5 });
  const samples = [];
  for (let index = 0; index < maximum; index++) {
    exact(await handle.append(history[index]), index, 'Actual append ID differs');
    const points = index + 1;
    if (milestones.includes(points) || points === maximum) {
      const inspection = await handle.inspect(), disk = await diskSummary(directory);
      check(disk.totalBytes === inspection.accounting.totalFileBytes, 'Actual disk accounting differs');
      exact(await handle.list(), history.slice(0, points).map((_, id) => id), 'Actual IDs differ');
      for (const id of [0, points - 1]) exact(await handle.restore(id), history[id], 'Actual restored fields differ');
      await validate(directory, history.slice(0, points), history.slice(0, points).map((_, id) => id));
      const modeledWrites = disk.frameBytes + disk.metadataBytes + inspection.accounting.currentPointerBytes * (points + 1) + inspection.accounting.formatBytes;
      check(modeledWrites === inspection.counters.bytesWritten, 'Actual cumulative committed bytes omit metadata');
      const previous = samples.at(-1);
      const interval = previous ? { fromPoints: previous.points, appendedPoints: points - previous.points,
        writtenCommittedBytes: inspection.counters.bytesWritten - previous.counters.bytesWritten,
        writtenMetadataBytes: disk.metadataBytes - previous.disk.metadataBytes,
        writtenIndexBytes: (inspection.counters.indexBytesWritten ?? 0) - (previous.counters.indexBytesWritten ?? 0),
        frameWrites: inspection.counters.frameWrites - previous.counters.frameWrites,
        manifestWrites: inspection.counters.manifestWrites - previous.counters.manifestWrites,
        indexWrites: (inspection.counters.indexWrites ?? 0) - (previous.counters.indexWrites ?? 0),
        pointerWrites: inspection.counters.pointerWrites - previous.counters.pointerWrites } : null;
      samples.push({ points, counters: inspection.counters, accounting: inspection.accounting, disk, interval });
      console.log(JSON.stringify({ metadataActualVersion: inspection.version, completedPoints: points }));
    }
  }
  await handle.close();
  return samples;
}

// Der v1-Seed enthält alle echten historischen Manifestdateien. Deren Größen
// liefern exakte logische Writes; die API-Prüfung bis100 belegt das Modell.
async function oldSeedModel(directory, points) {
  const manifests = [];
  for (const file of await readdir(directory)) if (file.startsWith('manifest-')) {
    const bytes = await readFile(join(directory, file));
    manifests.push({ manifest: JSON.parse(bytes), bytes: bytes.length });
  }
  manifests.sort((a, b) => a.manifest.generation - b.manifest.generation);
  const pointerBytes = (await stat(join(directory, 'CURRENT'))).size;
  const formatBytes = (await stat(join(directory, 'FORMAT'))).size;
  const rows = [];
  let manifestBytes = 0, frameBytes = 0;
  for (const item of manifests) {
    manifestBytes += item.bytes;
    const count = item.manifest.entries.length;
    if (count) frameBytes += (await stat(join(directory, item.manifest.entries.at(-1).file))).size;
    if (points.includes(count)) rows.push({ points: count,
      disk: { manifestBytes, indexBytes: 0, metadataBytes: manifestBytes, frameBytes,
        totalBytes: manifestBytes + frameBytes + pointerBytes + formatBytes,
        manifestFiles: count + 1, indexFiles: 0, frameFiles: count },
      equivalentApiCommittedBytes: manifestBytes + frameBytes + pointerBytes * (count + 1) + formatBytes,
      equivalentApiMetadataAndPointerBytes: manifestBytes + pointerBytes * (count + 1),
      currentManifestBytes: item.bytes });
  }
  return rows;
}

export async function runMetadataBenchmark({ beforeModule, outputRoot = resolve(import.meta.dirname, '../../.tmp/garrison-real-data'), maxPoints = 1000, oldApiMaxPoints = 100 } = {}) {
  check(typeof beforeModule === 'string', 'Frozen before module required');
  check(Number.isSafeInteger(maxPoints) && maxPoints >= 65 && maxPoints <= 1000, 'Invalid point limit');
  await mkdir(outputRoot, { recursive: true, mode: 0o700 }); await chmod(outputRoot, 0o700);
  const output = await mkdtemp(join(outputRoot, 'metadata-benchmark-')); await chmod(output, 0o700);
  const currentDirectory = join(output, 'module'), oldDirectory = join(output, 'before-module');
  const moduleSha256 = await pinModules(import.meta.dirname, currentDirectory, moduleFiles);
  const beforeModuleSha256 = await pinModules(beforeModule, oldDirectory, moduleFiles.filter(file => file !== 'metadata-benchmark.mjs'));
  const api = await import(pathToFileURL(join(currentDirectory, 'delta-store.mjs')));
  const codec = await import(pathToFileURL(join(currentDirectory, 'delta-archive.mjs')));
  const harness = await import(pathToFileURL(join(currentDirectory, 'scaling-benchmark.mjs')));
  const beforeApi = await import(pathToFileURL(join(oldDirectory, 'delta-store.mjs')));
  const beforeCodec = await import(pathToFileURL(join(oldDirectory, 'delta-archive.mjs')));
  const beforeHarness = await import(pathToFileURL(join(oldDirectory, 'scaling-benchmark.mjs')));
  const history = Array.from({ length: maxPoints }, (_, sequence) => [{ sequence, unchanged: { nested: ['fixed', true, null] } }]);
  const inputSha256 = harness.hashScalingHistory(history);
  const report = { version: 1, createdAt: new Date().toISOString(), complete: false, maxPoints, oldApiMaxPoints,
    moduleSha256, beforeModuleSha256, inputSha256,
    environment: { node: process.version, platform: platform(), release: release(), architecture: arch(), logicalCpuCount: cpus().length, cpuModel: cpus()[0]?.model },
    protocol: {
      input: 'Deterministic tiny synthetic points; no real Session values. Same history and checkpointInterval5 in old and new stores.',
      actual: 'Actual fresh public API append for every new-store point through1000. Cumulative committed logical bytes, file writes and full disk metadata at each milestone and index boundaries. Not SSD physical-write measurement.',
      old: 'Frozen v1 deterministic seed preserves every historic manifest through1000; actual v1 public API builds through100 prove logical bytes and disk equivalence.',
      validation: 'Every sampled history fully reconstructed and all fields deep-compared outside any timing. Public IDs and early/latest restores also checked.',
      timings: 'No comparative wall-time claim. This experiment supplies deterministic logical-write and metadata-growth evidence.',
    } };
  await privateWrite(join(output, 'protocol.json'), encode(report));
  const oldSeedDirectory = join(output, 'v1-seed');
  report.oldSeed = await beforeHarness.seedScalingStore(oldSeedDirectory, history, 5, beforeCodec);
  report.oldModel = await oldSeedModel(oldSeedDirectory, milestones.filter(n => n <= maxPoints).concat(maxPoints));
  report.oldActual = await buildActual(beforeApi, join(output, 'v1-api'), history, Math.min(oldApiMaxPoints, maxPoints),
    (directory, points, ids) => beforeHarness.verifyScalingStore(directory, points, ids, 5, beforeCodec));
  for (const actual of report.oldActual) {
    const modeled = report.oldModel.find(row => row.points === actual.points);
    check(modeled, 'Old actual milestone missing from seed model');
    check(actual.counters.bytesWritten === modeled.equivalentApiCommittedBytes, 'Old actual logical write bytes differ from seed model');
    for (const field of ['frameBytes', 'manifestBytes', 'indexBytes', 'metadataBytes', 'totalBytes', 'manifestFiles', 'indexFiles', 'frameFiles'])
      check(actual.disk[field] === modeled.disk[field], `Old seed/API ${field} differs`);
  }
  report.newActual = await buildActual(api, join(output, 'v2-api'), history, maxPoints,
    (directory, points, ids) => harness.verifyScalingStore(directory, points, ids, 5, codec));
  const seededDirectory = join(output, 'v2-seed');
  report.newSeed = await harness.seedScalingStore(seededDirectory, history, 5, codec);
  await harness.verifyScalingStore(seededDirectory, history, history.map((_, id) => id), 5, codec);
  const newSeedDisk = await diskSummary(seededDirectory), latest = report.newActual.at(-1);
  exact(newSeedDisk, latest.disk, 'New seed/API complete metadata inventory differs');
  check(report.newSeed.equivalentApiCommittedBytes === latest.counters.bytesWritten, 'New seed/API write bytes differ');
  check(report.newSeed.historicAndCurrentIndexBytes === latest.counters.indexBytesWritten, 'New seed/API index bytes differ');
  report.comparison = report.newActual.map(actual => {
    const old = report.oldModel.find(row => row.points === actual.points);
    check(actual.disk.frameBytes === old.disk.frameBytes, 'Old/new frame payload byte sizes differ');
    return { points: actual.points, oldMetadataBytes: old.disk.metadataBytes, newMetadataBytes: actual.disk.metadataBytes,
      metadataReductionPercent: 100 * (1 - actual.disk.metadataBytes / old.disk.metadataBytes),
      oldCumulativeMetadataAndPointerBytes: old.equivalentApiMetadataAndPointerBytes,
      newCumulativeMetadataAndPointerBytes: actual.counters.bytesWritten - actual.disk.frameBytes - actual.accounting.formatBytes,
      oldCumulativeCommittedBytes: old.equivalentApiCommittedBytes, newCumulativeCommittedBytes: actual.counters.bytesWritten,
      newIndexWrites: actual.counters.indexWrites, newManifestWrites: actual.counters.manifestWrites,
      newPointerWrites: actual.counters.pointerWrites, newFrameWrites: actual.counters.frameWrites };
  });
  report.complete = true;
  const reportPath = join(output, 'report.json');
  await privateWrite(reportPath, Buffer.from(JSON.stringify(report, null, 2) + '\n'));
  return { output, reportPath, report };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
  runMetadataBenchmark({ beforeModule: resolve(value('--before-module')), ...(args.includes('--max-points') ? { maxPoints: Number(value('--max-points')) } : {}) })
    .then(({ reportPath, report }) => console.log(JSON.stringify({ reportPath, complete: report.complete, comparison: report.comparison })))
    .catch(() => { console.error('Metadata benchmark failed; private artifacts retained.'); process.exitCode = 1; });
}
