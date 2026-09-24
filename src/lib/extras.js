// Weitere Funktionen: Aufräum-Vorschlag, Einsortieren, Doppel-Schutz, Entladen, Notizen,
// Gruppennamen, Sitzungen, Fokus, Verlauf-Suche, Volltext, Schlummern, Lesezeichen, Statistik.
// Jede Funktion prüft ihren Schalter selbst.

import { decide, decideChunked } from './jev.js';
import { getSettings, saveSettings, hasKey, CHROME_COLORS, hostMatches } from './settings.js';
import { isOn } from './flags.js';
import { normalizeUrl, hostOf, isWebUrl, describeTab } from './url.js';
import { parseRules, matchRule } from './rules.js';
import { nameCandidates } from './groupnames.js';
import { timeWindow } from './timewindow.js';
import { wakeTime, SNOOZE_PRESETS } from './snoozetime.js';
import { beforeAction, captureWindow, listSnapshots } from './history.js';
import * as P from './prompts.js';

const ownUrl = () => chrome.runtime.getURL('');
const off = (name) => { const e = new Error(`${name} ist in den Einstellungen ausgeschaltet.`); e.code = 'off'; return e; };

async function need(id, name) {
  const settings = await getSettings();
  if (!isOn(settings, id)) throw off(name);
  return settings;
}

async function sessionGet(key, fallback) {
  const { [key]: v } = await chrome.storage.session.get(key);
  return v ?? fallback;
}

// ---------- Aufräum-Vorschlag ----------

export async function suggestCleanup({ windowId, useJev = true }) {
  const settings = await need('cleanupSuggest', 'Der Aufräum-Vorschlag');
  const now = Date.now();
  const tabs = (await chrome.tabs.query({ windowId }))
    .filter((t) => !t.pinned && !t.active && !t.audible && isWebUrl(t.url) && !hostMatches(hostOf(t.url), settings.excludedHosts));
  let scores = {};
  let cost;
  const jev = useJev && hasKey(settings);
  if (jev && tabs.length) {
    const byKey = new Map(tabs.map((t) => [P.tabKey(t), t]));
    const result = await decideChunked([...byKey.keys()], (keys) => P.tabState(keys.map((k) => byKey.get(k))),
      (key) => P.priorityQuestion(key, settings.priorityLevels, settings.priorityFocus));
    cost = result.cost;
    scores = Object.fromEntries(Object.entries(result.answers).map(([k, a]) => [P.idFromKey(k), a]));
  }
  const oldMs = settings.cleanupDays * 864e5;
  const items = tabs.map((t) => {
    const age = now - (t.lastAccessed || now);
    const s = scores[t.id];
    const reasons = [];
    if (age >= oldMs) reasons.push(`seit ${Math.floor(age / 864e5)} Tagen nicht benutzt`);
    if (s && s.score < 0.75) reasons.push('Jev: kann weg');
    const sure = s ? s.confidence >= settings.confidence : false;
    const preselect = (s && s.score < 0.75 && sure) || (age >= oldMs && (!s || s.score < 1.5));
    return { id: t.id, title: t.title, url: t.url, lastAccessed: t.lastAccessed, score: s?.score, confidence: s?.confidence, reasons, preselect };
  }).filter((i) => i.reasons.length)
    .sort((a, b) => Number(b.preselect) - Number(a.preselect) || (a.lastAccessed || 0) - (b.lastAccessed || 0));
  return { items, cost, jev, threshold: settings.confidence };
}

// ---------- Neue Tabs einsortieren ----------

async function groupInto(windowId, tabIds, name, color) {
  const existing = (await chrome.tabGroups.query({ windowId })).find((g) => (g.title || '').toLowerCase() === name.toLowerCase());
  if (existing) return chrome.tabs.group({ groupId: existing.id, tabIds });
  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: name, color: color || 'grey' });
  return groupId;
}

export async function autoGroupTab(tab) {
  const settings = await getSettings();
  if (!isOn(settings, 'autoGroup') || tab.groupId !== -1 || tab.pinned || !isWebUrl(tab.url)) return null;
  const done = await sessionGet('autoGrouped', {});
  if (done[tab.id]) return null;
  const opened = (await sessionGet('openedAt', {}))[tab.id];
  if (!opened || Date.now() - opened > 120e3) return null;
  done[tab.id] = true;
  await chrome.storage.session.set({ autoGrouped: done });

  const colorOf = (name) => settings.categories.find((c) => c.name.toLowerCase() === name.toLowerCase())?.color;
  const rule = matchRule(hostOf(tab.url), parseRules(settings.groupRules));
  if (rule) {
    await groupInto(tab.windowId, [tab.id], rule.group, colorOf(rule.group));
    return { via: 'rule', group: rule.group };
  }
  if (!isOn(settings, 'autoGroupJev') || !hasKey(settings) || hostMatches(hostOf(tab.url), settings.excludedHosts)) return null;
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
  const { criteria, meta } = P.groupOptions(groups, settings.categories);
  const key = P.tabKey(tab);
  const result = await decide(P.tabState([tab]), { [key]: P.groupQuestion(key, criteria) });
  const a = result.answers[key];
  if (a.choice === 'none' || a.confidence < settings.confidence) return null;
  const opt = meta[a.choice];
  if (opt.type === 'existing') await chrome.tabs.group({ groupId: opt.groupId, tabIds: [tab.id] });
  else await groupInto(tab.windowId, [tab.id], opt.name, opt.color);
  return { via: 'jev', group: opt.name };
}

// ---------- Doppelte beim Öffnen abfangen ----------

const FRESH = /^(chrome:\/\/newtab|chrome:\/\/new-tab-page|about:blank|$)/;

export async function rememberUrl(tabId, url) {
  const urls = await sessionGet('tabUrls', {});
  urls[tabId] = url;
  await chrome.storage.session.set({ tabUrls: urls });
}

export async function guardDuplicate(tabId, url) {
  const settings = await getSettings();
  const urls = await sessionGet('tabUrls', {});
  const previous = urls[tabId];
  await rememberUrl(tabId, url);
  if (!isOn(settings, 'dupeGuard') || !isWebUrl(url)) return null;
  // Nur frisch geöffnete Tabs. Wer in einem Tab weiterklickt, bleibt unbehelligt.
  if (previous !== undefined && !FRESH.test(previous)) return null;
  if (hostMatches(hostOf(url), settings.dupeGuardAllow)) return null;
  if ((await sessionGet('dupePausedUntil', 0)) > Date.now()) return null;
  // Tabwerk öffnet selbst gerade Tabs, etwa beim Wiederherstellen.
  if ((await sessionGet('dupeQuietUntil', 0)) > Date.now()) return null;
  const key = normalizeUrl(url);
  const other = (await chrome.tabs.query({})).find((t) => t.id !== tabId && t.url && normalizeUrl(t.url) === key);
  if (!other) return null;
  // Zweimal hintereinander dieselbe Seite öffnen heißt: beide behalten.
  const last = await sessionGet('dupeLast', null);
  if (last && last.key === key && Date.now() - last.t < 20e3) {
    await chrome.storage.session.remove('dupeLast');
    return { kept: true };
  }
  await chrome.storage.session.set({ dupeLast: { key, t: Date.now(), newTab: tabId, oldTab: other.id, windowId: other.windowId } });
  if (settings.dupeGuardMode === 'ask') {
    chrome.notifications.create(`dupe:${tabId}:${other.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Diese Seite ist schon offen',
      message: other.title || url,
      buttons: [{ title: 'Zum offenen Tab' }, { title: 'Beide behalten' }],
      priority: 1,
    });
    return { asked: true };
  }
  // Der neue Tab kann schon wieder zu sein, etwa bei Pop-ups, die sich selbst schließen.
  if (!(await chrome.tabs.get(tabId).catch(() => null))) return { gone: true };
  await chrome.tabs.update(other.id, { active: true });
  await chrome.windows.update(other.windowId, { focused: true });
  await chrome.tabs.remove(tabId).catch(() => {});
  chrome.notifications.create(`dupeinfo:${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Zum offenen Tab gewechselt',
    message: 'Öffne die Seite innerhalb von 20 Sekunden noch einmal, dann bleiben beide offen.',
    priority: 0,
  });
  return { switched: other.id };
}

export async function onDupeButton(notificationId, buttonIndex) {
  const [, newTab, oldTab] = notificationId.split(':').map(Number);
  chrome.notifications.clear(notificationId);
  if (buttonIndex !== 0) return;
  try {
    const old = await chrome.tabs.get(oldTab);
    await chrome.tabs.update(old.id, { active: true });
    await chrome.windows.update(old.windowId, { focused: true });
    await chrome.tabs.remove(newTab);
  } catch {}
}

export async function pauseDupeGuard({ minutes = 10 }) {
  await chrome.storage.session.set({ dupePausedUntil: Date.now() + minutes * 60e3 });
  return { message: `Doppel-Schutz ${minutes} Minuten pausiert` };
}

// ---------- Inaktive Tabs entladen ----------

// dryRun zählt nur, ohne zu entladen.
export async function discardInactive({ windowId = null, all = false, dryRun = false } = {}) {
  const settings = await getSettings();
  if (!all && !isOn(settings, 'discard')) return { discarded: 0 };
  const limit = all ? 0 : settings.discardAfterMin * 60e3;
  const now = Date.now();
  const tabs = await chrome.tabs.query(windowId ? { windowId, discarded: false } : { discarded: false });
  let n = 0;
  for (const t of tabs) {
    if (t.active || t.pinned || t.audible || !isWebUrl(t.url)) continue;
    if (now - (t.lastAccessed || now) < limit) continue;
    if (dryRun) { n += 1; continue; }
    try {
      await chrome.tabs.discard(t.id);
      n += 1;
    } catch {}
  }
  return { discarded: n, message: `${n} Tabs entladen` };
}

// ---------- Notizen ----------

export async function listNotes() {
  const { notes = {} } = await chrome.storage.local.get('notes');
  return notes;
}

export async function getNote({ url }) {
  return (await listNotes())[normalizeUrl(url)] || null;
}

export async function setNote({ url, title, text }) {
  const notes = await listNotes();
  const key = normalizeUrl(url);
  if (text && text.trim()) notes[key] = { url, title: title || '', text: text.trim(), t: Date.now() };
  else delete notes[key];
  await chrome.storage.local.set({ notes });
  return notes[key] || null;
}

// Hängt Text an die Notiz des aktiven Tabs an. Eine vorhandene Notiz bleibt erhalten.
export async function addNote({ windowId, text }) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab?.url || !/^(https?|file):/.test(tab.url)) throw new Error('Notizen gehen nur auf normalen Webseiten.');
  const old = await getNote({ url: tab.url });
  const note = await setNote({ url: tab.url, title: tab.title, text: old ? `${old.text}\n${text.trim()}` : text });
  return { note, message: old ? 'Notiz ergänzt' : 'Notiz gespeichert' };
}

export async function openNoteEditor(tab) {
  if (!tab?.url) return;
  const params = new URLSearchParams({ url: tab.url, title: tab.title || '' });
  const base = await chrome.windows.get(tab.windowId);
  await chrome.windows.create({
    url: chrome.runtime.getURL(`src/note/note.html?${params}`),
    type: 'popup', width: 440, height: 360,
    left: Math.round((base.left ?? 0) + ((base.width ?? 440) - 440) / 2), top: Math.round((base.top ?? 0) + 90),
  });
}

// ---------- Gruppennamen ----------

export async function suggestGroupNames({ windowId, apply = true }) {
  const settings = await need('groupNames', 'Gruppennamen vorschlagen');
  const tabs = await chrome.tabs.query({ windowId });
  const groups = (await chrome.tabGroups.query({ windowId })).filter((g) => !g.title);
  if (!groups.length) return { groups: [], message: 'Alle Gruppen haben schon einen Namen' };
  const out = [];
  let cost = 0;
  for (const g of groups) {
    const members = tabs.filter((t) => t.groupId === g.id);
    const words = nameCandidates(members);
    const options = [...new Set([...words, ...settings.categories.map((c) => c.name)])].slice(0, 20);
    if (!options.length) continue;
    let name = options[0];
    let confidence = null;
    if (hasKey(settings)) {
      const criteria = Object.fromEntries(options.map((o, i) => [`n${i}`, o]));
      const result = await decide({ group_tabs: members.slice(0, 12).map((t) => describeTab(t)) }, {
        name: { type: 'choice', instructions: 'Which short name describes the browser tabs in `group_tabs` best as a tab group title?', criteria },
      });
      cost += result.cost || 0;
      name = options[Number(result.answers.name.choice.slice(1))];
      confidence = result.answers.name.confidence;
    }
    if (apply) await chrome.tabGroups.update(g.id, { title: name });
    out.push({ id: g.id, name, confidence, color: g.color });
  }
  return { groups: out, cost, message: `${out.length} Gruppen benannt` };
}

// ---------- Sitzungen ----------

export async function listSessions() {
  const { sessions = [] } = await chrome.storage.local.get('sessions');
  return sessions;
}

export async function saveSession({ windowId, name }) {
  await need('sessions', 'Sitzungen');
  const win = await captureWindow(windowId);
  const groups = win.groups.map((g) => g.title).filter(Boolean);
  const fallback = `${groups.slice(0, 2).join(', ') || hostOf(win.tabs.find((t) => isWebUrl(t.url))?.url || '') || 'Fenster'} · ${new Date().toLocaleDateString('de-DE')}`;
  const session = { id: crypto.randomUUID(), name: (name || '').trim() || fallback, t: Date.now(), windows: [win] };
  await chrome.storage.local.set({ sessions: [session, ...(await listSessions())] });
  return session;
}

export async function renameSession({ id, name }) {
  const sessions = await listSessions();
  const s = sessions.find((x) => x.id === id);
  if (s && name.trim()) s.name = name.trim();
  await chrome.storage.local.set({ sessions });
  return s;
}

export async function deleteSession({ id }) {
  await chrome.storage.local.set({ sessions: (await listSessions()).filter((s) => s.id !== id) });
  return { ok: true };
}

// Öffnet eine Sitzung in einem neuen Fenster, mit Gruppen.
export async function quietGuard(ms = 30e3) {
  await chrome.storage.session.set({ dupeQuietUntil: Date.now() + ms });
}

export async function openSession({ id }) {
  const s = (await listSessions()).find((x) => x.id === id);
  if (!s) throw new Error('Diese Sitzung gibt es nicht mehr.');
  await quietGuard();
  let opened = 0;
  for (const w of s.windows) {
    const tabs = w.tabs.filter((t) => isWebUrl(t.url));
    if (!tabs.length) continue;
    const win = await chrome.windows.create({ url: tabs[0].url, focused: true });
    const ids = [win.tabs[0].id];
    for (const t of tabs.slice(1)) {
      const created = await chrome.tabs.create({ windowId: win.id, url: t.url, active: false, pinned: t.pinned });
      ids.push(created.id);
    }
    if (tabs[0].pinned) await chrome.tabs.update(ids[0], { pinned: true });
    for (const g of w.groups) {
      const tabIds = tabs.map((t, i) => (t.groupId === g.id ? ids[i] : null)).filter(Boolean);
      if (!tabIds.length) continue;
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: win.id } });
      await chrome.tabGroups.update(groupId, { title: g.title, color: g.color, collapsed: g.collapsed });
    }
    opened += tabs.length;
  }
  return { opened, message: `„${s.name}“ geöffnet` };
}

// ---------- Fokus-Modus ----------

export async function focusState() {
  const { focus } = await chrome.storage.local.get('focus');
  return focus && focus.until > Date.now() ? focus : null;
}

export async function startFocus({ windowId, minutes }) {
  const settings = await need('focus', 'Der Fokus-Modus');
  const mins = Number(minutes) || settings.focusMinutes;
  const [active] = await chrome.tabs.query({ active: true, windowId });
  const collapsed = [];
  for (const g of await chrome.tabGroups.query({ windowId })) {
    if (g.id !== active?.groupId && !g.collapsed) {
      await chrome.tabGroups.update(g.id, { collapsed: true });
      collapsed.push(g.id);
    }
  }
  const focus = { until: Date.now() + mins * 60e3, windowId, collapsed, block: settings.focusBlock };
  await chrome.storage.local.set({ focus });
  await chrome.alarms.create('focus-end', { when: focus.until });
  await chrome.action.setBadgeBackgroundColor({ color: '#1f4fd8' });
  await chrome.action.setBadgeText({ text: 'F' });
  const end = new Date(focus.until).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return { message: `Fokus bis ${end}` };
}

export async function endFocus() {
  const { focus } = await chrome.storage.local.get('focus');
  if (focus) {
    for (const id of focus.collapsed || []) await chrome.tabGroups.update(id, { collapsed: false }).catch(() => {});
  }
  await chrome.storage.local.remove('focus');
  await chrome.alarms.clear('focus-end');
  await chrome.action.setBadgeText({ text: '' });
  return { message: 'Fokus beendet' };
}

export async function guardFocus(tabId, url) {
  const focus = await focusState();
  if (!focus || !isWebUrl(url)) return;
  const settings = await getSettings();
  if (!isOn(settings, 'focus') || !hostMatches(hostOf(url), focus.block)) return;
  const allowed = await sessionGet('focusAllow', []);
  if (allowed.includes(normalizeUrl(url))) return;
  await chrome.tabs.update(tabId, { url: chrome.runtime.getURL(`src/focus/blocked.html?${new URLSearchParams({ u: url, until: focus.until })}`) });
}

export async function allowOnce({ url }) {
  const allowed = await sessionGet('focusAllow', []);
  await chrome.storage.session.set({ focusAllow: [...allowed, normalizeUrl(url)] });
  return { ok: true };
}

// ---------- Verlauf in Alltagssprache ----------

export async function findHistory({ query }) {
  const settings = await need('paletteHistoryJev', 'Verlauf in Alltagssprache');
  if (!(await chrome.permissions.contains({ permissions: ['history'] }))) throw new Error('Tabwerk darf den Verlauf nicht lesen. Schalte es in den Einstellungen ein.');
  const w = timeWindow(query);
  let items = await chrome.history.search({ text: '', startTime: w.from, endTime: w.to, maxResults: 3000 });
  items = items.filter((i) => isWebUrl(i.url) && !hostMatches(hostOf(i.url), settings.excludedHosts));
  // Vorfiltern im Code: Treffer mit gemeinsamen Wörtern zuerst, dann die jüngsten.
  const words = query.toLowerCase().split(/\W+/).filter((x) => x.length > 3);
  const hits = (i) => words.filter((x) => `${i.title} ${i.url}`.toLowerCase().includes(x)).length;
  items = items.sort((a, b) => hits(b) - hits(a) || (b.lastVisitTime || 0) - (a.lastVisitTime || 0)).slice(0, 200);
  if (!items.length) return { hits: [], period: w.label };
  const criteria = Object.fromEntries(items.map((i, n) => [`h${n}`, describeTab({ title: i.title, url: i.url })]));
  criteria.none = 'No page in the history matches the search';
  const result = await decide({ search: query, period: w.label }, {
    match: { type: 'choice', instructions: 'Which visited page is the one described by `search`? Each option is one page from the browsing history in `period`.', criteria },
  });
  return {
    hits: P.ranked(result.answers.match, 4).filter((r) => r.key !== 'none' && r.p >= 0.05)
      .map((r) => ({ ...items[Number(r.key.slice(1))], p: r.p })),
    period: w.label,
    cost: result.cost,
  };
}

// ---------- Volltext in offenen Tabs ----------

export async function tabTexts() {
  const settings = await need('paletteFulltext', 'Die Volltext-Suche');
  const tabs = (await chrome.tabs.query({})).filter((t) => isWebUrl(t.url) && !t.discarded && t.status === 'complete'
    && !hostMatches(hostOf(t.url), settings.excludedHosts));
  const results = await Promise.allSettled(tabs.slice(0, 150).map(async (t) => {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => (document.body?.innerText || '').slice(0, 30000) });
    return { tabId: t.id, text: r.result || '' };
  }));
  return results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

// ---------- Schlummern ----------

export async function listSnoozed() {
  const { snoozed = [] } = await chrome.storage.local.get('snoozed');
  return snoozed;
}

export async function snoozeTab({ windowId, tabId = null, preset }) {
  await need('snooze', 'Schlummern');
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : (await chrome.tabs.query({ active: true, windowId }))[0];
  if (!tab) throw new Error('Dieser Tab ist schon geschlossen.');
  if (!isWebUrl(tab.url)) throw new Error('Nur Webseiten lassen sich schlummern.');
  const when = wakeTime(preset);
  if (!when) throw new Error('Unbekannte Weckzeit.');
  const item = { id: crypto.randomUUID(), url: tab.url, title: tab.title, when, t: Date.now() };
  await chrome.storage.local.set({ snoozed: [...(await listSnoozed()), item] });
  await chrome.alarms.create(`snooze:${item.id}`, { when });
  await beforeAction('Schlummern', tab.windowId);
  await chrome.tabs.remove(tab.id);
  const label = SNOOZE_PRESETS.find((p) => p.id === preset)?.label || '';
  return { message: `Kommt ${label} wieder` };
}

export async function wakeSnoozed({ id, notify = true }) {
  const list = await listSnoozed();
  const item = list.find((s) => s.id === id);
  await chrome.storage.local.set({ snoozed: list.filter((s) => s.id !== id) });
  await chrome.alarms.clear(`snooze:${id}`);
  if (!item) return { ok: false };
  await quietGuard(10e3);
  const tab = await chrome.tabs.create({ url: item.url, active: !notify });
  if (notify) {
    chrome.notifications.create(`woke:${tab.id}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Wieder da', message: item.title || item.url, priority: 1,
    });
  }
  return { ok: true, message: 'Wieder geöffnet' };
}

// ---------- Lesezeichen mit Ordner-Vorschlag ----------

export async function bookmarkWithFolder({ windowId }) {
  const settings = await getSettings();
  if (!(await chrome.permissions.contains({ permissions: ['bookmarks'] }))) throw new Error('Tabwerk darf keine Lesezeichen anlegen. Schalte es in den Einstellungen ein.');
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  const folders = [];
  const walk = (nodes, path) => {
    for (const n of nodes) {
      if (n.url) continue;
      const p = [path, n.title].filter(Boolean).join(' / ');
      if (n.id !== '0') folders.push({ id: n.id, path: p });
      if (n.children) walk(n.children, n.id === '0' ? '' : p);
    }
  };
  walk(await chrome.bookmarks.getTree(), '');
  let folder = folders.find((f) => f.id === '2') || folders[0];
  let confidence = null;
  if (isOn(settings, 'bookmarkFolder') && hasKey(settings) && folders.length > 1 && !hostMatches(hostOf(tab.url), settings.excludedHosts)) {
    const list = folders.slice(0, 250);
    const criteria = Object.fromEntries(list.map((f, i) => [`f${i}`, f.path]));
    const result = await decide({ page: describeTab(tab) }, {
      folder: { type: 'choice', instructions: 'In which bookmark folder does the web page `page` belong best?', criteria },
    });
    folder = list[Number(result.answers.folder.choice.slice(1))];
    confidence = result.answers.folder.confidence;
  }
  await chrome.bookmarks.create({ parentId: folder.id, title: tab.title, url: tab.url });
  return { folder: folder.path, confidence, message: `Gespeichert in „${folder.path}“` };
}

// ---------- Statistik ----------

export async function stats() {
  await need('stats', 'Die Statistik');
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const tabs = windows.flatMap((w) => w.tabs);
  const byHost = new Map();
  for (const t of tabs) {
    const h = isWebUrl(t.url) ? hostOf(t.url) : 'Browser-Seiten';
    byHost.set(h, (byHost.get(h) || 0) + 1);
  }
  const { openedAt = {} } = await chrome.storage.session.get('openedAt');
  const oldest = tabs.filter((t) => isWebUrl(t.url))
    .sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0)).slice(0, 8)
    .map((t) => ({ id: t.id, windowId: t.windowId, title: t.title, url: t.url, lastAccessed: t.lastAccessed, openedAt: openedAt[t.id] }));
  // Höchste Tab-Zahl pro Tag aus dem Verlauf.
  const days = new Map();
  for (const e of await listSnapshots()) {
    const d = new Date(e.t).toISOString().slice(0, 10);
    days.set(d, Math.max(days.get(d) || 0, e.tabs));
  }
  return {
    total: tabs.length,
    windows: windows.map((w, i) => ({ n: i + 1, tabs: w.tabs.length, focused: w.focused })),
    groups: (await chrome.tabGroups.query({})).length,
    discarded: tabs.filter((t) => t.discarded).length,
    hosts: [...byHost].sort((a, b) => b[1] - a[1]).slice(0, 12),
    oldest,
    daily: [...days].sort(([a], [b]) => a.localeCompare(b)).slice(-14),
  };
}

export { CHROME_COLORS, saveSettings };
