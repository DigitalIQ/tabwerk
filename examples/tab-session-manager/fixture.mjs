// Vollständig erfundene Daten nach dem öffentlich dokumentierten TSM-Codeformat.
export function syntheticExport() {
  const makeTab = (id, index, url, active) => ({
    id, index, windowId: id < 200 ? 10 : 20,
    url, title: `Beispiel ${id}`, pinned: false, active, groupId: -1,
    lastAccessed: 1700000000000, discarded: true,
    customFutureField: { label: 'Unbekanntes Feld bleibt erhalten', values: ['ä', '字', 7] },
  });
  const session = {
    id: 'synthetic-session-one', name: 'Synthetischer Export', date: 1700000000000,
    lastEditedTime: 1700000000000, sessionStartTime: 1699999990000,
    tag: ['regular', 'synthetisch'], tabsNumber: 60, windowsNumber: 2,
    windowsInfo: {
      10: { id: 10, focused: true, incognito: false, state: 'normal', type: 'normal', left: 25, width: 1440, customWindowFlag: 'erhalten' },
      20: { id: 20, focused: false, incognito: false, state: 'maximized', type: 'normal', left: 1500, width: 1440 },
    },
    windows: {
      10: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(100 + i), makeTab(100 + i, i, `https://example.org/a/${i}`, i === 0)])),
      20: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(200 + i), makeTab(200 + i, i, `https://example.net/b/${i}`, i === 0)])),
    },
    tabGroups: [{ id: 4, windowId: 10, title: 'Beispielgruppe', color: 'blue', collapsed: false, unknownGroupData: { keep: true } }],
    futureSessionField: { nested: ['bleibt', 'erhalten'] },
  };
  session.windows[10][100].groupId = 4;
  const changed = structuredClone(session);
  changed.id = 'synthetic-session-two';
  changed.date += 1000;
  changed.lastEditedTime += 1000;
  changed.windows[10][101].url = 'https://example.org/geaendert';
  changed.windows[10][101].title = 'Nur dieses Fenster wurde verändert';
  return [session, changed];
}
