// Wächter: beobachtet eine Seite und meldet Änderungen, die zur Bedingung in Alltagssprache passen.
// Ablauf: Text holen, im Code vergleichen, nur bei Änderung Jev fragen, dann benachrichtigen.

import { decide } from './jev.js';
import { getSettings } from './settings.js';
import { diffLines, MAX_SNAPSHOT } from './diff.js';
import { watchRequest } from './prompts.js';
import { hostOf, normalizeUrl } from './url.js';

const HISTORY = 12;

export async function listWatches() {
  const { watches = [] } = await chrome.storage.local.get('watches');
  return watches;
}

async function saveWatches(watches) {
  await chrome.storage.local.set({ watches });
}

async function updateWatch(id, patch) {
  const watches = await listWatches();
  const i = watches.findIndex((w) => w.id === id);
  if (i === -1) return null;
  watches[i] = { ...watches[i], ...patch };
  await saveWatches(watches);
  return watches[i];
}

export async function createWatch({ url, condition, intervalMin }) {
  const watch = {
    id: crypto.randomUUID(),
    url,
    site: hostOf(url),
    condition: condition.trim(),
    // Chrome weckt Erweiterungen frühestens alle 30 Sekunden.
    intervalMin: Math.max(0.5, Number(intervalMin) || 60),
    enabled: true,
    createdAt: Date.now(),
    history: [],
  };
  await saveWatches([...(await listWatches()), watch]);
  await schedule(watch);
  // Erste Prüfung legt nur die Vergleichsbasis an.
  checkWatch(watch.id).catch(() => {});
  return watch;
}

export async function removeWatch({ id }) {
  await saveWatches((await listWatches()).filter((w) => w.id !== id));
  await chrome.storage.local.remove(`snap:${id}`);
  await chrome.alarms.clear(`watch:${id}`);
  return { ok: true };
}

export async function toggleWatch({ id }) {
  const watch = (await listWatches()).find((w) => w.id === id);
  const next = await updateWatch(id, { enabled: !watch.enabled });
  if (next.enabled) await schedule(next);
  else await chrome.alarms.clear(`watch:${id}`);
  return next;
}

async function schedule(watch) {
  await chrome.alarms.create(`watch:${watch.id}`, { periodInMinutes: watch.intervalMin, delayInMinutes: watch.intervalMin });
}

export async function rescheduleAll() {
  for (const watch of await listWatches()) {
    if (!watch.enabled) continue;
    if (!(await chrome.alarms.get(`watch:${watch.id}`))) await schedule(watch);
  }
}

// ---------- Text holen ----------

// Ist die Seite offen, liest Tabwerk den gerenderten Text aus dem Tab. Das klappt auch bei JavaScript-Seiten.
async function textFromOpenTab(url) {
  const key = normalizeUrl(url);
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((t) => t.url && normalizeUrl(t.url) === key && t.status === 'complete' && !t.discarded);
  if (!tab) return null;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.body?.innerText || '' });
    return { text: res.result, title: tab.title, via: 'tab' };
  } catch {
    return null;
  }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Aus geladenem HTML den sichtbaren Text für Wächter lesen',
  });
}

async function textFromFetch(url) {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
  if (!response.ok) throw new Error(`Die Seite antwortet mit ${response.status}.`);
  const html = await response.text();
  await ensureOffscreen();
  const parsed = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'parse-html', html });
  return { text: parsed.text, title: parsed.title, via: 'fetch' };
}

async function pageText(url) {
  return (await textFromOpenTab(url)) || textFromFetch(url);
}

// ---------- Prüfen ----------

const running = new Set();

export async function checkWatch(id) {
  if (running.has(id)) return { busy: true };
  running.add(id);
  try {
    return await runCheck(id);
  } finally {
    running.delete(id);
  }
}

async function runCheck(id) {
  const watch = (await listWatches()).find((w) => w.id === id);
  if (!watch) return { missing: true };
  const settings = await getSettings();
  const entry = { t: Date.now() };
  try {
    const allowed = await chrome.permissions.contains({ origins: [new URL(watch.url).origin + '/*'] });
    if (!allowed) throw new Error('Tabwerk darf diese Website nicht lesen. Lege den Wächter neu an.');
    const page = await pageText(watch.url);
    const key = `snap:${id}`;
    const { [key]: before } = await chrome.storage.local.get(key);
    const text = (page.text || '').slice(0, MAX_SNAPSHOT);
    await chrome.storage.local.set({ [key]: text });
    entry.via = page.via;
    if (before === undefined) {
      entry.status = 'baseline';
    } else {
      const diff = diffLines(before, text);
      entry.added = diff.addedTotal;
      entry.removed = diff.removedTotal;
      if (!diff.changed) {
        entry.status = 'same';
      } else {
        const req = watchRequest(watch, { title: page.title, site: watch.site }, diff);
        const result = await decide(req.state, req.questions);
        entry.p = result.answers.notify.noul;
        entry.cost = result.cost;
        const pick = result.answers.evidence?.choice;
        entry.evidence = pick && pick !== 'none' ? req.evidence[Number(pick.slice(1))] : req.evidence[0];
        entry.status = entry.p >= settings.notifyAt ? 'match' : 'noise';
        if (entry.status === 'match') notify(watch, entry);
      }
    }
  } catch (error) {
    entry.status = 'error';
    entry.error = error.message;
  }
  const history = [entry, ...(watch.history || [])].slice(0, HISTORY);
  return updateWatch(id, { history, lastCheck: entry.t });
}

function notify(watch, entry) {
  chrome.notifications.create(`watch:${watch.id}:${entry.t}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `${watch.site}: passende Änderung`,
    message: entry.evidence || watch.condition,
    contextMessage: watch.condition,
    priority: 1,
  });
}

export async function openFromNotification(notificationId) {
  const [, id] = notificationId.split(':');
  const watch = (await listWatches()).find((w) => w.id === id);
  if (watch) await chrome.tabs.create({ url: watch.url });
  chrome.notifications.clear(notificationId);
}
