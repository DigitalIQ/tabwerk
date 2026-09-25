import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal, newKey, useKey, listProfiles, saveProfiles } from '../src/lib/formstore.js';

let area = {};
chrome.storage = {
  local: {
    get: async (keys) => Object.fromEntries([keys].flat().filter((k) => k in area).map((k) => [k, structuredClone(area[k])])),
    set: async (obj) => { Object.assign(area, structuredClone(obj)); },
    remove: async (keys) => { for (const k of [keys].flat()) delete area[k]; },
  },
};

const profile = { id: 'a', name: 'Test', host: 'example.com', fields: [{ name: 'iban', value: 'DE89370400440532013000', sensitive: true }] };

beforeEach(async () => {
  area = {};
  useKey(await newKey());
});

test('verschlüsseln und entschlüsseln hin und zurück', async () => {
  const key = await newKey();
  const box = await seal(key, { text: 'Größe € 漢字' });
  assert.deepEqual(await unseal(key, box), { text: 'Größe € 漢字' });
});

test('gespeicherte Werte stehen nicht im Klartext im Speicher', async () => {
  await saveProfiles([profile]);
  assert.ok(!JSON.stringify(area).includes('DE8937'));
  assert.equal(area.formProfiles, undefined);
  assert.deepEqual(await listProfiles(), [profile]);
});

test('alte Klartext-Formulare werden beim Lesen verschlüsselt', async () => {
  area.formProfiles = [profile];
  assert.deepEqual(await listProfiles(), [profile]);
  assert.equal(area.formProfiles, undefined);
  assert.ok(area.formVault);
  assert.deepEqual(await listProfiles(), [profile]);
});

test('falscher Schlüssel gibt einen Fehler', async () => {
  await saveProfiles([profile]);
  useKey(await newKey());
  await assert.rejects(listProfiles(), /nicht entschlüsseln/);
});

test('neuer Schlüssel verwirft unlesbare Formulare', async () => {
  await saveProfiles([profile]);
  useKey(await newKey(), true);
  assert.deepEqual(await listProfiles(), []);
  assert.equal(area.formVault, undefined);
});
