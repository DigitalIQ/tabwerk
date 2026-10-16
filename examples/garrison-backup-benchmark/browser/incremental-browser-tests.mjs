import { createBrowserIncrementalExporter, createBrowserIncrementalReceiver } from './browser-incremental-export.mjs';
import { createBrowserDeltaStore } from './browser-delta-store.mjs';
import { check, equal, syntheticPoints, uniqueName, deleteDatabase, rejects } from './browser-harness-utils.mjs';

async function withHistory(label, fn) {
  const name = uniqueName(`incremental-${label}`);
  let store;
  try {
    store = await createBrowserDeltaStore({ name, checkpointInterval: 5 });
    const sender = await createBrowserIncrementalExporter({ checkpointInterval: 5 });
    const receiver = await createBrowserIncrementalReceiver({ checkpointInterval: 5 });
    return await fn({ store, sender, receiver, name, points: syntheticPoints(4) });
  } finally { store?.close(); await deleteDatabase(name); }
}
const sameBytes = (a, b, label) => check(a.length === b.length && a.every((v, i) => v === b[i]), label);
const copy = bytes => new Uint8Array(bytes);

export async function runIncrementalBrowserTests(run) {
  await run('incremental-bootstrap-delta-and-independent-receiver', () => withHistory('bootstrap', async ({ store, sender, points }) => {
    const packets = [], stats = [];
    for (const point of points) {
      await store.append(point);
      const delivery = await sender.prepare(store);
      packets.push(copy(delivery.packet)); stats.push(delivery.stats);
      // ACK follows a completed local sink materialization of the exact bytes.
      await sender.acknowledge(delivery.receipt);
    }
    const fresh = await createBrowserIncrementalReceiver({ checkpointInterval: 5 });
    for (const packet of packets) await fresh.apply(packet);
    equal((await fresh.inspect()).ids, [0, 1, 2, 3], 'Independent receiver lost history');
    for (let i = 0; i < points.length; i++) equal(await fresh.restore(i), points[i], 'Packet-only restore changed point');
    check(stats[1].unchangedRecords > 0, 'Delta resent every acknowledged record');
    for (const stat of stats) check(stat.packetBytes === stat.recordEncodingBytes + stat.packetMetadataBytes && stat.recordEncodingBytes >= stat.recordPayloadBytes, 'Packet byte ledger does not balance');
    return { points: points.length, packets: packets.length };
  }));
  await run('incremental-unacked-retry-reopen-and-idempotent-delivery', () => withHistory('retry', async ({ store, sender, receiver, points }) => {
    await store.append(points[0]); const first = await sender.prepare(store);
    const reopened = await createBrowserIncrementalExporter({ stateBytes: await sender.exportState(), checkpointInterval: 5 });
    const retry = await reopened.prepare(store);
    sameBytes(retry.packet, first.packet, 'Unacknowledged retry changed exact packet');
    equal(retry.receipt, first.receipt, 'Unacknowledged retry changed receipt');
    const applied = await receiver.apply(first.packet);
    check(!applied.duplicate, 'Initial delivery incorrectly duplicate');
    const receiverReopened = await createBrowserIncrementalReceiver({ stateBytes: await receiver.exportState(), checkpointInterval: 5 });
    const duplicate = await receiverReopened.apply(retry.packet);
    check(duplicate.duplicate, 'Materialized retry not recognized');
    equal(await receiverReopened.restore(0), points[0], 'Receiver reopen damaged materialized point');
    await reopened.acknowledge(duplicate.receipt);
    check((await reopened.prepare(store)).packet === null, 'Acknowledged unchanged store delivered a packet');
  }));
  await run('incremental-wrong-ack-preserves-pending-packet', () => withHistory('ack', async ({ store, sender, receiver, points }) => {
    await store.append(points[0]); const prepared = await sender.prepare(store);
    const prior = await sender.exportState();
    await rejects(() => sender.acknowledge({ ...prepared.receipt, sha256: '0'.repeat(64) }), 'Wrong hash ACK accepted');
    await rejects(() => sender.acknowledge({ ...prepared.receipt, sequence: prepared.receipt.sequence + 1 }), 'Wrong sequence ACK accepted');
    sameBytes(await sender.exportState(), prior, 'Rejected ACK mutated sender state');
    sameBytes((await sender.prepare(store)).packet, prepared.packet, 'Rejected ACK lost pending bytes');
    const applied = await receiver.apply(prepared.packet); await sender.acknowledge(applied.receipt);
  }));
  await run('incremental-missing-and-out-of-order-package-detected', () => withHistory('order', async ({ store, sender, receiver, points }) => {
    const packets = [];
    for (const point of points.slice(0, 3)) {
      await store.append(point); const prepared = await sender.prepare(store);
      packets.push(copy(prepared.packet)); await sender.acknowledge(prepared.receipt);
    }
    await rejects(() => receiver.apply(packets[1]), 'Delta accepted without bootstrap');
    await receiver.apply(packets[0]); const prior = await receiver.exportState();
    await rejects(() => receiver.apply(packets[2]), 'Missing intermediate packet accepted');
    sameBytes(await receiver.exportState(), prior, 'Missing packet changed receiver state');
    await rejects(() => receiver.restore(2), 'Missing delivery silently reconstructed point');
    await receiver.apply(packets[1]); await receiver.apply(packets[2]);
    equal(await receiver.restore(2), points[2], 'Ordered retry did not recover');
    await rejects(() => receiver.apply(packets[0]), 'Stale bootstrap accepted over advanced receiver');
  }));
  await run('incremental-corrupt-and-truncated-import-is-atomic', () => withHistory('corruption', async ({ store, sender, receiver, points }) => {
    await store.append(points[0]); const first = await sender.prepare(store);
    await receiver.apply(first.packet); await sender.acknowledge(first.receipt);
    await store.append(points[1]); const second = await sender.prepare(store);
    const corrupt = copy(second.packet); corrupt[Math.floor(corrupt.length / 2)] ^= 1;
    const prior = await receiver.exportState();
    for (const packet of [corrupt, second.packet.slice(0, -1), second.packet.slice(0, 12)]) {
      await rejects(() => receiver.apply(packet), 'Malformed incremental package accepted');
      sameBytes(await receiver.exportState(), prior, 'Failed import partially changed receiver state');
      equal(await receiver.restore(0), points[0], 'Failed import damaged prior committed point');
      await rejects(() => receiver.restore(1), 'Failed import exposed an uncommitted point');
    }
    await receiver.apply(second.packet); equal(await receiver.restore(1), points[1], 'Valid retry after rejection failed');
  }));
  await run('incremental-retention-gc-and-source-reopen', () => withHistory('retention', async ({ store, sender, receiver, name, points }) => {
    for (const point of points) {
      await store.append(point); const prepared = await sender.prepare(store);
      await receiver.apply(prepared.packet); await sender.acknowledge(prepared.receipt);
    }
    await store.retain([1, 3]); await store.gc(); store.close();
    const reopened = await createBrowserDeltaStore({ name, checkpointInterval: 5 });
    try {
      const prepared = await sender.prepare(reopened);
      check(prepared.stats.deletedRecords > 0, 'Retention package omitted record removals');
      await receiver.apply(prepared.packet); await sender.acknowledge(prepared.receipt);
      equal((await receiver.inspect()).ids, [1, 3], 'Receiver retained removed IDs');
      equal(await receiver.restore(1), points[1], 'Retention changed first retained point');
      equal(await receiver.restore(3), points[3], 'Retention changed final retained point');
      await rejects(() => receiver.restore(0), 'Retention did not remove old point');
      check(await reopened.append(points[0]) === 4, 'Reopened source reused point ID');
      const next = await sender.prepare(reopened); await receiver.apply(next.packet);
      equal(await receiver.restore(4), points[0], 'Append after retention/reopen failed');
    } finally { reopened.close(); }
  }));
  await run('incremental-corrupt-persisted-state-rejected', () => withHistory('state', async ({ store, sender, receiver, points }) => {
    await store.append(points[0]); const prepared = await sender.prepare(store); await receiver.apply(prepared.packet);
    const senderState = await sender.exportState(), receiverState = await receiver.exportState();
    const brokenSender = copy(senderState), brokenReceiver = copy(receiverState);
    brokenSender[Math.floor(brokenSender.length / 2)] ^= 1; brokenReceiver[Math.floor(brokenReceiver.length / 2)] ^= 1;
    await rejects(() => createBrowserIncrementalExporter({ stateBytes: brokenSender, checkpointInterval: 5 }), 'Corrupt sender cursor accepted');
    await rejects(() => createBrowserIncrementalReceiver({ stateBytes: brokenReceiver, checkpointInterval: 5 }), 'Corrupt receiver state accepted');
    equal(await receiver.restore(0), points[0], 'Invalid state reopen changed live receiver');
  }));
  await run('incremental-pending-delivery-precedes-new-source-generation', () => withHistory('pending', async ({ store, sender, receiver, points }) => {
    await store.append(points[0]); const first = await sender.prepare(store);
    await store.append(points[1]); const retry = await sender.prepare(store);
    sameBytes(retry.packet, first.packet, 'Source advance replaced pending package');
    await receiver.apply(retry.packet); await sender.acknowledge(retry.receipt);
    const second = await sender.prepare(store); await receiver.apply(second.packet); await sender.acknowledge(second.receipt);
    equal((await receiver.inspect()).ids, [0, 1], 'Post-ACK export skipped advanced source');
    equal(await receiver.restore(1), points[1], 'Post-ACK generation mismatch');
  }));
}
