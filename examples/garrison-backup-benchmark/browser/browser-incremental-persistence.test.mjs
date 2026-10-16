import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { createBrowserDeltaStore } from './browser-delta-store.mjs';
import { createBrowserDurableIncrementalExporter } from './browser-incremental-export.mjs';
import { createBrowserIncrementalReceiver } from './baseline-incremental-export.mjs';

// Node verifies protocol and transactional failures. Native durability and
// process termination remain separate browser evidence.
const parse = bytes => JSON.parse(new TextDecoder().decode(bytes));
const point = i => [{ i, stable: Array.from({ length: 30 }, (_, j) => ({ j, text: `synthetic-${j}` })), special: -0 }];
async function fixture(t) {
  globalThis.indexedDB = new IDBFactory(); const locks = new Map(), handles = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request(name, _options, callback) {
    const next = (locks.get(name) ?? Promise.resolve()).catch(() => {}).then(callback); locks.set(name, next); return next;
  } } } });
  t.after(async () => { for (const handle of handles) await handle.close(); });
  const source = async (name = `durable-source-${randomUUID()}`) => { const store = await createBrowserDeltaStore({ name }); handles.push(store); return store; };
  const name = `durable-cursor-${randomUUID()}`;
  const sender = async (options = {}) => { const value = await createBrowserDurableIncrementalExporter({ name, ...options }); handles.push(value); return value; };
  return { source, sender, name, store: await source(), receiver: await createBrowserIncrementalReceiver() };
}
async function rawRead(name) {
  const req = indexedDB.open(name); const db = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const tx = db.transaction('records'), store = tx.objectStore('records'), keysReq = store.getAllKeys(), valuesReq = store.getAll();
  const entries = await new Promise((resolve, reject) => { tx.oncomplete = () => resolve(new Map(keysReq.result.map((key, i) => [key, valuesReq.result[i]]))); tx.onabort = () => reject(tx.error); });
  db.close(); return entries;
}
async function corruptSourceFrame(name) {
  const req = indexedDB.open(name), db = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'), get = store.getAll();
  get.onsuccess = () => { const frame = get.result.find(record => record.file.startsWith('frame-')); frame.bytes[frame.bytes.length - 1] ^= 1; store.put(frame); };
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
}

test('binary sender remains compatible with frozen receiver through ten reopens; exact ACK writes stay bounded', async t => {
  const { store, sender, receiver, name } = await fixture(t); let writer = await sender();
  for (let i = 0; i < 10; i++) {
    await store.append(point(i)); const prepared = await writer.prepare(store), packet = parse(prepared.packet);
    assert.equal(packet.sequence, i + 1); assert.equal(packet.upserts.filter(item => item.file.startsWith('frame-')).length, 1);
    const pending = await rawRead(name); assert.equal(pending.size, 4);
    assert.ok([...pending.keys()].some(key => key.startsWith('packet-')));
    const head = parse(pending.get('head')).payload;
    assert.deepEqual(pending.get(head.pending.packet.key), prepared.packet);
    const acknowledged = await receiver.apply(prepared.packet);
    await writer.close(); writer = await sender();
    const result = await writer.acknowledge(acknowledged.receipt), committed = await rawRead(name);
    assert.equal(result.stats.recordWrites, 1); assert.equal(result.stats.recordDeletes, 2); assert.equal(result.stats.commits, 1);
    assert.equal(result.stats.bytesWritten, committed.get('head').length);
    assert.ok(result.stats.bytesWritten < 1000); assert.equal(result.stats.base64Bytes, 0); assert.equal(result.stats.validationBytes, 0);
    assert.equal(committed.size, 2); assert.equal(result.stats.stateBytes, [...committed.values()].reduce((sum, bytes) => sum + bytes.length, 0));
    assert.deepEqual(await receiver.restore(i), point(i));
    await writer.close(); writer = await sender();
  }
  const before = await rawRead(name), unchanged = await writer.prepare(store);
  assert.equal(unchanged.packet, null); assert.equal(unchanged.stats.bytesWritten, 0); assert.deepEqual(await rawRead(name), before);
  for (let i = 0; i < 10; i++) assert.deepEqual(await receiver.restore(i), point(i));
});

test('unacknowledged snapshot survives reopen, lost receipt, retention and GC before catching up', async t => {
  const { store, sender, receiver } = await fixture(t); let writer = await sender();
  for (let i = 0; i < 4; i++) await store.append(point(i));
  const initial = await writer.prepare(store); await receiver.apply(initial.packet); await writer.close();
  await store.retain([1, 3]); await store.gc(); await store.append(point(4));
  writer = await sender(); const retry = await writer.prepare(store);
  assert.deepEqual(retry.packet, initial.packet); assert.equal(retry.stats.bytesWritten, 0);
  assert.equal((await receiver.apply(retry.packet)).duplicate, true); await writer.acknowledge(retry.receipt); await writer.close();
  writer = await sender(); const catchup = await writer.prepare(store); assert.ok(parse(catchup.packet).deletes.length > 0);
  await writer.acknowledge((await receiver.apply(catchup.packet)).receipt);
  assert.deepEqual((await receiver.inspect()).ids, [1, 3, 4]);
  for (const id of [1, 3, 4]) assert.deepEqual(await receiver.restore(id), point(id));
  assert.equal((await writer.prepare(store)).packet, null);
});

test('queued calls snapshot receipt inputs and serialize prepare, wrong ACK and valid ACK', async t => {
  const { store, sender, receiver } = await fixture(t), writer = await sender();
  await store.append(point(0)); const firstPromise = writer.prepare(store), retryPromise = writer.prepare(store);
  const first = await firstPromise, retry = await retryPromise; assert.deepEqual(retry.packet, first.packet);
  const receipt = (await receiver.apply(first.packet)).receipt;
  const wrong = writer.acknowledge({ ...receipt, sha256: '0'.repeat(64) }), accepted = writer.acknowledge(receipt);
  receipt.sequence = 999;
  await assert.rejects(wrong, /ACK/); await accepted;
  assert.equal((await writer.inspectPersistence()).sequence, 1);
  const duplicate = await writer.acknowledge(first.receipt); assert.equal(duplicate.stats.bytesWritten, 0);
  await assert.rejects(writer.acknowledge({ ...first.receipt, sequence: 2 }), /No matching/);
});

test('packet and total-state limits leave the committed sender unchanged, including reduced reopen limits', async t => {
  const { store, sender, name } = await fixture(t); await store.append(point(0));
  let writer = await sender({ maxPacketBytes: 20 }); const initial = await rawRead(name);
  await assert.rejects(writer.prepare(store), /limit/); assert.deepEqual(await rawRead(name), initial); await writer.close();
  writer = await sender(); const prepared = await writer.prepare(store), pending = await rawRead(name), totalBytes = [...pending.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  await writer.close(); await assert.rejects(sender({ maxStateBytes: totalBytes - 1 }), /limit/);
  assert.deepEqual(await rawRead(name), pending);
  writer = await sender(); await writer.acknowledge(prepared.receipt);
  assert.equal((await writer.inspectPersistence()).sequence, 1);
});

test('a pending retry still validates fresh source corruption and source identity without advancing cursor', async t => {
  const { store, source, sender, name } = await fixture(t), writer = await sender();
  await store.append(point(0)); await writer.prepare(store); const before = await rawRead(name), other = await source(); await other.append(point(1));
  await assert.rejects(writer.prepare(other), /source store differs/); assert.deepEqual(await rawRead(name), before);
  // A normal source append can advance while pending. The retry remains exact
  // and does not persist a new candidate until receipt confirmation.
  await store.append(point(1)); const retry = await writer.prepare(store);
  assert.equal(retry.receipt.sequence, 1); assert.deepEqual(await rawRead(name), before);
  await corruptSourceFrame(store.name); await assert.rejects(writer.prepare(store));
  assert.deepEqual(await rawRead(name), before);
});
