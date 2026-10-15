import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_PREFIX, splitWindow, joinWindow, contentKey, gzip, gunzip, orphanBlocks, planRetention } from '../src/legacy.js';
import { windowFixture } from './fixture.mjs';

// Captured by executing git show 220f7ff:src/lib/histstore.js, not this package.
const BODY = '{"tabs":[{"id":1,"url":"https://example.com/a","title":"A","pinned":false,"groupId":-1},{"id":2,"url":"https://example.com/b","title":"B – Ärger","pinned":true,"groupId":5}],"groups":[{"id":5,"title":"Arbeit","color":"blue","collapsed":false}]}';
const HASH = '776de7934afb5416bf9ecafe';
const GZIP = 'H4sIAAAAAAAAE32OQQrCMBBFr1JmHS0VuslOd55BukjqWAPTJkwSKJSAC2/gkbyJJzFQ0azczZvPf/wFgtIe5GkBcwbZCIhMIOEagvOyrnFWoyPc9nasFQgIJhDmfJ9vZ6YJc+miyKOAgW10x8ybJolVt/un04XuUL1uj+p55wG5MAeOpbhN3Yd+i9tiE2s0Idd7S5bzQ1PEFUk5/52auvQGtdHw0/cAAAA=';
const REF = { id: 7, focused: true, incognito: false, state: 'normal', active: 0, block: HASH };

test('v0 JSON byte order, truncated hash and reference remain unchanged', async () => {
  assert.equal(BLOCK_PREFIX, 'hwin:');
  assert.deepEqual(await splitWindow(windowFixture()), { ref: REF, block: HASH, body: BODY });
  assert.equal(await contentKey(BODY), HASH);
});

test('existing v0 gzip fixture decodes and restores without migration', async () => {
  assert.equal(await gunzip(GZIP), BODY);
  assert.deepEqual(await joinWindow(REF, GZIP), windowFixture());
  // gzip output bytes may differ by runtime; the old stored payload must read.
  assert.equal(await gunzip(await gzip(BODY)), BODY);
});

test('v0 active-only change still reuses the same body and block', async () => {
  const w = windowFixture(); w.tabs[0].active = false; w.tabs[1].active = true;
  const encoded = await splitWindow(w);
  assert.equal(encoded.body, BODY); assert.equal(encoded.block, HASH);
  assert.equal(encoded.ref.active, 1);
  assert.deepEqual(await joinWindow(encoded.ref, GZIP), w);
});

test('v0 orphan policy keeps shared blocks and preserves drop order', () => {
  assert.deepEqual(orphanBlocks([{ blocks: ['shared'] }], [{ blocks: ['first', 'shared', 'first'] }, {}, { blocks: ['second'] }]), ['first', 'second']);
});

test('v0 retention fixed boundaries and original order remain unchanged', () => {
  const hour = 3600000, day = 24 * hour, now = 1800000000000;
  const index = [
    { id: 'recent', t: now }, { id: 'day', t: now - day },
    { id: 'hour-new', t: now - 2 * day + 1000 }, { id: 'hour-old', t: now - 2 * day + 999 },
    { id: 'seven', t: now - 7 * day }, { id: 'ninety', t: now - 90 * day },
    { id: 'expired', t: now - 90 * day - 1 },
  ];
  const result = planRetention(index, now);
  assert.deepEqual(result.keep.map((e) => e.id), ['recent', 'day', 'hour-new', 'seven', 'ninety']);
  assert.deepEqual(result.drop.map((e) => e.id), ['hour-old', 'expired']);
  const many = Array.from({ length: 401 }, (_, i) => ({ t: now - i, id: i }));
  assert.equal(planRetention(many, now).keep.length, 400);
  assert.equal(planRetention(many, now).drop[0].id, 400);
});
