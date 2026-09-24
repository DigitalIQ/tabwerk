// Seite aufräumen, der Teil im Service Worker: meldet das Seitenskript an, fragt Jev,
// speichert Regeln pro Seitentyp und lernt aus „wieder einblenden“.
// Nach dem Vorbild von Unclutter (https://github.com/kitze/unclutter, MIT, siehe NOTICE).

import { decideChunked } from './jev.js';
import { getSettings, saveSettings, hasKey, hostMatches } from './settings.js';
import { isOn } from './flags.js';
import * as Learn from './learn.js';
import * as D from './declutter.js';
import { t } from './i18n.js';

const SCRIPT_ID = 'tabwerk-declutter';
const FILE = 'src/content/declutter.js';
export const ORIGINS = ['https://*/*', 'http://*/*'];
const PROFILES = 'declutterProfiles';
const ATTEMPTS = 'declutterAttempts';

const hostKey = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isWeb = (url) => /^https?:\/\//.test(url || '');

// ---------- Speicher ----------

// Alles läuft im Service Worker. Schreibvorgänge nacheinander, damit zwei Tabs sich nicht überschreiben.
let writes = Promise.resolve();
function update(key, change) {
  const run = writes.then(async () => {
    const { [key]: value = {} } = await chrome.storage.local.get(key);
    const next = change(value);
    await chrome.storage.local.set({ [key]: next });
    return next;
  });
  writes = run.catch(() => {});
  return run;
}

async function profileFor(context) {
  const { [PROFILES]: all = {} } = await chrome.storage.local.get(PROFILES);
  const p = all[context.key];
  return p && p.version === D.POLICY_VERSION && p.origin === context.origin ? p : null;
}

const saveProfile = (profile) => update(PROFILES, (all) => D.capProfiles({ ...all, [profile.key]: profile }));
const dropProfile = (key) => update(PROFILES, (all) => { const next = { ...all }; delete next[key]; return next; });

async function attempted(key) {
  const { [ATTEMPTS]: all = {} } = await chrome.storage.local.get(ATTEMPTS);
  return all[`${key}|a${D.ANALYSIS_VERSION}`] || null;
}
const markAttempt = (key, error = null) => update(ATTEMPTS, (all) => {
  const next = { ...all, [`${key}|a${D.ANALYSIS_VERSION}`]: { t: Date.now(), error } };
  const entries = Object.entries(next);
  return entries.length > 1000 ? Object.fromEntries(entries.sort((a, b) => b[1].t - a[1].t).slice(0, 1000)) : next;
});
const clearAttempt = (key) => update(ATTEMPTS, (all) => { const next = { ...all }; delete next[`${key}|a${D.ANALYSIS_VERSION}`]; return next; });

function prefs(settings) {
  return {
    hidden: D.cleanHidden(settings.declutterHidden),
    custom: D.cleanCustom(settings.declutterCustom),
    keywords: D.parseKeywords(settings.declutterKeywords),
    never: settings.declutterNever || [],
  };
}

// ---------- Seitenskript ----------

// Meldet das Skript für alle Websites an, wenn die Funktion an ist und Chrome das Leserecht gibt.
let chain = Promise.resolve();
export function syncDeclutterScript() {
  const run = chain.then(registerNow, registerNow);
  chain = run.catch(() => {});
  return run;
}

async function registerNow() {
  const settings = await getSettings();
  const on = isOn(settings, 'declutter') && (await chrome.permissions.contains({ origins: ORIGINS }));
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (on) {
    await chrome.scripting.registerContentScripts([{ id: SCRIPT_ID, js: [FILE], matches: ORIGINS, runAt: 'document_idle', persistAcrossSessions: true }]);
  }
  await refreshAll();
  return { on };
}

// Offene Tabs holen sich die Regeln neu. Tabs ohne Skript melden einen Fehler, das ist egal.
export async function refreshAll() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((tab) => isWeb(tab.url)).map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'declutter:refresh' }, { frameId: 0 }).catch(() => {})));
}

// Tabs, die schon vor dem Einschalten offen waren, bekommen das Skript beim ersten Bedarf.
async function ensureScript(tabId) {
  const alive = await chrome.tabs.sendMessage(tabId, { type: 'declutter:ping' }, { frameId: 0 }).catch(() => null);
  if (alive?.ok) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [FILE] });
  } catch {
    throw new Error(t('dc_cannotAccess'));
  }
}

async function page(tabId, type, extra = {}) {
  const r = await chrome.tabs.sendMessage(tabId, { type, ...extra }, { frameId: 0 }).catch(() => null);
  if (!r?.ok) throw new Error(t('dc_pageUnavailable'));
  return r.data;
}

async function tabOf({ windowId, tabId }) {
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : (await chrome.tabs.query({ active: true, windowId }))[0];
  if (!tab || !isWeb(tab.url)) throw new Error(t('dc_onlyNormalPages'));
  return tab;
}

// ---------- Analyse ----------

const jobs = new Map();
const busyTabs = new Set();

async function learnEvents(host, rules, ok) {
  const events = rules.map((r) => ({ f: 'declutter', host, jev: r.category, user: ok ? r.category : 'keep', conf: r.conf, ok }));
  if (events.length) await Learn.record({ events }).catch(() => {});
}

export async function analyzeTab({ windowId, tabId, automatic = false } = {}) {
  const settings = await getSettings();
  if (!isOn(settings, 'declutter')) throw new Error(t('dc_featureOff'));
  if (automatic && !isOn(settings, 'declutterAuto')) return { skipped: true };
  const tab = await tabOf({ windowId, tabId });
  const host = hostKey(tab.url);
  const p = prefs(settings);
  if (hostMatches(host, p.never)) throw new Error(t('dc_neverHere', host));
  // Datenschutz-Liste: diese Websites gehen nie an Jev.
  if (hostMatches(host, settings.excludedHosts)) throw new Error(t('dc_excluded', host));
  if (!hasKey(settings)) {
    if (automatic) return { skipped: true };
    throw new Error(t('dc_noKey'));
  }
  await ensureScript(tab.id);
  const snapshot = await page(tab.id, 'declutter:snapshot', { keywords: p.keywords });
  const { context } = snapshot;
  const running = jobs.get(context.key);
  if (running) return running;

  const task = (async () => {
    const before = await profileFor(context);
    if (automatic && !D.shouldAuto({ on: true, hasKey: true, attempted: await attempted(context.key), profile: before })) return { skipped: true };
    busyTabs.add(tab.id);
    // Vor der bezahlten Anfrage merken: ein Fehler oder Neustart darf keine Schleife auslösen.
    await markAttempt(context.key);
    const candidates = snapshot.candidates.slice(0, D.MAX_CANDIDATES);
    let rules = [];
    let cost = 0;
    if (candidates.length) {
      const threshold = await Learn.threshold('declutter', settings);
      const result = await decideChunked(
        candidates.map((c) => c.id),
        (ids) => D.declutterState(context.kind, candidates.filter((c) => ids.includes(c.id))),
        (id) => D.declutterQuestion(id, p.custom),
      );
      cost = result.cost || 0;
      try {
        rules = D.rulesFromAnswers(result.answers, candidates, threshold);
      } catch {
        throw new Error(t('dc_badAnswer'));
      }
    }
    const now = await page(tab.id, 'declutter:snapshot', { keywords: p.keywords }).catch(() => null);
    if (!now || now.context.key !== context.key) throw new Error(t('dc_pageChanged'));
    // Was vorher ausgeblendet blieb, hast du stehen lassen. Das zählt als Zustimmung.
    if (before) await learnEvents(host, before.rules.filter((r) => r.enabled && typeof r.conf === 'number'), true);
    const profile = {
      ...context,
      enabled: before?.enabled ?? true,
      version: D.POLICY_VERSION,
      analysisVersion: D.ANALYSIS_VERSION,
      analyzedAt: Date.now(),
      candidateCount: candidates.length,
      cost,
      rules: D.keepChoices(rules, before),
    };
    await saveProfile(profile);
    await clearAttempt(context.key);
    return { rules: profile.rules.length, cost };
  })();
  jobs.set(context.key, task);
  try {
    const result = await task;
    await refreshAll();
    return result;
  } catch (error) {
    await markAttempt(context.key, error.message).catch(() => {});
    throw error;
  } finally {
    jobs.delete(context.key);
    busyTabs.delete(tab.id);
  }
}

// ---------- Popup und Schnellsuche ----------

export async function status({ windowId }) {
  const settings = await getSettings();
  const tab = (await chrome.tabs.query({ active: true, windowId }))[0];
  if (!tab || !isWeb(tab.url)) return { supported: false };
  const host = hostKey(tab.url);
  const p = prefs(settings);
  let state;
  try {
    await ensureScript(tab.id);
    state = await page(tab.id, 'declutter:refresh');
  } catch (error) {
    return { supported: false, host, error: error.message };
  }
  const attempt = await attempted(state.context.key);
  return {
    supported: true,
    host,
    tabId: tab.id,
    context: state.context,
    profile: state.profile,
    hiddenCount: state.hiddenCount,
    hidden: p.hidden,
    never: hostMatches(host, p.never),
    excluded: hostMatches(host, settings.excludedHosts),
    busy: busyTabs.has(tab.id) || jobs.has(state.context.key),
    error: attempt?.error || null,
    outdated: Boolean(state.profile && (state.profile.analysisVersion || 0) < D.ANALYSIS_VERSION),
  };
}

async function currentProfile({ windowId, tabId }) {
  const tab = await tabOf({ windowId, tabId });
  await ensureScript(tab.id);
  const { context } = await page(tab.id, 'declutter:snapshot', { keywords: [] });
  const profile = await profileFor(context);
  if (!profile) throw new Error(t('dc_analyzeFirst'));
  return { tab, profile };
}

export async function toggle({ windowId, tabId, enabled }) {
  const { profile } = await currentProfile({ windowId, tabId });
  const on = typeof enabled === 'boolean' ? enabled : profile.enabled === false;
  await saveProfile({ ...profile, enabled: on });
  await refreshAll();
  return { enabled: on, message: on ? t('dc_resumed') : t('dc_paused') };
}

export async function setRule({ windowId, tabId, selector, enabled }) {
  const { tab, profile } = await currentProfile({ windowId, tabId });
  const rule = profile.rules.find((r) => r.selector === selector);
  if (!rule) throw new Error(t('dc_ruleMissing'));
  if (rule.enabled !== enabled && typeof rule.conf === 'number') await learnEvents(hostKey(tab.url), [rule], enabled);
  await saveProfile({ ...profile, rules: profile.rules.map((r) => (r.selector === selector ? { ...r, enabled } : r)) });
  await refreshAll();
  return { ok: true };
}

export async function forget({ windowId, tabId }) {
  const { tab, profile } = await currentProfile({ windowId, tabId });
  await learnEvents(hostKey(tab.url), profile.rules.filter((r) => r.enabled && typeof r.conf === 'number'), true);
  await dropProfile(profile.key);
  await clearAttempt(profile.key);
  await refreshAll();
  return { ok: true };
}

export async function setNever({ host, on }) {
  const clean = String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(clean)) throw new Error(t('dc_badHost'));
  const settings = await getSettings();
  const list = new Set(settings.declutterNever || []);
  if (on) list.add(clean); else list.delete(clean);
  await saveSettings({ declutterNever: [...list].sort() });
  await refreshAll();
  return { never: [...list], message: on ? t('dc_neverAdded', clean) : t('dc_neverRemoved', clean) };
}

// ---------- Nachrichten vom Seitenskript ----------

function validContext(sender, context) {
  if (!sender.tab?.id || sender.frameId !== 0 || !sender.url || !context?.key || !context.origin) return false;
  try {
    return new URL(sender.url).origin === context.origin && context.key.startsWith(`${context.origin}|v${D.POLICY_VERSION}|`);
  } catch {
    return false;
  }
}

async function onPage(type, payload, sender) {
  const { context } = payload || {};
  if (!validContext(sender, context)) throw new Error('invalid context');
  if (type === 'declutter:count') return null;
  if (type === 'declutter:visit') {
    await analyzeTab({ tabId: sender.tab.id, automatic: true }).catch(() => {});
    return null;
  }
  const settings = await getSettings();
  const p = prefs(settings);
  const host = hostKey(sender.url);
  const enabled = isOn(settings, 'declutter') && !hostMatches(host, p.never);
  const profile = await profileFor(context);
  const auto = enabled && isOn(settings, 'declutterAuto') && hasKey(settings) && !hostMatches(host, settings.excludedHosts)
    && D.shouldAuto({ on: true, hasKey: true, attempted: await attempted(context.key), profile });
  // stop: die Funktion ist aus. Das Skript gibt die Seite frei und hört auf zu fragen.
  return { profile, enabled, rules: enabled ? D.activeRules(profile, p.hidden) : [], auto, stop: !isOn(settings, 'declutter') };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const type = message?.type;
  if (typeof type !== 'string' || !type.startsWith('declutter:') || sender.id !== chrome.runtime.id || !sender.tab) return false;
  onPage(type, message.payload, sender).then((data) => reply({ ok: true, data }), (error) => reply({ ok: false, error: error.message }));
  return true;
});
