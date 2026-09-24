import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzip, gunzip, contentKey, splitWindow, joinWindow, orphanBlocks } from '../src/lib/histstore.js';

const win = (active = 0, extra = []) => ({
  id: 7, focused: true, incognito: false, state: 'normal',
  tabs: [
    { id: 1, url: 'https://example.com/a', title: 'A', pinned: false, active: active === 0, groupId: -1 },
    { id: 2, url: 'https://example.com/b', title: 'B – Ärger', pinned: true, active: active === 1, groupId: 5 },
    ...extra,
  ],
  groups: [{ id: 5, title: 'Arbeit', color: 'blue', collapsed: false }],
});

test('gzip hin und zurück, auch mit Umlauten', async () => {
  const text = JSON.stringify({ t: 'Größe ß € 漢字'.repeat(50) });
  const packed = await gzip(text);
  assert.equal(await gunzip(packed), text);
  assert.ok(packed.length < text.length);
});

test('Block ist unabhängig vom aktiven Tab', async () => {
  const a = await splitWindow(win(0));
  const b = await splitWindow(win(1));
  assert.equal(a.block, b.block);
  assert.equal(a.ref.active, 0);
  assert.equal(b.ref.active, 1);
});

test('anderer Inhalt gibt anderen Block', async () => {
  const a = await splitWindow(win(0));
  const b = await splitWindow(win(0, [{ id: 3, url: 'https://x.test', title: 'X', pinned: false, active: false, groupId: -1 }]));
  assert.notEqual(a.block, b.block);
  assert.equal((await contentKey('x')).length, 24);
});

test('zerlegen und zusammensetzen ergibt dasselbe Fenster', async () => {
  const w = win(1);
  const { ref, body } = await splitWindow(w);
  assert.deepEqual(await joinWindow(ref, await gzip(body)), w);
});

test('verwaiste Blöcke: nur was keine behaltene Sicherung braucht', () => {
  const keep = [{ blocks: ['a', 'b'] }, { blocks: ['b'] }];
  const drop = [{ blocks: ['a', 'c'] }, { blocks: ['d'] }, {}];
  assert.deepEqual(orphanBlocks(keep, drop).sort(), ['c', 'd']);
});
