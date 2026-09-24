// Aktionen für die Schnellsuche. Läuft im Service Worker.
// jev: true heißt, die Aktion fragt Jev und kostet ein paar Hundertstel Cent.

import * as F from './features.js';
import * as H from './history.js';
import { getSettings, hasKey } from './settings.js';

const activeTab = async (windowId) => (await chrome.tabs.query({ active: true, windowId }))[0];

const ACTIONS = [
  { id: 'tab.new', title: 'Neuer Tab', words: 'new tab öffnen', run: ({ windowId }) => chrome.tabs.create({ windowId }) },
  { id: 'tab.close', title: 'Tab schließen', words: 'close', run: async ({ windowId }) => chrome.tabs.remove((await activeTab(windowId)).id) },
  { id: 'tab.duplicate', title: 'Tab duplizieren', words: 'duplicate kopie', run: async ({ windowId }) => chrome.tabs.duplicate((await activeTab(windowId)).id) },
  { id: 'tab.pin', title: 'Tab anpinnen oder lösen', words: 'pin anheften', run: async ({ windowId }) => { const t = await activeTab(windowId); await chrome.tabs.update(t.id, { pinned: !t.pinned }); } },
  { id: 'tab.mute', title: 'Tab stumm oder laut', words: 'mute ton audio', run: async ({ windowId }) => { const t = await activeTab(windowId); await chrome.tabs.update(t.id, { muted: !t.mutedInfo?.muted }); } },
  { id: 'tab.reload', title: 'Tab neu laden', words: 'reload refresh', run: async ({ windowId }) => chrome.tabs.reload((await activeTab(windowId)).id) },
  { id: 'tab.detach', title: 'Tab in neues Fenster', words: 'move window ablösen', run: async ({ windowId }) => chrome.windows.create({ tabId: (await activeTab(windowId)).id }) },
  { id: 'window.new', title: 'Neues Fenster', words: 'new window', run: () => chrome.windows.create({}) },
  { id: 'window.incognito', title: 'Neues Inkognito-Fenster', words: 'incognito privat', run: () => chrome.windows.create({ incognito: true }) },
  { id: 'dupes.close', title: 'Doppelte Tabs schließen', words: 'duplicates entdoppeln', run: async ({ windowId }) => {
    const groups = await F.duplicates({ windowId });
    const tabIds = groups.flatMap((g) => g.close.map((t) => t.id));
    if (tabIds.length) await F.closeTabs({ tabIds, windowId });
    return `${tabIds.length} doppelte Tabs geschlossen`;
  } },
  { id: 'sort.site', title: 'Sortieren nach Website', words: 'sort domain', run: ({ windowId }) => F.sortTabs({ windowId, by: 'site' }).then(() => 'Nach Website sortiert') },
  { id: 'sort.recent', title: 'Sortieren nach zuletzt benutzt', words: 'sort recent', run: ({ windowId }) => F.sortTabs({ windowId, by: 'recent' }).then(() => 'Nach Nutzung sortiert') },
  { id: 'sort.opened', title: 'Sortieren nach Öffnungszeit', words: 'sort opened alt', run: ({ windowId }) => F.sortTabs({ windowId, by: 'opened' }).then(() => 'Nach Öffnungszeit sortiert') },
  { id: 'sort.title', title: 'Sortieren nach Titel', words: 'sort alphabet', run: ({ windowId }) => F.sortTabs({ windowId, by: 'title' }).then(() => 'Nach Titel sortiert') },
  { id: 'sort.priority', title: 'Tabs nach Priorität sortieren', words: 'sort wichtig', jev: true, run: ({ windowId }) => F.sortTabs({ windowId, by: 'priority' }).then(() => 'Nach Priorität sortiert') },
  { id: 'groups.priority', title: 'Gruppen nach Priorität sortieren', words: 'sort groups wichtig', jev: true, run: ({ windowId }) => F.sortGroups({ windowId }).then((r) => (r.moved ? 'Gruppen sortiert' : 'Reihenfolge passt schon')) },
  { id: 'groups.auto', title: 'Tabs gruppieren (nur sichere Vorschläge)', words: 'group ordnen', jev: true, run: async ({ windowId }) => {
    const res = await F.proposeGroups({ windowId, onlyUngrouped: true });
    const plan = res.items.filter((i) => i.sure && i.target !== 'none').map((i) => ({ tabId: i.id, target: i.target }));
    if (plan.length) await F.applyGroups({ windowId, plan, options: res.options });
    return `${plan.length} Tabs einsortiert, ${res.items.length - plan.length} offen gelassen`;
  } },
  { id: 'groups.collapse', title: 'Alle Gruppen einklappen', words: 'collapse', run: async ({ windowId }) => {
    for (const g of await chrome.tabGroups.query({ windowId })) await chrome.tabGroups.update(g.id, { collapsed: true });
  } },
  { id: 'groups.expand', title: 'Alle Gruppen ausklappen', words: 'expand', run: async ({ windowId }) => {
    for (const g of await chrome.tabGroups.query({ windowId })) await chrome.tabGroups.update(g.id, { collapsed: false });
  } },
  { id: 'groups.ungroup', title: 'Alle Gruppen auflösen', words: 'ungroup', run: async ({ windowId }) => {
    const tabIds = (await chrome.tabs.query({ windowId })).filter((t) => t.groupId !== -1).map((t) => t.id);
    if (!tabIds.length) return 'Keine Gruppen';
    await H.beforeAction('Gruppen auflösen', windowId);
    await chrome.tabs.ungroup(tabIds);
    return 'Gruppen aufgelöst';
  } },
  { id: 'undo', title: 'Rückgängig', words: 'undo zurück', run: async ({ windowId }) => {
    const r = await H.undoLastAction({ windowId });
    return r.ok ? `Stand vor „${r.label}“ wiederhergestellt` : 'Nichts rückgängig zu machen';
  } },
  { id: 'snapshot', title: 'Jetzt sichern', words: 'backup snapshot', run: () => H.takeSnapshot('Von Hand gesichert', { force: true }).then(() => 'Gesichert') },
  { id: 'bookmark.add', title: 'Lesezeichen für diesen Tab', words: 'bookmark merken', needs: 'bookmarks', run: async ({ windowId }) => {
    const t = await activeTab(windowId);
    await chrome.bookmarks.create({ title: t.title, url: t.url });
    return 'Lesezeichen gesetzt';
  } },
  { id: 'options', title: 'Tabwerk-Einstellungen', words: 'settings options', run: () => chrome.runtime.openOptionsPage() },
  { id: 'shortcuts', title: 'Tastenkürzel ändern', words: 'shortcut hotkey', run: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) },
];

export async function listActions() {
  const settings = await getSettings();
  const perms = await chrome.permissions.getAll();
  return ACTIONS
    .filter((a) => !a.needs || perms.permissions?.includes(a.needs))
    .map(({ id, title, words, jev }) => ({ id, title, words, jev: Boolean(jev), disabled: Boolean(jev && !hasKey(settings)) }));
}

export async function runAction({ id, windowId }) {
  const action = ACTIONS.find((a) => a.id === id);
  if (!action) throw new Error('Unbekannte Aktion.');
  const message = await action.run({ windowId });
  return { message: typeof message === 'string' ? message : null };
}
