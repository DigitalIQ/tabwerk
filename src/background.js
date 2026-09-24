// Service Worker: nimmt Aufträge aus Popup, Schnellsuche und Einstellungen an,
// hört auf Tab-Ereignisse, weckt Wächter und baut das Kontextmenü.

import * as F from './lib/features.js';
import * as W from './lib/watch.js';
import * as H from './lib/history.js';
import * as A from './lib/actions.js';
import * as X from './lib/extras.js';
import * as FO from './lib/formsbg.js';
import * as T from './lib/transfer.js';
import * as U from './lib/unlock.js';
import * as Learn from './lib/learn.js';
import * as PS from './lib/pagesearchbg.js';
import * as DC from './lib/declutterbg.js';
import { decide } from './lib/jev.js';
import { getUsage, getSettings } from './lib/settings.js';
import { isOn } from './lib/flags.js';
import { SNOOZE_PRESETS } from './lib/snoozetime.js';
import { REASON, labelText } from './lib/reasons.js';
import { initI18n, t, language } from './lib/i18n.js';

// Service Worker: kein Top-Level-await. Die Aktionen warten selbst darauf.
const i18nReady = initI18n();

const handlers = {
  duplicates: F.duplicates,
  similar: F.similar,
  closeTabs: F.closeTabs,
  find: F.find,
  focusTab: F.focusTab,
  proposeGroups: F.proposeGroups,
  applyGroups: F.applyGroups,
  sortTabs: F.sortTabs,
  sortGroups: F.sortGroups,
  undo: H.undoLastAction,
  lastAction: H.getLastAction,
  paletteActions: A.listActions,
  runAction: A.runAction,
  listSnapshots: H.listSnapshots,
  getSnapshot: ({ id }) => H.getSnapshot(id),
  restoreSnapshot: H.restoreFromHistory,
  saveSnapshot: () => H.takeSnapshot(REASON.manual, { force: true }),
  clearHistory: H.clearHistory,
  compactHistory: H.compactHistory,
  listWatches: W.listWatches,
  createWatch: W.createWatch,
  removeWatch: W.removeWatch,
  toggleWatch: W.toggleWatch,
  checkWatch: ({ id }) => W.checkWatch(id),
  suggestCleanup: X.suggestCleanup,
  suggestGroupNames: X.suggestGroupNames,
  listNotes: X.listNotes,
  getNote: X.getNote,
  setNote: X.setNote,
  addNote: X.addNote,
  listSessions: X.listSessions,
  saveSession: X.saveSession,
  renameSession: X.renameSession,
  deleteSession: X.deleteSession,
  openSession: X.openSession,
  focusState: X.focusState,
  startFocus: X.startFocus,
  endFocus: X.endFocus,
  allowOnce: X.allowOnce,
  findHistory: X.findHistory,
  tabTexts: X.tabTexts,
  listSnoozed: X.listSnoozed,
  snoozeTab: X.snoozeTab,
  wakeSnoozed: ({ id }) => X.wakeSnoozed({ id, notify: false }),
  stats: X.stats,
  discardInactive: X.discardInactive,
  listProfiles: FO.listProfiles,
  saveForm: FO.saveForm,
  fillForm: FO.fillForm,
  fillTestData: FO.fillTestData,
  renameProfile: FO.renameProfile,
  deleteProfile: FO.deleteProfile,
  learnRecord: Learn.record,
  learnState: Learn.learnState,
  learnRules: Learn.ruleSuggestions,
  acceptRule: Learn.acceptRule,
  dismissRule: Learn.dismissRule,
  clearLearn: Learn.clearLearn,
  learnJsonl: Learn.learnJsonl,
  watchFeedback: W.watchFeedback,
  pageSearch: PS.evaluate,
  openPageSearch: ({ windowId, query }) => PS.openPageSearch({ windowId, query }),
  declutterStatus: DC.status,
  declutterAnalyze: DC.analyzeTab,
  declutterToggle: DC.toggle,
  declutterRule: DC.setRule,
  declutterForget: DC.forget,
  declutterNever: DC.setNever,
  unlockTab: U.unlockTab,
  setAlwaysUnlock: U.setAlwaysUnlock,
  listUnlockHosts: U.listUnlockHosts,
  exportAll: T.exportAll,
  importAll: T.importAll,
  usage: getUsage,
  // Kleiner Probelauf mit erfundenem Text für die Einstellungen.
  testJev: () => decide({ tab: { title: 'Invoice 2026-114, please pay by Friday', site: 'billing.example' } }, {
    about_money: {
      type: 'noul',
      instructions: 'Is the browser tab `tab` about a payment?',
      criteria: { true: 'The tab is about paying, billing or an invoice', false: 'The tab is about something else' },
    },
  }),
};

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.target === 'offscreen') return false;
  const handler = handlers[message?.type];
  if (!handler) return false;
  i18nReady
    .then(() => handler(message.payload || {}))
    .then((data) => reply({ ok: true, data }))
    .catch((error) => reply({ ok: false, error: error.message, code: error.code, detail: error.detail }));
  return true;
});

// ---------- Tab-Ereignisse ----------

chrome.tabs.onCreated.addListener((tab) => F.trackOpened(tab.id));

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url) {
    X.guardDuplicate(tabId, change.url).catch(() => {});
    X.guardFocus(tabId, change.url).catch(() => {});
  }
  if (change.status === 'complete') X.autoGroupTab(tab).catch(() => {});
});

// Verlauf: jede Änderung an Fenstern, Tabs und Gruppen löst eine Sicherung aus.
for (const event of [
  chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.tabs.onReplaced,
  chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated, chrome.tabGroups.onRemoved, chrome.tabGroups.onMoved,
  chrome.windows.onCreated, chrome.windows.onRemoved,
]) event.addListener(() => H.scheduleSnapshot());
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || 'pinned' in change || 'groupId' in change) H.scheduleSnapshot();
});

// ---------- Wecker ----------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'history') {
    if (isOn(await getSettings(), 'history')) H.takeSnapshot(REASON.auto);
  } else if (alarm.name === 'discard') {
    X.discardInactive();
  } else if (alarm.name === 'focus-end') {
    X.endFocus();
  } else if (alarm.name.startsWith('snooze:')) {
    X.wakeSnoozed({ id: alarm.name.slice(7) });
  } else if (alarm.name.startsWith('watch:')) {
    W.checkWatch(alarm.name.slice(6));
  }
});

chrome.notifications.onClicked.addListener(async (id) => {
  if (id.startsWith('watch:')) W.openFromNotification(id);
  if (id.startsWith('woke:')) {
    const tabId = Number(id.split(':')[1]);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    chrome.notifications.clear(id);
  }
});

chrome.notifications.onButtonClicked.addListener((id, index) => {
  if (id.startsWith('dupe:')) X.onDupeButton(id, index);
});

async function ensureAlarms() {
  // Sicherheitsnetz, falls der Service Worker ein Ereignis verschlafen hat.
  if (!(await chrome.alarms.get('history'))) await chrome.alarms.create('history', { periodInMinutes: 10 });
  if (!(await chrome.alarms.get('discard'))) await chrome.alarms.create('discard', { periodInMinutes: 5 });
}

// ---------- Kontextmenü ----------

const WEB = ['http://*/*', 'https://*/*'];

async function createMenus() {
  await i18nReady;
  const settings = await getSettings();
  const on = (id) => isOn(settings, id);
  await chrome.contextMenus.removeAll();
  const add = (props) => chrome.contextMenus.create({ documentUrlPatterns: WEB, ...props });
  if (on('watches')) {
    add({ id: 'watch-page', title: t('bg_watchPage'), contexts: ['page'] });
    add({ id: 'watch-selection', title: t('bg_watchSelection'), contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'watch-link', title: t('bg_watchLink'), contexts: ['link'], targetUrlPatterns: WEB });
  }
  if (on('notes')) add({ id: 'note', title: t('bg_noteMenu'), contexts: ['page', 'selection'] });
  if (on('snooze')) {
    add({ id: 'snooze', title: t('bg_snoozeMenu'), contexts: ['page'] });
    for (const p of SNOOZE_PRESETS) add({ id: `snooze:${p.id}`, parentId: 'snooze', title: p.label, contexts: ['page'] });
  }
  if (on('copyUnlock')) add({ id: 'unlock', title: t('bg_unlockMenu'), contexts: ['page', 'editable', 'selection', 'image', 'link'] });
  if (on('forms')) {
    add({ id: 'form-save', title: t('bg_formSaveMenu'), contexts: ['page', 'editable'] });
    add({ id: 'form-fill', title: t('bg_formFillMenu'), contexts: ['page', 'editable'] });
    if (on('formsTestData')) add({ id: 'form-test', title: t('bg_formTestMenu'), contexts: ['page', 'editable'] });
  }
  if (await chrome.permissions.contains({ permissions: ['bookmarks'] })) {
    add({ id: 'bookmark', title: on('bookmarkFolder') ? t('bg_bookmarkFolderMenu') : t('bg_bookmarkPlainMenu'), contexts: ['page'] });
  }
}

function centered(base, width, height, top = 80) {
  return {
    type: 'popup', width, height,
    left: Math.round((base.left ?? 0) + ((base.width ?? width) - width) / 2),
    top: Math.round((base.top ?? 0) + top),
  };
}

// Kurze Rückmeldung direkt auf der Seite, für Aktionen aus Kontextmenü und Tastenkürzeln.
async function toast(tabId, text) {
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [text],
    func: (message) => {
      const el = document.createElement('div');
      el.textContent = message;
      el.setAttribute('role', 'status');
      el.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:50%;bottom:28px;transform:translateX(-50%);'
        + 'background:rgba(20,24,29,0.92);color:#fff;font:500 13px/1.4 system-ui,sans-serif;padding:10px 14px;border-radius:10px;'
        + 'box-shadow:0 8px 24px rgba(0,0,0,0.25);max-width:80vw;';
      document.documentElement.appendChild(el);
      setTimeout(() => el.remove(), 2600);
    },
  }).catch(() => {});
}

const hostOfTab = (tab) => { try { return new URL(tab.url).hostname.replace(/^www\./, ''); } catch { return ''; } };

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  const base = tab?.windowId ? await chrome.windows.get(tab.windowId) : await chrome.windows.getLastFocused();
  const say = (p) => p.then((r) => toast(tab.id, r?.message || t('bg_done'))).catch((e) => toast(tab.id, e.message));
  if (id.startsWith('watch-')) {
    const url = id === 'watch-link' ? info.linkUrl : info.pageUrl;
    const params = new URLSearchParams({ url });
    if (id === 'watch-selection') params.set('sel', (info.selectionText || '').slice(0, 300));
    await chrome.windows.create({ url: chrome.runtime.getURL(`src/watch/new.html?${params}`), ...centered(base, 460, 600) });
  } else if (id === 'note') {
    await X.openNoteEditor(tab);
  } else if (id.startsWith('snooze:')) {
    say(X.snoozeTab({ tabId: tab.id, preset: id.slice(7) }));
  } else if (id === 'form-save') {
    say(FO.saveForm({ windowId: tab.windowId }));
  } else if (id === 'form-test') {
    say(FO.fillTestData({ windowId: tab.windowId }));
  } else if (id === 'form-fill') {
    const mine = (await FO.listProfiles()).filter((p) => p.host === hostOfTab(tab));
    if (mine.length === 1) say(FO.fillForm({ windowId: tab.windowId, profileId: mine[0].id }));
    else openPalette(tab, '/f ');
  } else if (id === 'unlock') {
    say(U.unlockTab({ tabId: tab.id }));
  } else if (id === 'bookmark') {
    say(X.bookmarkWithFolder({ windowId: tab.windowId }));
  }
});

// Menü neu bauen, wenn sich Schalter oder Rechte ändern.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.features) createMenus();
  if (area === 'local' && (changes.features || changes.unlockHosts)) U.syncUnlockScripts().catch(() => {});
  if (area === 'local' && changes.features) DC.syncDeclutterScript().catch(() => {});
  else if (area === 'local' && (changes.declutterHidden || changes.declutterNever || changes.excludedHosts)) DC.refreshAll().catch(() => {});
  if (area === 'local' && changes.uiLanguage) {
    // i18nProbe: aktive Sprache des Service Workers, für den Browser-Test.
    initI18n().then(() => { chrome.storage.session.set({ i18nProbe: language() }); return createMenus(); });
  }
});
chrome.permissions.onAdded.addListener(() => { createMenus(); U.syncUnlockScripts().catch(() => {}); DC.syncDeclutterScript().catch(() => {}); });
chrome.permissions.onRemoved.addListener(() => { createMenus(); U.syncUnlockScripts().catch(() => {}); DC.syncDeclutterScript().catch(() => {}); });

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await createMenus();
  await W.rescheduleAll();
  await ensureAlarms();
  H.takeSnapshot(REASON.first);
  if (reason === 'update') H.compactHistory().catch(() => {});
  U.syncUnlockScripts().catch(() => {});
  DC.syncDeclutterScript().catch(() => {});
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await createMenus();
  await W.rescheduleAll();
  await ensureAlarms();
  if (isOn(await getSettings(), 'history')) H.takeSnapshot(REASON.startup);
  H.compactHistory().catch(() => {});
  if (await X.focusState()) chrome.action.setBadgeText({ text: t('bg_focusBadge') });
});

// ---------- Schnellsuche ----------

// Auf normalen Seiten legt Tabwerk die Suche über die Seite. Auf chrome:// und im Web Store
// geht das nicht, dann öffnet sich ein kleines Fenster. query startet die Suche mit einer Eingabe.
async function openPalette(tab, query = '') {
  if (!isOn(await getSettings(), 'palette')) return;
  if (tab?.id && /^(https?|file):/.test(tab.url || '')) {
    try {
      if (query) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [query], func: (q) => { window.__tabwerkPaletteQuery = q; } });
      }
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/palette/content.js'] });
      return;
    } catch {}
  }
  const { paletteWindow } = await chrome.storage.session.get('paletteWindow');
  if (paletteWindow) {
    try {
      await chrome.windows.remove(paletteWindow);
      await chrome.storage.session.remove('paletteWindow');
      return;
    } catch {}
  }
  const base = tab?.windowId ? await chrome.windows.get(tab.windowId) : await chrome.windows.getLastFocused();
  const params = new URLSearchParams({ standalone: '1', win: String(base.id) });
  if (query) params.set('q', query);
  const win = await chrome.windows.create({ url: chrome.runtime.getURL(`src/palette/palette.html?${params}`), ...centered(base, 680, 520, 90) });
  await chrome.storage.session.set({ paletteWindow: win.id });
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  const target = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  const settings = await getSettings();
  if (command === 'open-palette') openPalette(target);
  if (command === 'tab-note' && isOn(settings, 'notes')) X.openNoteEditor(target);
  if (command === 'undo' && isOn(settings, 'undo')) {
    const r = await H.undoLastAction({ windowId: target.windowId });
    if (/^https?:/.test(target.url || '')) toast(target.id, r.ok ? t('bg_undoRestored', labelText(r.label)) : t('bg_undoNothing'));
  }
  if (command === 'fill-form' && isOn(settings, 'forms')) {
    const mine = (await FO.listProfiles()).filter((p) => p.host === hostOfTab(target));
    if (mine.length === 1) FO.fillForm({ windowId: target.windowId, profileId: mine[0].id }).then((r) => toast(target.id, r.message)).catch((e) => toast(target.id, e.message));
    else openPalette(target, '/f ');
  }
  if (command === 'page-search') PS.openPageSearch({ tab: target });
});

chrome.windows.onRemoved.addListener(async (id) => {
  const { paletteWindow } = await chrome.storage.session.get('paletteWindow');
  if (paletteWindow === id) chrome.storage.session.remove('paletteWindow');
});
