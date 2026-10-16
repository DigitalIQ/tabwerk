import {
  browserHash, createBrowserDeltaArchive, createBrowserDeltaHistoryValidator,
  inspectBrowserDeltaFrame, snapshotBrowserDeltaPoint,
} from './browser-delta-codec.mjs';

// Experimental IndexedDB adapter. A Web Lock covers fresh validation, planning
// and the complete transaction. All new records and CURRENT commit atomically.
// IDB strict durability is requested, never equated with POSIX fsync. A killed
// tab can leave either committed state when the caller did not observe outcome.
// Byte accounting counts record payload bytes, not IndexedDB physical storage.
export const BROWSER_DELTA_STORE_FAULT_PHASES = Object.freeze([
  'locked', 'before-commit', 'transaction-started', 'transaction-enqueued', 'after-commit',
  'before-gc-commit', 'gc-transaction-started', 'gc-transaction-enqueued', 'after-gc-commit',
]);
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
// Capabilities only, no cached records or validation results. Unrecognized
// wrappers must take the independently validated portable path below.
const snapshotExports = new WeakMap();
const FORMAT = encoder.encode('tabwerk-delta-store-v2\n');
const MAX_INDEX_BYTES = 64 * 1024, MAX_METADATA_BYTES = 64 * 1024 * 1024, INDEX_ENTRIES = 32;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FRAME_NAME = new RegExp(`^frame-${UUID}\\.bin$`), MANIFEST_NAME = new RegExp(`^manifest-${UUID}\\.json$`), INDEX_NAME = new RegExp(`^index-${UUID}\\.json$`);
const HASH = /^[0-9a-f]{64}$/;
const safe = value => Number.isSafeInteger(value) && value >= 0;
const encode = value => encoder.encode(JSON.stringify(value));
const parse = bytes => { try { return JSON.parse(decoder.decode(bytes)); } catch { throw new Error('Invalid store JSON'); } };
const filename = kind => `${kind}-${globalThis.crypto.randomUUID()}.${kind === 'frame' ? 'bin' : 'json'}`;
const bytesEqual = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const refFor = async (file, bytes) => ({ file, sha256: await browserHash(bytes) });
function validIndexRef(ref) { return ref && typeof ref.file === 'string' && INDEX_NAME.test(ref.file) && typeof ref.sha256 === 'string' && HASH.test(ref.sha256); }
function validateManifest(manifest, checkpointInterval) {
  if (!manifest || manifest.version !== 2 || !safe(manifest.generation) || !safe(manifest.nextId) || !safe(manifest.checkpointInterval) || manifest.checkpointInterval < 1) throw new Error('Invalid committed manifest');
  if (manifest.checkpointInterval !== checkpointInterval) throw new Error('Store checkpointInterval differs from requested interval');
  if (manifest.previous !== undefined && (!manifest.previous || typeof manifest.previous.manifest !== 'string' || !MANIFEST_NAME.test(manifest.previous.manifest) || typeof manifest.previous.sha256 !== 'string' || !HASH.test(manifest.previous.sha256))) throw new Error('Invalid previous manifest reference');
  if (!safe(manifest.entryCount) || manifest.entryCount > manifest.nextId || (manifest.entryCount === 0 ? manifest.indexRoot !== null : !validIndexRef(manifest.indexRoot)) || 'entries' in manifest) throw new Error('Invalid committed index root');
}
function validateEntry(entry) {
  if (!entry || !safe(entry.id) || !safe(entry.index) || typeof entry.file !== 'string' || !FRAME_NAME.test(entry.file) || typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)) throw new Error('Invalid committed entry');
}
async function readIndex(read, reference) {
  if (!validIndexRef(reference)) throw new Error('Invalid index reference');
  const bytes = await read(reference.file, MAX_INDEX_BYTES);
  if (await browserHash(bytes) !== reference.sha256) throw new Error('Committed index hash mismatch');
  const node = parse(bytes);
  if (!node || node.version !== 2 || !Array.isArray(node.entries) || !node.entries.length || node.entries.length > INDEX_ENTRIES || (node.previous !== null && !validIndexRef(node.previous))) throw new Error('Invalid index segment');
  let previous;
  for (const entry of node.entries) {
    validateEntry(entry);
    if (previous && (entry.index !== previous.index + 1 || entry.id <= previous.id)) throw new Error('Invalid index entry range');
    previous = entry;
  }
  return { ...reference, node, bytes: bytes.length };
}
async function load(read, checkpointInterval, limits, onPoint, allowEmpty = false) {
  let marker, pointer;
  try { marker = await read('FORMAT', 128); } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
  try { pointer = await read('CURRENT', 1024); } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
  if (marker && !bytesEqual(marker, FORMAT)) throw new Error('Invalid store format');
  if (!pointer) {
    if (marker || !allowEmpty) throw new Error('Missing committed CURRENT');
    return { manifest: { version: 2, generation: 0, nextId: 0, checkpointInterval, entryCount: 0, indexRoot: null }, entries: [], indices: [], metadata: [], frameBytes: 0, manifestBytes: 0, indexBytes: 0, pointerBytes: 0, markerBytes: 0 };
  }
  if (!marker) throw new Error('Missing store FORMAT');
  const ref = parse(pointer);
  if (!ref || typeof ref.manifest !== 'string' || !MANIFEST_NAME.test(ref.manifest) || typeof ref.sha256 !== 'string' || !HASH.test(ref.sha256)) throw new Error('Invalid CURRENT');
  const bytes = await read(ref.manifest, MAX_METADATA_BYTES);
  if (await browserHash(bytes) !== ref.sha256) throw new Error('Committed manifest hash mismatch');
  const manifest = parse(bytes); validateManifest(manifest, checkpointInterval);
  const indices = [], seen = new Set();
  let reference = manifest.indexRoot, count = 0, nextStart = manifest.entryCount, totalBytes = bytes.length;
  while (reference) {
    if (seen.has(reference.file) || indices.length >= manifest.entryCount) throw new Error('Invalid index cycle');
    seen.add(reference.file);
    const index = await readIndex(read, reference); totalBytes += index.bytes;
    if (totalBytes > MAX_METADATA_BYTES) throw new RangeError('Metadata byte limit exceeded');
    count += index.node.entries.length;
    if (count > manifest.entryCount || index.node.entries.at(-1).index !== nextStart - 1) throw new Error('Invalid index entry range');
    nextStart = index.node.entries[0].index; indices.push(index); reference = index.node.previous;
  }
  if (count !== manifest.entryCount || nextStart !== 0) throw new Error('Invalid index entry count');
  const entries = indices.slice().reverse().flatMap(index => index.node.entries);
  const metadata = [], filenames = new Set(), validator = createBrowserDeltaHistoryValidator({ checkpointInterval, ...limits });
  let lastId = -1, frameBytes = 0, lastPoint, sinceCheckpoint = 0;
  for (const [index, entry] of entries.entries()) {
    validateEntry(entry);
    if (entry.id <= lastId || entry.id >= manifest.nextId || entry.index !== index || filenames.has(entry.file)) throw new Error('Invalid committed entry');
    filenames.add(entry.file); lastId = entry.id;
    const frame = await read(entry.file, limits.maxFrameBytes);
    const { metadata: meta, point } = await validator.append(frame, { expectedFrameHash: entry.sha256 });
    if (meta.index !== index || meta.checkpointInterval !== checkpointInterval) throw new Error('Committed frame metadata mismatch');
    metadata.push(meta); frameBytes += frame.length; lastPoint = point;
    sinceCheckpoint = meta.kind === 'checkpoint' ? 0 : sinceCheckpoint + 1;
    await onPoint?.(entry, meta, point, manifest);
  }
  return { manifest, entries, indices, metadata, frameBytes, lastPoint, sinceCheckpoint, manifestFile: ref.manifest, manifestHash: ref.sha256, manifestBytes: bytes.length, indexBytes: totalBytes - bytes.length, pointerBytes: pointer.length, markerBytes: marker.length };
}
async function newIndex(entries, previous) {
  const bytes = encode({ version: 2, entries, previous });
  if (bytes.length > MAX_INDEX_BYTES) throw new RangeError('Index byte limit exceeded');
  return { ...await refFor(filename('index'), bytes), bytes };
}
async function rebuildIndex(entries) {
  const indices = []; let indexRoot = null;
  for (let start = 0; start < entries.length; start += INDEX_ENTRIES) {
    const index = await newIndex(entries.slice(start, start + INDEX_ENTRIES), indexRoot);
    indices.push(index); indexRoot = { file: index.file, sha256: index.sha256 };
  }
  return { indices, indexRoot };
}
async function planFor(manifest, frames, indices = [], indexBytes = 0) {
  const bytes = encode(manifest);
  if (bytes.length + indexBytes > MAX_METADATA_BYTES) throw new RangeError('Metadata byte limit exceeded');
  const manifestFile = filename('manifest');
  return [...frames, ...indices.map(({ file, bytes }) => ({ file, bytes })), { file: manifestFile, bytes }, { file: 'CURRENT', bytes: encode({ manifest: manifestFile, sha256: await browserHash(bytes) }) }, { file: 'FORMAT', bytes: FORMAT.slice() }];
}
function requestResult(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function transactionDone(transaction) { return new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error ?? new DOMException('Transaction aborted', 'AbortError')); transaction.onerror = () => {}; }); }
function missing() { const error = new Error('Missing store record'); error.code = 'NOT_FOUND'; return error; }
function validateOptions(options) {
  const checkpointInterval = options.checkpointInterval ?? 5;
  const limits = { maxFrameBytes: options.maxFrameBytes ?? 64 * 1024 * 1024, maxPayloadBytes: options.maxPayloadBytes ?? 256 * 1024 * 1024 };
  if (!safe(checkpointInterval) || checkpointInterval < 1 || !safe(limits.maxFrameBytes) || limits.maxFrameBytes < 40 || !safe(limits.maxPayloadBytes) || limits.maxPayloadBytes < 1) throw new TypeError('Invalid store options');
  return { checkpointInterval, limits };
}
function recordsReader(records) {
  if (!Array.isArray(records)) throw new TypeError('Records array required');
  const map = new Map();
  for (const record of records) {
    if (!record || typeof record.file !== 'string' || !(record.bytes instanceof Uint8Array) || map.has(record.file) || !(record.file === 'FORMAT' || record.file === 'CURRENT' || FRAME_NAME.test(record.file) || MANIFEST_NAME.test(record.file) || INDEX_NAME.test(record.file))) throw new Error('Invalid portable record');
    map.set(record.file, record.bytes.slice());
  }
  return { map, read: async (file, maxBytes = Infinity) => { const bytes = map.get(file); if (!bytes) throw missing(); if (bytes.length > maxBytes) throw new RangeError('Store record byte limit exceeded'); return bytes.slice(); } };
}
export async function restoreBrowserDeltaRecords(records, id, options = {}) {
  const { checkpointInterval, limits } = validateOptions(options), { read } = recordsReader(records);
  let restored; const state = await load(read, checkpointInterval, limits, (entry, _meta, point) => { if (entry.id === id) restored = point; });
  if (!state.entries.some(entry => entry.id === id)) throw new RangeError('Point outside retained history');
  return structuredClone(restored);
}

// Full fresh validation for portable consumers, including empty histories.
// Return only the committed live set; historic manifest links are not required
// to restore a portable snapshot.
export async function validateBrowserDeltaRecords(records, options = {}) {
  const { checkpointInterval, limits } = validateOptions(options), portable = recordsReader(records);
  const state = await load(portable.read, checkpointInterval, limits);
  const files = ['FORMAT', 'CURRENT', state.manifestFile, ...state.indices.map(index => index.file), ...state.entries.map(entry => entry.file)];
  return { generation: state.manifest.generation, checkpointInterval, ids: state.entries.map(entry => entry.id), records: files.map(file => ({ file, bytes: portable.map.get(file).slice() })) };
}

export async function exportBrowserDeltaSnapshot(store, options = {}) {
  const requested = validateOptions(options), native = snapshotExports.get(store);
  if (native && requested.checkpointInterval === native.checkpointInterval && requested.limits.maxFrameBytes === native.limits.maxFrameBytes && requested.limits.maxPayloadBytes === native.limits.maxPayloadBytes) return native.export();
  return validateBrowserDeltaRecords(await store.exportRecords(), options);
}

export async function createBrowserDeltaStore(options = {}) {
  const { name, faultInjector: fault } = options, { checkpointInterval, limits } = validateOptions(options);
  if (typeof name !== 'string' || !name.length || name.length > 256) throw new TypeError('IndexedDB name required');
  if (fault !== undefined && typeof fault !== 'function') throw new TypeError('faultInjector must be a function');
  if (!globalThis.indexedDB || !globalThis.navigator?.locks?.request || !globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID || !globalThis.CompressionStream || !globalThis.DecompressionStream) throw new Error('IndexedDB, Web Locks, native WebCrypto and gzip streams are required');
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => { request.result.createObjectStore('records', { keyPath: 'file' }); };
  const db = await requestResult(request);
  let closed = false, queue = Promise.resolve();
  const counters = { operations: 0, commits: 0, abortedTransactions: 0, recordWrites: 0, bytesWritten: 0, recordDeletes: 0 };
  let transactionDurability = 'unobserved';
  db.onversionchange = () => { closed = true; db.close(); };
  async function read(file, maxBytes = Infinity) {
    const tx = db.transaction('records', 'readonly'), done = transactionDone(tx);
    const record = await requestResult(tx.objectStore('records').get(file)); await done;
    if (!record) throw missing();
    if (record.file !== file || !(record.bytes instanceof Uint8Array)) throw new Error('Invalid store record');
    if (record.bytes.length > maxBytes) throw new RangeError('Store record byte limit exceeded');
    return record.bytes;
  }
  async function keys() { const tx = db.transaction('records', 'readonly'), done = transactionDone(tx); const result = await requestResult(tx.objectStore('records').getAllKeys()); await done; return result; }
  async function committedSnapshot(allowEmpty) {
    // No hashing or compression inside this transaction. Promise continuations
    // only enqueue the next IDB request in the same task while it is active.
    const tx = db.transaction('records', 'readonly'), done = transactionDone(tx), objectStore = tx.objectStore('records'), map = new Map();
    async function get(file, maxBytes, optional = false) {
      if (map.has(file)) return map.get(file);
      const record = await requestResult(objectStore.get(file));
      if (!record) { if (optional) return undefined; throw missing(); }
      if (record.file !== file || !(record.bytes instanceof Uint8Array)) throw new Error('Invalid store record');
      if (record.bytes.length > maxBytes) throw new RangeError('Store record byte limit exceeded');
      map.set(file, record.bytes); return record.bytes;
    }
    try {
      const marker = await get('FORMAT', 128, true), pointer = await get('CURRENT', 1024, true);
      if (!pointer) { if (marker || !allowEmpty) throw new Error('Missing committed CURRENT'); }
      else {
        const ref = parse(pointer);
        if (!ref || typeof ref.manifest !== 'string' || !MANIFEST_NAME.test(ref.manifest)) throw new Error('Invalid CURRENT');
        const bytes = await get(ref.manifest, MAX_METADATA_BYTES), manifest = parse(bytes); validateManifest(manifest, checkpointInterval);
        let indexRef = manifest.indexRoot, metadataBytes = bytes.length, count = 0; const indexNames = new Set(), frameNames = [];
        while (indexRef) {
          if (!validIndexRef(indexRef) || indexNames.has(indexRef.file) || indexNames.size >= manifest.entryCount) throw new Error('Invalid index history'); indexNames.add(indexRef.file);
          const indexBytes = await get(indexRef.file, MAX_INDEX_BYTES); metadataBytes += indexBytes.length;
          if (metadataBytes > MAX_METADATA_BYTES) throw new RangeError('Metadata byte limit exceeded');
          const node = parse(indexBytes);
          if (!node || node.version !== 2 || !Array.isArray(node.entries) || !node.entries.length || node.entries.length > INDEX_ENTRIES || (node.previous !== null && !validIndexRef(node.previous))) throw new Error('Invalid index segment');
          for (const entry of node.entries) { validateEntry(entry); frameNames.push(entry.file); }
          count += node.entries.length; if (count > manifest.entryCount) throw new Error('Invalid index entry count'); indexRef = node.previous;
        }
        if (count !== manifest.entryCount) throw new Error('Invalid index entry count');
        for (const file of frameNames) await get(file, limits.maxFrameBytes);
      }
      await done;
    } catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
    return { map, read: async (file, maxBytes = Infinity) => { const bytes = map.get(file); if (!bytes) throw missing(); if (bytes.length > maxBytes) throw new RangeError('Store record byte limit exceeded'); return bytes; } };
  }
  async function mutate(operation, generation, records = [], deletions = [], expected = new Map()) {
    const gc = operation === 'gc', before = gc ? 'before-gc-commit' : 'before-commit', after = gc ? 'after-gc-commit' : 'after-commit';
    const context = { operation, generation, committed: false, durable: false };
    await fault?.(before, context);
    const tx = db.transaction('records', 'readwrite', { durability: 'strict' });
    transactionDurability = tx.durability ?? 'default';
    const done = transactionDone(tx); let hookError;
    function syncHook(phase) {
      const result = fault?.(phase, { ...context, transaction: tx });
      if (result && typeof result.then === 'function') { result.catch(() => {}); throw new TypeError('In-transaction fault hooks must be synchronous'); }
    }
    function enqueueWrites() {
      try {
        const objectStore = tx.objectStore('records');
        for (const record of records) objectStore.put(record);
        for (const file of deletions) objectStore.delete(file);
        syncHook(gc ? 'gc-transaction-enqueued' : 'transaction-enqueued');
      } catch (error) { hookError = error; try { tx.abort(); } catch {} }
    }
    try {
      if (transactionDurability !== 'strict') throw new Error('IndexedDB strict durability is required');
      syncHook(gc ? 'gc-transaction-started' : 'transaction-started');
      // Compare every validated live record, including CURRENT, inside the
      // write transaction. A raw writer between validation and commit aborts it.
      let remaining = expected.size;
      if (!remaining) enqueueWrites();
      for (const [file, bytes] of expected) {
        const request = tx.objectStore('records').get(file);
        request.onsuccess = () => {
          try {
            if (!request.result || !(request.result.bytes instanceof Uint8Array) || !bytesEqual(request.result.bytes, bytes)) throw new Error('Committed records changed during operation');
            if (--remaining === 0) enqueueWrites();
          } catch (error) { hookError = error; try { tx.abort(); } catch {} }
        };
      }
    } catch (error) { hookError = error; try { tx.abort(); } catch {} }
    try { await done; } catch (error) { counters.abortedTransactions++; throw hookError ?? error; }
    counters.commits++; counters.recordWrites += records.length; counters.bytesWritten += records.reduce((sum, record) => sum + record.bytes.length, 0); counters.recordDeletes += deletions.length;
    try { await fault?.(after, { ...context, committed: true }); }
    catch (error) { error.committed = true; error.durable = false; error.commitUnknown = false; throw error; }
  }
  function operation(kind, task, onPoint) {
    if (closed) return Promise.reject(new Error('Store is closed'));
    const run = () => navigator.locks.request(`tabwerk-delta-store:${name}`, { mode: 'exclusive' }, async () => {
      if (closed) throw new Error('Store is closed');
      const snapshot = await committedSnapshot(kind === 'open');
      const state = await load(snapshot.read, checkpointInterval, limits, onPoint, kind === 'open');
      state.snapshot = snapshot;
      await fault?.('locked', { operation: kind, generation: state.manifest.generation, committed: false, durable: false });
      counters.operations++;
      try { return await task(state); }
      catch (error) { if (!('committed' in error)) error.committed = false; if (!('durable' in error)) error.durable = false; if (!('commitUnknown' in error)) error.commitUnknown = false; throw error; }
    });
    const pending = queue.then(run, run); queue = pending.catch(() => {}); return pending;
  }
  const previous = state => ({ manifest: state.manifestFile, sha256: state.manifestHash });
  const liveFiles = state => ['FORMAT', 'CURRENT', state.manifestFile, ...state.indices.map(index => index.file), ...state.entries.map(entry => entry.file)];
  try { await operation('open', async state => { if (!state.manifestFile) await mutate('open', 0, await planFor(state.manifest, []), [], state.snapshot.map); }); }
  catch (error) { db.close(); throw error; }
  const api = {
    name,
    append(point) {
      let snapshot;
      try { snapshot = snapshotBrowserDeltaPoint(point); } catch (error) { return Promise.reject(error); }
      return operation('append', async state => {
        const { manifest, entries, indices, metadata } = state;
        if (!safe(manifest.nextId + 1) || !safe(manifest.generation + 1)) throw new RangeError('Store IDs exhausted');
        const writer = createBrowserDeltaArchive({ checkpointInterval, startIndex: entries.length, ...(entries.length ? { resume: { point: state.lastPoint, frameHash: metadata.at(-1).frameHash, sinceCheckpoint: state.sinceCheckpoint } } : {}) });
        const bytes = await writer.append(snapshot); await inspectBrowserDeltaFrame(bytes, limits);
        const id = manifest.nextId, file = filename('frame'), entry = { id, index: entries.length, file, sha256: await browserHash(bytes) }, tail = indices[0];
        const index = tail && tail.node.entries.length < INDEX_ENTRIES ? await newIndex([...tail.node.entries, entry], tail.node.previous) : await newIndex([entry], manifest.indexRoot);
        const next = { ...manifest, generation: manifest.generation + 1, nextId: id + 1, entryCount: entries.length + 1, indexRoot: { file: index.file, sha256: index.sha256 }, previous: previous(state) };
        const indexBytes = state.indexBytes + index.bytes.length - (tail && tail.node.entries.length < INDEX_ENTRIES ? tail.bytes : 0);
        await mutate('append', next.generation, await planFor(next, [{ file, bytes }], [index], indexBytes), [], state.snapshot.map); return id;
      });
    },
    list() { return operation('list', async state => state.entries.map(entry => entry.id)); },
    restore(id) {
      let restored;
      return operation('restore', async state => {
        if (!state.entries.some(entry => entry.id === id)) throw new RangeError('Point outside retained history');
        // The single fresh validation pass has checked every historical frame,
        // including frames after this point. Return only its captured snapshot.
        return structuredClone(restored);
      }, (entry, _meta, point) => { if (entry.id === id) restored = point; });
    },
    retain(ids) {
      if (!Array.isArray(ids) || ids.some(id => !safe(id)) || new Set(ids).size !== ids.length) return Promise.reject(new TypeError('retain requires distinct numeric IDs'));
      const wanted = new Set(ids), writer = createBrowserDeltaArchive({ checkpointInterval }), frames = [], entries = [];
      return operation('retain', async state => {
        const kept = state.entries.filter(entry => wanted.has(entry.id)), removedIds = state.entries.filter(entry => !wanted.has(entry.id)).map(entry => entry.id);
        if (kept.length !== wanted.size) throw new RangeError('Cannot retain missing IDs');
        if (!removedIds.length) return { retainedIds: kept.map(entry => entry.id), removedIds };
        if (!safe(state.manifest.generation + 1)) throw new RangeError('Store generations exhausted');
        const { indices, indexRoot } = await rebuildIndex(entries), next = { ...state.manifest, generation: state.manifest.generation + 1, entryCount: entries.length, indexRoot, previous: previous(state) };
        await mutate('retain', next.generation, await planFor(next, frames, indices, indices.reduce((sum, index) => sum + index.bytes.length, 0)), [], state.snapshot.map);
        return { retainedIds: entries.map(entry => entry.id), removedIds };
      }, async (entry, _meta, point, manifest) => {
        if (wanted.size >= manifest.entryCount || !wanted.has(entry.id)) return;
        const bytes = await writer.append(point); await inspectBrowserDeltaFrame(bytes, limits); const file = filename('frame');
        frames.push({ file, bytes }); entries.push({ id: entry.id, index: entries.length, file, sha256: await browserHash(bytes) });
      });
    },
    gc() { return operation('gc', async state => {
      // Delete only hash-proven records linked from committed manifests. Foreign
      // or uncommitted records are never inferred to be ours from their names.
      const live = new Set(liveFiles(state)), checked = new Map(state.indices.map(index => [index.file, index])), candidates = new Map(), seen = new Set([state.manifestFile]);
      const liveHashes = new Map(state.entries.map(entry => [entry.file, entry.sha256]));
      async function candidate(file, expectedHash, limit) {
        if (candidates.has(file)) { if (candidates.get(file).sha256 !== expectedHash) throw new Error('Conflicting historic reference'); return; }
        let bytes; try { bytes = await read(file, limit); } catch (error) { if (error.code === 'NOT_FOUND') return; throw error; }
        if (await browserHash(bytes) !== expectedHash) throw new Error('Historic record hash mismatch');
        candidates.set(file, { file, sha256: expectedHash, bytes: bytes.length });
      }
      async function proveIndex(root) {
        let reference = root, upper = Infinity; const path = new Set();
        while (reference) {
          if (!validIndexRef(reference) || path.has(reference.file)) throw new Error('Invalid historic index history'); path.add(reference.file);
          let index = checked.get(reference.file);
          if (index && index.sha256 !== reference.sha256) throw new Error('Conflicting historic index reference');
          if (!index) { try { index = await readIndex(read, reference); } catch (error) { if (error.code === 'NOT_FOUND') break; throw error; } }
          if (index.node.entries.at(-1).index >= upper) throw new Error('Invalid historic index entry range'); upper = index.node.entries[0].index;
          if (checked.has(index.file)) break;
          checked.set(index.file, index);
          for (const entry of index.node.entries) {
            if (live.has(entry.file)) { if (liveHashes.get(entry.file) !== entry.sha256) throw new Error('Conflicting historic frame reference'); }
            else await candidate(entry.file, entry.sha256, limits.maxFrameBytes);
          }
          if (!live.has(index.file)) await candidate(index.file, index.sha256, MAX_INDEX_BYTES);
          reference = index.node.previous;
        }
      }
      let reference = state.manifest.previous, generation = state.manifest.generation;
      while (reference) {
        if (!MANIFEST_NAME.test(reference.manifest) || !HASH.test(reference.sha256) || seen.has(reference.manifest)) throw new Error('Invalid manifest history'); seen.add(reference.manifest);
        let bytes; try { bytes = await read(reference.manifest, MAX_METADATA_BYTES); } catch (error) { if (error.code === 'NOT_FOUND') break; throw error; }
        if (await browserHash(bytes) !== reference.sha256) throw new Error('Historic manifest hash mismatch');
        const historic = parse(bytes); validateManifest(historic, checkpointInterval);
        if (historic.generation >= generation) throw new Error('Invalid historic manifest'); generation = historic.generation;
        await proveIndex(historic.indexRoot); await candidate(reference.manifest, reference.sha256, MAX_METADATA_BYTES); reference = historic.previous;
      }
      const deletions = [...candidates.keys()], reclaimedBytes = [...candidates.values()].reduce((sum, record) => sum + record.bytes, 0);
      const expected = new Map(state.snapshot.map);
      for (const record of candidates.values()) { const bytes = await read(record.file); if (await browserHash(bytes) !== record.sha256) throw new Error('Historic records changed during GC'); expected.set(record.file, bytes); }
      if (deletions.length) await mutate('gc', state.manifest.generation, [], deletions, expected);
      return { deletedFiles: deletions.length, reclaimedBytes };
    }); },
    inspect() { return operation('inspect', async state => {
      const referenced = new Set(liveFiles(state)); let totalRecordBytes = 0, orphanBytes = 0, orphanRecords = 0, otherBytes = 0;
      const records = [];
      for (const file of await keys()) {
        const bytes = await read(file); totalRecordBytes += bytes.length; records.push({ file, byteLength: bytes.length, referenced: referenced.has(file) });
        if (!referenced.has(file)) { if (FRAME_NAME.test(file) || INDEX_NAME.test(file) || MANIFEST_NAME.test(file)) { orphanBytes += bytes.length; orphanRecords++; } else otherBytes += bytes.length; }
      }
      const referencedBytes = state.frameBytes + state.manifestBytes + state.indexBytes + state.pointerBytes + state.markerBytes;
      return { version: 2, generation: state.manifest.generation, nextId: state.manifest.nextId, checkpointInterval, ids: state.entries.map(entry => entry.id), entries: state.entries.map((entry, i) => ({ ...entry, ...state.metadata[i] })), records, accounting: { referencedFrameBytes: state.frameBytes, referencedManifestBytes: state.manifestBytes + state.indexBytes, referencedIndexBytes: state.indexBytes, currentPointerBytes: state.pointerBytes, formatBytes: state.markerBytes, referencedBytes, totalRecordBytes, orphanBytes, orphanRecords, otherBytes, physicalBytes: null }, counters: { ...counters }, transactionDurability };
    }); },
    exportRecords() { return operation('exportRecords', async state => liveFiles(state).map(file => ({ file, bytes: state.snapshot.map.get(file).slice() }))); },
    importRecords(records) {
      let portable; try { portable = recordsReader(records); } catch (error) { return Promise.reject(error); }
      return operation('importRecords', async state => {
        if (state.manifest.nextId !== 0 || state.entries.length) throw new Error('Import requires an empty store');
        const imported = await load(portable.read, checkpointInterval, limits);
        const files = liveFiles(imported), records = files.map(file => ({ file, bytes: portable.map.get(file) }));
        await mutate('importRecords', imported.manifest.generation, records, [], state.snapshot.map); return imported.entries.map(entry => entry.id);
      });
    },
    async close() { closed = true; await queue; db.close(); },
  };
  snapshotExports.set(api, { checkpointInterval, limits, export: () => operation('exportSnapshot', async state => ({ generation: state.manifest.generation, checkpointInterval, ids: state.entries.map(entry => entry.id), records: liveFiles(state).map(file => ({ file, bytes: state.snapshot.map.get(file).slice() })) })) });
  return Object.freeze(api);
}
export async function importBrowserDeltaRecords(records, options = {}) {
  const store = await createBrowserDeltaStore(options);
  try { await store.importRecords(records); return store; } catch (error) { await store.close(); throw error; }
}
