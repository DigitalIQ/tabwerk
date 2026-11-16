import { getSettings } from './settings.js';
import { isOn } from './flags.js';
import { GOOGLE_SEARCH_MATCHES, GOOGLE_SEARCH_ORIGINS, isGoogleSearch } from './googlemaps-config.js';

const ID = 'tabwerk-google-maps';
const FILE = 'src/content/googlemaps.js';

export async function state({ url }) {
  const enabled = isGoogleSearch(url) && isOn(await getSettings(), 'googleMaps')
    && await chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] });
  return { enabled: Boolean(enabled) };
}

export async function refreshTab(tab) {
  if (!tab.id) return;
  const { enabled } = await state({ url: tab.url });
  if (enabled) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [FILE] }).catch(() => {});
  } else {
    await chrome.tabs.sendMessage(tab.id, { type: 'googleMaps:stop' }, { frameId: 0 }).catch(() => {});
  }
}

// Änderungen an Schaltern und Rechten können gleichzeitig eintreffen.
let chain = Promise.resolve();
export function syncGoogleMaps() {
  const run = chain.then(syncNow, syncNow);
  chain = run.catch(() => {});
  return run;
}

async function syncNow() {
  const matches = [];
  if (isOn(await getSettings(), 'googleMaps')) {
    for (let i = 0; i < GOOGLE_SEARCH_ORIGINS.length; i++) {
      if (await chrome.permissions.contains({ origins: [GOOGLE_SEARCH_ORIGINS[i]] })) matches.push(GOOGLE_SEARCH_MATCHES[i]);
    }
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ID] });
  if (!matches.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [ID] });
  } else {
    const script = { id: ID, matches, js: [FILE], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true };
    if (existing.length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  }
  // Auch bereits geöffnete Seiten reagieren ohne Neuladen auf den Schalter.
  const tabs = await chrome.tabs.query({ url: GOOGLE_SEARCH_ORIGINS });
  await Promise.all(tabs.map(refreshTab));
}
