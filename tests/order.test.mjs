import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segments, planSort, SORTERS } from '../src/lib/order.js';

const t = (id, index, groupId = -1, extra = {}) => ({ id, index, groupId, pinned: false, url: `https://s${id}.de/`, title: `T${id}`, ...extra });

test('segments trennt Gruppen und lässt angepinnte weg', () => {
  const tabs = [t(1, 0, -1, { pinned: true }), t(2, 1), t(3, 2), t(4, 3, 7), t(5, 4, 7), t(6, 5)];
  const segs = segments(tabs);
  assert.deepEqual(segs.map((s) => [s.groupId, s.start, s.tabs.map((x) => x.id)]), [[-1, 1, [2, 3]], [7, 3, [4, 5]], [-1, 5, [6]]]);
});

test('planSort sortiert nach Priorität innerhalb der Blöcke', () => {
  const tabs = [t(1, 0, -1, { score: 0.2 }), t(2, 1, -1, { score: 2.9 }), t(3, 2, 5, { score: 1 }), t(4, 3, 5, { score: 3 })];
  const plan = planSort(tabs, SORTERS.priority);
  assert.deepEqual(plan.map((p) => p.order), [[2, 1], [4, 3]]);
});

test('planSort meldet nichts, wenn die Reihenfolge schon stimmt', () => {
  const tabs = [t(1, 0, -1, { lastAccessed: 9 }), t(2, 1, -1, { lastAccessed: 3 })];
  assert.equal(planSort(tabs, SORTERS.recent).length, 0);
});

test('Website-Sortierung ignoriert www', () => {
  const tabs = [t(1, 0, -1, { url: 'https://www.zeit.de/a' }), t(2, 1, -1, { url: 'https://arte.tv/' })];
  assert.deepEqual(planSort(tabs, SORTERS.site)[0].order, [2, 1]);
});
