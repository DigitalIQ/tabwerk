// Aktionen für die Schnellsuche. Läuft im Service Worker.
// jev: true heißt, die Aktion fragt Jev und kostet ein paar Hundertstel Cent.
// flag: Schalter aus flags.js. Ist er aus, taucht die Aktion nicht auf.

import * as F from './features.js';
import * as H from './history.js';
import * as X from './extras.js';
import * as FO from './formsbg.js';
import * as U from './unlock.js';
import * as PS from './pagesearchbg.js';
import * as DC from './declutterbg.js';
import { getSettings, hasKey } from './settings.js';
import { isOn } from './flags.js';
import { toLinkList } from './links.js';
import { SNOOZE_PRESETS } from './snoozetime.js';
import { hostOf } from './url.js';
import { REASON, LABEL, labelText } from './reasons.js';
import { t, tp } from './i18n.js';

const activeTab = async (windowId) => (await chrome.tabs.query({ active: true, windowId }))[0];

// words: die alten deutsch/englischen Suchwörter bleiben als Fallback stehen, der Getter
// hängt zusätzlich die übersetzten Suchwörter der aktuellen Sprache an.
const ACTIONS = [
  { id: 'tab.new', get title() { return t('act_tabNew'); }, get words() { return `${t('act_tabNewWords')} new tab öffnen`; }, run: ({ windowId }) => chrome.tabs.create({ windowId }) },
  { id: 'tab.close', get title() { return t('act_tabClose'); }, get words() { return `${t('act_tabCloseWords')} close`; }, run: async ({ windowId }) => chrome.tabs.remove((await activeTab(windowId)).id) },
  { id: 'tab.duplicate', get title() { return t('act_tabDuplicate'); }, get words() { return `${t('act_tabDuplicateWords')} duplicate kopie`; }, run: async ({ windowId }) => chrome.tabs.duplicate((await activeTab(windowId)).id) },
  { id: 'tab.pin', get title() { return t('act_tabPin'); }, get words() { return `${t('act_tabPinWords')} pin anheften`; }, run: async ({ windowId }) => { const tab = await activeTab(windowId); await chrome.tabs.update(tab.id, { pinned: !tab.pinned }); } },
  { id: 'tab.mute', get title() { return t('act_tabMute'); }, get words() { return `${t('act_tabMuteWords')} mute ton audio`; }, run: async ({ windowId }) => { const tab = await activeTab(windowId); await chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted }); } },
  { id: 'tab.reload', get title() { return t('act_tabReload'); }, get words() { return `${t('act_tabReloadWords')} reload refresh`; }, run: async ({ windowId }) => chrome.tabs.reload((await activeTab(windowId)).id) },
  { id: 'tab.detach', get title() { return t('act_tabDetach'); }, get words() { return `${t('act_tabDetachWords')} move window ablösen`; }, run: async ({ windowId }) => chrome.windows.create({ tabId: (await activeTab(windowId)).id }) },
  { id: 'window.new', get title() { return t('act_windowNew'); }, get words() { return `${t('act_windowNewWords')} new window`; }, run: () => chrome.windows.create({}) },
  { id: 'window.incognito', get title() { return t('act_windowIncognito'); }, get words() { return `${t('act_windowIncognitoWords')} incognito privat`; }, run: () => chrome.windows.create({ incognito: true }) },
  { id: 'dupes.close', flag: 'cleanup', get title() { return t('act_dupesClose'); }, get words() { return `${t('act_dupesCloseWords')} duplicates entdoppeln`; }, run: async ({ windowId }) => {
    const groups = await F.duplicates({ windowId });
    const tabIds = groups.flatMap((g) => g.close.map((tab) => tab.id));
    if (tabIds.length) await F.closeTabs({ tabIds, windowId });
    return tp('act_dupesClosed', tabIds.length);
  } },
  { id: 'sort.site', flag: 'sort', get title() { return t('act_sortSite'); }, get words() { return `${t('act_sortSiteWords')} sort domain`; }, run: ({ windowId }) => F.sortTabs({ windowId, by: 'site' }).then(() => t('act_sortedBySite')) },
  { id: 'sort.recent', flag: 'sort', get title() { return t('act_sortRecent'); }, get words() { return `${t('act_sortRecentWords')} sort recent`; }, run: ({ windowId }) => F.sortTabs({ windowId, by: 'recent' }).then(() => t('act_sortedByRecent')) },
  { id: 'sort.opened', flag: 'sort', get title() { return t('act_sortOpened'); }, get words() { return `${t('act_sortOpenedWords')} sort opened alt`; }, run: ({ windowId }) => F.sortTabs({ windowId, by: 'opened' }).then(() => t('act_sortedByOpened')) },
  { id: 'sort.title', flag: 'sort', get title() { return t('act_sortTitle'); }, get words() { return `${t('act_sortTitleWords')} sort alphabet`; }, run: ({ windowId }) => F.sortTabs({ windowId, by: 'title' }).then(() => t('act_sortedByTitle')) },
  { id: 'sort.priority', flag: 'sort', get title() { return t('act_sortPriority'); }, get words() { return `${t('act_sortPriorityWords')} sort wichtig`; }, jev: true, run: ({ windowId }) => F.sortTabs({ windowId, by: 'priority' }).then(() => t('act_sortedByPriority')) },
  { id: 'groups.priority', flag: 'sort', get title() { return t('act_groupsPriority'); }, get words() { return `${t('act_groupsPriorityWords')} sort groups wichtig`; }, jev: true, run: ({ windowId }) => F.sortGroups({ windowId }).then((r) => (r.moved ? t('act_groupsSorted') : t('act_groupsOrderOk'))) },
  { id: 'groups.auto', flag: 'groups', get title() { return t('act_groupsAuto'); }, get words() { return `${t('act_groupsAutoWords')} group ordnen`; }, jev: true, run: async ({ windowId }) => {
    const res = await F.proposeGroups({ windowId, onlyUngrouped: true });
    const plan = res.items.filter((i) => i.sure && i.target !== 'none').map((i) => ({ tabId: i.id, target: i.target }));
    if (plan.length) await F.applyGroups({ windowId, plan, options: res.options });
    return tp('act_groupsAutoResult', plan.length, res.items.length - plan.length);
  } },
  { id: 'groups.collapse', get title() { return t('act_groupsCollapse'); }, get words() { return `${t('act_groupsCollapseWords')} collapse`; }, run: async ({ windowId }) => {
    for (const g of await chrome.tabGroups.query({ windowId })) await chrome.tabGroups.update(g.id, { collapsed: true });
  } },
  { id: 'groups.expand', get title() { return t('act_groupsExpand'); }, get words() { return `${t('act_groupsExpandWords')} expand`; }, run: async ({ windowId }) => {
    for (const g of await chrome.tabGroups.query({ windowId })) await chrome.tabGroups.update(g.id, { collapsed: false });
  } },
  { id: 'groups.ungroup', get title() { return t('act_groupsUngroup'); }, get words() { return `${t('act_groupsUngroupWords')} ungroup`; }, run: async ({ windowId }) => {
    const tabIds = (await chrome.tabs.query({ windowId })).filter((tab) => tab.groupId !== -1).map((tab) => tab.id);
    if (!tabIds.length) return t('act_noGroups');
    await H.beforeAction(LABEL.ungroup, windowId);
    await chrome.tabs.ungroup(tabIds);
    return t('act_groupsDissolved');
  } },
  { id: 'undo', flag: 'undo', get title() { return t('act_undo'); }, get words() { return `${t('act_undoWords')} undo zurück`; }, run: async ({ windowId }) => {
    const r = await H.undoLastAction({ windowId });
    return r.ok ? t('act_undoRestored', labelText(r.label)) : t('act_undoNothing');
  } },
  { id: 'snapshot', flag: 'history', get title() { return t('act_snapshot'); }, get words() { return `${t('act_snapshotWords')} backup snapshot`; }, run: () => H.takeSnapshot(REASON.manual, { force: true }).then(() => t('act_saved')) },
  { id: 'bookmark.add', get title() { return t('act_bookmarkAdd'); }, get words() { return `${t('act_bookmarkAddWords')} bookmark merken ordner`; }, needs: 'bookmarks', run: ({ windowId }) => X.bookmarkWithFolder({ windowId }).then((r) => r.message) },
  { id: 'note.edit', flag: 'notes', get title() { return t('act_noteEdit'); }, get words() { return `${t('act_noteEditWords')} note notiz merken`; }, run: async ({ windowId }) => { await X.openNoteEditor(await activeTab(windowId)); } },
  { id: 'groups.names', flag: 'groupNames', jev: true, get title() { return t('act_groupsNames'); }, get words() { return `${t('act_groupsNamesWords')} group name benennen`; }, run: ({ windowId }) => X.suggestGroupNames({ windowId }).then((r) => r.message) },
  { id: 'session.save', flag: 'sessions', get title() { return t('act_sessionSave'); }, get words() { return `${t('act_sessionSaveWords')} session speichern sichern`; }, run: ({ windowId }) => X.saveSession({ windowId }).then((s) => t('act_sessionSavedAs', s.name)) },
  { id: 'focus.start', flag: 'focus', get title() { return t('act_focusStart'); }, get words() { return `${t('act_focusStartWords')} focus konzentration pomodoro`; }, run: ({ windowId }) => X.startFocus({ windowId }).then((r) => r.message) },
  { id: 'focus.end', flag: 'focus', get title() { return t('act_focusEnd'); }, get words() { return `${t('act_focusEndWords')} focus stop`; }, run: () => X.endFocus().then((r) => r.message) },
  { id: 'links.md', flag: 'copyLinks', get title() { return t('act_linksMd'); }, get words() { return `${t('act_linksMdWords')} copy links markdown liste`; }, run: async ({ windowId }) => ({ copy: toLinkList(await chrome.tabs.query({ windowId })), message: t('act_linksCopied') }) },
  { id: 'links.group', flag: 'copyLinks', get title() { return t('act_linksGroup'); }, get words() { return `${t('act_linksGroupWords')} copy links gruppe`; }, run: async ({ windowId }) => {
    const tab = await activeTab(windowId);
    const tabs = tab.groupId === -1 ? [tab] : await chrome.tabs.query({ windowId, groupId: tab.groupId });
    return { copy: toLinkList(tabs), message: tp('act_linksCountCopied', tabs.length) };
  } },
  { id: 'links.text', flag: 'copyLinks', get title() { return t('act_linksText'); }, get words() { return `${t('act_linksTextWords')} copy links text mail`; }, run: async ({ windowId }) => ({ copy: toLinkList(await chrome.tabs.query({ windowId }), 'text'), message: t('act_linksCopied') }) },
  ...SNOOZE_PRESETS.map((p) => ({
    id: `snooze.${p.id}`,
    flag: 'snooze',
    get title() { return t('act_snoozePreset', p.label); },
    get words() { return `${t('act_snoozeWords')} snooze später wiedervorlage`; },
    run: ({ windowId }) => X.snoozeTab({ windowId, preset: p.id }).then((r) => r.message),
  })),
  { id: 'dupeguard.pause', flag: 'dupeGuard', get title() { return t('act_dupeguardPause'); }, get words() { return `${t('act_dupeguardPauseWords')} duplicate pause`; }, run: () => X.pauseDupeGuard({ minutes: 10 }).then((r) => r.message) },
  { id: 'discard.now', flag: 'discard', get title() { return t('act_discardNow'); }, get words() { return `${t('act_discardNowWords')} discard speicher memory`; }, run: ({ windowId }) => X.discardInactive({ windowId, all: true }).then((r) => r.message) },
  { id: 'stats.open', flag: 'stats', get title() { return t('act_statsOpen'); }, get words() { return `${t('act_statsOpenWords')} stats zahlen übersicht`; }, run: () => chrome.tabs.create({ url: chrome.runtime.getURL('src/stats/stats.html') }) },
  { id: 'forms.save', flag: 'forms', get title() { return t('act_formsSave'); }, get words() { return `${t('act_formsSaveWords')} form formular merken`; }, run: ({ windowId }) => FO.saveForm({ windowId }).then((r) => r.message) },
  { id: 'forms.fill', flag: 'forms', get title() { return t('act_formsFill'); }, get words() { return `${t('act_formsFillWords')} form formular füllen`; }, run: async ({ windowId }) => {
    const tab = await activeTab(windowId);
    const mine = (await FO.listProfiles()).filter((p) => p.host === hostOf(tab.url));
    if (mine.length === 1) return FO.fillForm({ windowId, profileId: mine[0].id }).then((r) => r.message);
    return { query: '/f ' };
  } },
  { id: 'forms.test', flag: 'formsTestData', get title() { return t('act_formsTest'); }, get words() { return `${t('act_formsTestWords')} form test fake dummy`; }, run: ({ windowId }) => FO.fillTestData({ windowId }).then((r) => r.message) },
  { id: 'unlock.tab', flag: 'copyUnlock', get title() { return t('act_unlockTab'); }, get words() { return `${t('act_unlockTabWords')} copy paste rechtsklick markieren entsperren unlock`; }, run: ({ windowId }) => U.unlockTab({ windowId }).then((r) => r.message) },
  // origin: die Schnellsuche fragt vorher nach dem Leserecht für die Website des aktiven Tabs.
  { id: 'unlock.always', flag: 'copyUnlock', origin: true, get title() { return t('act_unlockAlways'); }, get words() { return `${t('act_unlockAlwaysWords')} copy paste immer website unlock`; }, run: async ({ windowId }) => {
    const tab = await activeTab(windowId);
    return U.setAlwaysUnlock({ host: U.hostKey(tab.url), on: true, windowId }).then((r) => r.message);
  } },
  { id: 'pagesearch.open', flag: 'pageSearch', jev: true, get title() { return t('act_pageSearchOpen'); }, get words() { return `${t('act_pageSearchOpenWords')} seitensuche needle bedeutung find page`; }, run: ({ windowId }) => PS.openPageSearch({ windowId }) },
  { id: 'declutter.page', flag: 'declutter', jev: true, get title() { return t('act_declutterPage'); }, get words() { return `${t('act_declutterPageWords')} declutter unclutter werbung ads cookie aufräumen`; }, run: async ({ windowId }) => {
    const r = await DC.analyzeTab({ windowId });
    return tp('act_declutterDone', r.rules ?? 0);
  } },
  { id: 'declutter.pause', flag: 'declutter', get title() { return t('act_declutterPause'); }, get words() { return `${t('act_declutterPauseWords')} declutter pause`; }, run: ({ windowId }) => DC.toggle({ windowId }).then((r) => r.message) },
  { id: 'options', get title() { return t('act_options'); }, get words() { return `${t('act_optionsWords')} settings options`; }, run: () => chrome.runtime.openOptionsPage() },
  { id: 'shortcuts', get title() { return t('act_shortcuts'); }, get words() { return `${t('act_shortcutsWords')} shortcut hotkey`; }, run: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) },
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
  if (!action) throw new Error(t('act_unknownAction'));
  const result = await action.run({ windowId });
  if (typeof result === 'string') return { message: result };
  if (result && typeof result === 'object' && ('copy' in result || 'query' in result)) return result;
  return { message: null };
}
