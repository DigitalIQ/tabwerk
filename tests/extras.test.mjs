import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRules, matchRule } from '../src/lib/rules.js';
import { toLinkList } from '../src/lib/links.js';
import { nameCandidates } from '../src/lib/groupnames.js';
import { parseNumber, numberCandidates, compare } from '../src/lib/numbers.js';
import { timeWindow } from '../src/lib/timewindow.js';
import { isSensitive, matchFields, fakePerson, fakeValue, rng } from '../src/lib/formcore.js';
import { toBookmarkHtml } from '../src/lib/bookmarkfile.js';
import { isOn } from '../src/lib/flags.js';

test('Regeln: spezifischste gewinnt, Subdomains zählen', () => {
  const rules = parseRules('github.com = Entwicklung\ngist.github.com = Schnipsel\n# Kommentar\nkaputt');
  assert.equal(rules.length, 2);
  assert.equal(matchRule('www.github.com', rules).group, 'Entwicklung');
  assert.equal(matchRule('gist.github.com', rules).group, 'Schnipsel');
  assert.equal(matchRule('example.org', rules), null);
});

test('Linkliste als Markdown und Text', () => {
  const tabs = [{ title: 'A [x]', url: 'https://a.de/(1)' }, { title: 'Einstellungen', url: 'chrome://settings' }];
  assert.equal(toLinkList(tabs), '- [A \\[x\\]](https://a.de/(1%29)');
  assert.equal(toLinkList(tabs, 'text'), 'A [x]\nhttps://a.de/(1)');
});

test('Gruppennamen: häufige Wörter zuerst, Füllwörter raus', () => {
  const names = nameCandidates([
    { title: 'Umzug Checkliste', url: 'https://docs.google.com/a' },
    { title: 'Umzugsfirma Angebot – Umzug Berlin', url: 'https://umzug24.de' },
    { title: 'Kartons kaufen für den Umzug', url: 'https://shop.de' },
  ]);
  assert.equal(names[0], 'Umzug');
  assert.ok(!names.includes('Für'));
});

test('Zahlen: deutsche und englische Schreibweise', () => {
  assert.equal(parseNumber('1.299,00'), 1299);
  assert.equal(parseNumber('1,299.50'), 1299.5);
  assert.equal(parseNumber('189,99'), 189.99);
  assert.equal(parseNumber('2.499'), 2499);
  const c = numberCandidates('Sony WH-1000XM6\nJetzt nur 279,99 € statt 349,00 €\nVersand 4,95 €');
  assert.deepEqual(c.map((x) => x.value), [279.99, 349, 4.95]);
  assert.ok(compare(279.99, 'below', 300));
  assert.ok(!compare(349, 'below', 300));
});

test('Zeitraum aus Alltagssprache', () => {
  const now = new Date('2026-09-24T12:00:00').getTime();
  const w = timeWindow('der Artikel von letzter Woche', now);
  assert.equal(new Date(w.from).getDate(), 14);
  assert.equal(new Date(w.to).getDate(), 21);
  assert.equal(timeWindow('irgendwas', now).label, 'letzte 90 Tage');
});

test('Formulare: sensible Felder erkennen und zuordnen', () => {
  assert.ok(isSensitive({ type: 'password' }));
  assert.ok(isSensitive({ type: 'text', name: 'iban' }));
  assert.ok(isSensitive({ type: 'text', autocomplete: 'cc-number' }));
  assert.ok(!isSensitive({ type: 'email', name: 'email' }));
  const saved = [{ id: 'fn', label: 'Vorname' }, { name: 'mail' }, { label: 'Postleitzahl' }];
  assert.deepEqual(matchFields([{ name: 'mail' }, { label: 'postleitzahl:' }, { id: 'x' }], saved), [1, 2, -1]);
});

test('Testdaten passen zum Feld', () => {
  const r = rng(42);
  const p = fakePerson(r);
  assert.match(fakeValue({ type: 'email' }, p, r), /@example\.com$/);
  assert.equal(fakeValue({ type: 'text', label: 'PLZ' }, p, r), p.zip);
  assert.equal(fakeValue({ type: 'text', name: 'firstname' }, p, r), p.first);
});

test('Lesezeichen-Datei mit Gruppen als Ordner', () => {
  const html = toBookmarkHtml([{ name: 'Recherche & Co', windows: [{ groups: [{ id: 1, title: 'Artikel' }], tabs: [
    { url: 'https://a.de', title: 'A', groupId: 1 }, { url: 'https://b.de', title: 'B <b>', groupId: -1 }] }] }]);
  assert.match(html, /<H3 ADD_DATE="\d+">Recherche &amp; Co<\/H3>/);
  assert.match(html, /<H3>Artikel<\/H3>/);
  assert.match(html, /B &lt;b&gt;/);
});

test('Schalter: Unterfunktion aus, wenn die übergeordnete aus ist', () => {
  assert.ok(isOn({}, 'similar'));
  assert.ok(!isOn({ features: { cleanup: false } }, 'similar'));
  assert.ok(!isOn({}, 'autoGroupJev'));
});
