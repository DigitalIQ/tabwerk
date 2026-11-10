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
import { t, tp, fmtNumber, fmtDate, initI18n, language, localizeDom } from '../lib/i18n.js';
import { emojiDefaultKey, emojiTiles, indexEmojiVariants, loadEmoji, preferredEmoji, searchEmoji } from './emoji.js';
import { readEmojiUsage, rankEmojiUsage } from '../lib/emoji-usage.js';

// Nur weiter, wenn Tabwerk die Suche selbst geöffnet hat. Eine fremde Seite, die palette.html
// einrahmt, bekommt eine leere Fläche (siehe checkPaletteGrant in background.js).
// Im iFrame schickt content.js das Token nach dem Laden, im eigenen Fenster gibt es keins.
const framed = window.top !== window;
const token = framed ? await new Promise((resolve) => {
  const onToken = (event) => {
    if (event.source !== parent || typeof event.data?.tabwerkToken !== 'string') return;
    window.removeEventListener('message', onToken);
    resolve(event.data.tabwerkToken);
  };
  window.addEventListener('message', onToken);
  setTimeout(() => resolve(null), 5000);
}) : null;
const auth = await chrome.runtime.sendMessage({ type: 'paletteAuth', payload: { token } }).catch(() => null);
if (!auth?.ok) {
  document.documentElement.replaceChildren();
  throw new Error('Tabwerk palette: not opened by Tabwerk');
}

await initI18n();
localizeDom();

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
const jevKeyOn = jevOn || (isOn(settings, 'paletteHistoryJev') && hasKey(settings));

function close(restoreFocus = false) {
  if (standalone) window.close();
  else parent.postMessage({ tabwerk: 'close', restoreFocus: restoreFocus === true }, '*');
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
  const own = [chrome.runtime.getURL('src/palette/'), chrome.runtime.getURL('src/watch/'), chrome.runtime.getURL('src/popup/')];
  sources.tabs = windows.flatMap((w) => w.tabs.filter((tab) => !own.some((p) => (tab.url || '').startsWith(p))).map((tab) => {
    const note = notes[normalizeUrl(tab.url || '')]?.text || '';
    return {
      kind: 'tab',
      id: `tab:${tab.id}`,
      tab,
      title: tab.title || tab.url,
      sub: [note ? t('pal_notePrefix', note) : null, groups.get(tab.groupId)?.title, hostOf(tab.url) || tab.url].filter(Boolean).join(' · '),
      url: tab.url,
      note,
      here: tab.windowId === windowId,
      recent: tab.lastAccessed || 0,
      fields: [[tab.title || '', 1], [tab.url || '', 0.75], [groups.get(tab.groupId)?.title || '', 0.6], [note, 0.9]],
    };
  }));
  // Notizen zu Seiten, die gerade nicht offen sind, bleiben auffindbar.
  const open = new Set(sources.tabs.map((tab) => normalizeUrl(tab.url || '')));
  sources.notes = Object.entries(notes).filter(([k]) => !open.has(k)).map(([k, n]) => ({
    kind: 'note', id: `note:${k}`, title: n.title || n.url, sub: t('pal_notePrefix', n.text), url: n.url, recent: n.t,
    fields: [[n.title || '', 1], [n.text, 0.9], [n.url, 0.6]],
  }));
}

async function loadExtras() {
  const jobs = [];
  if (on('sessions')) jobs.push(send('listSessions').then((list) => {
    sources.sessions = list.map((s) => ({ kind: 'session', id: `session:${s.id}`, session: s, title: s.name,
      sub: `${tp('pal_tabsCount', s.windows.reduce((n, w) => n + w.tabs.length, 0))} · ${fmtDate(s.t, { day: 'numeric', month: 'numeric', year: 'numeric' })}`, fields: [[s.name, 1]] }));
  }));
  if (on('snooze')) jobs.push(send('listSnoozed').then((list) => {
    sources.snoozed = list.map((z) => ({ kind: 'snooze', id: `snooze:${z.id}`, snooze: z, title: z.title || z.url, url: z.url,
      sub: t('pal_snoozeWakesAt', fmtDate(z.when, { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })),
      fields: [[z.title || '', 1], [z.url, 0.7]] }));
  }));
  if (on('forms')) jobs.push(send('listProfiles').then((list) => {
    sources.forms = list.map((f) => ({ kind: 'form', id: `form:${f.id}`, form: f, title: f.name, sub: `${tp('pal_fieldsCount', f.fields.length)} · ${f.host}`,
      here: f.host === currentHost, fields: [[f.name, 1], [f.host, 0.8]] }));
  }));
  await Promise.all(jobs);
}

async function loadActions() {
  const actions = await send('paletteActions');
  sources.actions = actions.map((a) => ({ kind: 'action', id: `action:${a.id}`, action: a, title: a.title, sub: a.jev ? t('pal_jevHint') : '', fields: [[a.title, 1], [a.words, 0.6]] }));
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
const KIND_LABEL = {
  get newnote() { return t('pal_kindNewnote'); },
  get pagesearch() { return t('pal_kindJev'); },
  get tab() { return t('pal_kindTab'); },
  get action() { return t('pal_kindAction'); },
  get bookmark() { return t('pal_kindBookmark'); },
  get history() { return t('pal_kindHistory'); },
  get note() { return t('pal_kindNote'); },
  get session() { return t('pal_kindSession'); },
  get snooze() { return t('pal_kindSnooze'); },
  get form() { return t('pal_kindForm'); },
};
const SCOPE_LABEL = {
  get tab() { return t('pal_scopeTab'); },
  get action() { return t('pal_scopeAction'); },
  get bookmark() { return t('pal_scopeBookmark'); },
  get history() { return t('pal_scopeHistory'); },
  get note() { return t('pal_scopeNote'); },
  get session() { return t('pal_scopeSession'); },
  get snooze() { return t('pal_scopeSnooze'); },
  get form() { return t('pal_scopeForm'); },
};
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
  return t('pal_snippet', text.slice(Math.max(0, at - 30), at + 60).replace(/\s+/g, ' ').trim());
}

let activeTab = null;

function rank(raw) {
  const { only, text, create } = parseQuery(raw);
  if (create === 'note' && on('notes')) {
    $('#scope').hidden = false;
    $('#scope').textContent = t('pal_scopeNewNote');
    const old = activeTab && notes[normalizeUrl(activeTab.url || '')]?.text;
    return [{
      kind: 'newnote', id: 'newnote', text: text.trim(),
      title: text.trim() ? t('pal_newNoteSave', text.trim()) : t('pal_newNoteOpen'),
      sub: [activeTab?.title, old ? t('pal_newNoteAppend') : null].filter(Boolean).join(' · '),
    }];
  }
  if (create === 'pagesearch' && on('pageSearch')) {
    $('#scope').hidden = false;
    $('#scope').textContent = t('pal_scopePageSearch');
    return [{
      kind: 'pagesearch', id: 'pagesearch', text: text.trim(),
      title: text.trim() ? t('pal_pageSearchRun', text.trim()) : t('pal_pageSearchOpen'),
      sub: activeTab?.title || '',
    }];
  }
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

  const openUrls = new Set(sources.tabs.map((tab) => tab.url));
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
let rendered = 0;
let emojiCatalog;
let emojiLoad;
let emojiUsage;
let emojiVariants;
let emojiDefaults = {};
let variantAnchor;
let variantDismissTimer;
let savingEmojiDefault = false;
let emojiSections = new Map();
let emojiRows;
let choosingEmoji = false;
const EMOJI_BATCH = 80;
const emojiMode = () => $('#q').value.startsWith(':');
const emojiGrid = () => emojiMode() && settings.emojiLayout !== 'list';

function emojiResults(query) {
  const matches = emojiTiles(searchEmoji(emojiCatalog, query), emojiVariants, emojiDefaults, { query });
  const groups = new Map();
  if (!query.trim() && emojiUsage) {
    const byEmoji = new Map(emojiCatalog.map((item) => [item.emoji, item]));
    for (const key of ['recent', 'frequent']) {
      const items = emojiUsage[key].map(([emoji]) => byEmoji.get(emoji)).filter(Boolean);
      groups.set(`emoji_${key}`, emojiTiles(items, emojiVariants, emojiDefaults, { keepUsedTone: true }));
    }
  }
  if (settings.emojiLayout === 'grouped') {
    for (const item of matches) {
      const key = `emoji_group_${item.group}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
  } else groups.set('', matches);
  emojiSections = new Map();
  const items = [];
  for (const [key, group] of groups) {
    if (!group.length) continue;
    emojiSections.set(items.length, { label: key ? t(key) : '', end: items.length + group.length });
    items.push(...group);
  }
  return items;
}

function lead(item) {
  let inner;
  if (item.kind === 'action') inner = icon(item.action.jev ? 'bolt' : 'play');
  else if (item.kind === 'session') inner = icon('window');
  else if (item.kind === 'form') inner = icon('edit');
  else if (item.kind === 'newnote') inner = icon('note');
  else if (item.kind === 'pagesearch') inner = icon('search');
  else if (item.kind === 'snooze') inner = icon('moon');
  else if (item.url) inner = favicon(item.url);
  else inner = icon('window');
  return h('span', { class: 'lead', 'aria-hidden': 'true' }, inner);
}

function kindLabel(item) {
  if (item.kind === 'tab') return item.here ? KIND_LABEL.tab : t('pal_tabInWindow', windowNumbers.get(item.tab.windowId));
  if (item.kind === 'action' && item.action.jev) return t('pal_kindJev');
  return KIND_LABEL[item.kind];
}

function resultAttrs(i) {
  return {
    id: `r${i}`, role: 'option', 'aria-selected': 'false',
    onclick: () => { selected = i; choose(); },
    onmousemove: () => { if (selected !== i) { selected = i; mark(!emojiGrid()); } },
  };
}

function showEmojiTip(target) {
  const tip = $('#emoji-tip');
  tip.textContent = target.getAttribute('aria-label');
  tip.hidden = false;
  const cell = target.getBoundingClientRect();
  const x = cell.left + (cell.width - tip.offsetWidth) / 2;
  tip.style.left = `${Math.max(8, Math.min(x, innerWidth - tip.offsetWidth - 8))}px`;
  tip.style.top = `${cell.bottom + tip.offsetHeight + 14 < innerHeight ? cell.bottom + 6 : cell.top - tip.offsetHeight - 6}px`;
}

function hideEmojiTip() {
  $('#emoji-tip').hidden = true;
}

function hideEmojiVariants() {
  clearTimeout(variantDismissTimer);
  const popup = $('#emoji-variants');
  if (popup.contains(document.activeElement)) $('#q').focus({ preventScroll: true });
  popup.hidden = true;
  variantAnchor = undefined;
}

function leaveEmojiVariants() {
  clearTimeout(variantDismissTimer);
  if (!$('#emoji-variants').contains(document.activeElement)) variantDismissTimer = setTimeout(hideEmojiVariants, 180);
}

function positionEmojiVariants() {
  const popup = $('#emoji-variants');
  const choices = $('#emoji-variant-options');
  const cell = variantAnchor.getBoundingClientRect();
  const above = cell.top - 12;
  const below = innerHeight - cell.bottom - 12;
  const headingHeight = popup.offsetHeight - choices.offsetHeight;
  const showAbove = above >= choices.scrollHeight + headingHeight || above >= below;
  choices.style.maxHeight = `${Math.max(0, (showAbove ? above : below) - headingHeight)}px`;
  const x = cell.left + (cell.width - popup.offsetWidth) / 2;
  popup.style.left = `${Math.max(8, Math.min(x, innerWidth - popup.offsetWidth - 8))}px`;
  popup.style.top = `${showAbove ? cell.top - popup.offsetHeight - 4 : cell.bottom + 4}px`;
}

async function saveEmojiVariant(family, variant) {
  if (savingEmojiDefault) return;
  savingEmojiDefault = true;
  const anchor = variantAnchor;
  const key = emojiDefaultKey(family.base.emoji);
  try {
    await chrome.storage.local.set({ [key]: variant.emoji });
    emojiDefaults[key] = variant.emoji;
    if (!emojiMode()) return;
    if (anchor?.isConnected) selected = Number(anchor.id.slice(1));
    results = emojiResults($('#q').value.slice(1));
    selected = Math.min(selected, Math.max(0, results.length - 1));
    render();
    status(t('pal_emojiVariantSaved', variant.title));
  } catch {
    status(t('pal_emojiVariantFailed'), true);
  } finally {
    savingEmojiDefault = false;
  }
}

function showEmojiVariants(target, family, keyboard = false) {
  hideEmojiVariants();
  hideEmojiTip();
  variantAnchor = target;
  const preferred = preferredEmoji(family, emojiDefaults);
  $('#emoji-variant-options').replaceChildren(...family.choices.map((variant) => h('button', {
    type: 'button', tabindex: '-1', title: variant.title, 'aria-label': variant.title,
    'aria-pressed': String(variant === preferred), onclick: () => saveEmojiVariant(family, variant),
  }, variant.emoji)));
  $('#emoji-variants').hidden = false;
  positionEmojiVariants();
  if (keyboard) $('#emoji-variant-options [aria-pressed="true"]').focus();
}

function appendEmojiRows(limit) {
  const list = $('#list');
  for (; rendered < limit; rendered += 1) {
    const section = emojiSections.get(rendered);
    if (section) {
      emojiRows = h('ul', { class: 'emoji-rows', role: 'presentation', 'data-start': rendered, 'data-end': section.end });
      list.append(h('li', { class: 'emoji-group', role: 'group', 'aria-label': section.label || t('pal_emojiScope') },
        section.label ? h('div', { class: 'emoji-group-title', 'aria-hidden': 'true' }, section.label) : null,
        emojiRows));
    }
    const item = results[rendered];
    const grid = emojiGrid();
    const family = emojiVariants.get(item.emoji);
    emojiRows.append(h('li', {
      ...resultAttrs(rendered), class: `item emoji-entry${family ? ' has-variants' : ''}`, 'aria-label': item.title,
      onmouseenter: family ? (event) => showEmojiVariants(event.currentTarget, family) : (event) => {
        hideEmojiVariants();
        if (grid) showEmojiTip(event.currentTarget);
      },
      onmouseleave: family ? leaveEmojiVariants : hideEmojiTip,
    },
    h('span', { class: 'emoji', 'aria-hidden': 'true' }, item.emoji),
    grid ? null : h('span', { class: 'title' }, item.title)));
  }
}

function appendRows(limit) {
  if (emojiMode()) {
    appendEmojiRows(Math.min(limit, results.length));
    return;
  }
  const rows = results.slice(rendered, limit).map((item, offset) => {
    const i = rendered + offset;
    return h('li', {
      ...resultAttrs(i),
      class: `item${item.action?.disabled ? ' disabled' : ''}`,
    },
    lead(item),
    h('span', { class: 'txt' }, h('span', { class: 'title' }, item.title), item.sub ? h('span', { class: 'sub' }, item.sub) : null),
    h('span', { class: `kind${item.kind === 'action' && item.action.jev ? ' jev' : ''}` }, item.jevP !== undefined ? t('pal_jevPercent', fmtNumber(Math.round(item.jevP * 100))) : kindLabel(item)));
  });
  $('#list').append(...rows);
  rendered += rows.length;
}

function render() {
  const list = $('#list');
  list.classList.toggle('emoji-list', emojiMode());
  list.classList.toggle('emoji-grid', emojiGrid());
  list.replaceChildren();
  hideEmojiTip();
  hideEmojiVariants();
  emojiRows = undefined;
  rendered = 0;
  appendRows(emojiMode() ? EMOJI_BATCH : results.length);
  // Erst scrollen lassen, wenn das Raster den sichtbaren Bereich füllt.
  while (emojiMode() && rendered < results.length && list.clientHeight && list.scrollHeight <= list.clientHeight) {
    appendRows(rendered + EMOJI_BATCH);
  }
  if (selected === 0) list.scrollTop = 0;
  mark(selected !== 0);
}

function mark(scroll = true) {
  if (selected >= rendered && selected < results.length) appendRows(selected + EMOJI_BATCH);
  $('#list [aria-selected="true"]')?.setAttribute('aria-selected', 'false');
  const el = document.getElementById(`r${selected}`);
  $('#emoji-variant-key').hidden = !emojiMode() || !emojiVariants?.has(results[selected]?.emoji);
  el?.setAttribute('aria-selected', 'true');
  if (scroll) el?.scrollIntoView({ block: 'nearest' });
  $('#q').setAttribute('aria-activedescendant', el ? el.id : '');
}

function status(text, error = false) {
  const el = $('#status');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('error', error);
}

function update() {
  const emoji = emojiMode();
  $('#jev-key').hidden = emoji || !jevKeyOn;
  $('#close-tab-key').hidden = emoji;
  $('#palette-filters').hidden = emoji;
  $('#horizontal-keys').hidden = !emojiGrid();
  const emojiActionLabel = { both: 'pal_kbdEmoji', insert: 'pal_kbdEmojiInsert', copy: 'pal_kbdEmojiCopy' };
  $('#enter-label').textContent = t(emoji ? emojiActionLabel[settings.emojiAction] ?? 'pal_kbdEmoji' : 'pal_kbdOpen');
  if (emoji) {
    $('#scope').hidden = false;
    $('#scope').textContent = t('pal_emojiScope');
    results = emojiCatalog ? emojiResults($('#q').value.slice(1)) : [];
    status(emojiCatalog ? (results.length ? '' : t('pal_emojiNoResults')) : t('pal_emojiLoading'));
    emojiLoad ??= Promise.all([loadEmoji(language()), readEmojiUsage().catch(() => ({}))]).then(async ([catalog, usage]) => {
      emojiVariants = indexEmojiVariants(catalog);
      const keys = [...new Set([...emojiVariants.values()].map(({ base }) => emojiDefaultKey(base.emoji)))];
      emojiDefaults = await chrome.storage.local.get(keys).catch(() => ({}));
      emojiCatalog = catalog;
      emojiUsage = rankEmojiUsage(usage);
      if (emojiMode()) update();
    }).catch(() => {
      emojiLoad = undefined;
      if (emojiMode()) status(t('pal_emojiLoadFailed'), true);
    });
  } else {
    results = rank($('#q').value);
    status(results.length ? '' : jevOn ? t('pal_noResultsJev') : t('pal_noResults'));
  }
  selected = 0;
  render();
}

// ---------- Auswählen ----------

async function copyEmoji(emoji) {
  try {
    await navigator.clipboard.writeText(emoji);
    return true;
  } catch {
    // Manche Seiten sperren die Clipboard API für eingebettete Frames.
    const field = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    field.value = emoji;
    document.body.append(field);
    try {
      field.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      field.remove();
      $('#q').focus();
    }
  }
}

async function chooseEmoji(emoji) {
  choosingEmoji = true;
  const shouldCopy = settings.emojiAction !== 'insert';
  const shouldInsert = settings.emojiAction !== 'copy';
  const copied = shouldCopy && await copyEmoji(emoji);
  let inserted = false;
  if (framed && shouldInsert) {
    const reply = await chrome.tabs.sendMessage(auth.tabId, { type: 'paletteInsertEmoji', token, emoji }, { frameId: 0 }).catch(() => null);
    inserted = Boolean(reply?.inserted);
  }
  if (copied || inserted) {
    await send('recordEmojiUse', { emoji }).catch(() => {});
    if (inserted && (!shouldCopy || copied)) return close();
    status(t(copied ? 'pal_emojiCopied' : 'pal_emojiCopyFailed'), !copied);
    setTimeout(() => close(!inserted), copied ? 650 : 900);
    return;
  }
  status(t(shouldCopy ? 'pal_emojiCopyFailed' : 'pal_emojiNoEditor'), true);
  choosingEmoji = false;
}

async function choose() {
  const item = results[selected];
  if (!item || choosingEmoji) return;
  if (item.kind === 'emoji') return chooseEmoji(item.emoji);
  if (item.kind === 'tab') {
    chrome.runtime.sendMessage({ type: 'focusTab', payload: { tabId: item.tab.id, windowId: item.tab.windowId } });
    close();
    return;
  }
  if (item.kind === 'newnote') {
    try {
      if (item.text) {
        const r = await send('addNote', { windowId, text: item.text });
        status(r.message);
        setTimeout(close, 700);
      } else {
        await send('runAction', { id: 'note.edit', windowId });
        close();
      }
    } catch (error) {
      status(error.message, true);
    }
    return;
  }
  if (item.kind === 'pagesearch') {
    try {
      await send('openPageSearch', { windowId, query: item.text });
      close();
    } catch (error) {
      status(error.message, true);
    }
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
    status(t('pal_fillingForm'));
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
    status(t('pal_needJevKey'), true);
    return;
  }
  if (item.action.origin) {
    // Chrome fragt nach dem Leserecht nur direkt nach einem Klick oder Tastendruck in einer Tabwerk-Seite.
    const host = hostOf(activeTab?.url || '');
    const granted = host && await chrome.permissions.request({ origins: [`*://${host}/*`, `*://*.${host}/*`] }).catch(() => false);
    if (!granted) {
      status(t('pal_needPermission'), true);
      return;
    }
  }
  status(item.action.jev ? t('pal_jevDeciding') : t('pal_running'));
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
  sources.tabs = sources.tabs.filter((tab) => tab.id !== item.id);
  if (emojiMode()) return;
  const keep = selected;
  results = rank($('#q').value);
  selected = Math.min(keep, results.length - 1);
  render();
}

async function askJev() {
  const { only, text } = parseQuery($('#q').value);
  if (only === 'history' && on('paletteHistoryJev') && hasKey(settings) && text.trim()) {
    status(t('pal_jevSearchingHistory'));
    try {
      const { hits, period } = await send('findHistory', { query: text });
      if (emojiMode()) return;
      results = hits.map((x) => ({ kind: 'history', id: `jh:${x.id}`, title: x.title || x.url, sub: `${hostOf(x.url)} · ${period}`, url: x.url, jevP: x.p }));
      selected = 0;
      status(results.length ? '' : t('pal_jevNoHistoryHits', period));
      render();
    } catch (error) {
      if (!emojiMode()) status(error.message, true);
    }
    return;
  }
  if (!jevOn || !text.trim()) return;
  status(t('pal_jevSearchingTabs'));
  try {
    const { hits } = await send('find', { query: text });
    if (emojiMode()) return;
    const byId = new Map(sources.tabs.map((tab) => [tab.tab.id, tab]));
    results = hits.filter((x) => !x.none && byId.has(x.id)).map((x) => ({ ...byId.get(x.id), jevP: x.p }));
    selected = 0;
    status(results.length ? '' : t('pal_jevNoTabHits'));
    render();
  } catch (error) {
    if (!emojiMode()) status(error.message, true);
  }
}

function verticalEmojiTarget(direction) {
  const rows = document.getElementById(`r${selected}`).parentElement;
  const columns = getComputedStyle(rows).gridTemplateColumns.split(' ').length;
  const { start, end } = rows.dataset;
  const column = (selected - Number(start)) % columns;
  const target = selected + direction * columns;
  if (target >= Number(start) && target < Number(end)) return target;
  if (direction > 0) {
    if (target - column < Number(end)) return Number(end) - 1;
    const next = emojiSections.get(Number(end));
    return next ? Math.min(Number(end) + column, next.end - 1) : selected;
  }
  const previousRows = rows.parentElement.previousElementSibling?.lastElementChild;
  if (!previousRows) return selected;
  const last = Number(start) - 1;
  const lastRowStart = last - (last - Number(previousRows.dataset.start)) % columns;
  return Math.min(last, lastRowStart + column);
}

$('#q').addEventListener('input', update);
$('#q').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  const vertical = e.key === 'ArrowDown' || e.key === 'ArrowUp';
  const horizontal = emojiGrid() && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
    && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey);
  if (vertical || horizontal) {
    e.preventDefault();
    if (!results.length) return;
    const direction = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    const target = vertical && emojiGrid() ? verticalEmojiTarget(direction) : selected + direction;
    selected = Math.max(0, Math.min(target, results.length - 1));
    hideEmojiTip();
    hideEmojiVariants();
    mark();
  }
  else if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    if (!emojiMode()) askJev();
    else {
      const family = emojiVariants?.get(results[selected]?.emoji);
      if (family) showEmojiVariants(document.getElementById(`r${selected}`), family, true);
    }
  }
  else if (e.key === 'Enter') { e.preventDefault(); choose(); }
  else if (e.key === 'Escape') { e.preventDefault(); if (variantAnchor) hideEmojiVariants(); else close(); }
  else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && results[selected]?.kind === 'tab') { e.preventDefault(); closeSelectedTab(); }
});
const variantPopup = $('#emoji-variants');
variantPopup.addEventListener('mouseenter', () => clearTimeout(variantDismissTimer));
variantPopup.addEventListener('mouseleave', leaveEmojiVariants);
variantPopup.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault();
    hideEmojiVariants();
    return;
  }
  const buttons = [...$('#emoji-variant-options').children];
  const columns = getComputedStyle($('#emoji-variant-options')).gridTemplateColumns.split(' ').length;
  const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
  const offset = offsets[event.key];
  if (!offset) return;
  event.preventDefault();
  buttons[Math.max(0, Math.min(buttons.length - 1, buttons.indexOf(document.activeElement) + offset))].focus();
});
document.addEventListener('pointerdown', (event) => {
  if (variantAnchor && !variantPopup.contains(event.target) && !variantAnchor.contains(event.target)) hideEmojiVariants();
});
window.addEventListener('resize', () => { if (variantAnchor) positionEmojiVariants(); });
$('#list').addEventListener('scroll', ({ currentTarget: list }) => {
  if (variantAnchor) {
    const cell = variantAnchor.getBoundingClientRect();
    const view = list.getBoundingClientRect();
    if (cell.bottom <= view.top || cell.top >= view.bottom) hideEmojiVariants();
    else positionEmojiVariants();
  }
  if (!$('#emoji-tip').hidden) {
    const hovered = list.querySelector('.emoji-entry:hover');
    if (hovered) showEmojiTip(hovered);
    else hideEmojiTip();
  }
  if (rendered < results.length && list.scrollHeight - list.scrollTop < 2 * list.clientHeight) appendRows(rendered + EMOJI_BATCH);
});
$('#scrim').addEventListener('click', close);
if (standalone) window.addEventListener('blur', () => setTimeout(close, 150));

const currentHost = await (async () => {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  activeTab = tab || null;
  return tab?.url ? hostOf(tab.url) : '';
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
    if ($('#q').value.trim() && !emojiMode()) update();
  }).catch(() => {});
}
