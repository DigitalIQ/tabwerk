import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createDeltaArchive, restoreDeltaPoint } from '../delta-archive.mjs';
import {
  createBrowserDeltaArchive, createBrowserDeltaHistoryValidator,
  inspectBrowserDeltaFrame, restoreBrowserDeltaPoint, snapshotBrowserDeltaPoint,
} from './browser-delta-codec.mjs';
import { createBrowserDeltaStore, importBrowserDeltaRecords, restoreBrowserDeltaRecords } from './browser-delta-store.mjs';

const point = i => [{ i, special: JSON.parse('{"__proto__":{"safe":true},"constructor":{"prototype":"data"}}'), stable: Array.from({ length: 75 }, (_, n) => ({ n, text: `synthetic-${n}` })), values: [null, false, -0, Number.MAX_VALUE, Number.MIN_VALUE] }];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function rewrite(frame, mutate) {
  const envelope = JSON.parse(gunzipSync(frame.subarray(40))); mutate(envelope);
  const bytes = gzipSync(JSON.stringify(envelope)), header = Buffer.alloc(40);
  header.write('TJD1'); header.writeUInt32BE(bytes.length, 4); createHash('sha256').update(bytes).digest().copy(header, 8);
  return new Uint8Array(Buffer.concat([header, bytes]));
}

test('native Web API codec cross-decodes Node frames and Node decodes browser frames', async () => {
  for (const checkpointInterval of [1, 2, 5, 9]) {
    const browser = createBrowserDeltaArchive({ checkpointInterval }), node = createDeltaArchive({ checkpointInterval });
    const browserFrames = [], nodeFrames = [], history = Array.from({ length: 13 }, (_, i) => point(i));
    for (const value of history) { browserFrames.push(await browser.append(value)); nodeFrames.push(node.append(value)); }
    for (const [i, expected] of history.entries()) {
      assert.deepEqual(await restoreBrowserDeltaPoint(nodeFrames, i), expected);
      assert.deepEqual(restoreDeltaPoint(browserFrames, i), expected);
      assert.ok(Object.is((await restoreBrowserDeltaPoint(browserFrames, i))[0].values[2], -0));
    }
    const validator = createBrowserDeltaHistoryValidator({ checkpointInterval });
    for (const [i, frame] of nodeFrames.entries()) assert.deepEqual((await validator.append(frame, { expectedFrameHash: digest(frame) })).point, history[i]);
  }
});
test('browser writer snapshots before awaiting, serializes calls and preserves failed append state', async () => {
  const writer = createBrowserDeltaArchive(), original = point(0), expected = structuredClone(original);
  const first = writer.append(original); original[0].i = 100;
  const invalid = writer.append([{ undefined }]);
  const third = writer.append(point(1));
  await assert.rejects(invalid, /JSON/);
  const frames = [await first, await third]; assert.equal(writer.nextIndex, 2);
  assert.deepEqual(await restoreBrowserDeltaPoint(frames, 0), expected);
  assert.deepEqual(await restoreBrowserDeltaPoint(frames, 1), point(1));
  const validator = createBrowserDeltaHistoryValidator();
  assert.deepEqual((await Promise.all(frames.map(frame => validator.append(frame)))).map(value => value.point), [expected, point(1)]);
});
test('JSON semantics reject lossy inputs and preserve all own prototype-looking fields', () => {
  assert.ok(Object.is(snapshotBrowserDeltaPoint(point(0))[0].values[2], -0));
  assert.equal({}.safe, undefined);
  const cyclic = []; cyclic.push(cyclic);
  const sparse = new Array(2), getter = { get value() { throw new Error('Getter invoked'); } };
  const symbol = { [Symbol('x')]: 1 }, hidden = {}; Object.defineProperty(hidden, 'hidden', { value: 1 });
  const decorated = [1]; decorated.extra = 2;
  for (const invalid of [undefined, Infinity, NaN, 1n, () => {}, new Date(), getter, symbol, hidden, cyclic, sparse, decorated]) assert.throws(() => snapshotBrowserDeltaPoint([invalid]));
});
test('bounded decoding and rehashed malformed envelopes fail closed', async () => {
  const writer = createBrowserDeltaArchive(), frames = [await writer.append(point(0)), await writer.append(point(1))];
  const badChecksum = frames[0].slice(); badChecksum[8] ^= 1;
  for (const bytes of [badChecksum, frames[0].subarray(0, 39), frames[0].subarray(0, frames[0].length - 1)]) await assert.rejects(inspectBrowserDeltaFrame(bytes));
  await assert.rejects(inspectBrowserDeltaFrame(frames[0], { maxFrameBytes: 40 }), /limit/);
  await assert.rejects(inspectBrowserDeltaFrame(frames[0], { maxPayloadBytes: 40 }), /limit/);
  for (const mutate of [e => { e.stateHash = '0'.repeat(64); }, e => { e.index++; }, e => { e.checkpointInterval++; }, e => { e.payload = null; }, e => { e.extra = true; }, e => { e.baseHash = '0'.repeat(64); }, e => { e.payload = ['a', 1, [[0, ['v', 3]], [0, ['v', 4]]]]; }]) {
    const changed = [frames[0], rewrite(frames[1], mutate)];
    await assert.rejects(restoreBrowserDeltaPoint(changed, 1));
  }
  await assert.rejects(restoreBrowserDeltaPoint([frames[1]], 1, { startIndex: 1 }), /checkpoint/);
  const enormousArray = rewrite(frames[1], e => { e.payload = ['a', 0xffffffff, []]; });
  await assert.rejects(restoreBrowserDeltaPoint([frames[0], enormousArray], 1), /sparse/);
});

// Node-only simulation. Browser tests use actual IndexedDB and Web
// Locks; fake-indexeddb does not provide browser durability or crash evidence.
import * as fake from 'fake-indexeddb';
async function simulated(t) {
  globalThis.indexedDB = new fake.IDBFactory();
  const lockQueues = new Map();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request(name, _options, callback) {
    const previous = lockQueues.get(name) ?? Promise.resolve(), next = previous.catch(() => {}).then(callback); lockQueues.set(name, next); return next;
  } } } });
  const name = `browser-adapter-test-${randomUUID()}`, handles = [];
  t.after(async () => { for (const store of handles) await store.close(); });
  const open = async options => { const store = await createBrowserDeltaStore({ name, ...options }); handles.push(store); return store; };
  const store = await open(); return { name, store, open, handles };
}
async function raw(name, task) {
  const request = indexedDB.open(name), db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records');
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); task(store); }); db.close();
}
test('simulated store append, retention, logical ledger, GC and independent import', async t => {
  const { store, handles } = await simulated(t);
  for (let i = 0; i < 35; i++) assert.equal(await store.append(point(i)), i);
  const before = await store.inspect(); assert.equal(before.ids.length, 35);
  const exported = await store.exportRecords(); assert.equal(exported.reduce((sum, record) => sum + record.bytes.length, 0), before.accounting.referencedBytes);
  assert.equal(before.accounting.physicalBytes, null);
  assert.deepEqual(await restoreBrowserDeltaRecords(exported, 34), point(34));
  const imported = await importBrowserDeltaRecords(exported, { name: `import-${randomUUID()}` }); handles.push(imported);
  assert.deepEqual(await imported.list(), Array.from({ length: 35 }, (_, i) => i));
  assert.deepEqual(await imported.restore(15), point(15));
  assert.deepEqual(await store.retain([34, 1, 20]), { retainedIds: [1, 20, 34], removedIds: Array.from({ length: 35 }, (_, i) => i).filter(i => ![1, 20, 34].includes(i)) });
  for (const i of [1, 20, 34]) assert.deepEqual(await store.restore(i), point(i));
  const retained = await store.inspect(); assert.ok(retained.accounting.orphanBytes > 0);
  const gc = await store.gc(); assert.ok(gc.deletedFiles > 0); assert.ok(gc.reclaimedBytes > 0);
  assert.equal((await store.inspect()).accounting.orphanBytes, 0);
  assert.deepEqual(await store.gc(), { deletedFiles: 0, reclaimedBytes: 0 });
  assert.equal(await store.append(point(35)), 35);
});
test('simulated concurrent handles do not lose appends and input is snapshotted', async t => {
  const { store, open } = await simulated(t), second = await open();
  const original = point(0), pending = store.append(original); original[0].i = 999;
  const ids = await Promise.all([pending, second.append(point(1)), store.append(point(2)), second.append(point(3))]);
  assert.deepEqual(ids.slice().sort((a, b) => a - b), [0, 1, 2, 3]);
  assert.deepEqual(await store.restore(0), point(0)); assert.equal((await second.list()).length, 4);
});
test('simulated abort is atomic and after-commit exceptions report committed outcome', async t => {
  const { store, open } = await simulated(t); await store.append(point(0));
  const aborted = await open({ faultInjector(phase, context) { if (context.operation === 'append' && phase === 'transaction-enqueued') context.transaction.abort(); } });
  await assert.rejects(aborted.append(point(1)), error => error.committed === false);
  assert.deepEqual(await store.list(), [0]);
  const committed = await open({ faultInjector(phase, context) { if (context.operation === 'append' && phase === 'after-commit') throw new Error('After commit'); } });
  await assert.rejects(committed.append(point(1)), error => error.committed === true && error.durable === false);
  assert.deepEqual(await store.list(), [0, 1]);
});
test('every simulated operation freshly validates old referenced frames and index hashes', async t => {
  const { name, store, open } = await simulated(t); for (let i = 0; i < 35; i++) await store.append(point(i));
  const records = await store.exportRecords();
  const operations = [() => store.list(), () => store.restore(34), () => store.append(point(35)), () => store.retain([34]), () => store.gc(), () => store.inspect(), () => store.exportRecords(), () => open()];
  for (const record of [records.find(record => record.file.startsWith('frame-')), records.find(record => record.file.startsWith('index-'))]) {
    const changed = { file: record.file, bytes: record.bytes.slice() }; changed.bytes[changed.bytes.length - 1] ^= 1;
    await raw(name, objectStore => objectStore.put(changed));
    for (const operation of operations) await assert.rejects(operation);
    await raw(name, objectStore => objectStore.put(record));
  }
  assert.deepEqual(await store.restore(34), point(34));
});
test('portable import rejects duplicate, missing, tampered and oversized metadata records', async t => {
  const { store } = await simulated(t); await store.append(point(0)); const records = await store.exportRecords();
  await assert.rejects(restoreBrowserDeltaRecords([...records, records[0]], 0), /portable/);
  await assert.rejects(restoreBrowserDeltaRecords(records.filter(record => record.file !== 'CURRENT'), 0), /CURRENT/);
  const frame = records.find(record => record.file.startsWith('frame-')), changed = frame.bytes.slice(); changed[8] ^= 1;
  await assert.rejects(restoreBrowserDeltaRecords(records.map(record => record === frame ? { ...record, bytes: changed } : record), 0));
  const oversized = records.map(record => record.file.startsWith('index-') ? { ...record, bytes: new Uint8Array(65537) } : record);
  await assert.rejects(restoreBrowserDeltaRecords(oversized, 0), /limit/);
});
test('commit compares the validated records atomically against raw concurrent mutation', async t => {
  const { name, store, open } = await simulated(t); await store.append(point(0));
  const frame = (await store.exportRecords()).find(record => record.file.startsWith('frame-'));
  const other = await open({ faultInjector(phase, context) {
    if (phase === 'before-commit' && context.operation === 'append') return raw(name, objectStore => { const bytes = frame.bytes.slice(); bytes[8] ^= 1; objectStore.put({ file: frame.file, bytes }); });
  } });
  await assert.rejects(other.append(point(1)), /changed during operation/);
  await raw(name, objectStore => objectStore.put(frame));
  assert.deepEqual(await store.list(), [0]);
});
test('restore decompresses every frame exactly once and checks frames after the requested point', async t => {
  const { name, store } = await simulated(t), count = 12;
  for (let i = 0; i < count; i++) await store.append(point(i));
  const exported = await store.exportRecords(), info = await store.inspect();
  const last = exported.find(record => record.file === info.entries.at(-1).file);
  const NativeDecompressionStream = globalThis.DecompressionStream; let decodes = 0;
  globalThis.DecompressionStream = class extends NativeDecompressionStream {
    constructor(format) { super(format); decodes++; }
  };
  t.after(() => { globalThis.DecompressionStream = NativeDecompressionStream; });
  assert.deepEqual(await store.restore(0), point(0)); assert.equal(decodes, count);
  decodes = 0;
  const restored = await store.restore(count - 1); assert.deepEqual(restored, point(count - 1)); assert.equal(decodes, count);
  restored[0].i = -1;
  decodes = 0;
  assert.deepEqual(await store.restore(count - 1), point(count - 1)); assert.equal(decodes, count);
  const bytes = last.bytes.slice(); bytes[8] ^= 1;
  await raw(name, objectStore => objectStore.put({ file: last.file, bytes }));
  // A requested point before the corrupt frame must still fail validation.
  await assert.rejects(store.restore(0), /hash mismatch/);
  await raw(name, objectStore => objectStore.put(last));
  assert.deepEqual(await store.restore(0), point(0));
});
