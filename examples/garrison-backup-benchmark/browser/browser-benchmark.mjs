import { createBrowserDeltaStore, importBrowserDeltaRecords } from './browser-delta-store.mjs';
import { createBrowserDurableIncrementalExporter, createBrowserIncrementalReceiver } from './browser-incremental-export.mjs';
import { createBrowserIncrementalExporter as createBaselineExporter, createBrowserIncrementalReceiver as createBaselineReceiver } from './baseline-incremental-export.mjs';
import { createGarrisonReference, loadGarrisonRuntime } from './garrison-browser-reference.mjs';
import { check, equal, clone, canonical, round, sum, timed, uniqueName, deleteDatabase } from './browser-harness-utils.mjs';

export async function prepareWorkload(input, options = {}) {
  check(input?.prepared?.format === 'tabwerk-local-history-input' && input.prepared.version === 1, 'Prepared input contract mismatch');
  const history = input.prepared.history;
  check(Array.isArray(history) && history.length === 10 && history.every(point => Array.isArray(point) && point.length === 1), 'Expected ten original regular autosaves');
  const sessions = history.map(point => clone(point[0]));
  check(new Set(sessions.map(s => s.id)).size === sessions.length, 'Autosave IDs are not unique');
  check(sessions.every((s, i) => Array.isArray(s.tag) && s.tag.includes('regular') && Number.isSafeInteger(s.date) && (!i || s.date >= sessions[i - 1].date)), 'Autosave chronology contract mismatch');
  const sourceSnapshots = sessions.map((_, i) => clone(sessions.slice(0, i + 1)));
  sourceSnapshots.forEach((point, i) => equal(point.slice(0, i), sourceSnapshots[i - 1] ?? [], 'Cumulative snapshot changed original content'));
  // IndexedDB getAll returns primary-key order. Both measured paths receive
  // this actual exported order; IDs and every original field remain unchanged.
  const reference = await createGarrisonReference(options);
  const snapshots = [];
  let original = null;
  const byId = point => [...point].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  try {
    for (const source of sourceSnapshots) {
      await reference.seedDatabase(clone(source));
      const actual = await reference.readDatabase();
      equal(byId(actual), byId(source), 'Garrison transformation loses original session fields');
      snapshots.push(actual);
    }
    if (Array.isArray(input.original)) {
      check(new Set(input.original.map(s => s.id)).size === input.original.length, 'Original database IDs are not unique');
      await reference.seedDatabase(clone(input.original)); original = await reference.readDatabase();
      equal(byId(original), byId(input.original), 'Original database export transformation loses fields');
    }
  } finally { await reference.dispose(); }
  return { snapshots, original, summary: {
    name: 'prepared10-growing', points: snapshots.length, databaseSessionCounts: snapshots.map(s => s.length),
    inputSessionCount: sessions.length, fieldsRemovedByHarness: 0, nativeExportOrder: 'IndexedDB primary key order, lossless by-ID comparison against all original session fields', originalSessionCount: input.original?.length ?? null,
  } };
}

export function replayGarrisonPoint(reference, artifacts, boundary, mode) {
  check(Number.isInteger(boundary) && boundary >= 0 && boundary <= artifacts.length, 'Invalid delivery boundary');
  let start = 0;
  // Ein CompleteZIP ersetzt die gesamte DB. Frühere Artefakte tragen zum
  // gewünschten Restorepunkt nichts bei und werden nicht erneut dekodiert.
  for (let i = boundary - 1; i >= 0; i--) {
    if (artifacts[i].format === 'zip' || mode === 'legacy-all-json') { start = i; break; }
  }
  const sessions = new Map();
  for (let i = start; i < boundary; i++) {
    for (const session of reference.readDeliveryArchive(artifacts[i]).sessions) sessions.set(session.id, session);
  }
  return [...sessions.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

async function garrisonRun(snapshots, options, mode = 'complete-zip', enforceEquivalent = mode !== 'legacy-all-json') {
  const initialized = await timed(() => createGarrisonReference(options));
  const reference = initialized.value;
  const artifacts = [], pointBoundaries = [], backupMs = [], restoreMs = [], sourceJsonBytes = [], pointRestorable = [], restoreDifferences = [];
  let peakLogicalBytes = 0, clock = 0;
  try {
    for (const snapshot of snapshots) {
      await reference.seedDatabase(clone(snapshot));
      const actual = await reference.readDatabase();
      equal(actual, snapshot, 'Garrison DB read transformation changed workload content');
      clock = Math.max(clock + 1, ...snapshot.map(s => Math.max(s.date ?? 0, s.lastEditedTime ?? 0) + 1));
      const measured = await timed(() => reference.backup(mode, { now: clock }));
      check(Array.isArray(measured.value.deliveries), 'Garrison delivery list missing');
      for (const delivery of measured.value.deliveries) {
        check(delivery.bytes instanceof Uint8Array && delivery.bytes.length > 0, 'Garrison delivery bytes missing');
        artifacts.push(delivery);
      }
      pointBoundaries.push(artifacts.length); backupMs.push(measured.ms);
      const jsonBytes = new TextEncoder().encode(JSON.stringify(actual, null, 2)).length;
      sourceJsonBytes.push(jsonBytes);
      // Gezählt werden bekannte logische Nutzdaten, keine Prozess-RAM-Messung.
      peakLogicalBytes = Math.max(peakLogicalBytes, sum(artifacts.map(a => a.bytes.length)) + jsonBytes + sum(measured.value.deliveries.map(a => a.bytes.length)));
    }
    const byId = point => [...point].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (let i = 0; i < snapshots.length; i++) {
      const restored = await timed(() => replayGarrisonPoint(reference, artifacts, pointBoundaries[i], mode));
      const complete = canonical(restored.value) === canonical(byId(snapshots[i]));
      pointRestorable.push(complete);
      const restoredById = new Map(restored.value.map(s => [s.id, s])), expectedById = new Map(snapshots[i].map(s => [s.id, s]));
      restoreDifferences.push({ missingSessions: snapshots[i].filter(s => !restoredById.has(s.id)).length,
        extraSessions: restored.value.filter(s => !expectedById.has(s.id)).length,
        changedSessions: snapshots[i].filter(s => restoredById.has(s.id) && canonical(s) !== canonical(restoredById.get(s.id))).length });
      if (enforceEquivalent) check(complete, 'Original Garrison delivery history does not restore the complete database point');
      restoreMs.push(restored.ms);
    }
    // Diese Gruppierung ist ein explizites Harness-Artefakt. Garrison selbst
    // bietet für IndividualJSON keinen vollständigen DB-History-Index an.
    const restoreLedger = { format: 'tabwerk-replay-boundaries-v1', mode, throughArtifactCount: pointBoundaries };
    const restoreLedgerBytes = new TextEncoder().encode(JSON.stringify(restoreLedger)).length;
    const nativeArtifactHistoryBytes = sum(artifacts.map(a => a.bytes.length));
    return { path: mode, initializationMs: initialized.ms, backupMs, backupAndNativeDeliveryMs: backupMs,
      deliveryMs: null, acknowledgementMs: null, senderCursorPersistMs: null, independentImportMs: null,
      componentTiming: 'Original backup call includes native Blob/fetch delivery, download completion and metadata persistence. Decode/import remains inside each original replay restore; separate timing unavailable.',
      totalBackupMs: round(sum(backupMs)), totalBackupAndDeliveryMs: round(initialized.ms + sum(backupMs)),
      totalRunMs: round(initialized.ms + sum(backupMs) + sum(restoreMs)),
      totalRunTimingContract: 'Sum of reported initialization, native backup/delivery and replay restore phases. Source seeding and cleanup are excluded; not whole-run elapsed wall time.', restoreMs,
      totalRestoreMs: round(sum(restoreMs)), deliveredArtifactBytes: artifacts.map(a => a.bytes.length),
      deliveredArtifactFormats: artifacts.map(a => a.format), artifactsDeliveredPerPoint: pointBoundaries.map((n, i) => n - (pointBoundaries[i - 1] ?? 0)),
      cumulativeDeliveredBytes: nativeArtifactHistoryBytes, nativeArtifactHistoryBytes, restoreLedgerBytes,
      finalPortableHistoryBytes: nativeArtifactHistoryBytes + restoreLedgerBytes,
      portableHistoryIndex: 'Harness delivery-boundary sidecar; no claim of a native Garrison history restore feature',
      sourcePrettyJsonBytes: sourceJsonBytes, replayClockPolicy: 'max(previous replay time + 1, latest original date or lastEditedTime + 1); original source fields unchanged',
      peakKnownLogicalBytes: peakLogicalBytes, pointRestorable, restoreDifferences, restoredPoints: pointRestorable.filter(Boolean).length,
      equivalentCompleteHistory: pointRestorable.every(Boolean) };
  } finally { await reference.dispose(); }
}

async function deltaRun(snapshots, runtime) {
  const name = uniqueName('measurement'), importName = uniqueName('portable-import');
  let store, imported;
  const appendMs = [], exportMs = [], deliveryBytes = [], inventories = [];
  let finalZip, peakKnownLogicalBytes = 0;
  try {
    store = await createBrowserDeltaStore({ name, checkpointInterval: 5 });
    for (let i = 0; i < snapshots.length; i++) {
      const appended = await timed(() => store.append(clone(snapshots[i])));
      check(appended.value === i, 'Delta point ID mismatch');
      appendMs.push(appended.ms);
      const exported = await timed(async () => {
        const records = await store.exportRecords();
        const zip = runtime.packRecords(records);
        // Match Blob creation and sink delivery without an OS download.
        const blobUrl = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
        let delivered;
        try { delivered = new Uint8Array(await (await fetch(blobUrl)).arrayBuffer()); }
        finally { URL.revokeObjectURL(blobUrl); }
        return { zip: delivered, recordBytes: sum(records.map(r => r.bytes.length)) };
      });
      finalZip = exported.value.zip;
      exportMs.push(exported.ms); deliveryBytes.push(finalZip.length);
      const inspected = await store.inspect();
      inventories.push(inspected);
      const accounting = inspected.accounting;
      const storedBytes = accounting.totalRecordBytes;
      check(Number.isSafeInteger(storedBytes), 'Delta accounting lacks total logical bytes');
      check(accounting.referencedBytes + accounting.orphanBytes + accounting.otherBytes === storedBytes, 'Delta byte ledger does not balance');
      peakKnownLogicalBytes = Math.max(peakKnownLogicalBytes, storedBytes + exported.value.recordBytes + finalZip.length);
    }
    await store.close(); store = null;
    const importMeasured = await timed(async () => {
      const records = runtime.unpackRecords(finalZip);
      return importBrowserDeltaRecords(records, { name: importName, checkpointInterval: 5 });
    });
    imported = importMeasured.value;
    const restoreMs = [];
    equal(await imported.list(), snapshots.map((_, i) => i), 'Portable Delta history point list mismatch');
    for (let i = 0; i < snapshots.length; i++) {
      const restored = await timed(() => imported.restore(i));
      equal(restored.value, snapshots[i], 'Fresh imported Delta database restore changed content');
      restoreMs.push(restored.ms);
    }
    return { path: 'delta-indexeddb-plus-full-history-export-each-point', appendMs, exportMs,
      totalAppendMs: round(sum(appendMs)), totalExportMs: round(sum(exportMs)),
      totalBackupAndDeliveryMs: round(sum(appendMs) + sum(exportMs)), deliveredZipBytes: deliveryBytes,
      cumulativeDeliveredBytes: sum(deliveryBytes), finalPortableHistoryBytes: finalZip.length,
      independentImportMs: importMeasured.ms, restoreMs, totalRestoreMs: round(sum(restoreMs)),
      inventoryAfterEachPoint: inventories, peakKnownLogicalBytes, restoredPoints: snapshots.length };
  } finally {
    await store?.close(); await imported?.close();
    await deleteDatabase(name); await deleteDatabase(importName);
  }
}

// Logical IDB values and operations, not SSD writes or filesystem allocation.
async function createCursorPersistence(name) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Cursor persistence open failed'));
  });
  const counters = { bytesWritten: 0, recordWrites: 0, bytesDeleted: 0, recordDeletes: 0, bytesRead: 0, recordReads: 0 };
  return { close: () => database.close(), counters,
    async save(bytes) {
      await new Promise((resolve, reject) => {
        const tx = database.transaction('state', 'readwrite', { durability: 'strict' });
        check(tx.durability === 'strict', 'Cursor persistence strict durability unavailable');
        tx.objectStore('state').put(bytes, 'sender');
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(new Error('Cursor persistence failed'));
      });
      counters.bytesWritten += bytes.length; counters.recordWrites++;
    },
    async read() {
      const bytes = await new Promise((resolve, reject) => {
        const tx = database.transaction('state', 'readonly');
        const request = tx.objectStore('state').get('sender');
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(new Error('Cursor persistence read failed'));
      });
      counters.bytesRead += bytes?.length ?? 0; counters.recordReads++;
      return bytes;
    },
  };
}

async function materializePacket(packet) {
  const blobUrl = URL.createObjectURL(new Blob([packet], { type: 'application/octet-stream' }));
  try { return new Uint8Array(await (await fetch(blobUrl)).arrayBuffer()); }
  finally { URL.revokeObjectURL(blobUrl); }
}

async function restorePackets(packets, snapshots, factory) {
  const imported = await timed(async () => {
    const receiver = await factory({ checkpointInterval: 5 });
    for (const packet of packets) await receiver.apply(new Uint8Array(packet));
    return receiver;
  });
  const restoreMs = [];
  const inventory = await imported.value.inspect();
  equal(inventory.ids, snapshots.map((_, i) => i), 'Independent packet-only point list mismatch');
  for (let i = 0; i < snapshots.length; i++) {
    const restored = await timed(() => imported.value.restore(i));
    equal(restored.value, snapshots[i], 'Independent packet-only restore changed original fields');
    restoreMs.push(restored.ms);
  }
  return { independentImportMs: imported.ms, restoreMs, totalRestoreMs: round(sum(restoreMs)), receiverInventory: inventory };
}

async function incrementalRun(snapshots, optimized = false) {
  const name = uniqueName('incremental-source'), cursorName = uniqueName('incremental-sender');
  let store, persistence, sender;
  const appendMs = [], exportMs = [], deliveryMs = [], senderCursorPersistMs = [], acknowledgementMs = [], persistenceInspectMs = [];
  const packets = [], packetStats = [], acknowledgementStats = [], pendingPersistenceStats = [], senderPendingStateBytes = [], senderStateBytes = [], inventories = [], persistenceAfterEachPoint = [];
  let peakKnownLogicalBytes = 0, finalSenderPersistence, recoveryPersistence, initializationMs, finalReopenMs;
  try {
    const initialized = await timed(async () => {
      store = await createBrowserDeltaStore({ name, checkpointInterval: 5 });
      if (optimized) sender = await createBrowserDurableIncrementalExporter({ name: cursorName, checkpointInterval: 5 });
      else {
        persistence = await createCursorPersistence(cursorName);
        sender = await createBaselineExporter({ checkpointInterval: 5 });
      }
    });
    initializationMs = initialized.ms;
    for (let i = 0; i < snapshots.length; i++) {
      const appended = await timed(() => store.append(clone(snapshots[i])));
      check(appended.value === i, 'Incremental point ID mismatch'); appendMs.push(appended.ms);
      const exported = await timed(() => sender.prepare(store));
      const prepared = exported.value;
      check(prepared.packet instanceof Uint8Array, 'Append produced no incremental packet');
      exportMs.push(exported.ms); packetStats.push(prepared.stats);
      pendingPersistenceStats.push(optimized ? prepared.stats.persistence : { bytesWritten: prepared.stateBytes.length, recordWrites: 1, bytesDeleted: 0, recordDeletes: 0 });
      senderPendingStateBytes.push(optimized ? prepared.stats.totalRecordBytes : prepared.stateBytes.length);
      let persistMs = 0;
      if (!optimized) {
        const persisted = await timed(() => persistence.save(prepared.stateBytes));
        persistMs += persisted.ms;
      }
      const delivered = await timed(() => materializePacket(prepared.packet));
      packets.push(delivered.value); deliveryMs.push(delivered.ms);
      // ACK is allowed only after the exact bytes reached the materialized sink.
      const acknowledged = await timed(() => sender.acknowledge(prepared.receipt));
      acknowledgementMs.push(acknowledged.ms);
      acknowledgementStats.push(optimized ? acknowledged.value.stats : { bytesWritten: acknowledged.value.length, recordWrites: 1, bytesDeleted: 0, recordDeletes: 0 });
      if (!optimized) {
        const persisted = await timed(() => persistence.save(acknowledged.value));
        persistMs += persisted.ms;
      }
      senderCursorPersistMs.push(round(persistMs));
      const inspectedPersistence = await timed(async () => optimized ? sender.inspectPersistence() : (() => ({
        counters: { ...persistence.counters }, stateBytes: acknowledged.value.length, totalRecordBytes: acknowledged.value.length, pendingPacketBytes: 0,
        transactionDurability: 'strict',
      }))());
      persistenceInspectMs.push(inspectedPersistence.ms);
      persistenceAfterEachPoint.push(inspectedPersistence.value);
      senderStateBytes.push(inspectedPersistence.value.totalRecordBytes);
      finalSenderPersistence = inspectedPersistence.value;
      const inspected = await store.inspect(); inventories.push(inspected);
      peakKnownLogicalBytes = Math.max(peakKnownLogicalBytes, inspected.accounting.totalRecordBytes + sum(packets.map(p => p.length)) + Math.max(senderPendingStateBytes.at(-1), inspectedPersistence.value.totalRecordBytes));
    }
    // Final recovery reopen has its own timing, outside running backup totals.
    const reopened = await timed(async () => {
      if (optimized) {
        await sender.close();
        sender = await createBrowserDurableIncrementalExporter({ name: cursorName, checkpointInterval: 5 });
        recoveryPersistence = await sender.inspectPersistence();
      } else {
        const counters = { ...persistence.counters };
        persistence.close(); persistence = await createCursorPersistence(cursorName);
        Object.assign(persistence.counters, counters);
        const stateBytes = await persistence.read();
        sender = await createBaselineExporter({ stateBytes, checkpointInterval: 5 });
        recoveryPersistence = { counters: { ...persistence.counters }, stateBytes: stateBytes.length, totalRecordBytes: stateBytes.length, pendingPacketBytes: 0, transactionDurability: 'strict' };
      }
      check((await sender.prepare(store)).packet === null, 'Final reopened sender retransmitted acknowledged data');
      if (optimized) recoveryPersistence = await sender.inspectPersistence();
    });
    finalReopenMs = reopened.ms;
    const primary = await restorePackets(packets, snapshots, createBrowserIncrementalReceiver);
    const crosscheck = await restorePackets(packets, snapshots, createBaselineReceiver);
    const portableBytes = sum(packets.map(p => p.length));
    const totalBackupAndDeliveryMs = round(initializationMs + sum(appendMs) + sum(exportMs) + sum(deliveryMs) + sum(senderCursorPersistMs) + sum(acknowledgementMs));
    return { path: optimized ? 'delta-incremental-optimized' : 'delta-incremental-baseline', initializationMs, finalReopenMs,
      appendMs, exportMs, deliveryMs, senderCursorPersistMs, acknowledgementMs, persistenceInspectMs,
      totalAppendMs: round(sum(appendMs)), totalExportMs: round(sum(exportMs)), totalDeliveryMs: round(sum(deliveryMs)),
      totalSenderCursorPersistMs: round(sum(senderCursorPersistMs)), totalAcknowledgementMs: round(sum(acknowledgementMs)),
      totalPersistenceInspectMs: round(sum(persistenceInspectMs)), totalBackupAndDeliveryMs,
      totalSteadyCycleMs: round(totalBackupAndDeliveryMs - initializationMs),
      totalRunMs: round(totalBackupAndDeliveryMs + finalReopenMs + sum(persistenceInspectMs) + primary.independentImportMs + primary.totalRestoreMs),
      totalRunTimingContract: 'Sum of reported selected phases: running backup, diagnostic sender inspection, final recovery reopen, primary packet import and point restores. Excludes source-store diagnostic inspect, frozen-receiver crosscheck and cleanup; not whole-run elapsed wall time.',
      deliveredPacketBytes: packets.map(p => p.length), packetStats, acknowledgementStats, pendingPersistenceStats,
      senderPersistenceTiming: optimized ? 'Strict pending persistence is inside exportMs, strict ACK persistence inside acknowledgementMs. senderCursorPersistMs=0 means no extra external save, not zero persistence work.' : 'Strict full pending and ACK cursor saves are separately timed in senderCursorPersistMs.',
      cumulativeDeliveredBytes: portableBytes, finalPortableHistoryBytes: portableBytes,
      senderStateBytesAfterEachPoint: senderStateBytes, senderPendingStateBytesAfterEachPoint: senderPendingStateBytes,
      finalSourceStoreBytes: inventories.at(-1).accounting.totalRecordBytes, finalSenderStateBytes: finalSenderPersistence.totalRecordBytes,
      cumulativeSenderLogicalWriteBytes: finalSenderPersistence.counters.bytesWritten, cumulativeSenderLogicalDeleteBytes: finalSenderPersistence.counters.bytesDeleted,
      finalSenderPersistence, recoveryPersistence, persistenceAfterEachPoint,
      senderPersistenceAccounting: 'Logical IDB value bytes: source store, current sender state, cumulative sender puts/deletes and portable packets are separate. Read counters include explicitly timed diagnostic inspections. No physical SSD-write estimate.',
      ...primary, frozenReceiverCrosscheck: { independentImportMs: crosscheck.independentImportMs, restoreMs: crosscheck.restoreMs,
        totalRestoreMs: crosscheck.totalRestoreMs, restoredPoints: snapshots.length, excludedFromPrimaryTotals: true },
      inventoryAfterEachPoint: inventories, peakKnownLogicalBytes, restoredPoints: snapshots.length,
      equivalentCompleteHistory: true,
      portableHistoryIndex: 'Ordered bootstrap and delta packets with their sequence/hash metadata; no hidden full checkpoint',
      timingContract: optimized
        ? 'Init + append + full prepare (including read/validate and pending commit) + Blob sink + full ACK (including read/validate and commit). Diagnostic inspections and final recovery reopen are timed separately and included only in totalRunMs. Persistence submetrics overlap prepare/ACK and must not be added again. Import and restore are separate.'
        : 'Init + append + frozen prepare + strict full pending-state save + Blob sink + frozen ACK + strict full ACK-state save. Diagnostic inspection and final recovery reload/validation are timed separately and included only in totalRunMs. Import and restore are separate.',
    };
  } finally {
    await sender?.close?.(); await store?.close(); persistence?.close();
    await deleteDatabase(name); await deleteDatabase(cursorName);
  }
}


export async function runBrowserBenchmark(input, options = {}) {
  const pairs = options.pairs ?? 5, warmupPairs = options.warmupPairs ?? 1;
  check(pairs === 5 && warmupPairs === 1, 'Benchmark requires five measured rounds and one warmup');
  const workload = await prepareWorkload(input, options);
  const runtime = await loadGarrisonRuntime(options);
  const rounds = [];
  const paths = ['delta-incremental-baseline', 'delta-incremental-optimized', 'complete-zip', 'individual-json', 'complete-plus-individual-json'];
  for (let iteration = -warmupPairs; iteration < pairs; iteration++) {
    const rotation = ((iteration % paths.length) + paths.length) % paths.length;
    const order = [...paths.slice(rotation), ...paths.slice(0, rotation)];
    const result = {};
    for (const path of order) {
      result[path] = path.startsWith('delta-incremental-') ? await incrementalRun(workload.snapshots, path.endsWith('-optimized')) : await garrisonRun(workload.snapshots, options, path);
      await options.onProgress?.({ phase: iteration < 0 ? 'warmup' : 'measurement', pair: iteration, path, completed: true });
    }
    if (iteration >= 0) rounds.push({ pair: iteration, order, ...result, garrison: result['complete-zip'] });
    await options.onProgress?.({ phase: iteration < 0 ? 'warmup' : 'measurement', pair: iteration, completed: true });
  }
  const legacyAllBehaviorProbe = await garrisonRun(workload.snapshots, options, 'legacy-all-json');
  let original32 = null;
  if (workload.original) {
    original32 = { sessionCount: workload.original.length, 'delta-incremental-baseline': await incrementalRun([workload.original]), 'delta-incremental-optimized': await incrementalRun([workload.original], true) };
    for (const mode of [...paths.slice(2), 'legacy-all-json']) original32[mode] = await garrisonRun([workload.original], options, mode, mode === 'complete-zip');
  }
  return { version: 4, protocolVersion: 4, createdAt: new Date().toISOString(), browser: navigator.userAgent,
    workload: workload.summary, warmupPairs, pairs, rounds, legacyAllBehaviorProbe, original32,
    methodology: {
      protocol: 'Five paths per round: frozen original incremental exporter with full pending/ACK state persistence, optimized durable incremental exporter, and three original Garrison paths. Five measured rounds rotate every path through each position once, after one warmup round.',
      pathOrder: paths,
      input: 'Exactly the same cumulative complete SessionDB snapshots are supplied to every path; every original session field is compared canonically by ID before measuring.',
      garrison: 'CompleteZIP is an opt-in subpath. The native enabled-backup default is IndividualJSON. Complete-plus-IndividualJSON measures the additive original backupSessions entrypoint. LegacyAllJSON is a separate once-per-browser-session behavior probe.',
      clock: 'Historical replay injects Date.now and moment() per backup without changing original function bodies or source fields. Native lastBackupTime and once-per-session guards are retained.',
      delta: 'Both incremental paths export one bootstrap followed by ordered deltas. The frozen baseline persists its entire original pending and ACK state with strict IndexedDB transactions. The optimized path commits durable record-based cursor state. Complete materialization at the same packet sink precedes ACK. Fresh receivers import only delivered packets; a second frozen receiver crosschecks all points with separate timings.',
      finalSpace: 'Native Garrison artifacts and explicit harness boundary-sidecar bytes are reported separately. Ordered incremental packets include every complete restore point. Sender current state, cumulative logical writes and deletes are separate from portable exports. Incomplete legacy histories are excluded from equivalent comparisons.',
      restore: 'Garrison archives are independently decoded during each replay restore through recorded delivery cutoffs, starting at the latest complete ZIP when present. Garrison decoding/import remains included in restore time, as in the previous benchmark. Incremental packet replay into a fresh receiver is reported as import separately from all point restores. IndividualJSON restores are limited to this growing workload with no deletions. These helpers do not claim a native Garrison full-history import feature.',
      memory: 'peakKnownLogicalBytes sums explicitly held byte artifacts only. It does not measure browser heap, physical RAM, filesystem allocation, SSD writes, or power-loss durability.',
      timing: 'Wall-clock timings on one browser origin, rotating five paths with balanced measured positions, one warmup round, five measured rounds. Validation and portable delivery work are included; DB seeding is excluded. Both Delta paths run independently once per round. Initialization, all required read/validate/commit work, packet delivery and ACK are included in backup totals. Diagnostic inspection and final recovery reopen/validation are separate and included only in totalRunMs. Running operation does not inject sender restarts per point. Original Garrison backup timing bundles its native delivery and metadata commits; unavailable subcomponents are explicitly null. Import and restore are separate. Frozen-receiver crosschecks are excluded from primary totals.',
      durability: 'Delta requires IndexedDB strict transaction durability. Garrison retains its original transaction settings. Neither path establishes OS crash or power-loss durability.',
    }, contentIncludedInReport: false };
}
