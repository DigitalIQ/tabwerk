import { createBrowserDeltaStore } from './browser-delta-store.mjs';
import { createBrowserDurableIncrementalExporter, createBrowserIncrementalReceiver } from './browser-incremental-export.mjs';
import { createBrowserIncrementalReceiver as createFrozenReceiver } from './baseline-incremental-export.mjs';
import { check, equal, syntheticPoints, uniqueName, deleteDatabase, rejects } from './browser-harness-utils.mjs';

const sameBytes = (a, b) => check(a.length === b.length && a.every((v, i) => v === b[i]), 'Durable retry changed exact packet bytes');
async function withSender(label, fn) {
  const sourceName = uniqueName(`ack-source-${label}`), name = uniqueName(`ack-sender-${label}`), handles = [];
  let store;
  const open = async options => {
    const sender = await createBrowserDurableIncrementalExporter({ name, checkpointInterval: 5, ...options });
    handles.push(sender); return sender;
  };
  try {
    store = await createBrowserDeltaStore({ name: sourceName, checkpointInterval: 5 });
    return await fn({ name, sourceName, store, open, points: syntheticPoints(4) });
  } finally {
    for (const handle of handles) await handle.close();
    store?.close(); await deleteDatabase(sourceName); await deleteDatabase(name);
  }
}
async function mutate(name, selectKey) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('ACK mutation open failed'));
  });
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite', { durability: 'strict' }), records = tx.objectStore('records');
      const request = records.getAllKeys();
      request.onsuccess = () => {
        const key = request.result.find(selectKey);
        if (!key) { tx.abort(); return; }
        const read = records.get(key);
        read.onsuccess = () => { const bytes = new Uint8Array(read.result); bytes[Math.floor(bytes.length / 2)] ^= 1; records.put(bytes, key); };
      };
      tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(new Error('ACK mutation transaction failed'));
    });
  } finally { db.close(); }
}
async function terminateAt(data) {
  const worker = new Worker(new URL('./ack-browser-worker.mjs', import.meta.url), { type: 'module' });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ACK worker fault timeout')), 20000);
      worker.onerror = () => { clearTimeout(timer); reject(new Error('ACK worker failed')); };
      worker.onmessage = ({ data: result }) => {
        clearTimeout(timer);
        if (result.phase === data.phase && result.operation === data.operation) { worker.terminate(); resolve(); }
        else reject(new Error('ACK worker missed requested fault phase'));
      };
      worker.postMessage(data);
    });
  } finally { worker.terminate(); }
}

export async function runAckBrowserTests(run) {
  await run('ack-durable-packet-only-and-frozen-receiver-compatibility', () => withSender('wire', async ({ store, open, points }) => {
    const sender = await open(), receiver = await createBrowserIncrementalReceiver(), frozen = await createFrozenReceiver();
    let pendingBytes = 0, ackBytes = 0;
    for (const [i, point] of points.entries()) {
      await store.append(point); const prepared = await sender.prepare(store);
      pendingBytes += prepared.stats.bytesWritten;
      await receiver.apply(prepared.packet); await frozen.apply(prepared.packet);
      const ack = await sender.acknowledge(prepared.receipt); ackBytes += ack.stats.bytesWritten;
      check(ack.stats.recordWrites === 1 && ack.stats.recordDeletes === 2, 'ACK did not replace only head and retire old inventory/packet');
      check(ack.stats.bytesDeleted > 0 && ack.stats.totalRecordBytes > ack.stats.headBytes, 'ACK sender byte accounting omits inventory or deletions');
      equal(await receiver.restore(i), point, 'New receiver changed field content');
      equal(await frozen.restore(i), point, 'Frozen receiver changed field content');
    }
    const state = await sender.inspectPersistence();
    check(state.sequence === points.length && state.pendingSequence === null, 'Final durable sequence mismatch');
    return { points: points.length, pendingWriteBytes: pendingBytes, acknowledgementWriteBytes: ackBytes };
  }));
  for (const operation of ['prepare', 'ack']) {
    for (const phase of ['transaction-started', 'transaction-enqueued']) {
      await run(`ack-native-idb-abort-${operation}-${phase}`, () => withSender(`${operation}-${phase}`, async ({ store, open, points }) => {
        await store.append(points[0]); const initial = await open();
        const first = operation === 'ack' ? await initial.prepare(store) : null;
        await initial.close();
        const sender = await open({ fault: (at, context) => { if (at === phase && context.operation === operation) context.transaction.abort(); } });
        await rejects(() => operation === 'ack' ? sender.acknowledge(first.receipt) : sender.prepare(store), 'Aborted native transaction reported success');
        await sender.close(); const reopened = await open(), pending = await reopened.prepare(store);
        if (first) sameBytes(pending.packet, first.packet);
        const receiver = await createFrozenReceiver(); await receiver.apply(pending.packet);
        equal(await receiver.restore(0), points[0], 'Abort/reopen lost source point');
        await reopened.acknowledge(pending.receipt);
        check((await reopened.prepare(store)).packet === null, 'Abort recovery retransmitted acknowledged packet');
      }));
    }
  }
  for (const operation of ['prepare', 'ack']) {
    for (const phase of ['before-commit', 'after-commit']) {
      await run(`ack-worker-termination-${operation}-${phase}`, () => withSender(`worker-${operation}-${phase}`, async ({ name, sourceName, store, open, points }) => {
        await store.append(points[0]); const initial = await open();
        const first = operation === 'ack' ? await initial.prepare(store) : null;
        await initial.close();
        await terminateAt({ name, sourceName, operation, phase, receipt: first?.receipt });
        const reopened = await open(), state = await reopened.inspectPersistence();
        const committed = phase === 'after-commit';
        check(state.sequence === (operation === 'ack' && committed ? 1 : 0), 'Worker termination changed committed ACK boundary');
        check(state.pendingSequence === (operation === 'prepare' ? (committed ? 1 : null) : (committed ? null : 1)), 'Worker termination exposed incomplete pending state');
        const pending = await reopened.prepare(store);
        if (operation === 'ack' && committed) check(pending.packet === null, 'Committed ACK was lost on worker termination');
        else {
          if (first) sameBytes(pending.packet, first.packet);
          const receiver = await createFrozenReceiver(); await receiver.apply(pending.packet);
          equal(await receiver.restore(0), points[0], 'Worker termination damaged portable history');
          await reopened.acknowledge(pending.receipt);
        }
      }));
    }
  }
  await run('ack-lost-delivery-response-reopen-idempotent-receipt', () => withSender('lost', async ({ store, open, points }) => {
    await store.append(points[0]); let sender = await open(); const first = await sender.prepare(store);
    const receiver = await createFrozenReceiver(); await receiver.apply(first.packet);
    await sender.close(); sender = await open(); const retry = await sender.prepare(store); sameBytes(retry.packet, first.packet);
    const duplicate = await receiver.apply(retry.packet); check(duplicate.duplicate, 'Lost ACK retry changed receiver state');
    await sender.acknowledge(duplicate.receipt); await sender.close(); sender = await open();
    await sender.acknowledge(duplicate.receipt);
    check((await sender.prepare(store)).packet === null, 'Repeated committed ACK created a delivery');
  }));
  await run('ack-commit-response-loss-recovers-durable-state', () => withSender('response-loss', async ({ store, open, points }) => {
    await store.append(points[0]); const initial = await open(); const first = await initial.prepare(store); await initial.close();
    const sender = await open({ fault: (phase, context) => { if (phase === 'after-commit' && context.operation === 'ack') throw new Error('Synthetic lost ACK commit response'); } });
    await rejects(() => sender.acknowledge(first.receipt), 'Synthetic commit response loss did not reject'); await sender.close();
    const reopened = await open(); check((await reopened.prepare(store)).packet === null, 'Lost response rolled back committed ACK');
    await reopened.acknowledge(first.receipt);
  }));
  for (const prefix of ['head', 'inventory-', 'packet-']) {
    await run(`ack-external-${prefix.replace('-', '')}-corruption-fails-closed`, () => withSender(`corrupt-${prefix}`, async ({ name, store, open, points }) => {
      await store.append(points[0]); const sender = await open(); const pending = await sender.prepare(store);
      await mutate(name, key => prefix === 'head' ? key === 'head' : key.startsWith(prefix));
      await rejects(() => sender.acknowledge(pending.receipt), 'External persisted corruption accepted by live ACK');
      await sender.close(); await rejects(() => open(), 'External persisted corruption accepted on reopen');
      const frozen = await createFrozenReceiver(); await frozen.apply(pending.packet);
      equal(await frozen.restore(0), points[0], 'Sender corruption damaged previously delivered packet');
    }));
  }
  await run('ack-cas-rejects-external-change-between-read-and-commit', () => withSender('cas', async ({ name, store, open, points }) => {
    await store.append(points[0]); const initial = await open(), first = await initial.prepare(store); await initial.close();
    const sender = await open({ fault: (phase, context) => { if (phase === 'before-commit' && context.operation === 'ack') return mutate(name, key => key === 'head'); } });
    await rejects(() => sender.acknowledge(first.receipt), 'CAS accepted an externally changed head');
    await sender.close(); await rejects(() => open(), 'CAS failure overwrote external corruption');
  }));
  await run('ack-two-handles-interleave-without-sequence-loss', () => withSender('interleave', async ({ store, open, points }) => {
    const a = await open(), b = await open(); await store.append(points[0]);
    const [first, duplicate] = await Promise.all([a.prepare(store), b.prepare(store)]); sameBytes(first.packet, duplicate.packet);
    await Promise.all([a.acknowledge(first.receipt), b.acknowledge(duplicate.receipt)]);
    await store.append(points[1]); const second = await b.prepare(store);
    check(second.receipt.sequence === 2, 'Interleaved handles lost or duplicated sequence');
    const receiver = await createFrozenReceiver(); await receiver.apply(first.packet); await receiver.apply(second.packet);
    equal(await receiver.restore(1), points[1], 'Interleaved handles damaged history');
    await a.acknowledge(second.receipt); equal((await b.inspectPersistence()).sequence, 2, 'Stale handle did not observe new ACK');
  }));
}
