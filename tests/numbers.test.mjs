import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber, numberCandidates, compare } from '../src/lib/numbers.js';

test('parseNumber liest deutsche Schreibweise mit Tausenderpunkt', () => {
  assert.equal(parseNumber('1.234,56'), 1234.56);
});

test('parseNumber liest englische Schreibweise mit Tausenderkomma', () => {
  assert.equal(parseNumber('1,234.56'), 1234.56);
});

test('parseNumber liest deutsches Komma ohne Tausendertrenner', () => {
  assert.equal(parseNumber('199,99'), 199.99);
});

test('parseNumber liest englischen Punkt ohne Tausendertrenner', () => {
  assert.equal(parseNumber('199.99'), 199.99);
});

test('parseNumber liest Leerzeichen als Tausendertrenner', () => {
  assert.equal(parseNumber('1 234,56'), 1234.56);
});

test('parseNumber liefert null bei leerer oder unlesbarer Eingabe', () => {
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('abc'), null);
});

test('numberCandidates findet Beträge mit Kontext', () => {
  const hits = numberCandidates('Preis: 199,99 € · Lagerbestand: 12%');
  assert.ok(hits.some((h) => h.value === 199.99));
  assert.ok(hits.some((h) => h.value === 12));
});

test('compare wendet den gewählten Operator an', () => {
  assert.equal(compare(10, 'below', 20), true);
  assert.equal(compare(10, 'atmost', 10), true);
  assert.equal(compare(10, 'above', 20), false);
  assert.equal(compare(10, 'atleast', 10), true);
  assert.equal(compare(10, 'unknown', 10), false);
});
