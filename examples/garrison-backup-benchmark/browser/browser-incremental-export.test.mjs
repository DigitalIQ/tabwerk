import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { browserHash } from './browser-delta-codec.mjs';
import { createBrowserDeltaStore, validateBrowserDeltaRecords } from './browser-delta-store.mjs';
import { createBrowserIncrementalExporter, createBrowserIncrementalReceiver } from './browser-incremental-export.mjs';

// Node simulation verifies protocol behavior, not native browser durability.
import * as fake from 'fake-indexeddb';
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const parse = bytes => JSON.parse(new TextDecoder().decode(bytes));
const point = i => [{ i, stable: Array.from({ length: 20 }, (_, j) => ({ j, text: `synthetic-${j}` })), negativeZero: -0 }];
async function fixture(t) {
  globalThis.indexedDB = new fake.IDBFactory();
  const locks = new Map();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request(name, _options, callback) {
    const next = (locks.get(name) ?? Promise.resolve()).catch(() => {}).then(callback); locks.set(name, next); return next;
  } } } });
  const handles = [];
  t.after(async () => { for (const store of handles) await store.close(); });
  const open = async (name = `incremental-test-${randomUUID()}`) => { const store = await createBrowserDeltaStore({ name }); handles.push(store); return store; };
  return { store: await open(), open };
}
async function deliver(sender, receiver, store) {
  const prepared = await sender.prepare(store);
  assert.ok(prepared.packet);
  const applied = await receiver.apply(prepared.packet);
  const acknowledged = await sender.acknowledge(applied.receipt);
  assert.equal(acknowledged.length, prepared.stats.acknowledgedCursorBytes);
  assert.equal(prepared.stats.recordEncodingBytes + prepared.stats.packetMetadataBytes, prepared.packet.length);
  assert.equal(prepared.stateBytes.length, prepared.stats.senderStateBytes);
  return prepared;
}

test('portable chain restores ten snapshots with one new frame per append and explicit byte accounting', async t => {
  const { store } = await fixture(t), sender = await createBrowserIncrementalExporter(), receiver = await createBrowserIncrementalReceiver(), files = [];
  for (let i = 0; i < 10; i++) {
    await store.append(point(i));
    const prepared = await deliver(sender, receiver, store), packet = parse(prepared.packet);
    assert.equal(packet.sequence, i + 1);
    assert.equal(packet.upserts.filter(item => item.file.startsWith('frame-')).length, 1);
    assert.ok(i === 0 || !packet.upserts.some(item => item.file === 'FORMAT'));
    files.push(prepared.packet.slice());
  }
  const reconstructed = await createBrowserIncrementalReceiver();
  for (const file of files) await reconstructed.apply(file);
  for (let i = 0; i < 10; i++) assert.deepEqual(await reconstructed.restore(i), point(i));
  const noChange = await sender.prepare(store);
  assert.equal(noChange.packet, null); assert.equal(noChange.receipt, null); assert.equal(noChange.stats.packetBytes, 0);
  assert.equal(noChange.stats.unchangedRecords, (await store.exportRecords()).length);
  const restored = await createBrowserIncrementalReceiver({ stateBytes: await reconstructed.exportState() });
  assert.deepEqual(await restored.restore(7), point(7));
  assert.deepEqual(await restored.inspect(), await reconstructed.inspect());
});

test('pending state survives restart, lost ACK, retention and GC; next delta catches up', async t => {
  const { store, open } = await fixture(t), receiver = await createBrowserIncrementalReceiver();
  let sender = await createBrowserIncrementalExporter();
  for (let i = 0; i < 4; i++) await store.append(point(i));
  const initial = await sender.prepare(store), savedBeforeDelivery = initial.stateBytes.slice();
  await receiver.apply(initial.packet); // File saved, caller crashes before ACK.
  await store.retain([1, 3]); await store.gc(); await store.append(point(4));
  sender = await createBrowserIncrementalExporter({ stateBytes: savedBeforeDelivery });
  const retry = await sender.prepare(await open(store.name));
  assert.deepEqual(retry.packet, initial.packet);
  assert.equal((await receiver.apply(retry.packet)).duplicate, true);
  const cursor = await sender.acknowledge(retry.receipt);
  sender = await createBrowserIncrementalExporter({ stateBytes: cursor });
  const catchup = await deliver(sender, receiver, store);
  assert.ok(parse(catchup.packet).deletes.length > 0);
  assert.deepEqual((await receiver.inspect()).ids, [1, 3, 4]);
  for (const id of [1, 3, 4]) assert.deepEqual(await receiver.restore(id), point(id));
  await assert.rejects(receiver.restore(0), /outside/);
  await store.gc(); assert.equal((await sender.prepare(store)).packet, null);
});

test('missing, reordered, conflicting, truncated and corrupt packets fail without receiver changes', async t => {
  const { store } = await fixture(t), sender = await createBrowserIncrementalExporter(), sourceReceiver = await createBrowserIncrementalReceiver(), packets = [];
  for (let i = 0; i < 3; i++) { await store.append(point(i)); packets.push((await deliver(sender, sourceReceiver, store)).packet); }
  const receiver = await createBrowserIncrementalReceiver(), empty = await receiver.exportState();
  await assert.rejects(receiver.apply(packets[1]), /base/); assert.deepEqual(await receiver.exportState(), empty);
  await receiver.apply(packets[0]); const committed = await receiver.exportState();
  for (const bytes of [packets[2], packets[1].subarray(0, packets[1].length - 1), new Uint8Array([0, 1]), encode({ ...parse(packets[1]), previous: '0'.repeat(64) })]) {
    await assert.rejects(receiver.apply(bytes)); assert.deepEqual(await receiver.exportState(), committed);
  }
  const missing = parse(packets[1]); missing.upserts = missing.upserts.filter(item => !item.file.startsWith('frame-'));
  await assert.rejects(receiver.apply(encode(missing))); assert.deepEqual(await receiver.exportState(), committed);
  const corrupt = parse(packets[1]), frame = corrupt.upserts.find(item => item.file.startsWith('frame-'));
  const damaged = Uint8Array.from(atob(frame.data), char => char.charCodeAt(0)); damaged[damaged.length - 1] ^= 1;
  frame.data = btoa(String.fromCharCode(...damaged));
  await assert.rejects(receiver.apply(encode(corrupt)), /checksum/); assert.deepEqual(await receiver.exportState(), committed);
  frame.sha256 = await browserHash(damaged); // Matching transport checksum cannot bypass full frame validation.
  await assert.rejects(receiver.apply(encode(corrupt))); assert.deepEqual(await receiver.exportState(), committed);
  await receiver.apply(packets[1]); assert.equal((await receiver.apply(packets[1])).duplicate, true);
  await assert.rejects(receiver.apply(packets[0]), /base/);
  const conflict = parse(packets[1]); conflict.target.currentSha256 = '0'.repeat(64);
  await assert.rejects(receiver.apply(encode(conflict)), /base/);
});

test('arguments are captured immediately and queued concurrent prepare/apply/ACK calls remain consistent', async t => {
  const { store } = await fixture(t), sender = await createBrowserIncrementalExporter(), receiver = await createBrowserIncrementalReceiver();
  await store.append(point(0));
  const [a, b] = await Promise.all([sender.prepare(store), sender.prepare(store)]);
  assert.deepEqual(a.packet, b.packet);
  const supplied = a.packet.slice(), first = receiver.apply(supplied); supplied.fill(0);
  const [applied, duplicate] = await Promise.all([first, receiver.apply(b.packet)]);
  assert.equal(applied.duplicate, false); assert.equal(duplicate.duplicate, true);
  const receipt = structuredClone(applied.receipt), ack = sender.acknowledge(receipt); receipt.sha256 = '0'.repeat(64);
  const [cursorA, cursorB] = await Promise.all([ack, sender.acknowledge(applied.receipt)]);
  assert.deepEqual(cursorA, cursorB);
  a.packet.fill(0); // Returned buffers cannot corrupt saved pending or receiver state.
  assert.deepEqual(await receiver.restore(0), point(0));
});

test('wrong ACK and corrupt cursor fail closed; sender state only advances after matching ACK', async t => {
  const { store } = await fixture(t), sender = await createBrowserIncrementalExporter();
  await assert.rejects(sender.acknowledge({ sequence: 0, sha256: null }), /ACK/);
  await store.append(point(0));
  const prepared = await sender.prepare(store), pending = await sender.exportState();
  for (const receipt of [{ sequence: 2, sha256: prepared.receipt.sha256 }, { sequence: 1, sha256: '0'.repeat(64) }]) {
    await assert.rejects(sender.acknowledge(receipt), /ACK/); assert.deepEqual(await sender.exportState(), pending);
  }
  const damaged = pending.slice(); damaged[damaged.length - 2] ^= 1;
  await assert.rejects(createBrowserIncrementalExporter({ stateBytes: damaged }));
  const forged = parse(pending); forged.payload.sequence++;
  await assert.rejects(createBrowserIncrementalExporter({ stateBytes: encode(forged) }), /checksum/);
  const acked = await sender.acknowledge(prepared.receipt);
  assert.notDeepEqual(acked, pending); assert.equal(parse(acked).payload.pending, null);
});

test('full export validation catches altered portable records and fresh source corruption even on retry', async t => {
  const { store } = await fixture(t), sender = await createBrowserIncrementalExporter();
  await store.append(point(0)); const prepared = await sender.prepare(store);
  const records = await store.exportRecords(), frame = records.find(record => record.file.startsWith('frame-')); frame.bytes[45] ^= 1;
  const wrapper = { name: store.name, exportRecords: async () => records };
  await assert.rejects(sender.prepare(wrapper));
  assert.deepEqual((await sender.prepare(store)).packet, prepared.packet);
  const dbRequest = indexedDB.open(store.name), db = await new Promise((resolve, reject) => { dbRequest.onsuccess = () => resolve(dbRequest.result); dbRequest.onerror = () => reject(dbRequest.error); });
  const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(frame);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
  await assert.rejects(sender.prepare(store));
});

test('empty bootstrap and retain all/none keep portable semantics; alternate stores cannot reuse cursor', async t => {
  const { store, open } = await fixture(t), sender = await createBrowserIncrementalExporter(), receiver = await createBrowserIncrementalReceiver();
  await assert.rejects(validateBrowserDeltaRecords([]), /CURRENT/);
  const bootstrap = await deliver(sender, receiver, store);
  assert.equal(bootstrap.stats.upsertRecords, 3); assert.deepEqual((await receiver.inspect()).ids, []);
  await store.append(point(0)); await deliver(sender, receiver, store);
  await store.retain([0]); assert.equal((await sender.prepare(store)).packet, null);
  await store.retain([]); await store.gc(); await deliver(sender, receiver, store);
  assert.deepEqual((await receiver.inspect()).ids, []); await assert.rejects(receiver.restore(0), /outside/);
  const other = await open(); for (let i = 0; i < 5; i++) await other.append(point(i));
  await assert.rejects(sender.prepare(other), /differs/);
});

test('transport and frame byte bounds reject before receiver state changes', async t => {
  const { store } = await fixture(t), sender = await createBrowserIncrementalExporter();
  await store.append(point(0)); const prepared = await sender.prepare(store);
  const bounded = await createBrowserIncrementalReceiver({ maxPacketBytes: prepared.packet.length - 1 }), before = await bounded.exportState();
  await assert.rejects(bounded.apply(prepared.packet), /limit/); assert.deepEqual(await bounded.exportState(), before);
  const frameBounded = await createBrowserIncrementalReceiver({ maxFrameBytes: 40 });
  await assert.rejects(frameBounded.apply(prepared.packet), /limit/);
  await assert.rejects(createBrowserIncrementalExporter({ stateBytes: prepared.stateBytes, maxStateBytes: 20 }), /limit/);
  const stateBounded = await createBrowserIncrementalReceiver({ maxStateBytes: 400 });
  const original = await stateBounded.exportState();
  await assert.rejects(stateBounded.apply(prepared.packet), /limit/); assert.deepEqual(await stateBounded.exportState(), original);
});

test('valid Base64 larger than sixteen MB round-trips without RegExp stack overflow', async t => {
  const { store } = await fixture(t);
  await store.append(point(0));
  const records = await store.exportRecords(), manifest = records.find(record => record.file.startsWith('manifest-'));
  // JSON permits trailing whitespace. This creates a valid large metadata
  // record without a random/private fixture or expensive frame generation.
  const padded = new Uint8Array(manifest.bytes.length + 12 * 1024 * 1024); padded.fill(32); padded.set(manifest.bytes); manifest.bytes = padded;
  const pointer = records.find(record => record.file === 'CURRENT'), reference = parse(pointer.bytes);
  reference.sha256 = await browserHash(padded); pointer.bytes = encode(reference);
  const sender = await createBrowserIncrementalExporter(), receiver = await createBrowserIncrementalReceiver();
  const prepared = await sender.prepare({ name: store.name, exportRecords: async () => records });
  const packet = parse(prepared.packet);
  assert.ok(packet.upserts.find(item => item.file === manifest.file).data.length > 16 * 1024 * 1024);
  await receiver.apply(prepared.packet); await sender.acknowledge(prepared.receipt);
  assert.deepEqual(await receiver.restore(0), point(0));
  const reloaded = await createBrowserIncrementalReceiver({ stateBytes: await receiver.exportState() });
  assert.deepEqual(await reloaded.restore(0), point(0));
});

test('malformed or non-canonical Base64 padding is rejected atomically', async t => {
  const { store } = await fixture(t), sender = await createBrowserIncrementalExporter(), receiver = await createBrowserIncrementalReceiver();
  await store.append(point(0)); const prepared = await sender.prepare(store), before = await receiver.exportState();
  for (const data of ['A===', 'AA=A', 'AAA', 'AB==', 'AAB=']) {
    const changed = parse(prepared.packet); changed.upserts.find(item => item.file === 'FORMAT').data = data;
    await assert.rejects(receiver.apply(encode(changed)), /base64/); assert.deepEqual(await receiver.exportState(), before);
  }
});
