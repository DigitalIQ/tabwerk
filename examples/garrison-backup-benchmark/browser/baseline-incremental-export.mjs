import { browserHash } from './browser-delta-codec.mjs';
import { exportBrowserDeltaSnapshot, restoreBrowserDeltaRecords, validateBrowserDeltaRecords } from './browser-delta-store.mjs';

// Experimental portable transport. Hashes detect corruption, not an attacker
// who can rewrite a package and its chain. State and packets use canonical JSON
// with base64 record bytes, so their encoding overhead remains measurable.
// Persist prepare().stateBytes BEFORE delivering packet. Acknowledge only after
// the exact packet file has been saved. Persist the returned ACK state as well.
// The sender inventory is O(live records); a pending packet is persisted too.
// Packet metadata contains only changes, never another full live inventory.
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const HASH = /^[0-9a-f]{64}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD = /^(?:FORMAT|CURRENT|(?:frame-[0-9a-f-]{36}\.bin)|(?:(?:manifest|index)-[0-9a-f-]{36}\.json))$/;
const safe = value => Number.isSafeInteger(value) && value >= 0;
const encode = value => encoder.encode(JSON.stringify(value));
const equal = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const hash = value => typeof value === 'string' && HASH.test(value);
const clone = value => structuredClone(value);
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== expected.slice().sort().join(',')) throw new Error('Invalid incremental metadata fields');
}
function canonical(bytes, maxBytes = Infinity) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Incremental bytes required');
  if (bytes.length > maxBytes) throw new RangeError('Incremental byte limit exceeded');
  let result;
  try { result = JSON.parse(decoder.decode(bytes)); } catch { throw new Error('Invalid incremental JSON'); }
  if (!equal(encode(result), bytes)) throw new Error('Non-canonical incremental JSON');
  return result;
}
function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}
function unbase64(text, maxBytes = Infinity) {
  if (typeof text === 'string' && Math.floor(text.length / 4) * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0) > maxBytes) throw new RangeError('Incremental record byte limit exceeded');
  // A repeated quartet group overflows RegExp stacks on large valid exports.
  // atob plus the canonical re-encode below verifies the padding's unused bits.
  if (typeof text !== 'string' || text.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('Invalid incremental base64');
  const decoded = Uint8Array.from(atob(text), char => char.charCodeAt(0));
  if (base64(decoded) !== text) throw new Error('Non-canonical incremental base64');
  return decoded;
}
function validTarget(target) {
  keys(target, ['generation', 'currentSha256']);
  if (!safe(target.generation) || !hash(target.currentSha256)) throw new Error('Invalid incremental target');
}
function sameTarget(a, b) { return a === null ? b === null : b !== null && a.generation === b.generation && a.currentSha256 === b.currentSha256; }
function receiptFor(packet, digest) { return { sequence: packet.sequence, sha256: digest }; }
function sameReceipt(a, b) { return a && b && a.sequence === b.sequence && a.sha256 === b.sha256; }
async function seal(kind, payload, limits) {
  const bytes = encode({ version: 1, kind, payload, sha256: await browserHash(encode(payload)) });
  if (bytes.length > limits.maxStateBytes) throw new RangeError('Incremental state byte limit exceeded');
  return bytes;
}
async function unseal(bytes, kind, limits) {
  const state = canonical(bytes, limits.maxStateBytes); keys(state, ['version', 'kind', 'payload', 'sha256']);
  if (state.version !== 1 || state.kind !== kind || !hash(state.sha256) || await browserHash(encode(state.payload)) !== state.sha256) throw new Error('Incremental state checksum mismatch');
  return state.payload;
}
function validInventory(inventory) {
  if (!Array.isArray(inventory)) throw new Error('Invalid sender inventory');
  const names = new Set();
  for (const item of inventory) {
    keys(item, ['file', 'sha256']);
    if (typeof item.file !== 'string' || !RECORD.test(item.file) || !hash(item.sha256) || names.has(item.file)) throw new Error('Invalid sender inventory');
    names.add(item.file);
  }
}
function transportLimits(options) {
  const limits = { maxPacketBytes: options.maxPacketBytes ?? 512 * 1024 * 1024, maxStateBytes: options.maxStateBytes ?? 1024 * 1024 * 1024, maxFrameBytes: options.maxFrameBytes ?? 64 * 1024 * 1024 };
  if (Object.values(limits).some(value => !safe(value) || !value)) throw new TypeError('Invalid incremental limits');
  return limits;
}
function recordLimit(file, limits) { return file.startsWith('frame-') ? limits.maxFrameBytes : 64 * 1024 * 1024; }
function snapshotBytes(bytes, limit) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Incremental bytes required');
  if (bytes.length > limit) throw new RangeError('Incremental byte limit exceeded');
  return bytes.slice();
}
async function packetInfo(bytes, limits) {
  const packet = canonical(bytes, limits.maxPacketBytes);
  keys(packet, ['version', 'kind', 'stream', 'sequence', 'previous', 'base', 'target', 'upserts', 'deletes']);
  if (packet.version !== 1 || packet.kind !== 'tabwerk-incremental' || typeof packet.stream !== 'string' || !UUID.test(packet.stream) || !safe(packet.sequence) || packet.sequence < 1 || (packet.sequence === 1 ? packet.previous !== null || packet.base !== null : !hash(packet.previous) || packet.base === null)) throw new Error('Invalid incremental packet chain');
  validTarget(packet.target);
  if (packet.base !== null) { validTarget(packet.base); if (packet.target.generation <= packet.base.generation) throw new Error('Incremental generation did not advance'); }
  if (!Array.isArray(packet.upserts) || !Array.isArray(packet.deletes)) throw new Error('Invalid incremental changes');
  const names = new Set(), records = [];
  let recordPayloadBytes = 0, recordEncodingBytes = 0;
  for (const item of packet.upserts) {
    keys(item, ['file', 'sha256', 'data']);
    if (typeof item.file !== 'string' || !RECORD.test(item.file) || !hash(item.sha256) || names.has(item.file)) throw new Error('Invalid incremental upsert');
    const data = unbase64(item.data, recordLimit(item.file, limits));
    if (await browserHash(data) !== item.sha256) throw new Error('Incremental record checksum mismatch');
    names.add(item.file); records.push({ file: item.file, bytes: data }); recordPayloadBytes += data.length; recordEncodingBytes += item.data.length;
  }
  for (const file of packet.deletes) {
    if (typeof file !== 'string' || !RECORD.test(file) || names.has(file) || file === 'CURRENT' || file === 'FORMAT') throw new Error('Invalid incremental delete');
    names.add(file);
  }
  if (!packet.upserts.some(item => item.file === 'CURRENT') || (packet.sequence === 1 && (packet.deletes.length || !packet.upserts.some(item => item.file === 'FORMAT')))) throw new Error('Incomplete incremental packet');
  return { packet, records, digest: await browserHash(bytes), recordPayloadBytes, recordEncodingBytes };
}
function advanceInventory(inventory, packet) {
  const next = new Map(inventory.map(item => [item.file, item.sha256]));
  for (const file of packet.deletes) { if (!next.delete(file)) throw new Error('Incremental delete missing from base'); }
  for (const item of packet.upserts) {
    if (next.has(item.file) && item.file !== 'CURRENT') throw new Error('Incremental immutable record replacement');
    next.set(item.file, item.sha256);
  }
  return [...next].map(([file, sha256]) => ({ file, sha256 }));
}
function serial() {
  let queue = Promise.resolve();
  return fn => { const next = queue.then(() => fn(), () => fn()); queue = next.catch(() => {}); return next; };
}

export async function createBrowserIncrementalExporter(options = {}) {
  const { stateBytes, ...validationOptions } = options;
  const limits = transportLimits(options);
  let state = { stream: crypto.randomUUID(), sourceName: null, sequence: 0, previous: null, target: null, inventory: [], pending: null };
  if (stateBytes !== undefined) state = await unseal(snapshotBytes(stateBytes, limits.maxStateBytes), 'tabwerk-incremental-sender', limits);
  keys(state, ['stream', 'sourceName', 'sequence', 'previous', 'target', 'inventory', 'pending']);
  if (state.sourceName !== null && (typeof state.sourceName !== 'string' || !state.sourceName.length || state.sourceName.length > 256)) throw new Error('Invalid sender source name');
  if (typeof state.stream !== 'string' || !UUID.test(state.stream) || !safe(state.sequence) || (state.sequence === 0 ? state.previous !== null || state.target !== null || state.inventory.length !== 0 : !hash(state.previous) || state.target === null)) throw new Error('Invalid sender cursor');
  validInventory(state.inventory); if (state.target !== null) validTarget(state.target);
  if (state.sequence && state.inventory.find(item => item.file === 'CURRENT')?.sha256 !== state.target.currentSha256) throw new Error('Sender cursor target mismatch');
  async function pendingInfo() {
    const bytes = unbase64(state.pending, limits.maxPacketBytes), info = await packetInfo(bytes, limits), packet = info.packet;
    if (packet.stream !== state.stream || packet.sequence !== state.sequence + 1 || packet.previous !== state.previous || !sameTarget(packet.base, state.target)) throw new Error('Pending packet cursor mismatch');
    advanceInventory(state.inventory, packet);
    return { ...info, bytes };
  }
  if (state.pending !== null) await pendingInfo();
  const run = serial(), exportState = () => seal('tabwerk-incremental-sender', state, limits);
  async function result(info, unchangedRecords = null) {
    const saved = await exportState(), cursor = info ? { ...state, sequence: info.packet.sequence, previous: info.digest, target: info.packet.target, inventory: advanceInventory(state.inventory, info.packet), pending: null } : { ...state, pending: null };
    return { packet: info?.bytes.slice() ?? null, receipt: info ? receiptFor(info.packet, info.digest) : null, stateBytes: saved, stats: {
      packetBytes: info?.bytes.length ?? 0, recordPayloadBytes: info?.recordPayloadBytes ?? 0,
      recordEncodingBytes: info?.recordEncodingBytes ?? 0, packetMetadataBytes: info ? info.bytes.length - info.recordEncodingBytes : 0,
      upsertRecords: info?.packet.upserts.length ?? 0, deletedRecords: info?.packet.deletes.length ?? 0, unchangedRecords,
      acknowledgedCursorBytes: (await seal('tabwerk-incremental-sender', cursor, limits)).length,
      senderStateBytes: saved.length, pendingPacketBytes: info?.bytes.length ?? 0,
    } };
  }
  return Object.freeze({
    prepare(store) {
      const sourceName = store?.name;
      return run(async () => {
      // Even a retry observes and validates the entire current source first.
      // Its delivery still uses the previously persisted pending snapshot.
      const current = await exportBrowserDeltaSnapshot(store, validationOptions);
      if (typeof sourceName !== 'string' || !sourceName.length || sourceName.length > 256 || (state.sourceName !== null && state.sourceName !== sourceName)) throw new Error('Incremental source store differs from cursor');
      if (state.pending !== null) return result(await pendingInfo());
      const inventory = new Map(state.inventory.map(item => [item.file, item.sha256])), live = new Set(), upserts = [];
      let unchangedRecords = 0, currentSha256;
      for (const record of current.records) {
        const sha256 = await browserHash(record.bytes); live.add(record.file);
        if (record.file === 'CURRENT') currentSha256 = sha256;
        if (inventory.get(record.file) === sha256) unchangedRecords++;
        else {
          if (inventory.has(record.file) && record.file !== 'CURRENT') throw new Error('Source immutable record changed');
          upserts.push({ file: record.file, sha256, data: base64(record.bytes) });
        }
      }
      const target = { generation: current.generation, currentSha256 };
      if (sameTarget(target, state.target)) {
        if (upserts.length || live.size !== inventory.size) throw new Error('Source changed without a new generation');
        return result(null, unchangedRecords);
      }
      if (state.target && target.generation <= state.target.generation) throw new Error('Source generation rollback');
      if (!safe(state.sequence + 1)) throw new RangeError('Incremental sequences exhausted');
      const packet = { version: 1, kind: 'tabwerk-incremental', stream: state.stream, sequence: state.sequence + 1, previous: state.previous, base: state.target, target, upserts, deletes: state.inventory.filter(item => !live.has(item.file)).map(item => item.file) };
      const bytes = encode(packet), info = await packetInfo(bytes, limits);
      const next = { ...state, sourceName, pending: base64(bytes) };
      await seal('tabwerk-incremental-sender', next, limits);
      state = next;
      return result({ ...info, bytes }, unchangedRecords);
    }); },
    acknowledge(input) {
      const receipt = clone(input);
      return run(async () => {
      keys(receipt, ['sequence', 'sha256']);
      if (!safe(receipt.sequence) || receipt.sequence < 1 || !hash(receipt.sha256)) throw new Error('Invalid incremental ACK receipt');
      if (!state.pending) {
        if (sameReceipt(receipt, { sequence: state.sequence, sha256: state.previous })) return exportState();
        throw new Error('No matching pending packet');
      }
      const info = await pendingInfo();
      if (!sameReceipt(receipt, receiptFor(info.packet, info.digest))) throw new Error('ACK does not match pending packet');
      const packet = info.packet;
      const next = { stream: state.stream, sourceName: state.sourceName, sequence: packet.sequence, previous: info.digest, target: packet.target, inventory: advanceInventory(state.inventory, packet), pending: null };
      const saved = await seal('tabwerk-incremental-sender', next, limits);
      state = next;
      return saved;
    }); },
    exportState() { return run(exportState); },
  });
}

export async function createBrowserIncrementalReceiver(options = {}) {
  const { stateBytes, ...validationOptions } = options;
  const limits = transportLimits(options);
  let state = { stream: null, sequence: 0, previous: null, target: null }, records = new Map();
  if (stateBytes !== undefined) {
    const saved = await unseal(snapshotBytes(stateBytes, limits.maxStateBytes), 'tabwerk-incremental-receiver', limits); keys(saved, ['cursor', 'records']);
    state = saved.cursor; keys(state, ['stream', 'sequence', 'previous', 'target']);
    if (!safe(state.sequence) || (state.sequence === 0 ? state.stream !== null || state.previous !== null || state.target !== null : typeof state.stream !== 'string' || !UUID.test(state.stream) || !hash(state.previous) || state.target === null)) throw new Error('Invalid receiver cursor');
    if (!Array.isArray(saved.records)) throw new Error('Invalid receiver records');
    for (const item of saved.records) { keys(item, ['file', 'data']); if (typeof item.file !== 'string' || records.has(item.file)) throw new Error('Invalid receiver record'); records.set(item.file, unbase64(item.data, recordLimit(item.file, limits))); }
    if (state.sequence) {
      validTarget(state.target);
      const validated = await validateBrowserDeltaRecords([...records].map(([file, bytes]) => ({ file, bytes })), validationOptions);
      if (validated.records.length !== records.size || validated.generation !== state.target.generation || await browserHash(records.get('CURRENT')) !== state.target.currentSha256) throw new Error('Receiver state target mismatch');
    } else if (records.size) throw new Error('Uncommitted receiver records');
  }
  const run = serial();
  const recordList = () => [...records].map(([file, bytes]) => ({ file, bytes: bytes.slice() }));
  const saveState = (cursor, source) => seal('tabwerk-incremental-receiver', { cursor, records: [...source].map(([file, bytes]) => ({ file, data: base64(bytes) })) }, limits);
  const exportState = () => saveState(state, records);
  async function inspect(known) {
    const validated = known ?? (state.sequence ? await validateBrowserDeltaRecords(recordList(), validationOptions) : { ids: [] });
    return { sequence: state.sequence, generation: state.target?.generation ?? null, ids: validated.ids, recordCount: records.size, recordBytes: [...records.values()].reduce((sum, bytes) => sum + bytes.length, 0), metadataBytes: encode(state).length, stateBytes: (await exportState()).length };
  }
  return Object.freeze({
    apply(input) {
      let bytes; try { bytes = snapshotBytes(input, limits.maxPacketBytes); } catch (error) { return Promise.reject(error); }
      return run(async () => {
        const info = await packetInfo(bytes, limits), packet = info.packet, receipt = receiptFor(packet, info.digest);
        if (packet.sequence === state.sequence && info.digest === state.previous && packet.stream === state.stream) {
          // A repeated exact last package does not modify committed state.
          return { receipt, duplicate: true, stats: await inspect() };
        }
        if (packet.sequence !== state.sequence + 1 || packet.previous !== state.previous || !sameTarget(packet.base, state.target) || (state.stream !== null && packet.stream !== state.stream)) throw new Error('Incremental packet has missing, reordered or conflicting base');
        const candidate = new Map([...records].map(([file, data]) => [file, data.slice()]));
        for (const file of packet.deletes) { if (!candidate.delete(file)) throw new Error('Incremental delete missing from base'); }
        for (const record of info.records) {
          if (candidate.has(record.file) && record.file !== 'CURRENT') throw new Error('Incremental immutable record replacement');
          candidate.set(record.file, record.bytes);
        }
        const validated = await validateBrowserDeltaRecords([...candidate].map(([file, data]) => ({ file, bytes: data })), validationOptions);
        if (validated.records.length !== candidate.size || validated.generation !== packet.target.generation || await browserHash(candidate.get('CURRENT')) !== packet.target.currentSha256) throw new Error('Incremental packet target mismatch or extra records');
        // No await occurs between the two assignments. Failed validation leaves
        // all old records and metadata intact. Persist exportState atomically
        // if using this receiver as a durable online replica.
        const next = { stream: packet.stream, sequence: packet.sequence, previous: info.digest, target: packet.target };
        await saveState(next, candidate);
        records = candidate; state = next;
        return { receipt, duplicate: false, stats: await inspect(validated) };
      });
    },
    exportState() { return run(exportState); },
    exportRecords() { return recordList(); },
    restore(id) { return run(() => restoreBrowserDeltaRecords(recordList(), id, validationOptions)); },
    inspect() { return run(inspect); },
  });
}
