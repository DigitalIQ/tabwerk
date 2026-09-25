// Gespeicherte Formulare liegen verschlüsselt in chrome.storage.local (AES-GCM).
// Der Schlüssel liegt in IndexedDB und ist nicht exportierbar: Tabwerk kann damit ver- und
// entschlüsseln, aber niemand kann ihn als Bytes auslesen. Wer das Chrome-Profil hat, kann
// Tabwerk trotzdem zum Entschlüsseln bringen. Das schützt vor dem Blick in die Profildateien,
// nicht vor Schadsoftware auf dem Rechner.

import { t } from './i18n.js';

const toB64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { v: 1, iv: toB64(iv), data: toB64(new Uint8Array(data)) };
}

export async function unseal(key, box) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

export const newKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

const DB = 'tabwerk-keys';
const STORE = 'keys';
const KEY_ID = 'forms';

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// Liefert den Schlüssel und ob er gerade erst entstanden ist.
async function loadKey() {
  const open = indexedDB.open(DB, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  const db = await request(open);
  try {
    const found = await request(db.transaction(STORE).objectStore(STORE).get(KEY_ID));
    if (found) return { key: found, created: false };
    const key = await newKey();
    await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(key, KEY_ID));
    return { key, created: true };
  } finally {
    db.close();
  }
}

let keyPromise = null;
// „created“ meldet nur der erste Aufruf nach dem Anlegen.
const formKey = async () => {
  if (!keyPromise) keyPromise = loadKey().catch((e) => { keyPromise = null; throw e; });
  const entry = await keyPromise;
  const { created } = entry;
  entry.created = false;
  return { key: entry.key, created };
};

// Nur für Tests: fester Schlüssel statt IndexedDB.
export function useKey(key, created = false) {
  keyPromise = Promise.resolve({ key, created });
}

export async function listProfiles() {
  const { formVault, formProfiles } = await chrome.storage.local.get(['formVault', 'formProfiles']);
  // Ältere Versionen haben im Klartext gespeichert. Das wird beim ersten Lesen verschlüsselt.
  if (!formVault) {
    if (formProfiles?.length) await saveProfiles(formProfiles);
    else if (formProfiles) await chrome.storage.local.remove('formProfiles');
    return formProfiles || [];
  }
  const { key, created } = await formKey();
  // Ohne alten Schlüssel ist nichts mehr lesbar, etwa nach Löschen der Website-Daten.
  if (created) {
    await chrome.storage.local.remove('formVault');
    return [];
  }
  try {
    return await unseal(key, formVault);
  } catch {
    throw new Error(t('form_cannotDecrypt'));
  }
}

export async function saveProfiles(list) {
  const { key } = await formKey();
  await chrome.storage.local.set({ formVault: await seal(key, list) });
  await chrome.storage.local.remove('formProfiles');
}
