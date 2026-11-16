import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_SEARCH_ORIGINS, isGoogleSearch } from '../src/lib/googlemaps-config.js';
import { FEATURE_DEFAULTS, feature } from '../src/lib/flags.js';
import { state, syncGoogleMaps, refreshTab } from '../src/lib/googlemaps.js';

test('Maps läuft nur auf den unterstützten HTTPS-Suchseiten', () => {
  for (const origin of GOOGLE_SEARCH_ORIGINS) assert.ok(isGoogleSearch(origin.replace('*', 'search?q=Berlin')));
  for (const url of ['https://www.google.com/maps?q=x', 'https://www.google.com/searching?q=x', 'http://www.google.de/search?q=x', 'https://www.google.com.evil.example/search?q=x', 'https://mail.google.com/search?q=x', 'https://www.google.de:8443/search?q=x', 'invalid']) assert.equal(isGoogleSearch(url), false, url);
  assert.equal(FEATURE_DEFAULTS.googleMaps, false);
  assert.deepEqual(feature('googleMaps').perm.origins, GOOGLE_SEARCH_ORIGINS);
});

test('Maps folgt Schalter und Rechten, auch bei paralleler Synchronisation', async () => {
  const original = globalThis.chrome;
  let enabled = false;
  const grants = new Set(['https://www.google.de/*']);
  let registered = [];
  const injected = [];
  const stopped = [];
  globalThis.chrome = {
    ...original,
    storage: { local: { get: async () => ({ features: { googleMaps: enabled } }) } },
    permissions: { contains: async ({ origins }) => origins.every((x) => grants.has(x)) },
    scripting: {
      getRegisteredContentScripts: async () => registered,
      registerContentScripts: async (scripts) => { assert.equal(registered.length, 0); registered = scripts; },
      updateContentScripts: async (scripts) => { assert.equal(registered.length, 1); registered = scripts; },
      unregisterContentScripts: async () => { registered = []; },
      executeScript: async ({ target }) => { injected.push(target.tabId); },
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://www.google.de/search?q=Berlin' }, { id: 2, url: 'https://www.google.com/search?q=Berlin' }],
      sendMessage: async (id, message) => { assert.equal(message.type, 'googleMaps:stop'); stopped.push(id); },
    },
  };
  try {
    assert.deepEqual(await state({ url: 'https://www.google.de/search?q=x' }), { enabled: false });
    await syncGoogleMaps();
    assert.equal(registered.length, 0);
    enabled = true;
    await Promise.all([syncGoogleMaps(), syncGoogleMaps(), syncGoogleMaps()]);
    assert.deepEqual(registered[0].matches, ['https://www.google.de/search*']);
    assert.ok(injected.every((id) => id === 1));
    assert.deepEqual(await state({ url: 'https://www.google.com/search?q=x' }), { enabled: false });
    assert.deepEqual(await state({ url: 'https://www.google.de/search?q=x' }), { enabled: true });
    grants.clear();
    await syncGoogleMaps();
    assert.equal(registered.length, 0);
    assert.equal(stopped.at(-2), 1);
    grants.add('https://www.google.de/*');
    enabled = false;
    await refreshTab({ id: 1, url: 'https://www.google.de/search?q=x' });
    assert.equal(stopped.at(-1), 1);
  } finally { globalThis.chrome = original; }
});
