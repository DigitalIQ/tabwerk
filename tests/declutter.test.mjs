import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  declutterState, declutterQuestion, rulesFromAnswers, keepChoices, activeRules,
  parseKeywords, cleanHidden, shouldAuto, capProfiles, DEFAULT_HIDDEN, ANALYSIS_VERSION,
} from '../src/lib/declutter.js';

const candidates = [
  { id: 'e0', selector: 'div.ad-banner', tag: 'div', signals: 'ad-banner', text: 'Anzeige', position: 'static', count: 1 },
  { id: 'e1', selector: 'section#comments', tag: 'section', signals: 'comments', text: '42 Kommentare', position: 'static', count: 1 },
  { id: 'e2', selector: 'aside.context', tag: 'aside', signals: 'context', text: 'Hintergrund', position: 'static', count: 1 },
];
const answer = (choice, confidence = 1, probability = 1) => ({ type: 'choice', choice, confidence, probabilities: { [choice]: probability } });

test('Zustand für Jev: nur Seitentyp und Elementbeschreibungen, keine Selektoren', () => {
  const state = declutterState('article', candidates);
  assert.equal(state.page_type, 'article');
  assert.deepEqual(Object.keys(state.elements), ['e0', 'e1', 'e2']);
  assert.equal(JSON.stringify(state).includes('div.ad-banner'), false);
});

test('Frage: eigene Kategorie nur, wenn es eine eigene Regel gibt', () => {
  assert.equal(declutterQuestion('e0').criteria.custom, undefined);
  assert.ok(declutterQuestion('e0').criteria.comments);
  assert.equal(declutterQuestion('e0', '  Schwebende   Video-Player ').criteria.custom, 'User-defined clutter: Schwebende Video-Player');
  assert.match(declutterQuestion('e3').instructions, /elements\.e3/);
});

test('Regeln: nur sicher über der Schwelle, keep und uncertain bleiben sichtbar', () => {
  const rules = rulesFromAnswers({ e0: answer('ad'), e1: answer('comments', 0.85), e2: answer('keep') }, candidates, 0.9);
  assert.deepEqual(rules, [{ selector: 'div.ad-banner', category: 'ad', enabled: true, conf: 1 }]);
  assert.equal(rulesFromAnswers({ e0: answer('ad', 0.95, 0.89), e1: answer('uncertain'), e2: answer('keep') }, candidates, 0.9).length, 0);
});

test('Regeln: fehlende oder kaputte Antworten brechen ab', () => {
  assert.throws(() => rulesFromAnswers({ e0: answer('ad') }, candidates));
  assert.throws(() => rulesFromAnswers({ e0: answer('ad', 1.2), e1: answer('keep'), e2: answer('keep') }, candidates));
  assert.throws(() => rulesFromAnswers({ e0: answer('banana'), e1: answer('keep'), e2: answer('keep') }, candidates));
});

test('Neu analysieren behält „wieder einblenden“', () => {
  const before = { rules: [{ selector: 'div.ad-banner', category: 'ad', enabled: false }] };
  const next = keepChoices([{ selector: 'div.ad-banner', category: 'ad', enabled: true }, { selector: 'section#comments', category: 'comments', enabled: true }], before);
  assert.deepEqual(next.map((r) => r.enabled), [false, true]);
});

test('Aktive Regeln: Kategorie aus, Regel aus oder Profil pausiert', () => {
  const profile = { enabled: true, rules: [
    { selector: 'a', category: 'ad', enabled: true },
    { selector: 'b', category: 'comments', enabled: true },
    { selector: 'c', category: 'ad', enabled: false },
  ] };
  assert.deepEqual(activeRules(profile, DEFAULT_HIDDEN).map((r) => r.selector), ['a']);
  assert.deepEqual(activeRules(profile, [...DEFAULT_HIDDEN, 'comments']).map((r) => r.selector), ['a', 'b']);
  assert.deepEqual(activeRules({ ...profile, enabled: false }, DEFAULT_HIDDEN), []);
  assert.deepEqual(activeRules(null, DEFAULT_HIDDEN), []);
});

test('Stichwörter und Kategorien werden bereinigt', () => {
  assert.deepEqual(parseKeywords('Video-Player, sticky-video  x bad;sel video-player'), ['video-player', 'sticky-video']);
  assert.deepEqual(parseKeywords(['a', 'teaser']), ['teaser']);
  assert.deepEqual(cleanHidden(['comments', 'keep', 'ad']), ['ad', 'comments']);
  assert.deepEqual(cleanHidden(undefined), DEFAULT_HIDDEN);
});

test('Automatisch nur bei neuem oder veraltetem Seitentyp, einmal', () => {
  assert.equal(shouldAuto({ on: true, hasKey: true, attempted: null, profile: null }), true);
  assert.equal(shouldAuto({ on: true, hasKey: true, attempted: { t: 1 }, profile: null }), false);
  assert.equal(shouldAuto({ on: true, hasKey: false, attempted: null, profile: null }), false);
  assert.equal(shouldAuto({ on: true, hasKey: true, attempted: null, profile: { enabled: true, analysisVersion: ANALYSIS_VERSION } }), false);
  assert.equal(shouldAuto({ on: true, hasKey: true, attempted: null, profile: { enabled: true, analysisVersion: 0 } }), true);
  assert.equal(shouldAuto({ on: true, hasKey: true, attempted: null, profile: { enabled: false, analysisVersion: 0 } }), false);
});

test('Profile: die ältesten fliegen zuerst raus', () => {
  const profiles = Object.fromEntries([1, 2, 3].map((n) => [`k${n}`, { analyzedAt: n }]));
  assert.deepEqual(Object.keys(capProfiles(profiles, 2)).sort(), ['k2', 'k3']);
  assert.equal(capProfiles(profiles, 5), profiles);
});
