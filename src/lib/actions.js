// Aktionen für die Schnellsuche. Läuft im Service Worker.
// jev: true heißt, die Aktion fragt Jev und kostet ein paar Hundertstel Cent.
// flag: Schalter aus flags.js. Ist er aus, taucht die Aktion nicht auf.

import * as F from './features.js';
import * as H from './history.js';
import * as X from './extras.js';
import * as FO from './formsbg.js';
import * as U from './unlock.js';
import { getSettings, hasKey } from './settings.js';
import { isOn } from './flags.js';
import { toLinkList } from './links.js';
import { SNOOZE_PRESETS } from './snoozetime.js';
import { hostOf } from './url.js';

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
  { id: 'dupes.close', flag: 'cleanup', title: 'Doppelte Tabs schließen', words: 'duplicates entdoppeln', run: async ({ windowId }) => {
    const groups = await F.duplicates({ windowId });
    const tabIds = groups.flatMap((g) => g.close.map((t) => t.id));
    if (tabIds.length) await F.closeTabs({ tabIds, windowId });
    return `${tabIds.length} doppelte Tabs geschlossen`;
  } },
  { id: 'sort.site', flag: 'sort', title: 'Sortieren nach Website', words: 'sort domain', run: ({ windowId }) => F.sortTabs({ windowId, by: 'site' }).then(() => 'Nach Website sortiert') },
  { id: 'sort.recent', flag: 'sort', title: 'Sortieren nach zuletzt benutzt', words: 'sort recent', run: ({ windowId }) => F.sortTabs({ windowId, by: 'recent' }).then(() => 'Nach Nutzung sortiert') },
  { id: 'sort.opened', flag: 'sort', title: 'Sortieren nach Öffnungszeit', words: 'sort opened alt', run: ({ windowId }) => F.sortTabs({ windowId, by: 'opened' }).then(() => 'Nach Öffnungszeit sortiert') },
  { id: 'sort.title', flag: 'sort', title: 'Sortieren nach Titel', words: 'sort alphabet', run: ({ windowId }) => F.sortTabs({ windowId, by: 'title' }).then(() => 'Nach Titel sortiert') },
  { id: 'sort.priority', flag: 'sort', title: 'Tabs nach Priorität sortieren', words: 'sort wichtig', jev: true, run: ({ windowId }) => F.sortTabs({ windowId, by: 'priority' }).then(() => 'Nach Priorität sortiert') },
  { id: 'groups.priority', flag: 'sort', title: 'Gruppen nach Priorität sortieren', words: 'sort groups wichtig', jev: true, run: ({ windowId }) => F.sortGroups({ windowId }).then((r) => (r.moved ? 'Gruppen sortiert' : 'Reihenfolge passt schon')) },
  { id: 'groups.auto', flag: 'groups', title: 'Tabs gruppieren (nur sichere Vorschläge)', words: 'group ordnen', jev: true, run: async ({ windowId }) => {
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
  { id: 'undo', flag: 'undo', title: 'Rückgängig', words: 'undo zurück', run: async ({ windowId }) => {
    const r = await H.undoLastAction({ windowId });
    return r.ok ? `Stand vor „${r.label}“ wiederhergestellt` : 'Nichts rückgängig zu machen';
  } },
  { id: 'snapshot', flag: 'history', title: 'Jetzt sichern', words: 'backup snapshot', run: () => H.takeSnapshot('Von Hand gesichert', { force: true }).then(() => 'Gesichert') },
  { id: 'bookmark.add', title: 'Lesezeichen für diesen Tab', words: 'bookmark merken ordner', needs: 'bookmarks', run: ({ windowId }) => X.bookmarkWithFolder({ windowId }).then((r) => r.message) },
  { id: 'note.edit', flag: 'notes', title: 'Notiz zu diesem Tab', words: 'note notiz merken', run: async ({ windowId }) => { await X.openNoteEditor(await activeTab(windowId)); } },
  { id: 'groups.names', flag: 'groupNames', jev: true, title: 'Namen für Gruppen ohne Titel vorschlagen', words: 'group name benennen', run: ({ windowId }) => X.suggestGroupNames({ windowId }).then((r) => r.message) },
  { id: 'session.save', flag: 'sessions', title: 'Fenster als Sitzung speichern', words: 'session speichern sichern', run: ({ windowId }) => X.saveSession({ windowId }).then((s) => `Gespeichert als „${s.name}“`) },
  { id: 'focus.start', flag: 'focus', title: 'Fokus starten', words: 'focus konzentration pomodoro', run: ({ windowId }) => X.startFocus({ windowId }).then((r) => r.message) },
  { id: 'focus.end', flag: 'focus', title: 'Fokus beenden', words: 'focus stop', run: () => X.endFocus().then((r) => r.message) },
  { id: 'links.md', flag: 'copyLinks', title: 'Tabs dieses Fensters als Markdown kopieren', words: 'copy links markdown liste', run: async ({ windowId }) => ({ copy: toLinkList(await chrome.tabs.query({ windowId })), message: 'Linkliste kopiert' }) },
  { id: 'links.group', flag: 'copyLinks', title: 'Tabs dieser Gruppe als Markdown kopieren', words: 'copy links gruppe', run: async ({ windowId }) => {
    const t = await activeTab(windowId);
    const tabs = t.groupId === -1 ? [t] : await chrome.tabs.query({ windowId, groupId: t.groupId });
    return { copy: toLinkList(tabs), message: `${tabs.length} Links kopiert` };
  } },
  { id: 'links.text', flag: 'copyLinks', title: 'Tabs dieses Fensters als Text kopieren', words: 'copy links text mail', run: async ({ windowId }) => ({ copy: toLinkList(await chrome.tabs.query({ windowId }), 'text'), message: 'Linkliste kopiert' }) },
  ...SNOOZE_PRESETS.map((p) => ({ id: `snooze.${p.id}`, flag: 'snooze', title: `Tab schlummern: ${p.label}`, words: 'snooze später wiedervorlage', run: ({ windowId }) => X.snoozeTab({ windowId, preset: p.id }).then((r) => r.message) })),
  { id: 'dupeguard.pause', flag: 'dupeGuard', title: 'Doppel-Schutz 10 Minuten pausieren', words: 'duplicate pause', run: () => X.pauseDupeGuard({ minutes: 10 }).then((r) => r.message) },
  { id: 'discard.now', flag: 'discard', title: 'Inaktive Tabs jetzt entladen', words: 'discard speicher memory', run: ({ windowId }) => X.discardInactive({ windowId, all: true }).then((r) => r.message) },
  { id: 'stats.open', flag: 'stats', title: 'Statistik öffnen', words: 'stats zahlen übersicht', run: () => chrome.tabs.create({ url: chrome.runtime.getURL('src/stats/stats.html') }) },
  { id: 'forms.save', flag: 'forms', title: 'Formular speichern', words: 'form formular merken', run: ({ windowId }) => FO.saveForm({ windowId }).then((r) => r.message) },
  { id: 'forms.fill', flag: 'forms', title: 'Formular ausfüllen', words: 'form formular füllen', run: async ({ windowId }) => {
    const t = await activeTab(windowId);
    const mine = (await FO.listProfiles()).filter((p) => p.host === hostOf(t.url));
    if (mine.length === 1) return FO.fillForm({ windowId, profileId: mine[0].id }).then((r) => r.message);
    return { query: '/f ' };
  } },
  { id: 'forms.test', flag: 'formsTestData', title: 'Formular mit Testdaten füllen', words: 'form test fake dummy', run: ({ windowId }) => FO.fillTestData({ windowId }).then((r) => r.message) },
  { id: 'unlock.tab', flag: 'copyUnlock', title: 'Kopieren und Rechtsklick erlauben', words: 'copy paste rechtsklick markieren entsperren unlock', run: ({ windowId }) => U.unlockTab({ windowId }).then((r) => r.message) },
  // origin: die Schnellsuche fragt vorher nach dem Leserecht für die Website des aktiven Tabs.
  { id: 'unlock.always', flag: 'copyUnlock', origin: true, title: 'Kopieren auf dieser Website immer erlauben', words: 'copy paste immer website unlock', run: async ({ windowId }) => {
    const t = await activeTab(windowId);
    return U.setAlwaysUnlock({ host: U.hostKey(t.url), on: true, windowId }).then((r) => r.message);
  } },
  { id: 'options', title: 'Tabwerk-Einstellungen', words: 'settings options', run: () => chrome.runtime.openOptionsPage() },
  { id: 'shortcuts', title: 'Tastenkürzel ändern', words: 'shortcut hotkey', run: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) },
];

export async function listActions() {
  const settings = await getSettings();
  const perms = await chrome.permissions.getAll();
  const focus = await X.focusState();
  return ACTIONS
    .filter((a) => !a.flag || isOn(settings, a.flag))
    .filter((a) => !a.needs || perms.permissions?.includes(a.needs))
    .filter((a) => (a.id === 'focus.end' ? focus : a.id === 'focus.start' ? !focus : true))
    .map(({ id, title, words, jev, origin }) => ({ id, title, words, jev: Boolean(jev), origin: Boolean(origin), disabled: Boolean(jev && !hasKey(settings)) }));
}

export async function runAction({ id, windowId }) {
  const action = ACTIONS.find((a) => a.id === id);
  if (!action) throw new Error('Unbekannte Aktion.');
  const result = await action.run({ windowId });
  if (typeof result === 'string') return { message: result };
  if (result && typeof result === 'object' && ('copy' in result || 'query' in result)) return result;
  return { message: null };
}
