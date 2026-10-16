import { scenarios } from './fixtures.mjs';

const KINDS = new Set(['tsm-cycle', 'synthetic-sparse', 'synthetic-churn']);
const START = 1792051200000;
const STEP = 15 * 60 * 1000;
const WINDOWS = 6;
const TABS_PER_WINDOW = 60;
// 23 durchläuft alle Phasen eines Checkpoint-Intervalls von 5.
const RESTART_EVERY = 23;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function restart(session, epoch, time) {
  const windows = {};
  const windowsInfo = {};
  const windowIds = new Map();
  const groupIds = new Map();
  let tabId = epoch * 1000000 + 1000;
  for (const [index, [key, tabs]] of Object.entries(session.windows).entries()) {
    const windowId = epoch * 10000 + 100 + index;
    windowIds.set(Number(key), windowId);
    const groupId = epoch * 10000 + 200 + index;
    const rekeyed = {};
    for (const original of Object.values(tabs)) {
      const tab = { ...original, id: tabId++, windowId };
      if (tab.groupId >= 0) {
        groupIds.set(tab.groupId, groupId);
        tab.groupId = groupId;
      }
      if (tab.splitViewId >= 0) tab.splitViewId = epoch * 10000 + 300 + index;
      rekeyed[tab.id] = tab;
    }
    windows[windowId] = rekeyed;
    windowsInfo[windowId] = { ...session.windowsInfo[key], id: windowId };
  }
  return {
    ...session, windows, windowsInfo, sessionStartTime: time,
    tabGroups: session.tabGroups.map(group => ({ ...group, id: groupIds.get(group.id), windowId: windowIds.get(group.windowId) })),
  };
}

function nextSynthetic(previous, kind, point) {
  const time = START + point * STEP;
  let session = { ...previous, id: `${kind}-${String(point).padStart(6, '0')}`, date: time, lastEditedTime: time };
  if (point === 0) return session;
  if (kind === 'synthetic-churn' && point % RESTART_EVERY === 0) session = restart(session, point / RESTART_EVERY, time);
  const windows = { ...session.windows };
  if (kind === 'synthetic-churn') {
    for (const [key, tabs] of Object.entries(windows)) {
      windows[key] = Object.fromEntries(Object.entries(tabs).map(([id, tab]) => [id, { ...tab, lastAccessed: time + tab.index }]));
    }
  }
  const windowKey = Object.keys(windows)[(point - 1) % WINDOWS];
  const tabs = { ...windows[windowKey] };
  const tabKey = Object.keys(tabs)[point * 7 % TABS_PER_WINDOW];
  tabs[tabKey] = {
    ...tabs[tabKey],
    url: `https://site${point % 9}.example.test/scaling/revision/${point}?window=${(point - 1) % WINDOWS}`,
    title: `Synthetic scaling revision ${point}`,
    lastAccessed: time + tabs[tabKey].index,
  };
  windows[windowKey] = tabs;
  return { ...session, windows };
}

// Unveränderte Referenzen dürfen geteilt werden, weil jeder Snapshot tief eingefroren ist.
// Dies spart Fixture-RAM; der Benchmark serialisiert weiterhin jeden vollständigen Snapshot.
export function buildScalingHistory({ kind, points, realHistory } = {}) {
  if (!KINDS.has(kind)) throw new RangeError('Unbekannter Skalierungsverlauf');
  // Fünf weitere Punkte decken einen vollständigen Append-Zyklus nach 1000 Punkten ab.
  if (!Number.isSafeInteger(points) || points < 1 || points > 1005) throw new RangeError('points muss zwischen 1 und 1005 liegen');
  if (kind === 'tsm-cycle') {
    if (!Array.isArray(realHistory) || realHistory.length !== 10 || realHistory.some(point => !Array.isArray(point) || point.length !== 1 || !record(point[0]) || !record(point[0].windows))) {
      throw new TypeError('tsm-cycle benötigt genau zehn vorbereitete Einzel-Autosave-Snapshots');
    }
    // Nur zehn Kopien, keine Änderung oder Ergänzung eines Feldes aus der Eingabe.
    const cycle = freeze(structuredClone(realHistory));
    return freeze({
      id: kind,
      description: 'Extrapolation durch exakte Wiederholung von zehn bereitgestellten TSM-Snapshots, kein gemessener Langzeitverlauf.',
      metadata: {
        kind, points, provenance: 'extrapolated-real-cycle', synthetic: false, extrapolated: true,
        measuredLongHistory: false, measuredSourcePoints: 10, sourceAuthenticated: false,
        cycleLength: 10, completedCycles: Math.floor(points / 10), trailingCyclePoints: points % 10,
        exactSourceFieldsPreserved: true, repeatedSessionIds: points > 10, repeatedSourceTimestamps: points > 10,
        method: 'Exact input order repeated; source IDs and timestamps unchanged; point ordinal is the history identity.',
      },
      history: Array.from({ length: points }, (_, point) => cycle[point % cycle.length]),
    });
  }
  // Ausschließlich vorhandene unabhängige Fixtures, niemals die reale Eingabe als Vorlage.
  const initial = scenarios({ points: 1, windows: WINDOWS, tabsPerWindow: TABS_PER_WINDOW })[0].history[0][0];
  const history = [];
  let session = initial;
  for (let point = 0; point < points; point++) {
    session = freeze(nextSynthetic(session, kind, point));
    history.push(freeze([session]));
  }
  return freeze({
    id: kind,
    description: kind === 'synthetic-sparse'
      ? 'Unabhängig synthetisch: 360 Tabs, eine echte URLänderung in einem Fenster je weiterem Autosave.'
      : 'Unabhängig synthetisch: 360 Tabs, alle lastAccessed-Zeiten ändern sich; neue Browser-IDs alle 23 Schritte und eine echte URLänderung je Schritt.',
    metadata: {
      kind, points, provenance: 'independent-synthetic', synthetic: true, extrapolated: false,
      measuredLongHistory: false, measuredSourcePoints: 0, windows: WINDOWS, tabsPerWindow: TABS_PER_WINDOW,
      tabs: WINDOWS * TABS_PER_WINDOW, intervalMilliseconds: STEP,
      restartEverySteps: kind === 'synthetic-churn' ? RESTART_EVERY : null,
      restartCount: kind === 'synthetic-churn' ? Math.floor((points - 1) / RESTART_EVERY) : 0,
      method: 'Deterministic synthetic full-field snapshots; fixed workload per step, invariant under requested history length; no measured user distribution.',
    },
    history,
  });
}
