import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from './fixtures.mjs';

// Dieselben beobachteten Vergleichsfelder, unabhängig vom Upstream implementiert.
function autosaveSignature(session) {
  return JSON.stringify(Object.entries(session.windows).map(([key, tabs]) => [key, Object.values(tabs).map(tab => [tab.id, tab.url])]));
}
const configuration = { points: 8, windows: 3, tabsPerWindow: 5 };
const get = id => scenarios(configuration).find(item => item.id === id);

test('deterministische fünf Verläufe mit echtem Einzel-Autosave-Exportformat', () => {
  const first = scenarios(configuration);
  assert.deepEqual(first, scenarios(configuration));
  assert.equal(first.length, 5);
  assert.equal(new Set(first.map(item => item.id)).size, 5);
  for (const item of first) {
    assert.equal(item.history.length, configuration.points);
    for (const exported of item.history) {
      assert.equal(exported.length, 1);
      const session = exported[0];
      assert.deepEqual(JSON.parse(JSON.stringify(exported)), exported);
      assert.equal(Object.keys(session.windows).length, session.windowsNumber);
      assert.equal(Object.values(session.windows).reduce((n, tabs) => n + Object.keys(tabs).length, 0), session.tabsNumber);
    }
    for (let i = 1; i < item.history.length; i++) {
      assert.notEqual(autosaveSignature(item.history[i - 1][0]), autosaveSignature(item.history[i][0]));
      assert.notEqual(item.history[i - 1][0].id, item.history[i][0].id);
    }
  }
});

test('Sparse-Fall verändert genau ein Fenster und mutiert frühere Zeitpunkte nicht', () => {
  const { history } = get('sparse-one-window');
  for (let i = 1; i < history.length; i++) {
    const before = history[i - 1][0];
    const after = history[i][0];
    const changes = Object.keys(before.windows).filter(key => JSON.stringify(before.windows[key]) !== JSON.stringify(after.windows[key]));
    assert.equal(changes.length, 1);
  }
  const copied = structuredClone(history[1]);
  history[0][0].windows[100][1000].syntheticUnknownTabField.flags[0] = 'changed';
  assert.deepEqual(history[1], copied);
});

test('Volatile Profil verändert alle Fenster und jede lastAccessed-Zeit', () => {
  const { history } = get('volatile-last-accessed');
  for (let i = 1; i < history.length; i++) {
    const before = history[i - 1][0];
    const after = history[i][0];
    for (const key of Object.keys(before.windows)) {
      for (const tab of Object.values(before.windows[key])) assert.notEqual(tab.lastAccessed, after.windows[key][tab.id].lastAccessed);
    }
  }
});

test('Restart ändert Keys und IDs konsistent einschließlich Gruppen und Split-Views', () => {
  const { history } = get('browser-restart');
  assert.notDeepEqual(Object.keys(history[1][0].windows), Object.keys(history[2][0].windows));
  for (const [session] of history) {
    for (const [key, tabs] of Object.entries(session.windows)) {
      assert.equal(String(session.windowsInfo[key].id), key);
      for (const [tabKey, tab] of Object.entries(tabs)) {
        assert.equal(String(tab.id), tabKey);
        assert.equal(String(tab.windowId), key);
        assert.ok(Object.hasOwn(tab, 'splitViewId'));
        assert.ok(tab.syntheticUnknownTabField.token.length > 0);
        if (tab.groupId >= 0) assert.ok(session.tabGroups.some(group => group.id === tab.groupId && group.windowId === tab.windowId));
      }
    }
    assert.ok(session.syntheticFutureSessionField);
  }
});

test('Alle-Fenster-Fall ändert echte URLs in jedem Fenster, Tiny bleibt klein', () => {
  const { history } = get('all-windows-edit');
  for (let i = 1; i < history.length; i++) {
    for (const key of Object.keys(history[i][0].windows)) {
      const urls = session => Object.values(session.windows[key]).map(tab => tab.url);
      assert.notDeepEqual(urls(history[i - 1][0]), urls(history[i][0]));
    }
  }
  for (const [session] of get('tiny-one-window').history) {
    assert.equal(session.windowsNumber, 1);
    assert.equal(session.tabsNumber, 1);
  }
});

test('synthetische Inhalte variieren, alle Hosts bleiben reserviert und Icons sind eigene SVGs', () => {
  const [session] = get('sparse-one-window').history[0];
  const tabs = Object.values(session.windows).flatMap(window => Object.values(window));
  assert.ok(new Set(tabs.map(tab => new URL(tab.url).hostname)).size > 3);
  assert.ok(new Set(tabs.map(tab => tab.title)).size > 10);
  for (const tab of tabs) {
    assert.ok(new URL(tab.url).hostname.endsWith('.example.test'));
    assert.ok(Buffer.from(tab.favIconUrl.split(',')[1], 'base64').toString().startsWith('<svg '));
  }
});

test('Konfigurationsgrenzen und ein einzelner Zeitpunkt funktionieren', () => {
  assert.throws(() => scenarios({ points: 0 }), RangeError);
  assert.throws(() => scenarios({ windows: 1.5 }), RangeError);
  assert.throws(() => scenarios({ points: 100000, windows: 100, tabsPerWindow: 100 }), RangeError);
  for (const item of scenarios({ points: 1, windows: 1, tabsPerWindow: 1 })) assert.equal(item.history.length, 1);
});
