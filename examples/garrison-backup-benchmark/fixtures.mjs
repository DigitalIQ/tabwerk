// Unabhängig erzeugte synthetische Fixtures, keine Browser- oder Nutzerdaten.
const START = 1792051200000;
const STEP = 15 * 60 * 1000;
const WORDS = ['Nebula', 'Notebook', 'Research', 'Overview', 'Report', 'Planning', 'Diagram', 'Reference', 'Thread', 'Release', 'Archive', 'Checklist', 'Metrics', 'Workspace', 'Draft', 'Review'];

function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

const hex = value => value.toString(16).padStart(8, '0');

function icon(domain) {
  const color = ['3569af', 'b56135', '679041', '8d54a0', 'bb456e', '327b80', '9a8332', '50687d', '7b5245'][domain % 9];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="#${color}"/><path d="M4 4h8v8H4z" fill="#fff" opacity=".8"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function initialState(windows, tabsPerWindow) {
  const next = generator(0x67415252);
  const session = {
    id: 'synthetic-initial', name: 'Synthetic regular autosave', date: START,
    lastEditedTime: START, sessionStartTime: START - STEP,
    tag: ['regular'], tabsNumber: windows * tabsPerWindow, windowsNumber: windows,
    windows: {}, windowsInfo: {}, tabGroups: [],
    syntheticFutureSessionField: { source: 'deterministic-generated', version: 2 },
  };
  for (let w = 0; w < windows; w++) {
    const windowId = 100 + w;
    const groupId = 200 + w;
    const tabs = {};
    for (let t = 0; t < tabsPerWindow; t++) {
      const id = 1000 + w * tabsPerWindow + t;
      const domain = next() % 9;
      const path = next() % 5;
      const ref = hex(next());
      const group = t > 0 && t % 3 !== 0 ? groupId : -1;
      tabs[id] = {
        id, windowId, index: t,
        url: `https://site${domain}.example.test/${['docs', 'issues', 'projects', 'search', 'articles'][path]}/${ref}?view=${next() % 4}`,
        title: `${WORDS[next() % WORDS.length]} ${WORDS[next() % WORDS.length]} ${ref.slice(0, 5)}`,
        favIconUrl: icon(domain), active: t === 0, pinned: t === 0 && w % 2 === 0,
        groupId: group, splitViewId: t === 1 || t === 2 ? 300 + w : -1,
        lastAccessed: START - (next() % 3600000), discarded: t > 4,
        status: 'complete', highlighted: t === 0, incognito: false, audible: false,
        syntheticUnknownTabField: { token: hex(next()), flags: [t % 2 === 0, w % 2 === 0], note: 'ä字' },
      };
    }
    session.windows[windowId] = tabs;
    session.windowsInfo[windowId] = {
      id: windowId, focused: w === 0, incognito: false, state: w % 2 ? 'maximized' : 'normal',
      type: 'normal', left: w % 2 * 1440, top: 20, width: 1440, height: 960,
      alwaysOnTop: false, syntheticUnknownWindowField: { workspace: `workspace-${w % 3}` },
    };
    if (tabsPerWindow > 1) session.tabGroups.push({ id: groupId, windowId, title: `Group ${WORDS[next() % WORDS.length]}`, color: ['blue', 'green', 'orange'][w % 3], collapsed: w % 2 === 1, syntheticUnknownGroupField: { token: hex(next()) } });
  }
  return session;
}

function editWindow(session, windowIndex, point, next) {
  const key = Object.keys(session.windows)[windowIndex];
  const tabs = Object.values(session.windows[key]);
  const tab = tabs[(point * 7 + windowIndex) % tabs.length];
  const token = hex(next());
  const domain = next() % 9;
  tab.url = `https://site${domain}.example.test/${WORDS[next() % WORDS.length].toLowerCase()}/${token}?revision=${point}`;
  tab.title = `${WORDS[next() % WORDS.length]} ${WORDS[next() % WORDS.length]} ${token.slice(0, 5)}`;
  tab.lastAccessed = START + point * STEP;
  tab.favIconUrl = icon(domain);
}

function restart(session, epoch, time) {
  const windows = {};
  const windowsInfo = {};
  const oldToNew = new Map();
  let tabCounter = epoch * 1000000 + 1000;
  for (const [index, [key, tabs]] of Object.entries(session.windows).entries()) {
    const windowId = epoch * 10000 + 100 + index;
    oldToNew.set(Number(key), windowId);
    const rekeyed = {};
    for (const original of Object.values(tabs)) {
      const id = tabCounter++;
      const tab = { ...original, id, windowId };
      if (tab.groupId >= 0) tab.groupId = epoch * 10000 + 200 + index;
      if (tab.splitViewId >= 0) tab.splitViewId = epoch * 10000 + 300 + index;
      rekeyed[id] = tab;
    }
    windows[windowId] = rekeyed;
    windowsInfo[windowId] = { ...session.windowsInfo[key], id: windowId };
  }
  session.windows = windows;
  session.windowsInfo = windowsInfo;
  session.tabGroups = session.tabGroups.map((group, index) => ({ ...group, id: epoch * 10000 + 200 + index, windowId: oldToNew.get(group.windowId) }));
  session.sessionStartTime = time;
}

function historyFor(kind, { points, windows, tabsPerWindow }) {
  const session = initialState(windows, tabsPerWindow);
  const next = generator(0x0c0dec01);
  const history = [];
  const restartEvery = Math.max(1, Math.floor(points / 4));
  let epoch = 0;
  for (let point = 0; point < points; point++) {
    if (point > 0) {
      if (kind === 'restart' && point % restartEvery === 0) restart(session, ++epoch, START + point * STEP);
      if (kind === 'volatile') {
        for (const tabs of Object.values(session.windows)) {
          for (const tab of Object.values(tabs)) tab.lastAccessed = START + point * STEP + tab.index;
        }
      }
      if (kind === 'all') {
        for (let w = 0; w < windows; w++) editWindow(session, w, point, next);
      } else editWindow(session, (point - 1) % windows, point, next);
    }
    const uuid = `${hex(next())}-${hex(next()).slice(0, 4)}-4000-8000-${hex(next())}${hex(next()).slice(0, 4)}`;
    session.id = uuid;
    session.date = START + point * STEP;
    session.lastEditedTime = session.date;
    // Ein gespeicherter Autosave pro Zeitpunkt, kein Abbild der gesamten Datenbank.
    history.push([structuredClone(session)]);
  }
  return history;
}

export function scenarios({ points = 60, windows = 6, tabsPerWindow = 16 } = {}) {
  for (const [name, value] of Object.entries({ points, windows, tabsPerWindow })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} muss eine positive sichere Ganzzahl sein`);
  }
  if (points * windows * tabsPerWindow > 500000) throw new RangeError('Fixture-Budget überschritten');
  const options = { points, windows, tabsPerWindow };
  return [
    { id: 'sparse-one-window', description: 'Günstiger Grenzfall: echte URLänderung in genau einem Fenster je Autosave; andere Fensterfelder bleiben stabil.', history: historyFor('sparse', options) },
    { id: 'volatile-last-accessed', description: 'Ungünstiger Grenzfall: lastAccessed ändert sich in allen Tabs aller Fenster; zusätzlich echte URLänderung in einem Fenster.', history: historyFor('volatile', options) },
    { id: 'browser-restart', description: 'Sensitivitätsfall: periodisch neue Browser-, Tab-, Gruppen- und Split-IDs samt Keys; zusätzlich je Schritt echte URLänderung.', history: historyFor('restart', options) },
    { id: 'all-windows-edit', description: 'Ungünstiger Grenzfall: in jedem Fenster ändert sich mindestens eine echte URL pro Autosave.', history: historyFor('all', options) },
    { id: 'tiny-one-window', description: 'Overhead-Grenzfall: nur ein Fenster mit einem Tab; echte URLänderung bei jedem weiteren Zeitpunkt.', history: historyFor('sparse', { ...options, windows: 1, tabsPerWindow: 1 }) },
  ];
}
