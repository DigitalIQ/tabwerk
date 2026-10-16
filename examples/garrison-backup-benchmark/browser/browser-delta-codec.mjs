// Browser adapter for the experimental TJD1 format. Uses native WebCrypto and
// streaming gzip. Compression bytes may differ by runtime; decoded JSON data,
// including -0, and all frame/state/dependency integrity rules are shared.
// Decompression stops once maxPayloadBytes is crossed; one native stream chunk
// can transiently exceed that cap. SHA-256 is integrity, not authentication.
const FORMAT = 'tabwerk-structural-history';
const MAGIC = new TextEncoder().encode('TJD1');
const HEADER = 40;
const HASH = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const digest = async bytes => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', typeof bytes === 'string' ? encoder.encode(bytes) : bytes));
export const browserHash = async bytes => Array.from(await digest(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const hash = browserHash;
const equal = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
async function transform(bytes, stream, limit = Infinity) {
  // Consume concurrently so backpressure cannot deadlock the stream writer.
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new RangeError('Payload byte limit exceeded'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
const own = (object, key) => Object.hasOwn(object, key);
const integer = value => Number.isSafeInteger(value) && value >= 0;

// Eigener JSON-Serializer erhält auch -0 und lehnt stille Datenverluste durch
// undefined, Getter, toJSON, sparse Arrays oder fremde Prototypen ab.
function stringify(value, seen = new Set(), depth = 0) {
  if (depth > 128) throw new RangeError('JSON nesting exceeds 128');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? '-0' : String(value);
  if (!value || typeof value !== 'object') throw new TypeError('Only JSON data is supported');
  if (seen.has(value)) throw new TypeError('Cyclic JSON');
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new TypeError('Invalid JSON prototype');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) throw new TypeError('Symbol keys are not JSON');
  if (array && (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) throw new TypeError('Sparse or decorated array');
  seen.add(value);
  const parts = [];
  for (const key of array ? Array.from({ length: value.length }, (_, i) => String(i)) : keys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !own(descriptor, 'value')) throw new TypeError('Only own JSON data fields are supported');
    const encoded = stringify(descriptor.value, seen, depth + 1);
    parts.push(array ? encoded : `${JSON.stringify(key)}:${encoded}`);
  }
  seen.delete(value);
  return array ? `[${parts.join(',')}]` : `{${parts.join(',')}}`;
}

export function snapshotBrowserDeltaPoint(point) {
  if (!Array.isArray(point)) throw new TypeError('A point must be an export array');
  return JSON.parse(stringify(point));
}

function delta(before, after) {
  if (Object.is(before, after)) return null;
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) !== Array.isArray(after)) return ['v', after];
  if (Array.isArray(after)) {
    const edits = [];
    for (let i = 0; i < after.length; i++) {
      const patch = i < before.length ? delta(before[i], after[i]) : ['v', after[i]];
      if (patch !== null) edits.push([i, patch]);
    }
    return edits.length || before.length !== after.length ? ['a', after.length, edits] : null;
  }
  const removed = Object.keys(before).filter(key => !own(after, key)), edits = [];
  for (const key of Object.keys(after)) {
    const patch = own(before, key) ? delta(before[key], after[key]) : ['v', after[key]];
    if (patch !== null) edits.push([key, patch]);
  }
  return removed.length || edits.length ? ['o', removed, edits] : null;
}

function apply(before, patch) {
  if (patch === null) return before;
  if (!Array.isArray(patch)) throw new Error('Invalid delta');
  if (patch[0] === 'v' && patch.length === 2) return patch[1];
  const array = patch[0] === 'a';
  if (patch.length !== 3 || (!array && patch[0] !== 'o') || !before || typeof before !== 'object' || Array.isArray(before) !== array || !Array.isArray(patch[2])) throw new Error('Invalid structural delta');
  let result;
  if (array) {
    if (!integer(patch[1]) || patch[1] > 0xffffffff) throw new Error('Invalid array length');
    // Every new slot needs its own replacement edit. Reject impossible sparse
    // growth before allocating an attacker-chosen array length.
    if (patch[1] > before.length + patch[2].length) throw new Error('Invalid sparse array delta');
    result = before.slice(0, patch[1]); result.length = patch[1];
  } else {
    if (!Array.isArray(patch[1]) || patch[1].some(key => typeof key !== 'string' || !own(before, key)) || new Set(patch[1]).size !== patch[1].length) throw new Error('Invalid object deletions');
    result = Object.fromEntries(Object.entries(before));
    for (const key of patch[1]) delete result[key];
  }
  const seen = new Set();
  for (const entry of patch[2]) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid delta entry');
    const [key, child] = entry;
    if (array ? !integer(key) || key >= result.length : typeof key !== 'string' || patch[1].includes(key)) throw new Error('Invalid delta key');
    if (seen.has(key) || (!own(before, key) && (!Array.isArray(child) || child[0] !== 'v'))) throw new Error('Duplicate or missing delta base');
    seen.add(key);
    Object.defineProperty(result, key, { value: apply(before[key], child), writable: true, enumerable: true, configurable: true });
  }
  return result;
}

async function pack(envelope) {
  const compressed = await transform(encoder.encode(stringify(envelope)), new CompressionStream('gzip'));
  if (compressed.length > 0xffffffff) throw new RangeError('Frame length exceeds uint32');
  const result = new Uint8Array(HEADER + compressed.length);
  result.set(MAGIC); new DataView(result.buffer).setUint32(4, compressed.length);
  result.set(await digest(compressed), 8); result.set(compressed, HEADER);
  return result;
}

async function unpack(bytes, { maxFrameBytes = 64 * 1024 * 1024, maxPayloadBytes = 256 * 1024 * 1024 } = {}) {
  if (!integer(maxFrameBytes) || maxFrameBytes < HEADER || !integer(maxPayloadBytes) || maxPayloadBytes < 1) throw new TypeError('Invalid decode limits');
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Frame bytes required');
  const buffer = new Uint8Array(bytes); // Also copies Node Buffer subarrays.
  if (buffer.length > maxFrameBytes) throw new RangeError('Frame byte limit exceeded');
  if (buffer.length < HEADER || !equal(buffer.subarray(0, 4), MAGIC) || new DataView(buffer.buffer).getUint32(4) !== buffer.length - HEADER) throw new Error('Invalid frame header or length');
  const compressed = buffer.subarray(HEADER);
  if (!equal(buffer.subarray(8, HEADER), await digest(compressed))) throw new Error('Frame integrity mismatch');
  const envelope = JSON.parse(decoder.decode(await transform(compressed, new DecompressionStream('gzip'), maxPayloadBytes)));
  const keys = ['format', 'version', 'index', 'base', 'baseHash', 'stateHash', 'checkpointInterval', 'kind', 'payload'];
  if (!envelope || Object.keys(envelope).length !== keys.length || keys.some(key => !own(envelope, key)) || envelope.format !== FORMAT || envelope.version !== 1 || !integer(envelope.index) || !integer(envelope.checkpointInterval) || envelope.checkpointInterval < 1 || !HASH.test(envelope.stateHash)) throw new Error('Invalid frame envelope');
  if (envelope.kind === 'checkpoint') {
    if (envelope.base !== null || envelope.baseHash !== null || !Array.isArray(envelope.payload)) throw new Error('Invalid checkpoint');
  } else if (envelope.kind !== 'delta' || envelope.base !== envelope.index - 1 || !integer(envelope.base) || !HASH.test(envelope.baseHash)) throw new Error('Invalid delta dependency');
  return envelope;
}

export async function inspectBrowserDeltaFrame(bytes, limits = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Frame bytes required');
  bytes = new Uint8Array(bytes);
  const { payload, ...metadata } = await unpack(bytes, limits);
  return { ...metadata, byteLength: bytes.byteLength, frameHash: await hash(bytes) };
}

// Ein Durchlauf über eine zusammenhängende History. Jeder Frame wird genau
// einmal entpackt und jeder State einmal geprüft. Unveränderte Teilbäume können
// sich die gefrorenen Snapshots teilen; der Validator hält nur den letzten.
export function createBrowserDeltaHistoryValidator({ startIndex = 0, checkpointInterval, ...limits } = {}) {
  if (!integer(startIndex) || (checkpointInterval !== undefined && (!integer(checkpointInterval) || checkpointInterval < 1))) throw new TypeError('Invalid history options');
  let nextIndex = startIndex, previous, previousHash, chainLength = 0, interval = checkpointInterval, queue = Promise.resolve();
  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  }
  return Object.freeze({
    append(bytes, { expectedFrameHash } = {}) {
      if (!(bytes instanceof Uint8Array)) return Promise.reject(new TypeError('Frame bytes required'));
      bytes = new Uint8Array(bytes);
      const run = async () => {
      const frameHash = await hash(bytes);
      if (expectedFrameHash !== undefined && frameHash !== expectedFrameHash) throw new Error('History frame hash mismatch');
      const { payload, ...metadata } = await unpack(bytes, limits);
      if (metadata.index !== nextIndex) throw new Error('Missing or reordered frame');
      const expectedInterval = interval ?? metadata.checkpointInterval;
      if (metadata.checkpointInterval !== expectedInterval) throw new Error('Checkpoint replay bound exceeded');
      const length = metadata.kind === 'checkpoint' ? 1 : chainLength + 1;
      if (length > expectedInterval) throw new Error('Checkpoint replay bound exceeded');
      let point;
      if (metadata.kind === 'checkpoint') point = payload;
      else {
        if (previous === undefined) throw new Error('Missing dependency checkpoint');
        if (metadata.baseHash !== previousHash) throw new Error('Dependency integrity mismatch');
        point = apply(previous, payload);
      }
      if (!Array.isArray(point) || (await hash(stringify(point))) !== metadata.stateHash) throw new Error('Reconstructed state integrity mismatch');
      point = freeze(point);
      previous = point; previousHash = frameHash; chainLength = length;
      interval = expectedInterval; nextIndex++;
      return { metadata: { ...metadata, byteLength: bytes.byteLength, frameHash }, point };
      };
      const pending = queue.then(run, run); queue = pending.catch(() => {}); return pending;
    },
  });
}

export function createBrowserDeltaArchive({ checkpointInterval = 5, startIndex = 0, resume } = {}) {
  if (!integer(checkpointInterval) || checkpointInterval < 1 || !integer(startIndex)) throw new TypeError('Invalid archive options');
  let previous, previousHash, nextIndex = startIndex, sinceCheckpoint = checkpointInterval;
  if (resume !== undefined) {
    if (!resume || !Array.isArray(resume.point) || !HASH.test(resume.frameHash) || !integer(resume.sinceCheckpoint) || resume.sinceCheckpoint >= checkpointInterval || startIndex < 1) throw new TypeError('Invalid writer resume');
    previous = JSON.parse(stringify(resume.point)); previousHash = resume.frameHash; sinceCheckpoint = resume.sinceCheckpoint;
  }
  let queue = Promise.resolve();
  return Object.freeze({
    checkpointInterval,
    get nextIndex() { return nextIndex; },
    append(point) {
      let serialized;
      try { if (!Array.isArray(point)) throw new TypeError('A point must be an export array'); serialized = stringify(point); } catch (error) { return Promise.reject(error); }
      const run = async () => {
      if (!Array.isArray(point)) throw new TypeError('A point must be an export array');
      if (!Number.isSafeInteger(nextIndex + 1)) throw new RangeError('Index exhausted');
      const snapshot = JSON.parse(serialized);
      const common = { format: FORMAT, version: 1, index: nextIndex, base: null, baseHash: null, stateHash: await hash(serialized), checkpointInterval };
      const checkpoint = await pack({ ...common, kind: 'checkpoint', payload: snapshot });
      let frame = checkpoint, isCheckpoint = true;
      if (previous !== undefined && sinceCheckpoint + 1 < checkpointInterval) {
        const candidate = await pack({ ...common, base: nextIndex - 1, baseHash: previousHash, kind: 'delta', payload: delta(previous, snapshot) });
        if (candidate.length < checkpoint.length) { frame = candidate; isCheckpoint = false; }
      }
      const frameHash = await hash(frame);
      previous = snapshot; previousHash = frameHash; nextIndex++;
      sinceCheckpoint = isCheckpoint ? 0 : sinceCheckpoint + 1;
      return frame;
      };
      const pending = queue.then(run, run); queue = pending.catch(() => {}); return pending;
    },
  });
}

export async function restoreBrowserDeltaPoint(frames, index, { startIndex = 0, ...limits } = {}) {
  if (!Array.isArray(frames) || !integer(index) || !integer(startIndex) || index < startIndex || index - startIndex >= frames.length) throw new RangeError('Point outside retained history');
  const chain = [];
  let cursor = index, interval;
  while (true) {
    if (cursor < startIndex) throw new Error('Missing dependency checkpoint');
    const source = frames[cursor - startIndex];
    if (!(source instanceof Uint8Array)) throw new TypeError('Frame bytes required');
    const bytes = new Uint8Array(source), envelope = await unpack(bytes, limits);
    if (envelope.index !== cursor) throw new Error('Missing or reordered frame');
    interval ??= envelope.checkpointInterval;
    if (envelope.checkpointInterval !== interval || chain.length >= interval) throw new Error('Checkpoint replay bound exceeded');
    chain.push({ bytes, envelope });
    if (envelope.kind === 'checkpoint') break;
    cursor--;
  }
  let point, previousHash;
  for (const { bytes, envelope } of chain.reverse()) {
    if (envelope.kind === 'checkpoint') point = envelope.payload;
    else {
      if (envelope.baseHash !== previousHash) throw new Error('Dependency integrity mismatch');
      point = apply(point, envelope.payload);
    }
    if (!Array.isArray(point) || (await hash(stringify(point))) !== envelope.stateHash) throw new Error('Reconstructed state integrity mismatch');
    previousHash = await hash(bytes);
  }
  return point;
}
