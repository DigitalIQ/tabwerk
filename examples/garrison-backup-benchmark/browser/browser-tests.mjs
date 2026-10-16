import { createBrowserDeltaStore, restoreBrowserDeltaRecords, importBrowserDeltaRecords } from './browser-delta-store.mjs';
import { createBrowserDeltaArchive as createDeltaArchive, restoreBrowserDeltaPoint as restoreDeltaPoint, inspectBrowserDeltaFrame as inspectDeltaFrame } from './browser-delta-codec.mjs';
import { loadGarrisonRuntime } from './garrison-browser-reference.mjs';
import { check, equal, canonical, syntheticPoints, uniqueName, deleteDatabase, rejects, encodeBase64, decodeBase64, digest, timed } from './browser-harness-utils.mjs';
import { runIncrementalBrowserTests } from './incremental-browser-tests.mjs';
import { runAckBrowserTests } from './ack-browser-tests.mjs';
import { prepareWorkload, replayGarrisonPoint } from './browser-benchmark.mjs';

async function withStore(label, fn, options = {}) {
  const name = uniqueName(label);
  let store;
  try { store = await createBrowserDeltaStore({ name, checkpointInterval: 5, ...options }); return await fn(store, name); }
  finally { store?.close(); await deleteDatabase(name); }
}
async function mutateRecord(name, file, transform) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Test mutation open failed'));
  });
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('records', 'readwrite');
      const records = transaction.objectStore('records');
      const request = records.get(file);
      request.onsuccess = () => records.put(transform(request.result));
      transaction.oncomplete = resolve;
      transaction.onabort = transaction.onerror = () => reject(new Error('Test mutation failed'));
    });
  } finally { database.close(); }
}
async function terminateAt(name, phase, point) {
  const worker = new Worker(new URL('./browser-delta-worker.mjs', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker fault phase timeout')), 20000);
      worker.onerror = () => { clearTimeout(timer); reject(new Error('Worker fault test failed')); };
      worker.onmessage = ({ data }) => {
        if (data.phase === phase) { worker.terminate(); clearTimeout(timer); resolve(data); }
        else if (data.complete || data.error) { clearTimeout(timer); reject(new Error('Worker missed requested fault phase')); }
      };
      worker.postMessage({ name, phase, point, checkpointInterval: 5 });
    });
  } finally { worker.terminate(); }
}

export async function runBrowserTests(input = {}, options = {}) {
  const tests = [];
  const run = async (name, fn) => {
    const measured = await timed(fn);
    tests.push({ name, passed: true, ms: measured.ms, ...(measured.value ?? {}) });
    await options.onProgress?.({ phase: 'tests', name, passed: true });
  };
  const points = syntheticPoints();
  await run('garrison-restore-starts-at-latest-complete-zip', async () => {
    const artifacts = [
      { format: 'zip', sessions: [{ id: 'obsolete', value: 0 }] },
      { format: 'json', sessions: [{ id: 'obsolete', value: 1 }] },
      { format: 'zip', sessions: [{ id: 'current', value: 2 }] },
      { format: 'json', sessions: [{ id: 'current', value: 3 }] },
    ];
    const decoded = [];
    const reference = { readDeliveryArchive(artifact) { decoded.push(artifacts.indexOf(artifact)); return { sessions: artifact.sessions }; } };
    equal(replayGarrisonPoint(reference, artifacts, 4, 'complete-plus-individual-json'), [{ id: 'current', value: 3 }], 'Latest complete ZIP restore changed point');
    equal(decoded, [2, 3], 'Restore unnecessarily decoded artifacts before latest complete ZIP');
    decoded.length = 0;
    equal(replayGarrisonPoint(reference, artifacts, 2, 'complete-plus-individual-json'), [{ id: 'obsolete', value: 1 }], 'Earlier cutoff incorrectly read future ZIP');
    equal(decoded, [0, 1], 'Earlier cutoff decoded wrong artifacts');
  });
  await run('browser-codec-json-fidelity-and-corruption', async () => {
    const writer = createDeltaArchive({ checkpointInterval: 2 });
    const frames = [];
    for (let i = 0; i < points.length; i++) {
      frames.push(await writer.append(points[i]));
      equal(await restoreDeltaPoint(frames, i), points[i], 'Browser codec changed JSON content');
    }
    const corrupted = frames.map(frame => new Uint8Array(frame));
    corrupted[1][corrupted[1].length - 1] ^= 1;
    await rejects(() => restoreDeltaPoint(corrupted, 1), 'Corrupt compressed frame accepted');
    await rejects(() => inspectDeltaFrame(frames[0], { maxFrameBytes: frames[0].length - 1 }), 'Frame limit not enforced');
    await rejects(() => restoreDeltaPoint(frames, 0, { maxPayloadBytes: 8 }), 'Payload limit not enforced');
    await rejects(() => restoreDeltaPoint([frames[0].slice(0, 20)], 0), 'Truncated frame accepted');
    return { points: points.length, negativeZeroPreserved: true };
  });
  await run('cross-runtime-node-browser-and-browser-node', async () => {
    check(input.crossRuntime && Array.isArray(input.crossRuntime.nodeFrames), 'Node cross-runtime fixture missing');
    const fixture = input.crossRuntime;
    const frames = fixture.nodeFrames.map(decodeBase64);
    for (let i = 0; i < frames.length; i++) equal(await restoreDeltaPoint(frames, i), fixture.nodePoints[i], 'Node frame incompatible with browser decoder');
    check(typeof options.verifyNode === 'function', 'Independent Node verifier is required');
    const writer = createDeltaArchive({ checkpointInterval: fixture.checkpointInterval ?? 2 });
    const browserFrames = [];
    for (const point of fixture.nodePoints) browserFrames.push(encodeBase64(await writer.append(point)));
    const result = await options.verifyNode({ frames: browserFrames, points: fixture.nodePoints });
    check(result?.ok === true, 'Independent Node decoder rejected browser frames');
    return { nodeToBrowserPoints: frames.length, browserToNodePoints: browserFrames.length };
  });
  await run('indexeddb-reopen-and-independent-portable-zip-import', async () => {
    const runtime = await loadGarrisonRuntime(options);
    const importedName = uniqueName('portable-test');
    let reopened, imported;
    try {
      await withStore('reopen', async (store, name) => {
        for (const point of points) await store.append(point);
        store.close();
        reopened = await createBrowserDeltaStore({ name, checkpointInterval: 5 });
        for (let i = 0; i < points.length; i++) equal(await reopened.restore(i), points[i], 'Reopened IndexedDB changed content');
        const zip = runtime.packRecords(await reopened.exportRecords());
        const records = runtime.unpackRecords(zip);
        imported = await importBrowserDeltaRecords(records, { name: importedName, checkpointInterval: 5 });
        for (let i = 0; i < points.length; i++) {
          equal(await restoreBrowserDeltaRecords(records, i), points[i], 'Portable-only restore changed content');
          equal(await imported.restore(i), points[i], 'Fresh imported IndexedDB changed content');
        }
        reopened.close(); reopened = null;
      });
    } finally { reopened?.close(); imported?.close(); await deleteDatabase(importedName); }
    return { independentRestoredPoints: points.length };
  });
  await run('fresh-validation-detects-external-idb-corruption', async () => {
    await withStore('corrupt', async (store, name) => {
      for (const point of points) await store.append(point);
      equal(await store.restore(2), points[2], 'Initial read failed');
      const records = await store.exportRecords();
      const frame = records.find(record => record.file.startsWith('frame-'));
      check(frame, 'No frame record found');
      await mutateRecord(name, frame.file, record => {
        const bytes = new Uint8Array(record.bytes); bytes[bytes.length - 1] ^= 1; return { ...record, bytes };
      });
      await rejects(() => store.restore(2), 'Cached successful read concealed later byte corruption');
      await rejects(() => store.exportRecords(), 'Portable export accepted corrupted history');
    });
  });
  await run('portable-corruption-and-import-atomicity', async () => {
    const importedName = uniqueName('invalid-import');
    try {
      await withStore('invalid-export', async store => {
        await store.append(points[0]);
        const records = await store.exportRecords();
        const broken = records.map(record => ({ file: record.file, bytes: record.bytes.slice() }));
        const frame = broken.find(record => record.file.startsWith('frame-'));
        frame.bytes[frame.bytes.length - 1] ^= 1;
        await rejects(() => restoreBrowserDeltaRecords(broken, 0), 'Corrupted portable history accepted');
        await rejects(() => importBrowserDeltaRecords(broken, { name: importedName }), 'Corrupted portable import accepted');
        const empty = await createBrowserDeltaStore({ name: importedName });
        try { equal(await empty.list(), [], 'Rejected portable import leaked partial state'); }
        finally { await empty.close(); }
        await rejects(() => restoreBrowserDeltaRecords([...records, records[0]], 0), 'Duplicate portable filename accepted');
        // Alle übergeordneten Hashes werden erneuert. Ablehnung muss durch die
        // Indexgrenze entstehen, statt nur durch einen zufälligen Hashfehler.
        const oversized = records.map(record => ({ file: record.file, bytes: record.bytes.slice() }));
        const decode = record => JSON.parse(new TextDecoder().decode(record.bytes));
        const encode = value => new TextEncoder().encode(JSON.stringify(value));
        const current = oversized.find(record => record.file === 'CURRENT'), pointer = decode(current);
        const manifestRecord = oversized.find(record => record.file === pointer.manifest), manifest = decode(manifestRecord);
        const indexRecord = oversized.find(record => record.file === manifest.indexRoot.file), index = decode(indexRecord);
        index.entries = Array.from({ length: 33 }, () => index.entries[0]); indexRecord.bytes = encode(index);
        manifest.indexRoot.sha256 = await digest(indexRecord.bytes); manifestRecord.bytes = encode(manifest);
        pointer.sha256 = await digest(manifestRecord.bytes); current.bytes = encode(pointer);
        await rejects(() => restoreBrowserDeltaRecords(oversized, 0), 'Hash-consistent oversized index segment accepted');
      });
    } finally { await deleteDatabase(importedName); }
  });
  await run('segmented-index-boundary-and-retention', async () => {
    await withStore('index', async store => {
      const many = syntheticPoints(34);
      for (let i = 0; i < many.length; i++) check(await store.append(many[i]) === i, 'Index boundary point ID mismatch');
      const before = await store.inspect();
      check(before.ids.length === 34, 'Index boundary lost entries');
      const records = await store.exportRecords();
      const indexRecords = records.filter(record => record.file.startsWith('index-'));
      check(indexRecords.length >= 2, 'Index did not cross 32-entry segment boundary');
      for (const record of indexRecords) {
        const parsed = JSON.parse(new TextDecoder().decode(record.bytes));
        check(Array.isArray(parsed.entries) && parsed.entries.length <= 32, 'Index segment entry bound exceeded');
      }
      for (const i of [0, 31, 32, 33]) equal(await store.restore(i), many[i], 'Index boundary restore mismatch');
      await store.retain([1, 17, 33]);
      equal(await store.list(), [1, 17, 33], 'Retention changed logical IDs');
      for (const i of [1, 17, 33]) equal(await store.restore(i), many[i], 'Retention rebase changed content');
      await rejects(() => store.restore(0), 'Removed point remained restorable');
      await store.gc();
      for (const i of [1, 17, 33]) equal(await store.restore(i), many[i], 'Garbage collection changed retained point');
      check(await store.append(many[0]) === 34, 'Retention reused old logical ID');
    });
    return { writtenPoints: 35, retainedPoints: 3 };
  });
  await run('concurrent-writers-serialize-complete-commits', async () => {
    await withStore('writers', async (first, name) => {
      const second = await createBrowserDeltaStore({ name, checkpointInterval: 5 });
      try {
        const outcomes = await Promise.all([first.append(points[0]), second.append(points[1]), first.append(points[2])]);
        equal([...outcomes].sort((a, b) => a - b), [0, 1, 2], 'Concurrent writers duplicated or lost logical IDs');
        const expected = new Map(outcomes.map((id, i) => [id, points[i]]));
        for (const [id, point] of expected) equal(await second.restore(id), point, 'Concurrent writers mixed point payloads');
      } finally { second.close(); }
    });
  });
  for (const phase of ['transaction-started', 'transaction-enqueued']) {
    await run(`indexeddb-abort-${phase}`, async () => {
      let armed = false;
      await withStore('abort', async (store, name) => {
        await store.append(points[0]); armed = true;
        await rejects(() => store.append(points[1]), 'Explicit IndexedDB abort unexpectedly succeeded');
        armed = false;
        equal(await store.list(), [0], 'Aborted transaction leaked a committed point');
        equal(await store.restore(0), points[0], 'Aborted transaction damaged old point');
        store.close();
        const reopened = await createBrowserDeltaStore({ name, checkpointInterval: 5 });
        try { equal(await reopened.list(), [0], 'Aborted transaction persisted a partial commit'); }
        finally { reopened.close(); }
      }, { faultInjector(current, context) { if (armed && current === phase) context.transaction.abort(); } });
    });
  }
  for (const phase of ['before-commit', 'transaction-enqueued', 'after-commit']) {
    await run(`worker-termination-${phase}`, async () => {
      const name = uniqueName('worker');
      let store;
      try {
        store = await createBrowserDeltaStore({ name, checkpointInterval: 5 });
        await store.append(points[0]); store.close(); store = null;
        await terminateAt(name, phase, points[1]);
        store = await createBrowserDeltaStore({ name, checkpointInterval: 5 });
        const ids = await store.list();
        if (phase === 'before-commit') equal(ids, [0], 'Precommit worker termination changed committed state');
        else if (phase === 'after-commit') equal(ids, [0, 1], 'Postcommit worker termination lost committed state');
        else check(canonical(ids) === '[0]' || canonical(ids) === '[0,1]', 'In-flight worker termination exposed partial state');
        equal(await store.restore(0), points[0], 'Worker termination damaged previous point');
        if (ids.length === 2) equal(await store.restore(1), points[1], 'Worker termination exposed incomplete new point');
      } finally { store?.close(); await deleteDatabase(name); }
    });
  }
  if (input.prepared) await run('private-input-cumulative-whole-database-fidelity', async () => {
    const workload = await prepareWorkload(input, options);
    return { points: workload.snapshots.length, sessionsInFinalDatabase: workload.snapshots.at(-1).length, fieldsRemoved: 0 };
  });
  const baselinePassed = tests.length;
  await runIncrementalBrowserTests(run);
  const incrementalPassed = tests.length - baselinePassed;
  await runAckBrowserTests(run);
  return { version: 3, baselinePassed, incrementalPassed, ackPassed: tests.length - baselinePassed - incrementalPassed, createdAt: new Date().toISOString(), passed: tests.length, tests, contentIncludedInReport: false,
    limits: 'Worker termination and IndexedDB abort are browser transaction tests. They do not establish OS crash or power-loss durability.' };
}
