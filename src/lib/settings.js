// Einstellungen und Nutzungszähler in chrome.storage.local.
// Der API-Schlüssel bleibt lokal und wird nie synchronisiert.

export const CHROME_COLORS = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#1e8e3e',
  pink: '#d01884',
  purple: '#a142f4',
  cyan: '#007b83',
  orange: '#fa903e',
};

// Zwei Wege zu Jev: über OpenRouter oder direkt mit einem Konto bei typesafe.ai.
// Bei OpenRouter braucht der Alias für die neueste Version die Tilde:
// ~typesafe/jev-latest geht, typesafe/jev-latest ergibt Fehler 400 (geprüft am 2026-09-24).
export const PROVIDERS = {
  openrouter: {
    name: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    keyField: 'apiKey',
    modelField: 'model',
    keyPrefix: 'sk-or-',
    models: {
      'typesafe/jev-1.13': 'jev-1.13 (feste Version)',
      '~typesafe/jev-latest': 'jev-latest (immer die neueste Version)',
    },
  },
  typesafe: {
    name: 'TypeSafe',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    keyField: 'typesafeKey',
    modelField: 'typesafeModel',
    keyPrefix: '',
    models: {
      'jev-1.13': 'jev-1.13 (feste Version)',
      'jev-latest': 'jev-latest (immer die neueste Version)',
    },
  },
};

// Preis laut TypeSafe: 0,042 $ pro Million gelesener Tokens. TypeSafe meldet keine Kosten, Tabwerk schätzt sie daraus.
export const PRICE_PER_INPUT_TOKEN = 0.042 / 1e6;

export const modelShort = (model) => model.replace(/^~?typesafe\//, '');

export function connection(settings) {
  const p = PROVIDERS[settings.provider] || PROVIDERS.openrouter;
  return { provider: settings.provider, ...p, key: settings[p.keyField], model: settings[p.modelField] };
}

export const hasKey = (settings) => Boolean(connection(settings).key);

export const DEFAULTS = {
  provider: 'openrouter',
  apiKey: '',
  model: 'typesafe/jev-1.13',
  typesafeKey: '',
  typesafeModel: 'jev-1.13',
  // Ab dieser Sicherheit übernimmt Tabwerk einen Vorschlag ohne Nachfrage.
  confidence: 0.8,
  // Ab dieser Wahrscheinlichkeit meldet ein Wächter eine Änderung.
  notifyAt: 0.7,
  categories: [
    { name: 'Arbeit', color: 'blue', hint: 'Work tools, email, documents, tickets, internal business systems' },
    { name: 'Recherche', color: 'purple', hint: 'Articles, documentation, papers and search results being read or researched' },
    { name: 'Entwicklung', color: 'cyan', hint: 'Source code, repositories, developer documentation, APIs, local dev servers' },
    { name: 'Einkaufen', color: 'orange', hint: 'Online shops, product pages, price comparisons, orders and deliveries' },
    { name: 'Medien', color: 'red', hint: 'Video, music, podcasts, social media and entertainment' },
    { name: 'Organisation', color: 'green', hint: 'Calendar, travel, banking, appointments and personal admin' },
  ],
  priorityFocus: '',
  priorityLevels: [
    'Can be closed: finished, stale, or unrelated to anything I am doing',
    'Later: reading material or entertainment without a deadline',
    'Relevant: related to ongoing work, but not needed right now',
    'Now: needed for my current task or a pending action',
  ],
  excludedHosts: [],
  // Schnellsuche: sucht per Code. Jev nur auf ausdrücklichen Wunsch mit Umschalt+Enter.
  paletteJev: false,
  paletteBookmarks: false,
  paletteHistory: false,
  // site: hell oder dunkel wie die Seite dahinter. system, light, dark.
  paletteTheme: 'site',
  // Schalter pro Funktion, siehe flags.js.
  features: {},
  // Neue Tabs einsortieren: eine Regel pro Zeile, „domain = Gruppe“.
  groupRules: [],
  // Doppelte beim Öffnen: switch springt zum offenen Tab, ask fragt per Meldung.
  dupeGuardMode: 'switch',
  dupeGuardAllow: [],
  discardAfterMin: 60,
  // Aufräum-Vorschlag: so lange unbenutzt gilt ein Tab als alt.
  cleanupDays: 3,
  focusMinutes: 25,
  focusBlock: ['youtube.com', 'x.com', 'twitter.com', 'reddit.com', 'instagram.com', 'facebook.com', 'tiktok.com'],
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const settings = { ...DEFAULTS, ...stored };
  // Alte Einstellung ohne Tilde auf den gültigen Alias umstellen.
  if (settings.model === 'typesafe/jev-latest') settings.model = '~typesafe/jev-latest';
  if (!PROVIDERS.openrouter.models[settings.model]) settings.model = DEFAULTS.model;
  if (!PROVIDERS.typesafe.models[settings.typesafeModel]) settings.typesafeModel = DEFAULTS.typesafeModel;
  if (!PROVIDERS[settings.provider]) settings.provider = DEFAULTS.provider;
  return settings;
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

export async function getUsage() {
  const { usage } = await chrome.storage.local.get('usage');
  const month = monthKey();
  if (!usage || usage.month !== month) return { month, requests: 0, cost: 0, unknownCost: 0 };
  return usage;
}

export async function recordUsage(cost, estimated = false) {
  const usage = await getUsage();
  usage.requests += 1;
  if (typeof cost === 'number') usage.cost += cost;
  else usage.unknownCost += 1;
  if (estimated) usage.estimated = (usage.estimated || 0) + 1;
  await chrome.storage.local.set({ usage });
  return usage;
}

export function hostMatches(host, patterns) {
  const h = (host || '').toLowerCase();
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase();
    if (!p) return false;
    if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
    return h === p || h.endsWith('.' + p);
  });
}
