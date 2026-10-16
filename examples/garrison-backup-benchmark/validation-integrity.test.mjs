import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDeltaArchive, createDeltaHistoryValidator } from './delta-archive.mjs';
import { openDeltaStore } from './delta-store.mjs';
import { metadata, rewriteMetadata } from './metadata-test-helpers.mjs';

// Independent regression oracle retained from before the optimization. Optional
// outside this local experiment; all fixtures below are synthetic.
const baselinePath = resolve(import.meta.dirname, '../../.tmp/garrison-real-data/validation-before-3_p7j_ko/delta-archive.mjs');
let baseline;
try { baseline = await import(baselinePath); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const sha = bytes => createHash('sha256').update(bytes).digest();
const point = i => [{ count: i, stable: Array.from({ length: 50 }, (_, n) => ({ n, text: `synthetic-${n}` })), extra: { zero: -0, unknown: [null, true] }, ...JSON.parse('{"__proto__":{"safe":true},"constructor":{"value":1}}') }];
function encode(value) {
  if (typeof value === 'number' && Object.is(value, -0)) return '-0';
  if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).map(key => `${JSON.stringify(key)}:${encode(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function rewrite(bytes, mutate) {
  const envelope = JSON.parse(gunzipSync(bytes.subarray(40)));
  mutate(envelope);
  const compressed = gzipSync(Buffer.from(encode(envelope)));
  const header = Buffer.alloc(40);
  header.write('TJD1'); header.writeUInt32BE(compressed.length, 4); sha(compressed).copy(header, 8);
  return Buffer.concat([header, compressed]);
}
function accepts(run) { try { run(); return true; } catch { return false; } }
function oldValidate(frames, options) {
  for (let i = 0; i < frames.length; i++) {
    const meta = baseline.inspectDeltaFrame(frames[i], options);
    if (meta.index !== i + (options.startIndex ?? 0) || meta.checkpointInterval !== options.checkpointInterval) throw Error('metadata');
    baseline.restoreDeltaPoint(frames.slice(0, i + 1), meta.index, options);
  }
}
function newValidate(frames, options) {
  const validator = createDeltaHistoryValidator(options);
  return frames.map(frame => validator.append(frame));
}

test('single pass matches previous full-prefix validation for adversarial frames', { skip: !baseline }, () => {
  let cases = 0;
  for (const checkpointInterval of [1, 2, 5, 9]) {
    const writer = createDeltaArchive({ checkpointInterval });
    const frames = Array.from({ length: 12 }, (_, i) => writer.append(point(i)));
    const options = { checkpointInterval };
    assert.deepEqual(newValidate(frames, options).map(result => result.point), frames.map((_, i) => baseline.restoreDeltaPoint(frames, i)));
    assert.deepEqual(newValidate([rewrite(frames[0], () => {})], options)[0].point, point(0));
    const mutations = [
      e => { e.stateHash = '0'.repeat(64); }, e => { e.index++; }, e => { e.checkpointInterval++; },
      e => { e.extra = true; }, e => { delete e.payload; }, e => { e.version = 2; },
      e => { e.base = 0; }, e => { e.baseHash = '0'.repeat(64); },
      e => { e.payload = null; }, e => { e.payload = ['invalid']; },
      e => { e.payload = ['a', 3, [[0, ['v', 'x']], [0, ['v', 'y']]]]; },
      e => { e.payload = ['o', ['missing'], []]; },
    ];
    for (let index = 0; index < frames.length; index++) {
      const candidates = [frames[index].subarray(0, frames[index].length - 1), Buffer.from(frames[index]), ...mutations.map(mutate => rewrite(frames[index], mutate))];
      candidates[1][8] ^= 1;
      for (const candidate of candidates) {
        const changed = frames.slice(); changed[index] = candidate;
        assert.equal(accepts(() => newValidate(changed, options)), accepts(() => oldValidate(changed, options)), `acceptance case ${cases++}`);
      }
    }
    for (const limits of [{ maxFrameBytes: 40 }, { maxPayloadBytes: 1 }]) {
      assert.equal(accepts(() => newValidate(frames, { ...options, ...limits })), accepts(() => oldValidate(frames, { ...options, ...limits })));
    }
    for (let startIndex = 1; startIndex < frames.length; startIndex++) {
      const suffix = frames.slice(startIndex), suffixOptions = { ...options, startIndex };
      assert.equal(accepts(() => newValidate(suffix, suffixOptions)), accepts(() => oldValidate(suffix, suffixOptions)));
    }
  }
  assert.equal(cases, 672);
});

test('self-consistent hashes cannot extend a checkpoint chain beyond its bound', { skip: !baseline }, () => {
  const writer = createDeltaArchive({ checkpointInterval: 9 });
  const frames = Array.from({ length: 3 }, (_, i) => writer.append(point(i)));
  assert.equal(baseline.inspectDeltaFrame(frames[1]).kind, 'delta');
  assert.equal(baseline.inspectDeltaFrame(frames[2]).kind, 'delta');
  for (let i = 0; i < frames.length; i++) {
    frames[i] = rewrite(frames[i], e => {
      e.checkpointInterval = 2;
      if (i) e.baseHash = sha(frames[i - 1]).toString('hex');
    });
  }
  assert.throws(() => oldValidate(frames, { checkpointInterval: 2 }), /bound/);
  assert.throws(() => newValidate(frames, { checkpointInterval: 2 }), /bound/);
});

test('validator snapshots cannot mutate subsequent state or earlier snapshots', () => {
  const writer = createDeltaArchive({ checkpointInterval: 5 });
  const frames = [writer.append(point(0)), writer.append(point(1))];
  const validator = createDeltaHistoryValidator({ checkpointInterval: 5 });
  const first = validator.append(frames[0]);
  assert.throws(() => { first.point[0].stable[0].n = 999; }, TypeError);
  first.metadata.index = 999;
  frames[0].fill(0);
  const second = validator.append(frames[1]);
  assert.deepEqual(first.point, point(0));
  assert.deepEqual(second.point, point(1));
  assert.equal(Object.is(second.point[0].extra.zero, -0), true);
});

async function fixture(t) {
  const scratch = resolve(import.meta.dirname, '../../.tmp');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(`${scratch}/validation-integrity-`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('every store operation detects corruption of an unrelated old committed frame', async t => {
  const directory = await fixture(t);
  const store = await openDeltaStore(directory, { checkpointInterval: 2 });
  t.after(() => store.close());
  for (let i = 0; i < 7; i++) await store.append(point(i));
  const value = await metadata(directory);
  const path = `${directory}/${value.entries[0].file}`;
  const original = await readFile(path), corrupt = Buffer.from(original);
  corrupt[corrupt.length - 1] ^= 1;
  await writeFile(path, corrupt);
  for (const operation of [() => store.list(), () => store.restore(6), () => store.append(point(7)), () => store.inspect(), () => store.retain([6]), () => store.collectGarbage()]) {
    await assert.rejects(operation, /Committed/);
  }
  await writeFile(path, original);
  const restored = await store.restore(6);
  restored[0].stable[0].n = 999;
  assert.deepEqual(await store.restore(6), point(6));
  assert.equal(await store.append(point(7)), 7);
});

test('recomputed file and manifest hashes cannot hide invalid reconstructed old state', async t => {
  const directory = await fixture(t);
  const store = await openDeltaStore(directory, { checkpointInterval: 2 });
  t.after(() => store.close());
  for (let i = 0; i < 5; i++) await store.append(point(i));
  const value = await metadata(directory);
  const entry = value.entries[0], path = `${directory}/${entry.file}`;
  const invalid = rewrite(await readFile(path), e => { e.payload = []; });
  await writeFile(path, invalid);
  entry.sha256 = sha(invalid).toString('hex');
  await rewriteMetadata(directory, value);
  await assert.rejects(() => store.list(), /Committed/);
  await assert.rejects(() => store.restore(4), /Committed/);
  await assert.rejects(() => store.append(point(5)), /Committed/);
});

test('same-generation valid CURRENT replacement cannot reuse stale writer state', async t => {
  const directory = await fixture(t), otherDirectory = await fixture(t);
  const store = await openDeltaStore(directory), other = await openDeltaStore(otherDirectory);
  t.after(() => store.close()); t.after(() => other.close());
  for (let i = 0; i < 3; i++) { await store.append(point(i)); await other.append(point(i + 100)); }
  for (const name of await readdir(otherDirectory)) {
    if (name !== '.writer.lock') await copyFile(`${otherDirectory}/${name}`, `${directory}/${name}`);
  }
  assert.deepEqual(await store.restore(2), point(102));
  assert.equal(await store.append(point(103)), 3);
  assert.deepEqual(await store.restore(3), point(103));
});
