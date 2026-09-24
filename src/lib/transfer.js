// Export und Import aller Tabwerk-Daten als eine JSON-Datei.

import { getSettings, saveSettings, DEFAULTS } from './settings.js';
import { listSnapshots, getSnapshot, compactHistory } from './history.js';
import { t } from './i18n.js';

const KEYS = ['apiKey', 'typesafeKey'];

export async function exportAll({ withKeys = false, withHistory = true, withForms = true } = {}) {
  const settings = await getSettings();
  if (!withKeys) for (const k of KEYS) delete settings[k];
  const store = await chrome.storage.local.get(['sessions', 'watches', 'notes', 'snoozed', 'formProfiles', 'learnLog', 'declutterProfiles']);
  const data = {
    format: 'tabwerk',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    sessions: store.sessions || [],
    watches: (store.watches || []).map(({ history, ...w }) => w),
    notes: store.notes || {},
    snoozed: store.snoozed || [],
    learnLog: store.learnLog || [],
    declutterProfiles: store.declutterProfiles || {},
  };
  if (withForms) data.formProfiles = store.formProfiles || [];
  if (withHistory) {
    const index = await listSnapshots();
    // Die Datei enthält jede Sicherung vollständig, damit sie auch ohne Tabwerk lesbar bleibt.
    data.history = [];
    for (const e of index) {
      const snap = await getSnapshot(e.id).catch(() => null);
      if (snap) data.history.push((({ blocks, ...rest }) => rest)(snap));
    }
  }
  return data;
}

const mergeById = (a = [], b = []) => {
  const ids = new Set(a.map((x) => x.id));
  return [...a, ...b.filter((x) => !ids.has(x.id))];
};

// Führt zusammen, statt zu ersetzen. Vorhandenes bleibt.
export async function importAll({ data }) {
  if (data?.format !== 'tabwerk') throw new Error(t('xfer_notATabwerkFile'));
  const store = await chrome.storage.local.get(['sessions', 'watches', 'notes', 'snoozed', 'formProfiles', 'learnLog', 'declutterProfiles']);
  // Lern-Ereignisse haben keine ID. Gleich sind sie bei gleicher Zeit, Funktion und gleichem Titel.
  const eventKey = (e) => `${e.t}|${e.f}|${e.title || ''}`;
  const knownEvents = new Set((store.learnLog || []).map(eventKey));
  const next = {
    sessions: mergeById(store.sessions, data.sessions),
    watches: mergeById(store.watches, (data.watches || []).map((w) => ({ ...w, history: [] }))),
    notes: { ...(data.notes || {}), ...(store.notes || {}) },
    snoozed: mergeById(store.snoozed, data.snoozed),
    formProfiles: mergeById(store.formProfiles, data.formProfiles),
    // Seite aufräumen: vorhandene Profile gehen vor, die Datei ergänzt nur neue Seitentypen.
    declutterProfiles: { ...(data.declutterProfiles || {}), ...(store.declutterProfiles || {}) },
    learnLog: [...(store.learnLog || []), ...(data.learnLog || []).filter((e) => !knownEvents.has(eventKey(e)))].sort((a, b) => b.t - a.t).slice(0, 1000),
  };
  await chrome.storage.local.set(next);
  if (data.settings) {
    const patch = Object.fromEntries(Object.entries(data.settings).filter(([k]) => k in DEFAULTS));
    await saveSettings(patch);
  }
  let snapshots = 0;
  if (Array.isArray(data.history)) {
    const { histIndex = [] } = await chrome.storage.local.get('histIndex');
    const have = new Set(histIndex.map((e) => e.id));
    const add = data.history.filter((s) => s?.id && !have.has(s.id));
    const writes = Object.fromEntries(add.map((s) => [`hist:${s.id}`, s]));
    const index = [...histIndex, ...add.map(({ windows, ...entry }) => entry)].sort((a, b) => b.t - a.t);
    await chrome.storage.local.set({ ...writes, histIndex: index });
    snapshots = add.length;
    if (add.length) await compactHistory();
  }
  for (const s of next.snoozed) {
    if (s.when > Date.now()) await chrome.alarms.create(`snooze:${s.id}`, { when: s.when });
  }
  return {
    sessions: next.sessions.length,
    watches: next.watches.length,
    snapshots,
    origins: [...new Set((data.watches || []).map((w) => { try { return `${new URL(w.url).origin}/*`; } catch { return null; } }).filter(Boolean))],
  };
}
