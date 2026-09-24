// Reine URL-Helfer. Keine Chrome-APIs, damit sie in Node testbar bleiben.

const TRACKING = [
  /^utm_/, /^fbclid$/, /^gclid$/, /^dclid$/, /^msclkid$/, /^mc_cid$/, /^mc_eid$/,
  /^igshid$/, /^ref_src$/, /^ref_url$/, /^_hsenc$/, /^_hsmi$/, /^yclid$/, /^si$/,
];

export function isWebUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Macht aus zwei Schreibweisen derselben Seite denselben Schlüssel.
export function normalizeUrl(url) {
  if (!isWebUrl(url)) return url || '';
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  const params = [...u.searchParams.entries()]
    .filter(([key]) => !TRACKING.some((re) => re.test(key.toLowerCase())))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = new URLSearchParams(params).toString();
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  return u.toString();
}

// Was Jev über einen Tab sieht: Titel, Website und Pfad. Keine Query, kein Fragment,
// denn dort stehen oft Tokens und Sitzungsdaten.
export function describeTab(tab) {
  if (!isWebUrl(tab.url)) return { title: tab.title || '', site: (tab.url || '').split('/')[0] || 'browser' };
  const u = new URL(tab.url);
  const path = u.pathname.length > 80 ? u.pathname.slice(0, 80) + '…' : u.pathname;
  return { title: (tab.title || '').slice(0, 160), site: hostOf(tab.url), path };
}

// Findet exakte Doppel. Behalten wird der aktive, dann der angepinnte, dann der zuletzt benutzte Tab.
export function findDuplicates(tabs) {
  const byKey = new Map();
  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith('chrome://newtab')) continue;
    const key = normalizeUrl(tab.url);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(tab);
  }
  const groups = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    const ranked = [...list].sort((a, b) =>
      Number(b.active) - Number(a.active) ||
      Number(b.pinned) - Number(a.pinned) ||
      (b.lastAccessed || 0) - (a.lastAccessed || 0));
    groups.push({ key, keep: ranked[0], close: ranked.slice(1) });
  }
  return groups;
}

// Kandidaten für inhaltliche Doppel: gleiche Website, andere Adresse.
export function similarCandidates(tabs, limit = 60) {
  const byHost = new Map();
  for (const tab of tabs) {
    if (!isWebUrl(tab.url)) continue;
    const host = hostOf(tab.url);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(tab);
  }
  const pairs = [];
  for (const list of byHost.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (normalizeUrl(list[i].url) === normalizeUrl(list[j].url)) continue;
        pairs.push([list[i], list[j]]);
        if (pairs.length >= limit) return pairs;
      }
    }
  }
  return pairs;
}
