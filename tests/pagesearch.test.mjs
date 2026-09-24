import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPassages, splitSentences, locateSentence, rankPassages, MAX_PASSAGES, MAX_PASSAGE_CHARS, MAX_TOTAL_CHARS, RELEVANCE_THRESHOLD } from '../src/lib/pagesearch.js';
import { pageSearchState, pageSearchQuestion, sentencePickQuestion } from '../src/lib/prompts.js';

test('buildPassages fasst Weißraum zusammen und wirft Leeres weg', () => {
  const { passages, omittedOversized, omittedLimit } = buildPassages([
    { tag: 'p', text: '  Hallo   Welt  \n\n mit   viel   Raum ' },
    { tag: 'li', text: '   ' },
    { tag: 'p', text: null },
  ]);
  assert.equal(passages.length, 1);
  assert.equal(passages[0].text, 'Hallo Welt mit viel Raum');
  assert.equal(passages[0].id, 'p0');
  assert.equal(omittedOversized, 0);
  assert.equal(omittedLimit, 0);
});

test('buildPassages behält den ursprünglichen Index als Id, auch wenn etwas wegfällt', () => {
  const items = [
    { tag: 'p', text: 'kurzer Text' },
    { tag: 'p', text: 'x'.repeat(MAX_PASSAGE_CHARS + 1) },
    { tag: 'p', text: 'noch ein Text' },
  ];
  const { passages, omittedOversized } = buildPassages(items);
  assert.equal(omittedOversized, 1);
  assert.deepEqual(passages.map((p) => p.id), ['p0', 'p2']);
});

test('buildPassages hört bei höchstens 160 Passagen auf', () => {
  const items = Array.from({ length: MAX_PASSAGES + 20 }, (_, i) => ({ tag: 'p', text: `Absatz ${i}` }));
  const { passages, omittedLimit } = buildPassages(items);
  assert.equal(passages.length, MAX_PASSAGES);
  assert.equal(omittedLimit, 20);
});

test('buildPassages hört bei 60.000 Zeichen insgesamt auf', () => {
  const items = Array.from({ length: 40 }, () => ({ tag: 'p', text: 'x'.repeat(2000) }));
  const { passages, totalChars, omittedLimit } = buildPassages(items);
  assert.ok(totalChars <= MAX_TOTAL_CHARS);
  assert.ok(passages.length < 40);
  assert.ok(omittedLimit > 0);
});

test('splitSentences teilt nach Sprache und lässt Leeres weg', () => {
  const de = splitSentences('Das ist Satz eins. Und das ist Satz zwei!', 'de');
  assert.deepEqual(de, ['Das ist Satz eins.', 'Und das ist Satz zwei!']);
  assert.deepEqual(splitSentences('', 'en'), []);
  assert.deepEqual(splitSentences('   ', 'en'), []);
});

test('splitSentences fällt bei unbekannter Sprache auf Englisch zurück', () => {
  const s = splitSentences('One sentence. Another one.', 'not-a-real-locale');
  assert.equal(s.length, 2);
});

test('locateSentence findet den Satz als Zeichen-Offset im Originaltext wieder', () => {
  const text = 'Erster Satz. Zweiter Satz mit dem Preis. Dritter Satz.';
  const sentences = splitSentences(text, 'de');
  for (const sentence of sentences) {
    const loc = locateSentence(text, sentence);
    assert.ok(loc, `kein Treffer für "${sentence}"`);
    assert.equal(text.slice(loc.start, loc.end), sentence);
  }
});

test('locateSentence liefert null, wenn der Satz nicht vorkommt', () => {
  assert.equal(locateSentence('Ein Text ohne den Satz.', 'Erfundener Satz.'), null);
  assert.equal(locateSentence('', 'x'), null);
  assert.equal(locateSentence('x', ''), null);
});

test('rankPassages filtert nach Schwelle und sortiert nach Relevanz', () => {
  const passages = [
    { id: 'p0', text: 'a' },
    { id: 'p1', text: 'b' },
    { id: 'p2', text: 'c' },
  ];
  const answers = { p0: { noul: 0.9 }, p1: { noul: 0.2 }, p2: { noul: 0.6 } };
  const ranked = rankPassages(passages, answers);
  assert.deepEqual(ranked.map((p) => p.id), ['p0', 'p2']);
  assert.equal(ranked[0].relevance, 0.9);
});

test('rankPassages nutzt die Standard-Schwelle 0,58', () => {
  const passages = [{ id: 'p0', text: 'a' }];
  assert.equal(rankPassages(passages, { p0: { noul: 0.58 } }).length, 1);
  assert.equal(rankPassages(passages, { p0: { noul: 0.579999 } }).length, 0);
  assert.equal(RELEVANCE_THRESHOLD, 0.58);
});

test('rankPassages behandelt fehlende Antworten als nicht relevant', () => {
  const passages = [{ id: 'p0', text: 'a' }];
  assert.deepEqual(rankPassages(passages, {}), []);
});

test('pageSearchQuestion und sentencePickQuestion sprechen die Passage per Namen an', () => {
  const q = pageSearchQuestion('p3');
  assert.equal(q.type, 'noul');
  assert.match(q.instructions, /`passages\.p3`/);
  assert.ok(q.criteria.true && q.criteria.false);

  const state = pageSearchState([{ id: 'p3', text: 'Der Preis liegt bei 10 Euro.' }], 'Kosten');
  assert.equal(state.query, 'Kosten');
  assert.equal(state.passages.p3, 'Der Preis liegt bei 10 Euro.');

  const pick = sentencePickQuestion('p3', ['Satz eins.', 'Satz zwei.']);
  assert.equal(pick.type, 'choice');
  assert.deepEqual(Object.keys(pick.criteria), ['s0', 's1']);
  assert.match(pick.instructions, /`passages\.p3`/);
});
