import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArchive, appendPoint, restorePoint, retainPoints } from './archive.mjs';

// Vollständig synthetisches Exportarray im Adapterformat, keine Nutzerdaten.
function source(title = 'Example') {
  return [{
    id: 1, date: 1800000000000, name: 'Synthetic backup',
    windows: {
      10: {
        11: { id: 11, index: 0, url: 'https://example.test/', title, active: true, pinned: false, groupId: 3, lastAccessed: 42, splitViewId: 7 },
        12: { id: 12, index: 1, url: 'https://second.test/', title: 'Second', active: false, custom: { values: [null, true, 'kept'] } },
      },
      20: { 21: { id: 21, index: 0, url: 'https://stable.test/', title: 'Stable', active: true } },
    },
    windowsInfo: {
      10: { id: 10, focused: true, state: 'normal', futureWindowField: { x: 1 } },
      20: { id: 20, focused: false, state: 'maximized', incognito: false },
    },
    tabGroups: [{ id: 3, windowId: 10, title: 'Group', color: 'blue', collapsed: false, future: 'kept' }],
    splitViews: [{ id: 7, tabIds: [11, 12], layout: { ratios: [0.4, 0.6] } }],
    unknownSessionData: { nested: [1, { preserved: 'yes' }] },
  }];
}

test('empty container is JSON serializable and empty points restore', async () => {
  const archive = createArchive();
  assert.deepEqual(JSON.parse(JSON.stringify(archive)), archive);
  assert.deepEqual(await appendPoint(archive, []), { newBlockCount: 0 });
  assert.deepEqual(await restorePoint(archive, 0), []);
});

test('roundtrip preserves all sessions, groups, split-view and unknown metadata', async () => {
  const archive = createArchive(), input = source();
  input.push({ id: 2, windows: {}, unknown: ['empty session'] });
  const untouched = structuredClone(input);
  assert.deepEqual(await appendPoint(archive, input), { newBlockCount: 2 });
  const serialized = JSON.stringify(archive);
  assert.deepEqual(await restorePoint(JSON.parse(serialized), 0), untouched);
  assert.deepEqual(input, untouched);
  input[0].unknownSessionData.nested[1].preserved = 'external mutation';
  const restored = await restorePoint(archive, 0);
  assert.deepEqual(restored, untouched);
  restored[0].windowsInfo[10].futureWindowField.x = 99;
  assert.deepEqual(await restorePoint(archive, 0), untouched);
});

test('unchanged windows and active-tab-only changes share stored blocks', async () => {
  const archive = createArchive();
  const first = source(), changed = source('Changed'), activeOnly = source('Changed');
  activeOnly[0].windows[10][11].active = false;
  activeOnly[0].windows[10][12].active = true;
  assert.equal((await appendPoint(archive, first)).newBlockCount, 2);
  assert.equal((await appendPoint(archive, changed)).newBlockCount, 1);
  assert.equal((await appendPoint(archive, activeOnly)).newBlockCount, 0);
  assert.equal(Object.keys(archive.blocks).length, 3);
  for (const [index, expected] of [first, changed, activeOnly].entries()) assert.deepEqual(await restorePoint(archive, index), expected);
});

test('failed append leaves previous points and block dictionary unchanged', async () => {
  const archive = createArchive(), input = source();
  await appendPoint(archive, input);
  const before = JSON.stringify(archive), points = archive.points, blocks = archive.blocks;
  const bad = source('Changed'); bad[0].windows[20][21].active = 'invalid';
  await assert.rejects(appendPoint(archive, bad));
  assert.equal(JSON.stringify(archive), before);
  assert.equal(archive.points, points); assert.equal(archive.blocks, blocks);
  assert.deepEqual(await restorePoint(archive, 0), input);
  assert.equal((await appendPoint(archive, source('Valid later'))).newBlockCount, 1);
});

test('retaining selected points collects only unused blocks and keeps shared blocks', async () => {
  const archive = createArchive();
  const inputs = [source('First'), source('Second'), source('Third')];
  for (const input of inputs) await appendPoint(archive, input);
  const original = JSON.stringify(archive);
  const retained = retainPoints(archive, [2, 0]);
  assert.equal(retained.points.length, 2);
  assert.equal(Object.keys(retained.blocks).length, 3);
  assert.deepEqual(await restorePoint(retained, 0), inputs[2]);
  assert.deepEqual(await restorePoint(retained, 1), inputs[0]);
  assert.equal(JSON.stringify(archive), original);
  retained.points[0].manifests[0].metadata.name = 'changed copy';
  assert.equal(JSON.stringify(archive), original);
  assert.deepEqual(retainPoints(archive, []), createArchive());
});

test('missing, corrupt and mismatched blocks fail instead of restoring partial data', async () => {
  const archive = createArchive(); await appendPoint(archive, source());
  const hash = Object.keys(archive.blocks)[0];
  const missing = structuredClone(archive); delete missing.blocks[hash];
  await assert.rejects(restorePoint(missing, 0), /fehlt/);
  const corrupt = structuredClone(archive); corrupt.blocks[hash].data = 'AAAA';
  await assert.rejects(restorePoint(corrupt, 0));
  const corruptBefore = JSON.stringify(corrupt);
  await assert.rejects(appendPoint(corrupt, source()));
  assert.equal(JSON.stringify(corrupt), corruptBefore);
  const mismatch = structuredClone(archive); mismatch.blocks[hash].hash = '0'.repeat(64);
  await assert.rejects(restorePoint(mismatch, 0), /Fensterblock/);
});

test('format, index and duplicate-reference checks reject malformed containers', async () => {
  const archive = createArchive(); await appendPoint(archive, source());
  for (const index of [-1, 1, 0.5, '0', NaN]) await assert.rejects(restorePoint(archive, index), RangeError);
  for (const indices of [[0, 0], [1], [-1], [undefined], '0']) assert.throws(() => retainPoints(archive, indices));
  const wrong = structuredClone(archive); wrong.version = 2;
  await assert.rejects(restorePoint(wrong, 0), /Format|format/);
  const duplicate = structuredClone(archive);
  duplicate.points[0].manifests[0].windowsRefs.push(structuredClone(duplicate.points[0].manifests[0].windowsRefs[0]));
  await assert.rejects(restorePoint(duplicate, 0), /doppelter/);
});

test('concurrent append is rejected without losing the successful point', async () => {
  const archive = createArchive();
  const first = appendPoint(archive, source());
  await assert.rejects(appendPoint(archive, source('Second')), /bereits/);
  await first;
  assert.equal(archive.points.length, 1);
  assert.deepEqual(await restorePoint(archive, 0), source());
});

test('non-JSON metadata is rejected without invoking getters or mutating the archive', async () => {
  const archive = createArchive();
  let calls = 0;
  const input = source();
  Object.defineProperty(input[0], 'getter', { enumerable: true, get() { calls++; return 1; } });
  await assert.rejects(appendPoint(archive, input), TypeError);
  assert.equal(calls, 0); assert.deepEqual(archive, createArchive());
  const nonfinite = source(); nonfinite[0].metadata = Infinity;
  await assert.rejects(appendPoint(archive, nonfinite), TypeError);
  assert.deepEqual(archive, createArchive());
});
