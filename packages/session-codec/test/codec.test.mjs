import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWindow, decodeWindow, DEFAULT_LIMITS } from '../src/index.js';
import { compress, fromBase64, readBounded } from '../src/streams.js';
import { windowFixture } from './fixture.mjs';

async function crafted(text) {
  const encoded = await encodeWindow(windowFixture());
  const bytes = new TextEncoder().encode(text);
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  return { ref: { ...encoded.ref, block: hash }, block: { ...encoded.block, hash, data: await compress(bytes, 1024 * 1024) } };
}

test('v1 roundtrip preserves unknown nested tab/group JSON fields', async () => {
  const w = windowFixture();
  w.tabs[0].lastAccessed = 1800000000000;
  w.tabs[0].extra = { values: [null, true, 1.5, 'ß 漢字\ud800'], nested: { z: 'last', a: 'first' } };
  w.groups[0].extensionData = { collapsedAt: null };
  const before = structuredClone(w);
  const { ref, block } = await encodeWindow(w);
  assert.match(ref.block, /^[a-f0-9]{64}$/);
  assert.equal(ref.block, block.hash); assert.equal(ref.version, 1);
  assert.equal(block.encoding, 'gzip-base64');
  assert.deepEqual(await decodeWindow(ref, block), w);
  assert.deepEqual(w, before);
});

test('v1 stable key order, active tab and window metadata do not duplicate body', async () => {
  const a = windowFixture();
  const b = windowFixture();
  b.id = 20; b.focused = false; b.state = 'minimized';
  b.tabs[0].active = false; b.tabs[1].active = true;
  b.tabs[0] = Object.fromEntries(Object.entries(b.tabs[0]).reverse());
  const ea = await encodeWindow(a), eb = await encodeWindow(b);
  assert.equal(ea.block.hash, eb.block.hash);
  assert.equal(eb.ref.active, 1);
  assert.deepEqual(await decodeWindow(eb.ref, ea.block), b);
});

test('empty windows and no active tab have index -1', async () => {
  for (const tabs of [[], windowFixture().tabs.map((t) => ({ ...t, active: false }))]) {
    const w = { ...windowFixture(), tabs, groups: [] };
    const { ref, block } = await encodeWindow(w);
    assert.equal(ref.active, -1); assert.deepEqual(await decodeWindow(ref, block), w);
  }
});

test('schema rejects invalid types, unknown window fields and ambiguous active tabs', async () => {
  const cases = [
    (w) => { w.id = 0.5; }, (w) => { w.focused = 'true'; },
    (w) => { w.extra = 'use a sidecar'; }, (w) => { delete w.tabs[0].url; },
    (w) => { w.tabs[0].groupId = null; }, (w) => { w.tabs[1].active = true; },
    (w) => { w.groups[0].collapsed = 1; }, (w) => { w.groups = {}; },
  ];
  for (const mutate of cases) { const w = windowFixture(); mutate(w); await assert.rejects(encodeWindow(w), TypeError); }
});

test('unsafe prototypes, getters, symbols, cycles and non-JSON values are rejected', async () => {
  let calls = 0;
  const getter = {}; Object.defineProperty(getter, 'secret', { enumerable: true, get() { calls++; return 'bad'; } });
  const cycle = {}; cycle.self = cycle;
  const hidden = {}; Object.defineProperty(hidden, 'hidden', { value: 1 });
  const sparse = []; sparse.length = 1;
  const extraArray = []; extraArray.extra = true;
  const symbol = { [Symbol('key')]: 1 };
  const proto = Object.create({ inherited: 1 }); proto.own = 2;
  for (const value of [getter, cycle, hidden, sparse, extraArray, symbol, proto, new Date(), NaN, Infinity, undefined, 1n, () => 1, JSON.parse('{"__proto__":{}}'), { constructor: 'x' }, { prototype: {} }]) {
    const w = windowFixture(); w.tabs[0].extra = value;
    await assert.rejects(encodeWindow(w), TypeError);
  }
  assert.equal(calls, 0);
  assert.equal({}.polluted, undefined);
});

test('null-prototype JSON objects are accepted as ordinary JSON data', async () => {
  const w = windowFixture(); w.tabs[0].extra = Object.assign(Object.create(null), { n: 1 });
  const { ref, block } = await encodeWindow(w);
  assert.deepEqual((await decodeWindow(ref, block)).tabs[0].extra, { n: 1 });
});

test('input size, nodes, depth, tab/group and compressed-output bounds apply', async () => {
  const cases = [
    { maxDecompressedBytes: 100 }, { maxNodes: 4 }, { maxDepth: 1 },
    { maxTabs: 1 }, { maxCompressedBytes: 1 },
  ];
  for (const options of cases) await assert.rejects(encodeWindow(windowFixture(), options), RangeError);
  const w = windowFixture(); w.groups.push({ ...w.groups[0], id: 6 });
  await assert.rejects(encodeWindow(w, { maxGroups: 1 }), RangeError);
});

test('invalid options are rejected without invoking accessors', async () => {
  for (const options of [{ maxDepth: 0 }, { maxDepth: 129 }, { maxNodes: Infinity }, { maxTabs: -1 }, { maxGroups: 0.5 }, { maxCompressedBytes: 'big' }]) await assert.rejects(encodeWindow(windowFixture(), options), RangeError);
  for (const options of [null, [], { unknown: 1 }]) await assert.rejects(encodeWindow(windowFixture(), options), TypeError);
  let calls = 0;
  const options = { get maxDepth() { calls++; return 2; } };
  await assert.rejects(encodeWindow(windowFixture(), options), TypeError);
  assert.equal(calls, 0); assert.ok(Object.isFrozen(DEFAULT_LIMITS));
});

test('wrong hash, format, reference, active index and compressed data fail', async () => {
  const { ref, block } = await encodeWindow(windowFixture());
  await assert.rejects(decodeWindow({ ...ref, version: 2 }, block), /format/);
  await assert.rejects(decodeWindow(ref, { ...block, encoding: 'other' }), /format/);
  await assert.rejects(decodeWindow({ ...ref, block: '0'.repeat(64) }, block), /mismatch/);
  await assert.rejects(decodeWindow({ ...ref, block: '0'.repeat(64) }, { ...block, hash: '0'.repeat(64) }), /hash mismatch/);
  for (const active of [-2, 2, 1.5]) await assert.rejects(decodeWindow({ ...ref, active }, block), /active/);
  for (const data of ['!!!', 'YQ==', block.data.slice(0, -4), block.data + '\n']) await assert.rejects(decodeWindow(ref, { ...block, data }));
  await assert.rejects(decodeWindow(ref, block, { maxCompressedBytes: 1 }), RangeError);
});

test('decoded body validates JSON, types, forbidden keys and format even with a valid hash', async () => {
  for (const text of ['not json', '{"version":2,"tabs":[],"groups":[]}', '{"version":1,"tabs":[],"groups":[],"__proto__":{}}', '{"version":1,"tabs":[{"id":1}],"groups":[]}']) {
    const { ref, block } = await crafted(text);
    await assert.rejects(decodeWindow(ref, block));
  }
});

test('decompression stops at a decoded-byte bound, including a tiny compressed expansion', async () => {
  const w = windowFixture(); w.tabs[0].extra = 'x'.repeat(200000);
  const { ref, block } = await encodeWindow(w);
  assert.ok(block.data.length < 3000);
  await assert.rejects(decodeWindow(ref, block, { maxDecompressedBytes: 1024 }), /Stream byte limit/);
});

test('bounded reader cancels before consuming subsequent chunks', async () => {
  let pulls = 0, cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(4)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await assert.rejects(readBounded(stream, 5), RangeError);
  assert.equal(pulls, 2); assert.equal(cancelled, true);
});

test('base64 checks size before decoding and handles large strings without regex recursion', () => {
  assert.throws(() => fromBase64('A'.repeat(100), 1), RangeError);
  assert.throws(() => fromBase64('YR==', 4), /canonical/);
  const text = 'A'.repeat(4 * 350000);
  assert.equal(fromBase64(text, 1050000).length, 1050000);
});
