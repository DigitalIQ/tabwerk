// Lernen aus deinen Entscheidungen, gespeichert nur in chrome.storage.local.
// Die Rechenregeln stehen in learncore.js.

import { getSettings, saveSettings, hostMatches } from './settings.js';
import { isOn } from './flags.js';
import * as L from './learncore.js';

const KEY = 'learnLog';
const DISMISSED = 'learnDismissed';
export const FEATURES = ['groups', 'cleanup', 'find', 'watch', 'declutter'];
// Seite aufräumen startet bei 90 %. Das Lernen darf die Schwelle dort nur anheben,
// weil Tabwerk Elemente unter 90 % nie ausblendet und darüber also nichts weiß.
const FLOOR = { declutter: 0.9 };
const fallbackFor = (feature, settings) => (feature === 'watch' ? settings.notifyAt : Math.max(settings.confidence, FLOOR[feature] || 0));

export async function learnLog() {
  const { [KEY]: log = [] } = await chrome.storage.local.get(KEY);
  return log;
}

// Nimmt nur die Felder, die das Lernen braucht. Websites von der Ausschlussliste bleiben draußen.
function clean(e, settings) {
  if (!FEATURES.includes(e.f)) return null;
  if (e.host && hostMatches(e.host, settings.excludedHosts)) return null;
  const out = { f: e.f, t: Date.now() };
  if (e.host) out.host = String(e.host).slice(0, 100);
  if (e.title) out.title = String(e.title).slice(0, 120);
  for (const k of ['jev', 'user']) if (e[k] !== undefined && e[k] !== null) out[k] = String(e[k]).slice(0, 60);
  if (typeof e.conf === 'number') out.conf = Math.round(e.conf * 1000) / 1000;
  for (const k of ['ok', 'truth']) if (typeof e[k] === 'boolean') out[k] = e[k];
  return out;
}

export async function record({ events = [] }) {
  const settings = await getSettings();
  if (!isOn(settings, 'learn')) return { recorded: 0 };
  const list = events.map((e) => clean(e, settings)).filter(Boolean);
  if (list.length) await chrome.storage.local.set({ [KEY]: L.append(await learnLog(), list) });
  return { recorded: list.length };
}

// Gelernte Schwelle einer Funktion oder die aus den Einstellungen.
export async function threshold(feature, settings) {
  const fallback = fallbackFor(feature, settings);
  if (!isOn(settings, 'learnThreshold')) return fallback;
  const events = (await learnLog()).filter((e) => e.f === feature);
  const learned = feature === 'watch' ? L.calibrateNoul(events) : L.calibrate(events);
  return Math.max(learned?.threshold ?? fallback, FLOOR[feature] || 0);
}

export async function examples(hosts) {
  const settings = await getSettings();
  if (!isOn(settings, 'learnExamples')) return [];
  return L.pickExamples(await learnLog(), hosts);
}

export async function ruleSuggestions() {
  const settings = await getSettings();
  if (!isOn(settings, 'learnRules')) return [];
  const { [DISMISSED]: dismissed = [] } = await chrome.storage.local.get(DISMISSED);
  return L.suggestRules(await learnLog(), settings.groupRules, dismissed);
}

export async function acceptRule({ rule }) {
  const settings = await getSettings();
  if (!settings.groupRules.includes(rule)) await saveSettings({ groupRules: [...settings.groupRules, rule] });
  return { rules: [...settings.groupRules, rule], autoGroup: isOn(settings, 'autoGroup') };
}

export async function dismissRule({ rule }) {
  const { [DISMISSED]: dismissed = [] } = await chrome.storage.local.get(DISMISSED);
  await chrome.storage.local.set({ [DISMISSED]: [...new Set([...dismissed, rule])] });
  return { ok: true };
}

// Überblick für die Einstellungen: Anzahl je Funktion, gelernte Schwellen, Regelvorschläge.
export async function learnState() {
  const settings = await getSettings();
  const log = await learnLog();
  const per = {};
  for (const f of FEATURES) {
    const events = log.filter((e) => e.f === f);
    const learned = f === 'find' ? null : f === 'watch' ? L.calibrateNoul(events) : L.calibrate(events);
    per[f] = {
      n: events.length,
      agreed: events.filter((e) => e.ok === true).length,
      learned,
      fallback: fallbackFor(f, settings),
    };
  }
  return { total: log.length, per, rules: await ruleSuggestions() };
}

export async function clearLearn() {
  await chrome.storage.local.remove([KEY, DISMISSED]);
  return { ok: true };
}

export async function learnJsonl() {
  return L.toJsonl(await learnLog());
}
