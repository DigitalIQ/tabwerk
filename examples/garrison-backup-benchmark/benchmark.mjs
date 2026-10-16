import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { scenarios } from './fixtures.mjs';
import { createArchive, appendPoint, restorePoint, retainPoints } from './archive.mjs';
import { methods, json, fileBytes } from './baselines.mjs';
import { saveArchive, loadArchive } from './persistence.mjs';
import { loadPrepared } from './real-input.mjs';

const args = process.argv.slice(2);
const readOption = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
function integerOption(name, fallback, min, max) {
  const n = Number(readOption(name, fallback));
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be ${min}..${max}`);
  return n;
}
const options = {
  points: integerOption('--points', 60, 2, 300),
  windows: integerOption('--windows', 6, 1, 30),
  tabsPerWindow: integerOption('--tabs', 16, 2, 100),
  rounds: integerOption('--rounds', 3, 1, 10),
};
const preparedPath = readOption('--prepared');
const prepared = preparedPath ? await loadPrepared(preparedPath) : undefined;
const workloads = prepared ? [{
  id: `local-${prepared.summary.declaredSource}`,
  description: 'Locally supplied regular autosave history; declared source, not independently authenticated',
  history: prepared.history,
}] : scenarios(options);
if (prepared) {
  options.points = prepared.history.length;
  options.windows = null;
  options.tabsPerWindow = null;
}
const outputRoot = resolve(readOption('--output-root', resolve(import.meta.dirname, '../../.tmp')));
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(join(outputRoot, 'garrison-benchmark-'));
await chmod(output, 0o700);
const allMethods = [...Object.keys(methods), 'codec-json', 'codec-gzip'];
const hash = data => createHash('sha256').update(data).digest('hex');
const quantile = (values, q) => {
  const a = [...values].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((a.length - 1) * q))];
};
const rounded = n => Math.round(n * 1000) / 1000;

async function build(id, history) {
  let packed;
  let archive;
  let cumulativePayloadBytes = 0;
  const appendMs = [];
  const addedBlocks = [];
  const method = methods[id];
  if (id.startsWith('codec-')) archive = createArchive();
  if (method?.append) packed = [];
  for (let i = 0; i < history.length; i++) {
    const start = performance.now();
    if (archive) {
      const { newBlockCount } = await appendPoint(archive, history[i]);
      addedBlocks.push(newBlockCount);
      packed = id === 'codec-gzip' ? gzipSync(json(archive), { level: 6 }) : json(archive);
      cumulativePayloadBytes += packed.length;
    } else if (method.append) {
      const bytes = method.append(history[i]);
      packed.push(bytes);
      cumulativePayloadBytes += bytes.length;
    } else {
      packed = method.build(history.slice(0, i + 1));
      cumulativePayloadBytes += packed.length;
    }
    appendMs.push(performance.now() - start);
  }
  return { packed, cumulativePayloadBytes, appendMs, addedBlocks, archive };
}

async function restore(id, packed, index) {
  if (id === 'codec-json') return restorePoint(JSON.parse(packed.toString('utf8')), index);
  if (id === 'codec-gzip') return restorePoint(JSON.parse(gunzipSync(packed)), index);
  return methods[id].restore(packed, index);
}

async function verifyAndTime(id, packed, history) {
  const restoreMs = [];
  // Bytebuffer liegen schon im RAM, Formatparsing und Dekompression gehören zur Messung.
  for (let i = 0; i < history.length; i++) {
    const start = performance.now();
    const restored = await restore(id, packed, i);
    restoreMs.push(performance.now() - start);
    assert.deepEqual(restored, history[i], `${id}: point ${i} roundtrip`);
  }
  return restoreMs;
}

async function persistAndVerify(dir, id, result, history) {
  const path = join(dir, id);
  await mkdir(path);
  let readBack;
  if (Array.isArray(result.packed)) {
    readBack = [];
    for (let i = 0; i < result.packed.length; i++) {
      const file = join(path, `${String(i).padStart(6, '0')}.bin`);
      await writeFile(file, result.packed[i], { flag: 'wx', mode: 0o600 });
      readBack.push(await readFile(file));
    }
  } else if (id === 'codec-json') {
    const file = join(path, 'archive.json');
    await saveArchive(file, result.archive);
    const parsed = await loadArchive(file);
    readBack = json(parsed);
    const keep = history.map((_, i) => i).filter(i => i % 3 !== 0);
    const retained = JSON.parse(JSON.stringify(retainPoints(parsed, keep)));
    for (let i = 0; i < keep.length; i++) {
      assert.deepEqual(await restorePoint(retained, i), history[keep[i]], 'retained point restores');
    }
  } else {
    const file = join(path, 'archive.bin');
    await writeFile(file, result.packed, { flag: 'wx', mode: 0o600 });
    readBack = await readFile(file);
  }
  assert.equal(fileBytes(readBack), fileBytes(result.packed), 'read-back byte count');
  await verifyAndTime(id, readBack, history);
  return Array.isArray(readBack) ? readBack.map(hash) : hash(readBack);
}

// Kleiner unberichteter Warmup für alle Implementierungen, keine Registry-Aufrufe.
const warmup = scenarios({ points: 3, windows: 2, tabsPerWindow: 3 })[0].history;
for (const id of allMethods) {
  const run = await build(id, warmup);
  await verifyAndTime(id, run.packed, warmup);
}

const report = {
  createdAt: new Date().toISOString(),
  sourceCommit: '850099b1b0b8a03bef1743c2e21f42f951e08e2e',
  codecSource: 'local source corresponding to npm tabwerk-session-codec@0.1.0; no registry install',
  scope: prepared
    ? `Locally supplied autosave export arrays declared as ${prepared.summary.declaredSource}. Not an authenticated Garrison dataset, whole-database captures, browser performance, or external adoption.`
    : 'Synthetic chronological saved-autosave export arrays. Not Garrison whole-database captures, extension performance, or external adoption.',
  inputSummary: prepared?.summary,
  measurements: {
    sizes: 'Retained logical bytes, including every format header and all manifests/blocks. Not filesystem allocated blocks.',
    writePayload: 'Sum of emitted payload lengths across append operations; modeled writes, excludes disk I/O/fsync. Codec is a rewritten standalone JSON container, not an implemented append-only block store.',
    timings: 'Sequential local Node, warmed implementations, rotated method order per round. Include serialization/compression or parsing/decompression; exclude assertions and disk I/O. Not browser timings.',
    restore: 'One target point from an already memory-resident compressed byte buffer. Entire codec JSON is parsed each time; ZIP-rollup extracts only target entry.',
    units: 'bytes and milliseconds',
  },
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, zlib: process.versions.zlib, fflate: '0.8.3' },
  options,
  scenarios: [],
};

for (const scenario of workloads) {
  console.log(`Running ${scenario.id} (${scenario.history.length} points)`);
  const scenarioDir = join(output, scenario.id);
  await mkdir(scenarioDir);
  const source = json(scenario.history);
  await writeFile(join(scenarioDir, 'input.json'), source, { flag: 'wx', mode: 0o600 });
  const runs = Object.fromEntries(allMethods.map(id => [id, []]));
  for (let round = 0; round < options.rounds; round++) {
    const offset = (round * 3) % allMethods.length;
    const order = [...allMethods.slice(offset), ...allMethods.slice(0, offset)];
    for (const id of order) {
      const result = await build(id, scenario.history);
      result.restoreMs = await verifyAndTime(id, result.packed, scenario.history);
      if (round === 0) result.sha256 = await persistAndVerify(scenarioDir, id, result, scenario.history);
      if (runs[id].length) {
        assert.equal(fileBytes(result.packed), runs[id][0].bytes, `${id}: deterministic size`);
      }
      runs[id].push({
        bytes: fileBytes(result.packed),
        cumulativePayloadBytes: result.cumulativePayloadBytes,
        appendMs: result.appendMs,
        restoreMs: result.restoreMs,
        sha256: result.sha256,
        uniqueBlocks: result.archive ? Object.keys(result.archive.blocks).length : undefined,
        addedBlocks: result.archive ? result.addedBlocks : undefined,
      });
    }
  }
  const metrics = Object.fromEntries(allMethods.map(id => {
    const values = runs[id];
    const append = values.flatMap(v => v.appendMs);
    const restores = values.flatMap(v => v.restoreMs);
    return [id, {
      description: methods[id]?.description ?? (id === 'codec-gzip'
        ? 'Whole standalone codec container additionally gzipped, including metadata'
        : 'Standalone JSON container with shared compressed window blocks'),
      layout: methods[id]?.layout ?? 'single-file',
      bytes: values[0].bytes,
      cumulativePayloadBytes: values[0].cumulativePayloadBytes,
      appendTotalMedianMs: rounded(quantile(values.map(v => v.appendMs.reduce((a, b) => a + b, 0)), 0.5)),
      appendP50Ms: rounded(quantile(append, 0.5)),
      appendP95Ms: rounded(quantile(append, 0.95)),
      restoreP50Ms: rounded(quantile(restores, 0.5)),
      restoreP95Ms: rounded(quantile(restores, 0.95)),
      uniqueBlocks: values[0].uniqueBlocks,
      addedBlocks: values[0].addedBlocks,
      sha256: values[0].sha256,
      roundtrip: 'all points equal in all rounds; serialized artifacts read back and verified',
    }];
  }));
  report.scenarios.push({ id: scenario.id, description: scenario.description, inputBytes: source.length, inputSha256: hash(source), metrics, rounds: runs });
  assert.equal(hash(json(scenario.history)), hash(source), 'benchmark leaves source unchanged');
}

report.processPeakRssKiB = process.resourceUsage().maxRSS;
report.memoryCaveat = 'Whole-process peak includes fixtures, validation and multiple methods. Not a per-method memory comparison.';
await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
const lines = [
  '# Garrison backup comparison', '',
  report.scope, '',
  `Node ${process.version}; fflate 0.8.3; ${options.rounds} rounds; ${options.points} points.`, '',
  'Retained logical bytes. Identical restored history across all formats.', '',
  '| Scenario | Per-point ZIP | ZIP rollup | Combined ZIP | Combined gzip | Codec JSON | Codec gzip |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...report.scenarios.map(s => `| ${s.id} | ${s.metrics['zip-points'].bytes} | ${s.metrics['zip-rollup'].bytes} | ${s.metrics['zip-combined'].bytes} | ${s.metrics['gzip-combined'].bytes} | ${s.metrics['codec-json'].bytes} | ${s.metrics['codec-gzip'].bytes} |`),
  '', 'See results.json for full per-round timings, write payload totals, hashes, and measurement boundaries.', '',
];
await writeFile(join(output, 'summary.md'), lines.join('\n'), { flag: 'wx' });
console.log(`RESULTS ${join(output, 'results.json')}`);
console.log(lines.join('\n'));
