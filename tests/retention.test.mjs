import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRetention } from '../src/lib/retention.js';

const H = 3600e3;
const now = 1_800_000_000_000;

test('letzte 24 Stunden bleiben vollständig', () => {
  const index = Array.from({ length: 50 }, (_, i) => ({ id: String(i), t: now - i * 60e3 }));
  assert.equal(planRetention(index, now).keep.length, 50);
});

test('ältere Sicherungen werden auf eine pro Stunde und später pro Tag ausgedünnt', () => {
  const index = [];
  for (let i = 0; i < 6 * 12; i++) index.push({ id: `a${i}`, t: now - 2 * 24 * H - i * 5 * 60e3 }); // 6 h, alle 5 min
  for (let i = 0; i < 48; i++) index.push({ id: `b${i}`, t: now - 20 * 24 * H - i * H }); // 2 Tage, stündlich
  index.push({ id: 'alt', t: now - 120 * 24 * H });
  const { keep, drop } = planRetention(index, now);
  const a = keep.filter((e) => e.id.startsWith('a')).length;
  const b = keep.filter((e) => e.id.startsWith('b')).length;
  assert.ok(a >= 6 && a <= 7, `stündlich: ${a}`);
  assert.ok(b >= 2 && b <= 3, `täglich: ${b}`);
  assert.ok(drop.some((e) => e.id === 'alt'));
});

test('mehr als 400 frische Sicherungen werden gekappt', () => {
  const index = Array.from({ length: 450 }, (_, i) => ({ id: String(i), t: now - i * 1000 }));
  assert.equal(planRetention(index, now).keep.length, 400);
});
