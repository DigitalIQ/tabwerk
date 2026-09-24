import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, findDuplicates, similarCandidates, describeTab } from '../src/lib/url.js';
import { tabs } from './fixtures/tabs.mjs';

test('normalizeUrl entfernt Tracking, Anker, www und Schrägstrich', () => {
  assert.equal(
    normalizeUrl('https://www.Example.com/a/?utm_source=x&b=2&a=1#top'),
    normalizeUrl('https://example.com/a?a=1&b=2'),
  );
  assert.notEqual(normalizeUrl('https://example.com/a?id=1'), normalizeUrl('https://example.com/a?id=2'));
  assert.equal(normalizeUrl('chrome://settings'), 'chrome://settings');
});

test('findDuplicates behält den zuletzt benutzten Tab', () => {
  const groups = findDuplicates(tabs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keep.id, 17);
  assert.deepEqual(groups[0].close.map((t) => t.id), [12]);
});

test('findDuplicates behält den aktiven Tab vor allen anderen', () => {
  const a = { id: 1, url: 'https://x.de/', active: true, lastAccessed: 1 };
  const b = { id: 2, url: 'https://x.de', active: false, lastAccessed: 9 };
  assert.equal(findDuplicates([b, a])[0].keep.id, 1);
});

test('similarCandidates paart nur gleiche Websites mit anderer Adresse', () => {
  const pairs = similarCandidates(tabs);
  for (const [a, b] of pairs) assert.equal(new URL(a.url).hostname.replace('www.', ''), new URL(b.url).hostname.replace('www.', ''));
  assert.ok(!pairs.some(([a, b]) => [a.id, b.id].includes(12) && [a.id, b.id].includes(17)));
});

test('describeTab schickt keine Query an Jev', () => {
  const d = describeTab({ title: 'Login', url: 'https://bank.example/konto?session=geheim#x' });
  assert.equal(d.path, '/konto');
  assert.ok(!JSON.stringify(d).includes('geheim'));
});
