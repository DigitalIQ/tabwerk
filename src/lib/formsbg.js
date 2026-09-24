// Formulare speichern und ausfüllen. Läuft im Service Worker, die Arbeit in der Seite
// erledigen die Funktionen aus content/forms.js.

import { decide } from './jev.js';
import { getSettings, hasKey } from './settings.js';
import { isOn } from './flags.js';
import { hostOf } from './url.js';
import { matchFields, describeField, fakePerson, fakeValue, isSensitive } from './formcore.js';
import { collectFields, fillFields } from '../content/forms.js';

async function activeTab(windowId) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab || !/^https?:/.test(tab.url || '')) throw new Error('Formulare gehen nur auf normalen Webseiten.');
  return tab;
}

async function inPage(tabId, func, args = []) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return res.result;
  } catch {
    throw new Error('Tabwerk darf diese Seite gerade nicht lesen. Öffne die Schnellsuche per Tastenkürzel oder nutze das Kontextmenü auf der Seite.');
  }
}

export async function listProfiles() {
  const { formProfiles = [] } = await chrome.storage.local.get('formProfiles');
  return formProfiles;
}

async function saveProfiles(list) {
  await chrome.storage.local.set({ formProfiles: list });
}

export async function saveForm({ windowId, name }) {
  const settings = await getSettings();
  if (!isOn(settings, 'forms')) throw new Error('Formulare sind in den Einstellungen ausgeschaltet.');
  const tab = await activeTab(windowId);
  const { fields } = await inPage(tab.id, collectFields);
  // Sensible Felder bleiben ganz draußen, auch ohne Wert.
  const kept = fields.filter((f) => !f.sensitive && !isSensitive(f) && f.value !== null && f.value !== '' && f.value !== false);
  if (!kept.length) throw new Error('Auf dieser Seite gibt es kein ausgefülltes Formularfeld.');
  const host = hostOf(tab.url);
  const profile = {
    id: crypto.randomUUID(),
    name: (name || '').trim() || `${host} · ${new Date().toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`,
    host,
    path: new URL(tab.url).pathname,
    t: Date.now(),
    fields: kept,
  };
  await saveProfiles([profile, ...(await listProfiles())]);
  const skipped = fields.filter((f) => f.sensitive).length;
  return { profile, message: `${kept.length} Felder gespeichert${skipped ? `, ${skipped} geschützte ausgelassen` : ''}` };
}

export async function renameProfile({ id, name }) {
  const list = await listProfiles();
  const p = list.find((x) => x.id === id);
  if (p && name.trim()) p.name = name.trim();
  await saveProfiles(list);
  return p;
}

export async function deleteProfile({ id }) {
  await saveProfiles((await listProfiles()).filter((p) => p.id !== id));
  return { ok: true };
}

export async function fillForm({ windowId, profileId }) {
  const settings = await getSettings();
  if (!isOn(settings, 'forms')) throw new Error('Formulare sind in den Einstellungen ausgeschaltet.');
  const tab = await activeTab(windowId);
  const profiles = await listProfiles();
  const host = hostOf(tab.url);
  const profile = profileId ? profiles.find((p) => p.id === profileId) : profiles.find((p) => p.host === host);
  if (!profile) throw new Error('Für diese Website ist noch kein Formular gespeichert.');
  const { fields } = await inPage(tab.id, collectFields);
  const targets = fields.filter((f) => !f.sensitive && !isSensitive(f));
  const match = matchFields(targets, profile.fields);
  let cost;
  let viaJev = 0;
  // Übrige Felder: Jev ordnet zu, sieht dabei nur Beschriftungen, keine Werte.
  const open = targets.map((t, i) => (match[i] === -1 ? i : null)).filter((i) => i !== null);
  const free = profile.fields.map((_, i) => i).filter((i) => !match.includes(i));
  if (open.length && free.length && isOn(settings, 'formsJev') && hasKey(settings)) {
    const criteria = Object.fromEntries(free.map((i) => [`s${i}`, describeField(profile.fields[i])]));
    criteria.none = 'None of the saved fields fits this form field';
    const state = { form_fields: Object.fromEntries(open.map((i) => [`f${i}`, describeField(targets[i])])) };
    const questions = Object.fromEntries(open.slice(0, 40).map((i) => [`f${i}`, {
      type: 'choice',
      instructions: `Which saved form field holds the same kind of information as \`form_fields.f${i}\`?`,
      criteria,
    }]));
    const result = await decide(state, questions);
    cost = result.cost;
    const taken = new Set();
    for (const [key, a] of Object.entries(result.answers)) {
      if (a.choice === 'none' || a.confidence < settings.confidence) continue;
      const s = Number(a.choice.slice(1));
      if (taken.has(s)) continue;
      taken.add(s);
      match[Number(key.slice(1))] = s;
      viaJev += 1;
    }
  }
  const assignments = targets.map((t, i) => (match[i] === -1 ? null : { ...t, value: profile.fields[match[i]].value })).filter(Boolean);
  const res = await inPage(tab.id, fillFields, [assignments]);
  return {
    ...res,
    cost,
    message: `${res.filled} Felder ausgefüllt${viaJev ? `, ${viaJev} davon mit Jev` : ''}${targets.length - res.filled > 0 ? `, ${targets.length - res.filled} leer gelassen` : ''}`,
  };
}

export async function fillTestData({ windowId }) {
  const settings = await getSettings();
  if (!isOn(settings, 'formsTestData')) throw new Error('Testdaten sind in den Einstellungen ausgeschaltet.');
  const tab = await activeTab(windowId);
  const { fields } = await inPage(tab.id, collectFields);
  const person = fakePerson();
  const radios = new Set();
  const assignments = fields.filter((f) => !f.sensitive && !isSensitive(f)).map((f) => {
    if (f.type === 'radio') {
      if (radios.has(f.name)) return null;
      radios.add(f.name);
    }
    return { ...f, value: fakeValue(f, person) };
  }).filter(Boolean);
  const res = await inPage(tab.id, fillFields, [assignments]);
  return { ...res, message: `${res.filled} Felder mit Testdaten gefüllt` };
}
