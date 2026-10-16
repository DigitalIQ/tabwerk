import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScalingHistory } from './scaling-fixtures.mjs';

// Kleine unabhängige Testdaten. Keine privaten Dateien werden gelesen.
const realHistory = () => Array.from({ length: 10 }, (_, index) => [{
  id: `test-only-${index}`, date: 1000 + index, windows: { 7: { 11: { id: 11, windowId: 7, url: `https://fixture.example.test/${index}`, title: `Test ${index}`, opaque: { values: [null, false, 'ä字'] } } } },
  arbitraryFutureField: { array: [index], untouched: true },
}]);
const signature = session => JSON.stringify(Object.entries(session.windows).map(([key, tabs]) => [key, Object.values(tabs).map(tab => [tab.id, tab.url])]));

test('Zyklus bleibt bei 10, 100, 300 und 1000 Punkten exakt, unveränderlich und als Extrapolation bezeichnet', () => {
  const source = realHistory();
  const original = structuredClone(source);
  for (const points of [10, 100, 300, 1000]) {
    const result = buildScalingHistory({ kind: 'tsm-cycle', points, realHistory: source });
    assert.equal(result.history.length, points);
    assert.equal(result.metadata.extrapolated, true);
    assert.equal(result.metadata.measuredLongHistory, false);
    assert.equal(result.metadata.measuredSourcePoints, 10);
    assert.equal(result.metadata.sourceAuthenticated, false);
    for (let point = 0; point < points; point++) assert.deepEqual(result.history[point], original[point % 10]);
    assert.notEqual(result.history[0], source[0]);
    assert.equal(new Set(result.history).size, 10);
    if (points > 10) assert.equal(result.history[0], result.history[10]);
    assert.throws(() => { result.history[0][0].arbitraryFutureField.array.push(22); }, TypeError);
  }
  assert.deepEqual(source, original);
  assert.equal(Object.isFrozen(source[0][0]), false);
});

test('Reale Eingabe wird einmal kopiert und bleibt vom Ergebnis unabhängig', () => {
  const source = realHistory();
  const result = buildScalingHistory({ kind: 'tsm-cycle', points: 100, realHistory: source });
  source[0][0].arbitraryFutureField.array[0] = -1;
  assert.equal(result.history[0][0].arbitraryFutureField.array[0], 0);
  assert.equal(result.history[10][0].arbitraryFutureField.array[0], 0);
});

test('1000-Punkte-Prefix bleibt mit fünf weiteren Append-Punkten exakt erhalten', () => {
  for (const kind of ['tsm-cycle', 'synthetic-sparse', 'synthetic-churn']) {
    const options = { kind, realHistory: realHistory() };
    const baseline = buildScalingHistory({ ...options, points: 1000 });
    const extended = buildScalingHistory({ ...options, points: 1005 });
    assert.equal(extended.history.length, 1005);
    // Je Snapshot vergleichen, damit der Test keine zweite große serialisierte Historie erzeugt.
    for (let point = 0; point < 1000; point++) assert.deepEqual(extended.history[point], baseline.history[point]);
    for (let point = 1000; point < 1005; point++) {
      assert.ok(Object.isFrozen(extended.history[point][0]));
      if (kind === 'tsm-cycle') assert.deepEqual(extended.history[point], extended.history[point % 10]);
      else assert.notEqual(extended.history[point][0].id, extended.history[point - 1][0].id);
    }
  }
});

test('Synthetische Prefixe sind deterministisch, unabhängig von Länge und realer Eingabe', () => {
  for (const kind of ['synthetic-sparse', 'synthetic-churn']) {
    const first = buildScalingHistory({ kind, points: 10 });
    const longer = buildScalingHistory({ kind, points: 30, realHistory: realHistory() });
    assert.deepEqual(first.history, longer.history.slice(0, 10));
    assert.deepEqual(first, buildScalingHistory({ kind, points: 10, realHistory: [] }));
    assert.equal(first.metadata.provenance, 'independent-synthetic');
    assert.equal(first.metadata.measuredSourcePoints, 0);
    assert.equal(first.metadata.synthetic, true);
    assert.equal(first.metadata.measuredLongHistory, false);
  }
});

test('Sparse skaliert bis 1000, verändert genau einen Tab und teilt nur eingefrorene Objekte', () => {
  const { history } = buildScalingHistory({ kind: 'synthetic-sparse', points: 1000 });
  assert.equal(history.length, 1000);
  for (let point = 1; point < history.length; point++) {
    const before = history[point - 1][0];
    const after = history[point][0];
    let changedTabs = 0;
    let sharedWindows = 0;
    for (const [key, tabs] of Object.entries(before.windows)) {
      if (tabs === after.windows[key]) sharedWindows++;
      for (const [id, tab] of Object.entries(tabs)) if (tab !== after.windows[key][id]) changedTabs++;
    }
    assert.equal(changedTabs, 1);
    assert.equal(sharedWindows, 5);
    assert.notEqual(signature(before), signature(after));
    assert.notEqual(before.id, after.id);
    assert.equal(after.date - before.date, 15 * 60 * 1000);
  }
  assert.throws(() => { history[0][0].windows[100][1000].syntheticUnknownTabField.flags[0] = 'changed'; }, TypeError);
  assert.equal(history[1][0].windows[100][1000].syntheticUnknownTabField.flags[0], true);
});

test('Churn verändert alle Tab-Zeiten und startet alle 23 Schritte in verschiedenen Checkpoint-Phasen neu', () => {
  const { history, metadata } = buildScalingHistory({ kind: 'synthetic-churn', points: 117 });
  assert.equal(metadata.restartEverySteps, 23);
  assert.equal(metadata.restartCount, 5);
  assert.equal(new Set(Array.from({ length: 5 }, (_, index) => (index + 1) * metadata.restartEverySteps % 5)).size, 5);
  for (let point = 0; point < history.length; point++) {
    const session = history[point][0];
    assert.equal(Object.keys(session.windows).length, 6);
    assert.equal(session.tabsNumber, 360);
    assert.ok(session.syntheticFutureSessionField);
    let tabCount = 0;
    for (const [windowKey, tabs] of Object.entries(session.windows)) {
      assert.equal(session.windowsInfo[windowKey].id, Number(windowKey));
      assert.ok(session.windowsInfo[windowKey].syntheticUnknownWindowField);
      for (const [tabKey, tab] of Object.entries(tabs)) {
        tabCount++;
        assert.equal(tab.id, Number(tabKey));
        assert.equal(tab.windowId, Number(windowKey));
        assert.ok(tab.syntheticUnknownTabField);
        assert.ok(Object.isFrozen(tab.syntheticUnknownTabField.flags));
        if (tab.groupId >= 0) assert.ok(session.tabGroups.some(group => group.id === tab.groupId && group.windowId === tab.windowId));
        if (tab.splitViewId >= 0) assert.equal(tab.splitViewId, Math.floor(point / 23) * 10000 + 300 + Number(windowKey) % 100);
        if (point > 0 && point % 23 !== 0) assert.notEqual(tab.lastAccessed, history[point - 1][0].windows[windowKey][tabKey].lastAccessed);
      }
    }
    assert.equal(tabCount, 360);
    if (point > 0) {
      const before = history[point - 1][0];
      assert.notEqual(signature(before), signature(session));
      if (point % 23 === 0) {
        assert.notDeepEqual(Object.keys(before.windows), Object.keys(session.windows));
        assert.notEqual(before.sessionStartTime, session.sessionStartTime);
      } else assert.deepEqual(Object.keys(before.windows), Object.keys(session.windows));
    }
  }
});

test('Ungültige Längen und unpassende Zykluseingaben werden ohne Ausgabe von Inhalten abgelehnt', () => {
  for (const points of [undefined, 0, -1, 1.5, 1006, Infinity, '100']) assert.throws(() => buildScalingHistory({ kind: 'synthetic-sparse', points }), RangeError);
  assert.throws(() => buildScalingHistory({ kind: 'unknown', points: 10 }), RangeError);
  for (const history of [undefined, [], realHistory().slice(1), Array.from({ length: 10 }, () => []), Array.from({ length: 10 }, () => [{ windows: null }])]) {
    assert.throws(() => buildScalingHistory({ kind: 'tsm-cycle', points: 100, realHistory: history }), TypeError);
  }
});
