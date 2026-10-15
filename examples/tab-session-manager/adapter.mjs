import { encodeWindow, decodeWindow } from '../../packages/session-codec/src/index.js';

// Unabhängiger Formatadapter. Kein Code aus Tab Session Manager übernommen.
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);

function requireRecord(value, name) {
  if (!isRecord(value)) throw new TypeError(`${name} muss ein JSON-Objekt sein`);
}

function tabEnvelope(key, original, index) {
  requireRecord(original, 'Tab');
  if (own(original, 'active') && typeof original.active !== 'boolean') {
    throw new TypeError('Tab.active muss ein Boolean sein, wenn vorhanden');
  }
  const { active, ...data } = original;
  return {
    id: Number.isSafeInteger(original.id) ? original.id : index,
    url: typeof original.url === 'string' ? original.url : '',
    title: typeof original.title === 'string' ? original.title : '',
    pinned: original.pinned === true,
    active: active === true,
    groupId: Number.isSafeInteger(original.groupId) ? original.groupId : -1,
    tsmKey: key,
    tsmHadActive: own(original, 'active'),
    tsmData: data,
  };
}

export async function encodeExport(sessions, options) {
  if (!Array.isArray(sessions)) throw new TypeError('TSM-Export muss ein Array sein');
  const manifests = [];
  const blocks = {};
  for (const session of sessions) {
    requireRecord(session, 'Session');
    requireRecord(session.windows, 'Session.windows');
    const { windows, ...metadata } = session;
    const windowsRefs = [];
    for (const [key, tabsById] of Object.entries(windows)) {
      requireRecord(tabsById, 'Fenster-Tabs');
      // Originale Keys bleiben Teil des Blocks. index beschreibt die Browserreihenfolge.
      const entries = Object.entries(tabsById);
      for (const [, tab] of entries) requireRecord(tab, 'Tab');
      entries.sort((a, b) => (a[1].index ?? 0) - (b[1].index ?? 0));
      const info = session.windowsInfo?.[key] ?? {};
      const encoded = await encodeWindow({
        id: Number.isSafeInteger(info.id) ? info.id : Number.isSafeInteger(Number(key)) ? Number(key) : 0,
        focused: info.focused === true,
        incognito: info.incognito === true,
        state: typeof info.state === 'string' ? info.state : 'normal',
        tabs: entries.map(([tabKey, tab], i) => tabEnvelope(tabKey, tab, i)),
        groups: [],
      }, options);
      blocks[encoded.block.hash] = encoded.block;
      windowsRefs.push({ key, ref: encoded.ref });
    }
    manifests.push({ metadata, windowsRefs });
  }
  return { format: 'tabwerk-tsm-offline', version: 1, manifests, blocks };
}

export async function decodeExport(archive, options) {
  requireRecord(archive, 'Archiv');
  if (archive.format !== 'tabwerk-tsm-offline' || archive.version !== 1 || !Array.isArray(archive.manifests)) {
    throw new TypeError('Unbekanntes Offline-Archivformat');
  }
  requireRecord(archive.blocks, 'Archiv.blocks');
  const sessions = [];
  for (const manifest of archive.manifests) {
    requireRecord(manifest.metadata, 'Session-Metadaten');
    if (!Array.isArray(manifest.windowsRefs)) throw new TypeError('Fensterreferenzen fehlen');
    const windows = [];
    const seenWindows = new Set();
    for (const entry of manifest.windowsRefs) {
      if (typeof entry.key !== 'string' || seenWindows.has(entry.key)) throw new TypeError('Ungültiger Fenster-Key');
      seenWindows.add(entry.key);
      if (!own(archive.blocks, entry.ref.block)) throw new Error('Referenzierter Fensterblock fehlt');
      const window = await decodeWindow(entry.ref, archive.blocks[entry.ref.block], options);
      const tabs = [];
      const seenTabs = new Set();
      for (const tab of window.tabs) {
        if (typeof tab.tsmKey !== 'string' || seenTabs.has(tab.tsmKey) || typeof tab.tsmHadActive !== 'boolean') {
          throw new TypeError('Ungültiger TSM-Tab-Envelope');
        }
        seenTabs.add(tab.tsmKey);
        requireRecord(tab.tsmData, 'Originale Tabdaten');
        const original = { ...tab.tsmData };
        if (tab.tsmHadActive) original.active = tab.active;
        tabs.push([tab.tsmKey, original]);
      }
      windows.push([entry.key, Object.fromEntries(tabs)]);
    }
    sessions.push({ ...manifest.metadata, windows: Object.fromEntries(windows) });
  }
  return sessions;
}

export const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
