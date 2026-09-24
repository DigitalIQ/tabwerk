// Schnellsuche wie Omni: Tabs, Aktionen, Lesezeichen und Verlauf.
// Gesucht wird per Code bei jedem Tastendruck. Jev fragt Tabwerk nur mit Umschalt+Enter,
// und nur wenn das in den Einstellungen eingeschaltet ist.

import { h, icon, send, favicon } from '../ui/dom.js';
import { getSettings, hasKey } from '../lib/settings.js';
import { scoreItem, parseQuery } from '../lib/fuzzy.js';
import { hostOf } from '../lib/url.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const standalone = params.has('standalone');
document.body.classList.toggle('standalone', standalone);

const settings = await getSettings();
const windowId = standalone ? Number(params.get('win')) : (await chrome.windows.getCurrent()).id;
const jevOn = settings.paletteJev && hasKey(settings);
$('#jev-key').hidden = !jevOn;

function close() {
  if (standalone) window.close();
  else parent.postMessage({ tabwerk: 'close' }, '*');
}

// ---------- Quellen laden ----------

const sources = { tabs: [], actions: [], bookmarks: [], history: [] };
const windowNumbers = new Map();

async function loadTabs() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  windows.forEach((w, i) => windowNumbers.set(w.id, i + 1));
  const groups = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
  // Tabwerks eigene Hilfsfenster tauchen nicht als Treffer auf.
  const own = [chrome.runtime.getURL('src/palette/'), chrome.runtime.getURL('src/watch/')];
  sources.tabs = windows.flatMap((w) => w.tabs.filter((t) => !own.some((p) => (t.url || '').startsWith(p))).map((t) => ({
    kind: 'tab',
    id: `tab:${t.id}`,
    tab: t,
    title: t.title || t.url,
    sub: [groups.get(t.groupId)?.title, hostOf(t.url) || t.url].filter(Boolean).join(' · '),
    url: t.url,
    here: t.windowId === windowId,
    recent: t.lastAccessed || 0,
    fields: [[t.title || '', 1], [t.url || '', 0.75], [groups.get(t.groupId)?.title || '', 0.6]],
  })));
}

async function loadActions() {
  const actions = await send('paletteActions');
  sources.actions = actions.map((a) => ({ kind: 'action', id: `action:${a.id}`, action: a, title: a.title, sub: a.jev ? 'fragt Jev' : '', fields: [[a.title, 1], [a.words, 0.6]] }));
}

async function loadBookmarks() {
  if (!settings.paletteBookmarks || !(await chrome.permissions.contains({ permissions: ['bookmarks'] }))) return;
  const out = [];
  const walk = (nodes, path) => {
    for (const n of nodes) {
      if (n.url) out.push({ kind: 'bookmark', id: `bm:${n.id}`, title: n.title || n.url, sub: [path, hostOf(n.url)].filter(Boolean).join(' · '), url: n.url, fields: [[n.title || '', 1], [n.url, 0.75], [path, 0.5]] });
      if (n.children) walk(n.children, [path, n.title].filter(Boolean).join(' / '));
    }
  };
  walk(await chrome.bookmarks.getTree(), '');
  sources.bookmarks = out;
}

async function loadHistory() {
  if (!settings.paletteHistory || !(await chrome.permissions.contains({ permissions: ['history'] }))) return;
  const items = await chrome.history.search({ text: '', maxResults: 1500, startTime: Date.now() - 90 * 864e5 });
  sources.history = items.map((i) => ({ kind: 'history', id: `hist:${i.id}`, title: i.title || i.url, sub: hostOf(i.url) || i.url, url: i.url, recent: i.lastVisitTime || 0, fields: [[i.title || '', 1], [i.url, 0.75]] }));
}

// ---------- Rangfolge ----------

const WEIGHT = { tab: 1, action: 0.95, bookmark: 0.8, history: 0.65 };
const KIND_LABEL = { tab: 'Tab', action: 'Aktion', bookmark: 'Lesezeichen', history: 'Verlauf' };
const SCOPE_LABEL = { tab: 'nur Tabs', action: 'nur Aktionen', bookmark: 'nur Lesezeichen', history: 'nur Verlauf' };

function rank(raw) {
  const { only, text } = parseQuery(raw);
  $('#scope').hidden = !only;
  $('#scope').textContent = only ? SCOPE_LABEL[only] : '';
  const pool = [...sources.tabs, ...sources.actions, ...sources.bookmarks, ...sources.history].filter((i) => !only || i.kind === only);
  const now = Date.now();

  if (!text.trim()) {
    // Ohne Eingabe: zuletzt benutzte Tabs dieses Fensters, dann Aktionen.
    const tabs = pool.filter((i) => i.kind === 'tab' && (only || i.here) && !i.tab.active).sort((a, b) => b.recent - a.recent).slice(0, 8);
    const rest = pool.filter((i) => i.kind !== 'tab').slice(0, only ? 40 : 6);
    return [...tabs, ...rest];
  }

  const openUrls = new Set(sources.tabs.map((t) => t.url));
  return pool
    .filter((i) => i.kind === 'tab' || i.kind === 'action' || !openUrls.has(i.url))
    .map((i) => {
      const s = scoreItem(text, i.fields);
      if (s === null) return null;
      let score = s * WEIGHT[i.kind];
      if (i.here) score += 4;
      if (i.recent) score += Math.max(0, 3 - (now - i.recent) / 36e5 / 8);
      return { ...i, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 60);
}

// ---------- Anzeige ----------

let results = [];
let selected = 0;

function lead(item) {
  let inner;
  if (item.kind === 'action') inner = icon(item.action.jev ? 'bolt' : 'play');
  else if (item.url) inner = favicon(item.url);
  else inner = icon('window');
  return h('span', { class: 'lead', 'aria-hidden': 'true' }, inner);
}

function kindLabel(item) {
  if (item.kind === 'tab') return item.here ? 'Tab' : `Tab · Fenster ${windowNumbers.get(item.tab.windowId)}`;
  if (item.kind === 'action' && item.action.jev) return 'Jev';
  return KIND_LABEL[item.kind];
}

function render() {
  const list = $('#list');
  list.replaceChildren(...results.map((item, i) => {
    const li = h('li', {
      class: `item${item.action?.disabled ? ' disabled' : ''}`,
      id: `r${i}`,
      role: 'option',
      'aria-selected': String(i === selected),
      onclick: () => { selected = i; choose(); },
      onmousemove: () => { if (selected !== i) { selected = i; mark(); } },
    },
    lead(item),
    h('span', { class: 'txt' }, h('span', { class: 'title' }, item.title), item.sub ? h('span', { class: 'sub' }, item.sub) : null),
    h('span', { class: `kind${item.kind === 'action' && item.action.jev ? ' jev' : ''}` }, item.jevP !== undefined ? `Jev ${Math.round(item.jevP * 100)} %` : kindLabel(item)));
    return li;
  }));
  mark();
}

function mark() {
  document.querySelectorAll('.item').forEach((el, i) => el.setAttribute('aria-selected', String(i === selected)));
  const el = document.getElementById(`r${selected}`);
  el?.scrollIntoView({ block: 'nearest' });
  $('#q').setAttribute('aria-activedescendant', el ? el.id : '');
}

function status(text, error = false) {
  const el = $('#status');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('error', error);
}

function update() {
  results = rank($('#q').value);
  selected = 0;
  status(results.length ? '' : jevOn ? 'Kein Treffer. Umschalt+Enter fragt Jev.' : 'Kein Treffer.');
  render();
}

// ---------- Auswählen ----------

async function choose() {
  const item = results[selected];
  if (!item) return;
  if (item.kind === 'tab') {
    chrome.runtime.sendMessage({ type: 'focusTab', payload: { tabId: item.tab.id, windowId: item.tab.windowId } });
    close();
    return;
  }
  if (item.kind === 'bookmark' || item.kind === 'history') {
    chrome.tabs.create({ url: item.url, windowId });
    close();
    return;
  }
  if (item.action.disabled) {
    status('Für diese Aktion braucht Tabwerk einen Schlüssel für Jev. Trag ihn in den Einstellungen ein.', true);
    return;
  }
  status(item.action.jev ? 'Jev entscheidet …' : 'Läuft …');
  try {
    const { message } = await send('runAction', { id: item.action.id, windowId });
    if (message) {
      status(message);
      setTimeout(close, 900);
    } else close();
  } catch (error) {
    status(error.message, true);
  }
}

async function closeSelectedTab() {
  const item = results[selected];
  if (item?.kind !== 'tab') return;
  await chrome.tabs.remove(item.tab.id);
  sources.tabs = sources.tabs.filter((t) => t.id !== item.id);
  const keep = selected;
  results = rank($('#q').value);
  selected = Math.min(keep, results.length - 1);
  render();
}

async function askJev() {
  const { text } = parseQuery($('#q').value);
  if (!jevOn || !text.trim()) return;
  status('Jev sucht in allen offenen Tabs …');
  try {
    const { hits } = await send('find', { query: text });
    const byId = new Map(sources.tabs.map((t) => [t.tab.id, t]));
    results = hits.filter((x) => !x.none && byId.has(x.id)).map((x) => ({ ...byId.get(x.id), jevP: x.p }));
    selected = 0;
    status(results.length ? '' : 'Jev findet keinen passenden Tab.');
    render();
  } catch (error) {
    status(error.message, true);
  }
}

$('#q').addEventListener('input', update);
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, results.length - 1); mark(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); mark(); }
  else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); askJev(); }
  else if (e.key === 'Enter') { e.preventDefault(); choose(); }
  else if (e.key === 'Escape') { e.preventDefault(); close(); }
  else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && results[selected]?.kind === 'tab') { e.preventDefault(); closeSelectedTab(); }
});
$('#scrim').addEventListener('click', close);
if (standalone) window.addEventListener('blur', () => setTimeout(close, 150));

await Promise.all([loadTabs(), loadActions(), loadBookmarks(), loadHistory()]);
update();
$('#q').focus();
