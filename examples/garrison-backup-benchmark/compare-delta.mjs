import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { loadPrepared } from './real-input.mjs';
import { methods, json, fileBytes } from './baselines.mjs';
import { createArchive, appendPoint, restorePoint } from './archive.mjs';
import { createDeltaArchive, restoreDeltaPoint, inspectDeltaFrame } from './delta-archive.mjs';
import { scenarios } from './fixtures.mjs';

const argument = name => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes('--prepared')) throw new Error('--prepared erforderlich');
const prepared = await loadPrepared(resolve(argument('--prepared')));
const root = resolve(import.meta.dirname, '../../.tmp/garrison-real-data');
await mkdir(root, { recursive: true, mode: 0o700 });
const output = await mkdtemp(join(root, 'delta-comparison-'));
await chmod(output, 0o700);
const hash = value => createHash('sha256').update(value).digest('hex');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rounded = n => Math.round(n * 1000) / 1000;
const ids = ['zip-points', 'gzip-points', 'gzip-combined', 'brotli4-combined', 'brotli6-combined', 'codec-gzip', 'delta5'];
const workloads = [
  { id: 'real-tsm', history: prepared.history },
  { id: 'real-first-half', history: prepared.history.slice(0, Math.floor(prepared.history.length / 2)) },
  { id: 'real-second-half', history: prepared.history.slice(Math.floor(prepared.history.length / 2)) },
  ...scenarios({ points: 20, windows: 6, tabsPerWindow: 16 }).map(s => ({ id: `synthetic-${s.id}`, history: s.history })),
];

async function build(id, history) {
  const frames = [];
  const writer = id === 'delta5' ? createDeltaArchive({ checkpointInterval: 5 }) : null;
  const archive = id === 'codec-gzip' ? createArchive() : null;
  let packed;
  let emittedBytes = 0;
  const appendMs = [];
  for (let i = 0; i < history.length; i++) {
    const start = performance.now();
    if (writer) {
      const frame = await writer.append(history[i]);
      frames.push(frame); packed = frames; emittedBytes += frame.length;
    } else if (methods[id]?.append) {
      const frame = methods[id].append(history[i]);
      frames.push(frame); packed = frames; emittedBytes += frame.length;
    } else if (archive) {
      await appendPoint(archive, history[i]);
      packed = gzipSync(json(archive), { level: 6 }); emittedBytes += packed.length;
    } else {
      const bytes = json(history.slice(0, i + 1));
      packed = id.startsWith('brotli')
        ? brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: id === 'brotli4-combined' ? 4 : 6 } })
        : gzipSync(bytes, { level: 6 });
      emittedBytes += packed.length;
    }
    appendMs.push(performance.now() - start);
  }
  return { packed, emittedBytes, appendMs };
}

async function restore(id, packed, index) {
  if (id === 'delta5') return restoreDeltaPoint(packed, index);
  if (id === 'codec-gzip') return restorePoint(JSON.parse(gunzipSync(packed)), index);
  if (id.startsWith('brotli')) return JSON.parse(brotliDecompressSync(packed))[index];
  return methods[id].restore(packed, index);
}

async function verify(id, packed, history) {
  const times = [];
  for (let i = 0; i < history.length; i++) {
    const start = performance.now();
    const restored = await restore(id, packed, i);
    times.push(performance.now() - start);
    assert.deepEqual(restored, history[i], `${id} point ${i}`);
  }
  return times;
}

const report = {
  format: 'tabwerk-delta-experiment-results', version: 1,
  createdAt: new Date().toISOString(), node: process.version,
  source: prepared.summary, rounds: 3, checkpointInterval: 5,
  scope: 'Private local TSM history and synthetic countercases. Experimental new format, no npm change or external adoption.',
  limitations: 'All fields retained. CPU timings exclude filesystem IO. Cumulative bytes are modeled emitted payload, not measured SSD writes. Entire input byte buffers in RAM; delta replay and validation included. First/second halves overlap full dataset and are sensitivity checks, not independent held-out validation. Checkpoint interval fixed before measurement.',
  scenarios: [],
};
const warmup = scenarios({ points: 3, windows: 2, tabsPerWindow: 3 })[0].history;
for (const id of ids) {
  const run = await build(id, warmup);
  await verify(id, run.packed, warmup);
}
for (const workload of workloads) {
  console.log(`Running ${workload.id}`);
  const dir = join(output, workload.id);
  await mkdir(dir, { mode: 0o700 });
  const input = json(workload.history);
  await writeFile(join(dir, 'input.json'), input, { flag: 'wx', mode: 0o600 });
  const runs = Object.fromEntries(ids.map(id => [id, []]));
  for (let round = 0; round < 3; round++) {
    const offset = round * 2;
    for (const id of [...ids.slice(offset), ...ids.slice(0, offset)]) {
      const run = await build(id, workload.history);
      const restoreMs = await verify(id, run.packed, workload.history);
      const blobs = Array.isArray(run.packed) ? run.packed : [run.packed];
      const hashes = blobs.map(hash);
      if (round === 0) {
        const methodDir = join(dir, id);
        await mkdir(methodDir, { mode: 0o700 });
        const reread = [];
        for (let i = 0; i < blobs.length; i++) {
          const path = join(methodDir, `${String(i).padStart(6, '0')}.bin`);
          await writeFile(path, blobs[i], { flag: 'wx', mode: 0o600 });
          const bytes = await readFile(path); assert.equal(hash(bytes), hashes[i]); reread.push(bytes);
        }
        await verify(id, Array.isArray(run.packed) ? reread : reread[0], workload.history);
      } else assert.deepEqual(hashes, runs[id][0].hashes, 'deterministic encoding');
      runs[id].push({ bytes: fileBytes(run.packed), emittedBytes: run.emittedBytes,
        appendMs: run.appendMs, restoreMs, hashes,
        frames: id === 'delta5' && round === 0 ? run.packed.map(frame => inspectDeltaFrame(frame)) : undefined });
    }
  }
  assert.equal(hash(json(workload.history)), hash(input), 'input unchanged');
  const metrics = Object.fromEntries(ids.map(id => {
    const data = runs[id];
    return [id, { bytes: data[0].bytes, cumulativePayloadBytes: data[0].emittedBytes,
      appendTotalMedianMs: rounded(median(data.map(v => v.appendMs.reduce((s, x) => s + x, 0)))),
      restoreP50Ms: rounded(median(data.flatMap(v => v.restoreMs))),
      restoreMaxMs: rounded(Math.max(...data.flatMap(v => v.restoreMs))),
      hashes: data[0].hashes, frames: data[0].frames }];
  }));
  report.scenarios.push({ id: workload.id, points: workload.history.length, inputSha256: hash(input), metrics, runs });
}
await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
console.log(`RESULTS ${join(output, 'results.json')}`);
