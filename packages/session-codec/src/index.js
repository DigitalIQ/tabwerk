import { DEFAULT_LIMITS, limitsFor, copyJson, exactKeys, windowMetadata, windowContents } from './validation.js';
import { compress, decompress } from './streams.js';

export { DEFAULT_LIMITS };
const encoder = new TextEncoder();
const HASH = /^[0-9a-f]{64}$/;
const WINDOW_KEYS = ['id', 'focused', 'incognito', 'state', 'tabs', 'groups'];

async function digest(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function encodeWindow(window, options) {
  const limits = limitsFor(options);
  const value = copyJson(window, limits);
  exactKeys(value, WINDOW_KEYS, 'window');
  windowMetadata(value);
  windowContents(value, limits);
  const body = JSON.stringify({ version: 1, tabs: value.tabs.map(({ active, ...tab }) => tab), groups: value.groups });
  const bytes = encoder.encode(body);
  if (bytes.byteLength > limits.maxDecompressedBytes) throw new RangeError('JSON byte limit exceeded');
  const hash = await digest(bytes);
  const data = await compress(bytes, limits.maxCompressedBytes);
  const ref = {
    version: 1,
    id: value.id,
    focused: value.focused,
    incognito: value.incognito,
    state: value.state,
    active: value.tabs.findIndex((tab) => tab.active),
    block: hash,
  };
  return { ref, block: { version: 1, encoding: 'gzip-base64', hash, data } };
}

export async function decodeWindow(ref, block, options) {
  const limits = limitsFor(options);
  const reference = copyJson(ref, limits);
  // The compressed envelope needs its own budget: base64 is larger than its
  // compressed bytes and is independent of the decoded JSON budget.
  const envelope = copyJson(block, { ...limits, maxDecompressedBytes: 4 * Math.ceil(limits.maxCompressedBytes / 3) + 1024 });
  exactKeys(reference, ['version', 'id', 'focused', 'incognito', 'state', 'active', 'block'], 'reference');
  exactKeys(envelope, ['version', 'encoding', 'hash', 'data'], 'block');
  if (reference.version !== 1 || envelope.version !== 1 || envelope.encoding !== 'gzip-base64') throw new TypeError('Unsupported snapshot format');
  windowMetadata(reference);
  if (!Number.isSafeInteger(reference.active) || reference.active < -1) throw new TypeError('Invalid active tab index');
  if (typeof reference.block !== 'string' || typeof envelope.hash !== 'string' || !HASH.test(reference.block) || !HASH.test(envelope.hash) || reference.block !== envelope.hash) throw new TypeError('Block reference mismatch');
  const bytes = await decompress(envelope.data, limits);
  if (await digest(bytes) !== reference.block) throw new TypeError('Block content hash mismatch');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const body = copyJson(JSON.parse(text), limits);
  exactKeys(body, ['version', 'tabs', 'groups'], 'block body');
  if (body.version !== 1) throw new TypeError('Unsupported block body version');
  windowContents(body, limits, true);
  if (reference.active >= body.tabs.length) throw new TypeError('Invalid active tab index');
  return {
    id: reference.id,
    focused: reference.focused,
    incognito: reference.incognito,
    state: reference.state,
    tabs: body.tabs.map((tab, index) => ({ ...tab, active: index === reference.active })),
    groups: body.groups,
  };
}
