// Schnellsuche wie Omni: Tabs, Aktionen, Lesezeichen und Verlauf.
// Gesucht wird per Code bei jedem Tastendruck. Jev fragt Tabwerk nur mit Umschalt+Enter,
// und nur wenn das in den Einstellungen eingeschaltet ist.

import { h, icon, send, favicon } from '../ui/dom.js';
import { getSettings, hasKey } from '../lib/settings.js';
import { isOn } from '../lib/flags.js';
import { normalize } from '../lib/fuzzy.js';
import { normalizeUrl } from '../lib/url.js';
import { scoreItem, parseQuery } from '../lib/fuzzy.js';
import { hostOf } from '../lib/url.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const standalone = params.has('standalone');
document.body.classList.toggle('standalone', standalone);

const settings = await getSettings();

// Farbmodus: fest hell, fest dunkel, wie das System oder wie die Seite dahinter.
// Im iFrame meldet prefers-color-scheme nicht zuverlässig das System, deshalb misst content.js beides.
function resolveTheme() {
  const system = params.get('sys') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  if (settings.paletteTheme === 'light' || settings.paletteTheme === 'dark') return settings.paletteTheme;
  if (settings.paletteTheme === 'system') return system;
  return params.get('site') || system;
}
document.documentElement.dataset.theme = resolveTheme();
const windowId = standalone ? Number(params.get('win')) : (await chrome.windows.getCurrent()).id;
const jevOn = settings.paletteJev && hasKey(settings);
$('#jev-key').hidden = !(jevOn || (isOn(settings, 'paletteHistoryJev') && hasKey(settings)));

function close() {
  if (standalone) window.close();
  else parent.postMessage({ tabwerk: 'close' }, '*');
}

// ---------- Quellen laden ----------

const sources = { tabs: [], actions: [], bookmarks: [], history: [], notes: [], sessions: [], snoozed: [], forms: [] };
const on = (id) => isOn(settings, id);
let notes = {};
let texts = new Map();
const windowNumbers = new Map();

async function loadTabs() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  windows.forEach((w, i) => windowNumbers.set(w.id, i + 1));
  const groups = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
  // Tabwerks eigene Hilfsfenster tauchen nicht als Treffer auf.
  const own = [chrome.runtime.getURL('src/palette/'), chrome.runtime.getURL('src/watch/')];
  sources.tabs = windows.flatMap((w) => w.tabs.filter((t) => !own.some((p) => (t.url || '').startsWith(p))).map((t) => {
    const note = notes[normalizeUrl(t.url || '')]?.text || '';
    return {
      kind: 'tab',
      id: `tab:${t.id}`,
      tab: t,
      title: t.title || t.url,
      sub: [note ? `✎ ${note}` : null, groups.get(t.groupId)?.title, hostOf(t.url) || t.url].filter(Boolean).join(' · '),
      url: t.url,
      note,
      here: t.windowId === windowId,
      recent: t.lastAccessed || 0,
      fields: [[t.title || '', 1], [t.url || '', 0.75], [groups.get(t.groupId)?.title || '', 0.6], [note, 0.9]],
    };
  }));
  // Notizen zu Seiten, die gerade nicht offen sind, bleiben auffindbar.
  const open = new Set(sources.tabs.map((t) => normalizeUrl(t.url || '')));
  sources.notes = Object.entries(notes).filter(([k]) => !open.has(k)).map(([k, n]) => ({
    kind: 'note', id: `note:${k}`, title: n.title || n.url, sub: `✎ ${n.text}`, url: n.url, recent: n.t,
    fields: [[n.title || '', 1], [n.text, 0.9], [n.url, 0.6]],
  }));
}

async function loadExtras() {
  const jobs = [];
  if (on('sessions')) jobs.push(send('listSessions').then((list) => {
    sources.sessions = list.map((s) => ({ kind: 'session', id: `session:${s.id}`, session: s, title: s.name,
      sub: `${s.windows.reduce((n, w) => n + w.tabs.length, 0)} Tabs · ${new Date(s.t).toLocaleDateString('de-DE')}`, fields: [[s.name, 1]] }));
  }));
  if (on('snooze')) jobs.push(send('listSnoozed').then((list) => {
    sources.snoozed = list.map((z) => ({ kind: 'snooze', id: `snooze:${z.id}`, snooze: z, title: z.title || z.url, url: z.url,
      sub: `kommt ${new Date(z.when).toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
      fields: [[z.title || '', 1], [z.url, 0.7]] }));
  }));
  if (on('forms')) jobs.push(send('listProfiles').then((list) => {
    sources.forms = list.map((f) => ({ kind: 'form', id: `form:${f.id}`, form: f, title: f.name, sub: `${f.fields.length} Felder · ${f.host}`,
      here: f.host === currentHost, fields: [[f.name, 1], [f.host, 0.8]] }));
  }));
  await Promise.all(jobs);
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

const WEIGHT = { tab: 1, action: 0.95, form: 0.9, session: 0.85, note: 0.8, bookmark: 0.8, snooze: 0.75, history: 0.65 };
const KIND_LABEL = { tab: 'Tab', action: 'Aktion', bookmark: 'Lesezeichen', history: 'Verlauf', note: 'Notiz', session: 'Sitzung', snooze: 'Schlummert', form: 'Formular' };
const SCOPE_LABEL = { tab: 'nur Tabs', action: 'nur Aktionen', bookmark: 'nur Lesezeichen', history: 'nur Verlauf', note: 'nur Notizen', session: 'nur Sitzungen', snooze: 'nur Schlummernde', form: 'nur Formulare' };
const ALL = () => [...sources.tabs, ...sources.actions, ...sources.forms, ...sources.sessions, ...sources.notes, ...sources.snoozed, ...sources.bookmarks, ...sources.history];

// Volltext: jedes Wort muss im Seitentext stehen. Liefert einen Ausschnitt um den ersten Treffer.
function textHit(tabId, query) {
  const text = texts.get(tabId);
  if (!text) return null;
  const words = normalize(query).split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return null;
  const hay = normalize(text);
  if (!words.every((w) => hay.includes(w))) return null;
  const at = hay.indexOf(words[0]);
  return `„…${text.slice(Math.max(0, at - 30), at + 60).replace(/\s+/g, ' ').trim()}…“`;
}

function rank(raw) {
  const { only, text } = parseQuery(raw);
  $('#scope').hidden = !only;
  $('#scope').textContent = only ? SCOPE_LABEL[only] : '';
  const pool = ALL().filter((i) => (only ? i.kind === only || (only === 'note' && i.kind === 'tab' && i.note) : true));
  const now = Date.now();

  if (!text.trim()) {
    // Ohne Eingabe: zuletzt benutzte Tabs dieses Fensters, dann Aktionen.
    const tabs = pool.filter((i) => i.kind === 'tab' && (only || i.here) && !i.tab.active).sort((a, b) => b.recent - a.recent).slice(0, 8);
    const forms = only ? [] : pool.filter((i) => i.kind === 'form' && i.here);
    const rest = pool.filter((i) => i.kind !== 'tab' && !forms.includes(i)).sort((a, b) => Number(b.here || 0) - Number(a.here || 0)).slice(0, only ? 60 : 6);
    return [...forms, ...tabs, ...rest];
  }

  const openUrls = new Set(sources.tabs.map((t) => t.url));
  return pool
    .filter((i) => i.kind === 'tab' || i.kind === 'action' || !openUrls.has(i.url))
    .map((i) => {
      let s = scoreItem(text, i.fields);
      let snippet = null;
      if (s === null && i.kind === 'tab' && texts.size) {
        snippet = textHit(i.tab.id, text);
        if (snippet) s = 8;
      }
      if (s === null) return null;
      if (snippet) return { ...i, sub: snippet, score: s };
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
  else if (item.kind === 'session') inner = icon('window');
  else if (item.kind === 'form') inner = icon('edit');
  else if (item.kind === 'snooze') inner = icon('moon');
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
  if (item.kind === 'bookmark' || item.kind === 'history' || item.kind === 'note') {
    chrome.tabs.create({ url: item.url, windowId });
    close();
    return;
  }
  if (item.kind === 'session') {
    chrome.runtime.sendMessage({ type: 'openSession', payload: { id: item.session.id } });
    close();
    return;
  }
  if (item.kind === 'snooze') {
    chrome.runtime.sendMessage({ type: 'wakeSnoozed', payload: { id: item.snooze.id } });
    close();
    return;
  }
  if (item.kind === 'form') {
    status('Füllt aus …');
    try {
      const r = await send('fillForm', { windowId, profileId: item.form.id });
      status(r.message);
      setTimeout(close, 1100);
    } catch (error) {
      status(error.message, true);
    }
    return;
  }
  if (item.action.disabled) {
    status('Für diese Aktion braucht Tabwerk einen Schlüssel für Jev. Trag ihn in den Einstellungen ein.', true);
    return;
  }
  status(item.action.jev ? 'Jev entscheidet …' : 'Läuft …');
  try {
    const { message, copy, query } = await send('runAction', { id: item.action.id, windowId });
    if (query !== undefined) {
      $('#q').value = query;
      status('');
      update();
      return;
    }
    if (copy !== undefined) await navigator.clipboard.writeText(copy);
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
  await chrome.tabs.remove(item.tab.id).catch(() => {});
  sources.tabs = sources.tabs.filter((t) => t.id !== item.id);
  const keep = selected;
  results = rank($('#q').value);
  selected = Math.min(keep, results.length - 1);
  render();
}

async function askJev() {
  const { only, text } = parseQuery($('#q').value);
  if (only === 'history' && on('paletteHistoryJev') && hasKey(settings) && text.trim()) {
    status('Jev sucht im Verlauf …');
    try {
      const { hits, period } = await send('findHistory', { query: text });
      results = hits.map((x) => ({ kind: 'history', id: `jh:${x.id}`, title: x.title || x.url, sub: `${hostOf(x.url)} · ${period}`, url: x.url, jevP: x.p }));
      selected = 0;
      status(results.length ? '' : `Jev findet nichts im Zeitraum „${period}“.`);
      render();
    } catch (error) {
      status(error.message, true);
    }
    return;
  }
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

const currentHost = await (async () => {
  const [t] = await chrome.tabs.query({ active: true, windowId });
  return t?.url ? hostOf(t.url) : '';
})();
if (on('notes')) notes = await send('listNotes');
await Promise.all([loadTabs(), loadActions(), loadBookmarks(), loadHistory(), loadExtras()]);
if (params.get('q')) $('#q').value = params.get('q');
update();
$('#q').focus();
// Volltext kommt im Hintergrund nach, die Suche ist sofort benutzbar.
if (on('paletteFulltext')) {
  send('tabTexts').then((list) => {
    texts = new Map(list.map((x) => [x.tabId, x.text]));
    if ($('#q').value.trim()) update();
  }).catch(() => {});
}
