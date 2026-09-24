import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/lib/prompts.js';
import { DEFAULTS } from '../src/lib/settings.js';
import { tabs } from './fixtures/tabs.mjs';

test('groupOptions nimmt bestehende Gruppen vor gleichnamige Kategorien', () => {
  const { criteria, meta } = P.groupOptions([{ id: 4, title: 'Arbeit', color: 'blue' }], DEFAULTS.categories, { 4: [{ title: 'Outlook' }] });
  assert.ok(criteria.g4);
  assert.deepEqual(criteria.g4.contains_tabs_like, ['Outlook']);
  assert.ok(!Object.values(meta).some((m) => m.type === 'new' && m.name === 'Arbeit'));
  assert.equal(meta.none.type, 'none');
});

test('Choice-Fragen bleiben unter 255 Optionen', () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ id: i, title: `T${i}`, url: `https://x.de/${i}` }));
  const req = P.findRequest(many, 'x');
  assert.ok(Object.keys(req.questions.match.criteria).length <= 255);
});

test('Fragen sprechen den Tab per Namen an', () => {
  const q = P.groupQuestion('t12', { a: 'x', none: 'y' });
  assert.match(q.instructions, /`tabs\.t12`/);
  const state = P.tabState(tabs);
  assert.ok(state.tabs.t12);
});

test('priorityQuestion nutzt den Fokus nur, wenn er gesetzt ist', () => {
  assert.equal(typeof P.priorityQuestion('t1', DEFAULTS.priorityLevels, '').instructions, 'string');
  assert.equal(P.priorityQuestion('t1', DEFAULTS.priorityLevels, 'Bericht').instructions.my_current_focus, 'Bericht');
});

test('watchRequest fragt nur nach Belegzeilen, wenn es mindestens zwei gibt', () => {
  const one = P.watchRequest({ condition: 'x' }, {}, { added: ['a'], removed: [] });
  assert.ok(!one.questions.evidence);
  const two = P.watchRequest({ condition: 'x' }, {}, { added: ['a', 'b'], removed: [] });
  assert.deepEqual(Object.keys(two.questions.evidence.criteria), ['l0', 'l1', 'none']);
});

test('ranked sortiert nach Wahrscheinlichkeit', () => {
  assert.deepEqual(P.ranked({ probabilities: { a: 0.1, b: 0.7, c: 0.2 } }, 2).map((r) => r.key), ['b', 'c']);
});
