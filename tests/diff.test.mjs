import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, hasNumericCondition } from '../src/lib/diff.js';

test('diffLines findet neue und entfernte Zeilen', () => {
  const d = diffLines('Kopfhörer\nNicht verfügbar\nFooter', 'Kopfhörer\nAuf Lager\nFooter');
  assert.deepEqual(d.added, ['Auf Lager']);
  assert.deepEqual(d.removed, ['Nicht verfügbar']);
  assert.ok(d.changed);
});

test('diffLines ignoriert Reihenfolge und Leerraum', () => {
  const d = diffLines('A  eins\n\nB zwei', 'B zwei\nA eins');
  assert.equal(d.changed, false);
});

test('diffLines zählt doppelte Zeilen', () => {
  const d = diffLines('Neu\n', 'Neu\nNeu');
  assert.deepEqual(d.added, ['Neu']);
});

test('hasNumericCondition erkennt Preisbedingungen', () => {
  assert.ok(hasNumericCondition('wenn der Preis unter 200 € fällt'));
  assert.ok(!hasNumericCondition('wenn ein neuer Artikel erscheint'));
});
