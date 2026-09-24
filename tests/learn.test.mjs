import { test } from 'node:test';
import assert from 'node:assert/strict';
import { append, calibrate, calibrateNoul, suggestRules, pickExamples, toJsonl } from '../src/lib/learncore.js';

const ev = (conf, ok) => ({ f: 'groups', conf, ok });

test('zu wenig Daten: keine gelernte Schwelle', () => {
  assert.equal(calibrate([ev(0.9, true), ev(0.8, true)]), null);
});

test('Schwelle: niedrigste Stufe mit mindestens 90 % Treffern', () => {
  const events = [
    ...Array.from({ length: 10 }, () => ev(0.72, true)),
    ...Array.from({ length: 6 }, () => ev(0.55, false)),
    ev(0.6, true),
  ];
  assert.equal(calibrate(events).threshold, 0.6);
});

test('alle Daten unter der Zielgenauigkeit: eine Stufe höher', () => {
  const events = [...Array.from({ length: 3 }, () => ev(0.6, false)), ...Array.from({ length: 12 }, () => ev(0.62, true))];
  assert.equal(calibrate(events).threshold, 0.65);
});

test('Jev liegt oft daneben: Schwelle geht nach oben', () => {
  const events = [...Array.from({ length: 12 }, () => ev(0.85, false)), ...Array.from({ length: 6 }, () => ev(0.97, true))];
  assert.equal(calibrate(events).threshold, 0.9);
});

test('Wächter: Grenze trennt deine Urteile am besten', () => {
  const events = [
    ...Array.from({ length: 6 }, () => ({ conf: 0.62, truth: true })),
    ...Array.from({ length: 6 }, () => ({ conf: 0.4, truth: false })),
  ];
  assert.equal(calibrateNoul(events).threshold, 0.5);
  assert.equal(calibrateNoul(events.filter((e) => e.truth)), null);
});

test('Regel nach drei gleichen Zuordnungen', () => {
  const g = (host, user) => ({ f: 'groups', host, user });
  const events = [g('github.com', 'Entwicklung'), g('github.com', 'Entwicklung'), g('github.com', 'Entwicklung'), g('github.com', 'Arbeit'),
    g('youtube.com', 'Medien'), g('youtube.com', 'Medien')];
  assert.deepEqual(suggestRules(events).map((r) => r.rule), ['github.com = Entwicklung']);
  assert.deepEqual(suggestRules(events, ['github.com = Dev']), []);
  assert.deepEqual(suggestRules(events, [], ['github.com = Entwicklung']), []);
});

test('Beispiele: offene Websites und Korrekturen zuerst, ohne Doppel', () => {
  const events = [
    { f: 'groups', host: 'a.com', title: 'A', user: 'X', ok: true },
    { f: 'groups', host: 'b.com', title: 'B', user: 'Y', ok: false },
    { f: 'groups', host: 'b.com', title: 'B', user: 'Y', ok: false },
    { f: 'groups', host: 'c.com', title: 'C', user: 'none', ok: false },
  ];
  const ex = pickExamples(events, ['a.com'], 5);
  assert.deepEqual(ex.map((x) => x.placed_in_group), ['X', 'Y']);
});

test('Protokoll ist begrenzt, neueste zuerst', () => {
  const log = append([{ n: 1 }], [{ n: 2 }], 2);
  assert.deepEqual(log, [{ n: 2 }, { n: 1 }]);
  assert.equal(append(log, [{ n: 3 }], 2).length, 2);
  assert.equal(toJsonl([{ a: 1 }, { b: 2 }]), '{"a":1}\n{"b":2}\n');
});
