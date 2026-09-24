// Kopieren erlauben: für einen Tab sofort oder für eine Website immer.
// "Immer" braucht das Leserecht für diese Website. Chrome startet das Skript dann bei jedem Laden.

import { getSettings, saveSettings } from './settings.js';
import { isOn } from './flags.js';

const SCRIPT_ID = 'tabwerk-unlock';
const FILE = 'src/content/unlock.js';

export const hostKey = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
// Einzeln je Schema, weil Chrome ein Recht auch nur für https geben kann.
export const originPatterns = (host) => ['https', 'http'].flatMap((s) => [`${s}://${host}/*`, `${s}://*.${host}/*`]);

async function activeTab(windowId, tabId) {
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : (await chrome.tabs.query({ active: true, windowId }))[0];
  if (!tab || !/^https?:/.test(tab.url || '')) throw new Error('Das geht nur auf normalen Webseiten.');
  return tab;
}

export async function unlockTab({ windowId, tabId } = {}) {
  const settings = await getSettings();
  if (!isOn(settings, 'copyUnlock')) throw new Error('„Kopieren erlauben“ ist in den Einstellungen ausgeschaltet.');
  const tab = await activeTab(windowId, tabId);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: [FILE], world: 'MAIN' });
  } catch {
    throw new Error('Tabwerk darf diese Seite gerade nicht ändern. Nutze das Kontextmenü oder das Tastenkürzel der Schnellsuche.');
  }
  return { message: 'Kopieren und Rechtsklick sind jetzt erlaubt' };
}

export async function listUnlockHosts() {
  return (await getSettings()).unlockHosts || [];
}

// Die Leseerlaubnis fragt die Seite, die den Klick bekommt. Der Service Worker darf das nicht.
export async function setAlwaysUnlock({ host, on, windowId }) {
  const settings = await getSettings();
  const hosts = new Set(settings.unlockHosts || []);
  if (on) hosts.add(host); else hosts.delete(host);
  await saveSettings({ unlockHosts: [...hosts].sort() });
  await syncUnlockScripts();
  if (on && windowId) await unlockTab({ windowId }).catch(() => {});
  return { hosts: [...hosts], message: on ? `Auf ${host} immer erlaubt` : `Auf ${host} nicht mehr automatisch` };
}

// Registriert das Skript für alle Websites aus der Liste, für die Chrome das Leserecht gibt.
// Mehrere Anstöße kurz hintereinander laufen nacheinander, sonst meldet Chrome eine doppelte ID.
let chain = Promise.resolve();
export function syncUnlockScripts() {
  const run = chain.then(registerNow, registerNow);
  chain = run.catch(() => {});
  return run;
}

async function registerNow() {
  const settings = await getSettings();
  const hosts = isOn(settings, 'copyUnlock') ? settings.unlockHosts || [] : [];
  const matches = [];
  for (const host of hosts) {
    for (const pattern of originPatterns(host)) {
      if (await chrome.permissions.contains({ origins: [pattern] })) matches.push(pattern);
    }
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (!matches.length) return { hosts: 0 };
  await chrome.scripting.registerContentScripts([{
    id: SCRIPT_ID, js: [FILE], matches, runAt: 'document_start', world: 'MAIN', allFrames: true, persistAcrossSessions: true,
  }]);
  return { patterns: matches.length };
}
