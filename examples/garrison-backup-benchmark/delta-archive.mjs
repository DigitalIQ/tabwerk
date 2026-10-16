import { createHash, timingSafeEqual } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

// Experimentelles lokales Format, unabhängig vom veröffentlichten Session-Codec.
// API: createDeltaArchive({checkpointInterval=5,startIndex=0}).append(point)
// gibt ausschließlich einen neuen Buffer zurück. Der Writer hält nur den letzten
// Punkt. Buffer sind im Aufrufer unveränderlich zu behandeln und separat abzulegen.
// restoreDeltaPoint(frames,index,{startIndex=0}) liest höchstens interval Frames.
// Restore und inspectDeltaFrame akzeptieren maxFrameBytes (Default 64 MiB) und
// maxPayloadBytes (Default 256 MiB, entpacktes Envelope). Größere gültige Punkte
// brauchen explizit höhere Leselimits. Object-Keys werden kanonisch sortiert.
// frames ist eine zusammenhängende Liste. Retention darf nur vor einem Checkpoint
// schneiden; startIndex benennt dann dessen ursprünglichen Index. Kein Rebase.
// inspectDeltaFrame(bytes) liefert Metadaten ohne Payload. Speichermaß ist die
// Summe der Buffer.byteLength, einschließlich aller Header und Index-Metadaten.
// Es gibt keinen versteckten persistenten Index, keine Dateinamen/FS-Overhead-
// Modellierung, keine Transaktionen und keine Authentizitätsgarantie durch SHA-256.
const FORMAT = 'tabwerk-structural-history';
const MAGIC = Buffer.from('TJD1');
const HEADER = 40;
const HASH = /^[a-f0-9]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest();
const hash = bytes => digest(bytes).toString('hex');
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

function pack(envelope) {
  const compressed = gzipSync(Buffer.from(stringify(envelope)), { level: 6 });
  const header = Buffer.alloc(HEADER);
  MAGIC.copy(header); header.writeUInt32BE(compressed.length, 4); digest(compressed).copy(header, 8);
  return Buffer.concat([header, compressed]);
}

function unpack(bytes, { maxFrameBytes = 64 * 1024 * 1024, maxPayloadBytes = 256 * 1024 * 1024 } = {}) {
  if (!integer(maxFrameBytes) || maxFrameBytes < HEADER || !integer(maxPayloadBytes) || maxPayloadBytes < 1) throw new TypeError('Invalid decode limits');
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Frame bytes required');
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length > maxFrameBytes) throw new RangeError('Frame byte limit exceeded');
  if (buffer.length < HEADER || !buffer.subarray(0, 4).equals(MAGIC) || buffer.readUInt32BE(4) !== buffer.length - HEADER) throw new Error('Invalid frame header or length');
  const compressed = buffer.subarray(HEADER);
  if (!timingSafeEqual(buffer.subarray(8, HEADER), digest(compressed))) throw new Error('Frame integrity mismatch');
  const envelope = JSON.parse(gunzipSync(compressed, { maxOutputLength: maxPayloadBytes }));
  const keys = ['format', 'version', 'index', 'base', 'baseHash', 'stateHash', 'checkpointInterval', 'kind', 'payload'];
  if (!envelope || Object.keys(envelope).length !== keys.length || keys.some(key => !own(envelope, key)) || envelope.format !== FORMAT || envelope.version !== 1 || !integer(envelope.index) || !integer(envelope.checkpointInterval) || envelope.checkpointInterval < 1 || !HASH.test(envelope.stateHash)) throw new Error('Invalid frame envelope');
  if (envelope.kind === 'checkpoint') {
    if (envelope.base !== null || envelope.baseHash !== null || !Array.isArray(envelope.payload)) throw new Error('Invalid checkpoint');
  } else if (envelope.kind !== 'delta' || envelope.base !== envelope.index - 1 || !integer(envelope.base) || !HASH.test(envelope.baseHash)) throw new Error('Invalid delta dependency');
  return envelope;
}

export function inspectDeltaFrame(bytes, limits = {}) {
  const { payload, ...metadata } = unpack(bytes, limits);
  return { ...metadata, byteLength: bytes.byteLength, frameHash: hash(bytes) };
}

// Ein Durchlauf über eine zusammenhängende History. Jeder Frame wird genau
// einmal entpackt und jeder State einmal geprüft. Unveränderte Teilbäume können
// sich die gefrorenen Snapshots teilen; der Validator hält nur den letzten.
export function createDeltaHistoryValidator({ startIndex = 0, checkpointInterval, ...limits } = {}) {
  if (!integer(startIndex) || (checkpointInterval !== undefined && (!integer(checkpointInterval) || checkpointInterval < 1))) throw new TypeError('Invalid history options');
  let nextIndex = startIndex, previous, previousHash, chainLength = 0, interval = checkpointInterval;
  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  }
  return Object.freeze({
    append(bytes, { expectedFrameHash } = {}) {
      const frameHash = hash(bytes);
      if (expectedFrameHash !== undefined && frameHash !== expectedFrameHash) throw new Error('History frame hash mismatch');
      const { payload, ...metadata } = unpack(bytes, limits);
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
      if (!Array.isArray(point) || hash(stringify(point)) !== metadata.stateHash) throw new Error('Reconstructed state integrity mismatch');
      point = freeze(point);
      previous = point; previousHash = frameHash; chainLength = length;
      interval = expectedInterval; nextIndex++;
      return { metadata: { ...metadata, byteLength: bytes.byteLength, frameHash }, point };
    },
  });
}

export function createDeltaArchive({ checkpointInterval = 5, startIndex = 0 } = {}) {
  if (!integer(checkpointInterval) || checkpointInterval < 1 || !integer(startIndex)) throw new TypeError('Invalid archive options');
  let previous, previousHash, nextIndex = startIndex, sinceCheckpoint = checkpointInterval;
  return Object.freeze({
    checkpointInterval,
    get nextIndex() { return nextIndex; },
    append(point) {
      if (!Array.isArray(point)) throw new TypeError('A point must be an export array');
      if (!Number.isSafeInteger(nextIndex + 1)) throw new RangeError('Index exhausted');
      const serialized = stringify(point), snapshot = JSON.parse(serialized);
      const common = { format: FORMAT, version: 1, index: nextIndex, base: null, baseHash: null, stateHash: hash(serialized), checkpointInterval };
      const checkpoint = pack({ ...common, kind: 'checkpoint', payload: snapshot });
      let frame = checkpoint, isCheckpoint = true;
      if (previous !== undefined && sinceCheckpoint + 1 < checkpointInterval) {
        const candidate = pack({ ...common, base: nextIndex - 1, baseHash: previousHash, kind: 'delta', payload: delta(previous, snapshot) });
        if (candidate.length < checkpoint.length) { frame = candidate; isCheckpoint = false; }
      }
      previous = snapshot; previousHash = hash(frame); nextIndex++;
      sinceCheckpoint = isCheckpoint ? 0 : sinceCheckpoint + 1;
      return frame;
    },
  });
}

export function restoreDeltaPoint(frames, index, { startIndex = 0, ...limits } = {}) {
  if (!Array.isArray(frames) || !integer(index) || !integer(startIndex) || index < startIndex || index - startIndex >= frames.length) throw new RangeError('Point outside retained history');
  const chain = [];
  let cursor = index, interval;
  while (true) {
    if (cursor < startIndex) throw new Error('Missing dependency checkpoint');
    const bytes = frames[cursor - startIndex], envelope = unpack(bytes, limits);
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
    if (!Array.isArray(point) || hash(stringify(point)) !== envelope.stateHash) throw new Error('Reconstructed state integrity mismatch');
    previousHash = hash(bytes);
  }
  return point;
}
