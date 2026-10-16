import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSessions } from './real-input.mjs';
import { scenarios } from './fixtures.mjs';

const sessions = () => scenarios({ points: 6, windows: 2, tabsPerWindow: 3 })[0].history.flat();

test('latest regular autosaves selected chronologically without changing original data', () => {
  const source = sessions().reverse();
  const before = JSON.stringify(source);
  source.push({ ...structuredClone(source[0]), id: 'manual', tag: ['manual'] });
  const result = prepareSessions(source, { source: 'tsm', maxPoints: 3 });
  assert.equal(result.summary.declaredSource, 'tsm');
  assert.equal(result.summary.sourceAuthenticated, false);
  assert.equal(result.summary.selectedPoints, 3);
  assert.equal(result.summary.regularAutosavesAvailable, 6);
  assert.equal(result.summary.excludedOtherSessions, 1);
  assert.deepEqual(result.history, [source[2], source[1], source[0]].map(s => [s]));
  assert.equal(JSON.stringify(source.slice(0, -1)), before);
  assert.ok(!JSON.stringify(result.summary).includes('https://'));
});

test('explicit provenance, sufficient history and distinct IDs required', () => {
  const data = sessions();
  assert.throws(() => prepareSessions(data, {}), /Quelle/);
  assert.throws(() => prepareSessions([data[0]], { source: 'garrison' }), /Weniger/);
  assert.throws(() => prepareSessions([data[0], data[0]], { source: 'garrison' }), /doppelt/);
  assert.throws(() => prepareSessions([{ ...data[0], date: null }, data[1]], { source: 'garrison' }), /Erstellungszeit/);
});

test('same-time records remain visible as ambiguity instead of silently deduplicating', () => {
  const data = sessions();
  data[1].date = data[0].date;
  const result = prepareSessions(data, { source: 'garrison' });
  assert.equal(result.summary.equalTimestampPairs, 1);
  assert.equal(result.history.length, 6);
  assert.deepEqual(result.history[0][0], data[0]);
});
