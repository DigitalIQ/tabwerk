export const DEFAULT_LIMITS = Object.freeze({
  maxCompressedBytes: 2 * 1024 * 1024,
  maxDecompressedBytes: 8 * 1024 * 1024,
  maxTabs: 10000,
  maxGroups: 1000,
  maxDepth: 64,
  maxNodes: 200000,
});

const CEILINGS = Object.freeze({
  maxCompressedBytes: 256 * 1024 * 1024,
  maxDecompressedBytes: 256 * 1024 * 1024,
  maxTabs: 1000000,
  maxGroups: 1000000,
  maxDepth: 128,
  maxNodes: 1000000,
});
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const encoder = new TextEncoder();
const own = (value, key) => Object.hasOwn(value, key);

export function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`${label} must be a plain object`);
}

export function limitsFor(options = {}) {
  record(options, 'options');
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Reflect.ownKeys(options)) {
    const d = Object.getOwnPropertyDescriptor(options, key);
    if (typeof key !== 'string' || !own(DEFAULT_LIMITS, key) || !d.enumerable || !own(d, 'value')) throw new TypeError('Unknown or non-data option');
    if (!Number.isSafeInteger(d.value) || d.value < 1 || d.value > CEILINGS[key]) throw new RangeError(`Invalid ${key}`);
    limits[key] = d.value;
  }
  return limits;
}

// Copy JSON data without invoking accessors or toJSON. Sort object keys for a
// reproducible v1 representation; arrays retain their order.
export function copyJson(value, limits) {
  const ancestors = new Set();
  let nodes = 0;
  let bytes = 0;
  function charge(count) {
    bytes += count;
    if (bytes > limits.maxDecompressedBytes) throw new RangeError('JSON byte limit exceeded');
  }
  function stringBytes(s) {
    if (s.length > limits.maxDecompressedBytes) throw new RangeError('JSON byte limit exceeded');
    return encoder.encode(JSON.stringify(s)).byteLength;
  }
  function visit(item, depth) {
    if (++nodes > limits.maxNodes) throw new RangeError('JSON node limit exceeded');
    if (depth > limits.maxDepth) throw new RangeError('JSON depth limit exceeded');
    if (item === null) { charge(4); return null; }
    if (typeof item === 'string') { charge(stringBytes(item)); return item; }
    if (typeof item === 'boolean') { charge(item ? 4 : 5); return item; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('JSON numbers must be finite');
      charge(String(item).length);
      return item;
    }
    if (typeof item !== 'object') throw new TypeError('Only JSON data is supported');
    if (ancestors.has(item)) throw new TypeError('Cyclic JSON data');
    const array = Array.isArray(item);
    if (array) {
      if (Object.getPrototypeOf(item) !== Array.prototype) throw new TypeError('Arrays must have the standard prototype');
      if (item.length > limits.maxNodes) throw new RangeError('JSON node limit exceeded');
    } else record(item, 'JSON value');
    const keys = Reflect.ownKeys(item);
    if (keys.length > limits.maxNodes + 1) throw new RangeError('JSON node limit exceeded');
    if (keys.some((key) => typeof key !== 'string' || FORBIDDEN.has(key))) throw new TypeError('Unsupported JSON property');
    if (array && (keys.length !== item.length + 1 || keys.some((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) throw new TypeError('Arrays must be dense and have no extra properties');
    ancestors.add(item);
    charge(2);
    const result = array ? [] : {};
    const ordered = array ? Array.from({ length: item.length }, (_, i) => String(i)) : keys.sort();
    for (let i = 0; i < ordered.length; i++) {
      const key = ordered[i];
      const d = Object.getOwnPropertyDescriptor(item, key);
      if (!d || !d.enumerable || !own(d, 'value')) throw new TypeError('Only enumerable own data properties are supported');
      if (i) charge(1);
      if (!array) charge(stringBytes(key) + 1);
      result[key] = visit(d.value, depth + 1);
    }
    ancestors.delete(item);
    return result;
  }
  return visit(value, 0);
}

export function exactKeys(value, keys, label) {
  record(value, label);
  if (Object.keys(value).length !== keys.length || keys.some((key) => !own(value, key))) throw new TypeError(`Invalid ${label} fields`);
}

function field(value, key, type) {
  if (!own(value, key) || typeof value[key] !== type) throw new TypeError(`Invalid ${key}`);
}

function integer(value, key) {
  field(value, key, 'number');
  if (!Number.isSafeInteger(value[key])) throw new TypeError(`Invalid ${key}`);
}

export function windowMetadata(value) {
  integer(value, 'id');
  field(value, 'focused', 'boolean');
  field(value, 'incognito', 'boolean');
  field(value, 'state', 'string');
}

export function windowContents(value, limits, stored = false) {
  if (!Array.isArray(value.tabs) || !Array.isArray(value.groups)) throw new TypeError('tabs and groups must be arrays');
  if (value.tabs.length > limits.maxTabs) throw new RangeError('Tab limit exceeded');
  if (value.groups.length > limits.maxGroups) throw new RangeError('Group limit exceeded');
  let active = 0;
  for (const tab of value.tabs) {
    record(tab, 'tab');
    integer(tab, 'id'); integer(tab, 'groupId');
    field(tab, 'url', 'string'); field(tab, 'title', 'string'); field(tab, 'pinned', 'boolean');
    if (stored) {
      if (own(tab, 'active')) throw new TypeError('Stored tabs must not contain active');
    } else {
      field(tab, 'active', 'boolean');
      if (tab.active && ++active > 1) throw new TypeError('At most one tab may be active');
    }
  }
  for (const group of value.groups) {
    record(group, 'group');
    integer(group, 'id');
    field(group, 'title', 'string'); field(group, 'color', 'string'); field(group, 'collapsed', 'boolean');
  }
}
