import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, scoreItem, parseQuery, normalize } from '../src/lib/fuzzy.js';

test('normalize macht Umlaute und ß vergleichbar', () => {
  assert.equal(normalize('Kopfhörer Straße'), 'kopfhorer strasse');
  assert.ok(fuzzyScore('kopfhorer', 'Sony Kopfhörer') !== null);
});

test('Teilwort am Wortanfang schlägt Treffer mitten im Wort', () => {
  assert.ok(fuzzyScore('bericht', 'Berichtsvorlage Q3') > fuzzyScore('bericht', 'Monatsbericht Liste'));
});

test('Buchstabenfolge mit Lücken findet Abkürzungen', () => {
  assert.ok(fuzzyScore('gh tw', 'GitHub tabwerk') !== null);
  assert.ok(fuzzyScore('ghtw', 'github.com/example/tabwerk') !== null);
});

test('fehlendes Wort ergibt null', () => {
  assert.equal(fuzzyScore('bericht youtube', 'Berichtsvorlage Q3'), null);
});

test('Wörter dürfen auf Titel und Adresse verteilt sein', () => {
  const s = scoreItem('regeln blog', [['Klare Berichte: 7 Regeln', 1], ['schreibwerkstatt-blog.de', 0.8]]);
  assert.ok(s !== null);
});

test('parseQuery erkennt Filter', () => {
  assert.deepEqual(parseQuery('/b iso'), { only: 'bookmark', text: 'iso' });
  assert.deepEqual(parseQuery('/actions grup'), { only: 'action', text: 'grup' });
  assert.deepEqual(parseQuery('/xyz'), { only: null, text: '/xyz' });
});

test('verstreute Buchstaben sind kein Treffer', () => {
  assert.equal(fuzzyScore('bericht', 'chrome.tabGroups | Chrome for Developers'), null);
  assert.equal(scoreItem('bericht', [['Tab duplizieren', 1], ['duplicate kopie', 0.6]]), null);
});

test('/N legt eine Notiz an, /n sucht in Notizen', () => {
  assert.deepEqual(parseQuery('/N'), { only: null, create: 'note', text: '' });
  assert.deepEqual(parseQuery('/N Das ist neu'), { only: null, create: 'note', text: 'Das ist neu' });
  assert.deepEqual(parseQuery('/n rechnung'), { only: 'note', text: 'rechnung' });
  assert.deepEqual(parseQuery('/F kündigungsfrist'), { only: null, create: 'pagesearch', text: 'kündigungsfrist' });
  assert.deepEqual(parseQuery('/f kontakt'), { only: 'form', text: 'kontakt' });
});
