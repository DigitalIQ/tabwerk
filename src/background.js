// Service Worker: nimmt Aufträge aus Popup und Einstellungen an und startet die Wächter.

import * as F from './lib/features.js';
import * as W from './lib/watch.js';
import * as H from './lib/history.js';
import * as A from './lib/actions.js';
import { decide } from './lib/jev.js';
import { getUsage } from './lib/settings.js';

const handlers = {
  duplicates: F.duplicates,
  similar: F.similar,
  closeTabs: F.closeTabs,
  find: F.find,
  focusTab: F.focusTab,
  proposeGroups: F.proposeGroups,
  applyGroups: F.applyGroups,
  sortTabs: F.sortTabs,
  undo: H.undoLastAction,
  lastAction: H.getLastAction,
  sortGroups: F.sortGroups,
  paletteActions: A.listActions,
  runAction: A.runAction,
  listSnapshots: H.listSnapshots,
  getSnapshot: ({ id }) => H.getSnapshot(id),
  restoreSnapshot: H.restoreFromHistory,
  saveSnapshot: () => H.takeSnapshot('Von Hand gesichert', { force: true }),
  clearHistory: H.clearHistory,
  listWatches: W.listWatches,
  createWatch: W.createWatch,
  removeWatch: W.removeWatch,
  toggleWatch: W.toggleWatch,
  checkWatch: ({ id }) => W.checkWatch(id),
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
  Promise.resolve(handler(message.payload || {}))
    .then((data) => reply({ ok: true, data }))
    .catch((error) => reply({ ok: false, error: error.message, code: error.code, detail: error.detail }));
  return true;
});

chrome.tabs.onCreated.addListener((tab) => F.trackOpened(tab.id));

// Verlauf: jede Änderung an Fenstern, Tabs und Gruppen löst eine Sicherung aus.
for (const event of [
  chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.tabs.onReplaced,
  chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated, chrome.tabGroups.onRemoved, chrome.tabGroups.onMoved,
  chrome.windows.onCreated, chrome.windows.onRemoved,
]) event.addListener(() => H.scheduleSnapshot());
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || 'pinned' in change || 'groupId' in change) H.scheduleSnapshot();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'history') H.takeSnapshot('Automatisch');
  if (alarm.name.startsWith('watch:')) W.checkWatch(alarm.name.slice(6));
});

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith('watch:')) W.openFromNotification(id);
});

// Sicherheitsnetz, falls der Service Worker ein Ereignis verschlafen hat.
async function ensureHistoryAlarm() {
  if (!(await chrome.alarms.get('history'))) await chrome.alarms.create('history', { periodInMinutes: 10 });
}

// ---------- Kontextmenü: Wächter direkt von der Seite ----------

const WEB = ['http://*/*', 'https://*/*'];

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'watch-page', title: 'Tabwerk: Diese Seite beobachten …', contexts: ['page'], documentUrlPatterns: WEB });
    chrome.contextMenus.create({ id: 'watch-selection', title: 'Tabwerk: Auf „%s“ achten …', contexts: ['selection'], documentUrlPatterns: WEB });
    chrome.contextMenus.create({ id: 'watch-link', title: 'Tabwerk: Verlinkte Seite beobachten …', contexts: ['link'], targetUrlPatterns: WEB });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.menuItemId.startsWith('watch-')) return;
  const url = info.menuItemId === 'watch-link' ? info.linkUrl : info.pageUrl;
  const params = new URLSearchParams({ url });
  if (info.menuItemId === 'watch-selection') params.set('sel', (info.selectionText || '').slice(0, 300));
  const base = tab?.windowId ? await chrome.windows.get(tab.windowId) : await chrome.windows.getLastFocused();
  const width = 460;
  await chrome.windows.create({
    url: chrome.runtime.getURL(`src/watch/new.html?${params}`),
    type: 'popup',
    width,
    height: 560,
    left: Math.round((base.left ?? 0) + ((base.width ?? width) - width) / 2),
    top: Math.round((base.top ?? 0) + 80),
  });
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  createMenus();
  await W.rescheduleAll();
  await ensureHistoryAlarm();
  H.takeSnapshot('Erste Sicherung');
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await W.rescheduleAll();
  await ensureHistoryAlarm();
  H.takeSnapshot('Browserstart');
});

// ---------- Schnellsuche ----------

// Auf normalen Seiten legt Tabwerk die Suche über die Seite. Auf chrome:// und im Web Store
// geht das nicht, dann öffnet sich ein kleines Fenster.
async function openPalette(tab) {
  if (tab?.id && /^(https?|file):/.test(tab.url || '')) {
    try {
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
  const width = 680;
  const height = 520;
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`src/palette/palette.html?standalone=1&win=${base.id}`),
    type: 'popup',
    width,
    height,
    left: Math.round((base.left ?? 0) + ((base.width ?? width) - width) / 2),
    top: Math.round((base.top ?? 0) + 90),
  });
  await chrome.storage.session.set({ paletteWindow: win.id });
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'open-palette') return;
  openPalette(tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]);
});

chrome.windows.onRemoved.addListener(async (id) => {
  const { paletteWindow } = await chrome.storage.session.get('paletteWindow');
  if (paletteWindow === id) chrome.storage.session.remove('paletteWindow');
});

