import { h, icon, send, meter, favicon, cost, ago } from '../ui/dom.js';
import { getSettings, getUsage, CHROME_COLORS, modelShort, connection, hasKey } from '../lib/settings.js';
import { watchForm } from '../ui/watchform.js';
import { describeInterval } from '../lib/duration.js';
import { hostOf } from '../lib/url.js';
import { isOn } from '../lib/flags.js';

const $ = (sel) => document.querySelector(sel);
// replaceChildren schreibt null als Text. put filtert leere Einträge heraus.
const put = (el, ...nodes) => el.replaceChildren(...nodes.flat().filter(Boolean));
const win = await chrome.windows.getCurrent();
const settings = await getSettings();

// Ausgeschaltete Funktionen verschwinden. data-flag darf mehrere Schalter mit | nennen.
for (const el of document.querySelectorAll('[data-flag]')) {
  el.hidden = !el.dataset.flag.split('|').some((id) => isOn(settings, id));
}

// ---------- Rahmen ----------

async function refreshHeader() {
  const tabs = await chrome.tabs.query({ windowId: win.id });
  const groups = await chrome.tabGroups.query({ windowId: win.id });
  $('#count').textContent = `${tabs.length} Tabs · ${groups.length} Gruppen`;
  const usage = await getUsage();
  const month = new Date().toLocaleDateString('de-DE', { month: 'long' });
  $('#usage').textContent = `${modelShort(connection(settings).model)} · ${usage.requests} Anfragen · ${usage.estimated ? '≈ ' : ''}${cost(usage.cost)}`;
  $('#usage').title = `Jev-Anfragen und gemeldete Kosten im ${month}`;
  const lastAction = isOn(settings, 'undo') ? await send('lastAction', { windowId: win.id }) : null;
  $('#undo').hidden = !lastAction;
  if (lastAction) {
    $('#undo').title = `Stand vor „${lastAction.label}“ wiederherstellen`;
    $('#undo-label').textContent = 'Rückgängig';
  }
}

$('#keybar').hidden = hasKey(settings);
$('#connect').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#undo').addEventListener('click', async () => {
  const button = $('#undo');
  button.disabled = true;
  try {
    await send('undo', { windowId: win.id });
  } finally {
    button.disabled = false;
  }
  await refreshHeader();
  const active = document.querySelector('[role=tab][aria-selected=true]').dataset.panel;
  if (active === 'dupes') showClean();
  if (active === 'history') showHist();
});

function showPanel(name) {
  for (const tab of document.querySelectorAll('[role=tab]')) {
    const on = tab.dataset.panel === name;
    tab.setAttribute('aria-selected', String(on));
    $(`#panel-${tab.dataset.panel}`).hidden = !on;
  }
  try { localStorage.setItem('panel', name); } catch {}
  if (name === 'dupes') showClean();
  if (name === 'watch') loadWatches();
  if (name === 'history') showHist();
  if (name === 'find') $('#find-q').focus();
}
document.querySelectorAll('[role=tab]').forEach((tab) => tab.addEventListener('click', () => showPanel(tab.dataset.panel)));

const skeleton = () => h('div', { class: 'skel', 'aria-label': 'Jev entscheidet' }, h('i'), h('i'), h('i'));

function failure(error) {
  const text = error.code === 'no-key' ? 'Kein Schlüssel für Jev. Verbinde Tabwerk in den Einstellungen.' : error.message;
  return h('div', { class: 'fail', role: 'alert' }, icon('warn'), h('span', {}, text));
}

function empty(ico, title, text) {
  return h('div', { class: 'empty' }, icon(ico), h('b', {}, title), text ? h('span', {}, text) : null);
}

function tabRow(tab, extra, attrs = {}) {
  return h('div', { class: 'row', ...attrs },
    favicon(tab.url),
    h('span', { class: 'txt' }, h('span', { class: 'title' }, tab.title), h('span', { class: 'site' }, hostOf(tab.url) || tab.url)),
    extra || '');
}

async function run(out, task) {
  put(out, skeleton());
  try {
    await task();
  } catch (error) {
    put(out, failure(error));
  }
  refreshHeader();
}

// ---------- Finden ----------

$('#find-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = $('#find-q').value.trim();
  if (!query) return;
  const out = $('#find-out');
  run(out, async () => {
    const { hits, cost: c } = await send('find', { query });
    const top = hits.find((x) => !x.none);
    if (!top) {
      put(out, empty('search', 'Kein Tab passt.', 'Beschreib ihn anders, zum Beispiel mit der Website.'));
      return;
    }
    put(out, ...hits.map((hit) => hit.none
      ? h('p', { class: 'help' }, `Kein passender Tab: ${Math.round(hit.p * 100)} %`)
      : h('button', {
        class: 'row',
        onclick: async () => { await send('focusTab', { tabId: hit.id, windowId: hit.windowId }); window.close(); },
      },
      favicon(hit.url),
      h('span', { class: 'txt' }, h('span', { class: 'title' }, hit.title), h('span', { class: 'site' }, hostOf(hit.url))),
      meter(hit.p, settings.confidence, 'sicher, dass es dieser Tab ist'))),
    h('p', { class: 'help mono' }, cost(c)));
  });
});

// ---------- Gruppen ----------

function reiter(opt) {
  const color = CHROME_COLORS[opt.color] || CHROME_COLORS.grey;
  if (opt.type === 'none') return h('span', { class: 'reiter none' }, opt.name);
  return h('span', { class: `reiter${opt.type === 'new' ? ' new' : ''}`, 'data-c': opt.color, style: { '--c': color } }, opt.name);
}

$('#propose').addEventListener('click', () => {
  const out = $('#groups-out');
  run(out, async () => {
    const res = await send('proposeGroups', { windowId: win.id, onlyUngrouped: $('#only-ungrouped').checked });
    if (!res.items.length) {
      put(out, empty('groups', 'Nichts zu gruppieren.', 'Alle Tabs haben schon eine Gruppe.'));
      return;
    }
    renderGroupPlan(out, res);
  });
});

$('#name-groups').addEventListener('click', () => {
  const out = $('#groups-out');
  run(out, async () => {
    const res = await send('suggestGroupNames', { windowId: win.id });
    if (!res.groups.length) {
      put(out, empty('check', res.message));
      return;
    }
    put(out, h('p', { class: 'help' }, 'Benannt:'),
      ...res.groups.map((g) => h('div', { class: 'row', style: { gridTemplateColumns: '1fr auto' } },
        reiter({ type: 'existing', name: g.name, color: g.color }),
        g.confidence !== null ? meter(g.confidence, settings.confidence) : h('span', { class: 'faint mono' }, 'Code'))),
      res.cost ? h('p', { class: 'help mono' }, cost(res.cost)) : null);
  });
});

function renderGroupPlan(out, res) {
  const plan = new Map(res.items.map((item) => [item.id, { target: item.target, on: item.sure }]));
  const keys = Object.keys(res.options);

  const draw = () => {
    const buckets = keys
      .map((key) => ({ key, opt: res.options[key], items: res.items.filter((i) => plan.get(i.id).target === key) }))
      .filter((b) => b.items.length);
    const unsure = res.items.filter((i) => !i.sure).length;
    const selected = [...plan.values()].filter((p) => p.on && p.target !== 'none').length;
    const apply = h('button', { class: 'primary', disabled: !selected, onclick: applyPlan }, `${selected} Tabs einsortieren`);
    put(out, 
      unsure ? h('p', { class: 'help' }, h('span', { class: 'flag' }, icon('warn'), `${unsure} prüfen`), ' Hier ist Jev unsicher. Diese Tabs sind abgewählt.') : null,
      ...buckets.map((b) => h('div', { class: `bucket${b.opt.type === 'none' ? ' none' : ''}`, style: { '--c': CHROME_COLORS[b.opt.color] } },
        reiter(b.opt),
        h('div', { class: 'list' }, ...b.items.map((item) => groupRow(item))))),
      h('div', { class: 'summary sticky' }, h('span', { class: 'mono' }, cost(res.cost)), apply),
    );
  };

  const groupRow = (item) => {
    const state = plan.get(item.id);
    const box = h('input', { type: 'checkbox', 'aria-label': `${item.title} einsortieren`, onchange: (e) => { state.on = e.target.checked; draw(); } });
    box.checked = state.on;
    const select = h('select', { 'aria-label': 'Ziel ändern', onchange: (e) => { state.target = e.target.value; state.on = e.target.value !== 'none'; draw(); } },
      ...keys.map((k) => h('option', { value: k }, res.options[k].name)));
    select.value = state.target;
    return h('div', { class: `row check-row${item.sure ? '' : ' unsure'}` },
      box,
      favicon(item.url),
      h('span', { class: 'txt' }, h('span', { class: 'title' }, item.title), h('span', { class: 'site' }, hostOf(item.url))),
      h('span', { style: { display: 'grid', gap: '4px', justifyItems: 'end' } }, meter(item.confidence, res.threshold), select));
  };

  async function applyPlan() {
    const chosen = [...plan].filter(([, p]) => p.on && p.target !== 'none').map(([tabId, p]) => ({ tabId, target: p.target }));
    await run(out, async () => {
      const { moved } = await send('applyGroups', { windowId: win.id, plan: chosen, options: res.options });
      put(out, empty('check', `${moved} Tabs einsortiert.`, 'Mit Rückgängig stellst du den alten Stand her.'));
    });
  }

  draw();
}

// ---------- Sortieren ----------

$('#sort-go').addEventListener('click', () => {
  const by = document.querySelector('input[name=sort]:checked').value;
  const out = $('#sort-out');
  run(out, async () => {
    if (by === 'groups') {
      const res = await send('sortGroups', { windowId: win.id });
      if (!res.groups.length) {
        put(out, empty('groups', 'Weniger als zwei Gruppen.', 'Gruppiere erst ein paar Tabs.'));
        return;
      }
      const labels = ['schließen', 'später', 'relevant', 'jetzt'];
      put(out,
        h('p', { class: 'help' }, res.moved ? 'Gruppen sortiert, wichtigste zuerst:' : 'Die Reihenfolge passt schon:'),
        ...res.groups.map((g) => h('div', { class: `row${g.confidence < res.threshold ? ' unsure' : ''}`, style: { gridTemplateColumns: '1fr auto' } },
          h('span', { class: 'txt' }, reiter({ type: 'existing', name: g.title, color: g.color }), h('span', { class: 'site' }, `${g.tabs} Tabs`)),
          h('span', { style: { display: 'grid', gap: '4px', justifyItems: 'end' } },
            h('span', { class: 'level' }, g.levels === 4 ? labels[g.level] : `Stufe ${g.level}`),
            meter(g.confidence, res.threshold)))),
        h('p', { class: 'help mono' }, cost(res.cost)));
      out.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const res = await send('sortTabs', { windowId: win.id, by });
    if (!res.scores) {
      put(out, empty('check', res.segments ? 'Sortiert.' : 'Schon in dieser Reihenfolge.'));
      return;
    }
    const labels = ['schließen', 'später', 'relevant', 'jetzt'];
    put(out, 
      h('p', { class: 'help' }, 'Jevs Bewertung, wichtigste zuerst:'),
      ...res.scores.map((s) => tabRow(s, h('span', { style: { display: 'grid', gap: '4px', justifyItems: 'end' } },
        h('span', { class: 'level' }, s.levels === 4 ? labels[s.level] : `Stufe ${s.level}`),
        meter(s.confidence, res.threshold)), { class: `row${s.confidence < res.threshold ? ' unsure' : ''}` })),
      h('p', { class: 'help mono' }, cost(res.cost)));
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

// ---------- Doppelte ----------

// Pro Seite entscheidest du selbst, welche Tabs zugehen. Vorausgewählt ist alles außer dem Tab,
// den Tabwerk behalten würde: aktiv, angepinnt oder zuletzt benutzt.
// Doppel unterscheiden sich oft erst am Ende der Adresse. Deshalb bleibt das Ende sichtbar.
function shortUrl(url) {
  const s = (url || '').replace(/^https?:\/\/(www\.)?/, '');
  return s.length > 44 ? `${s.slice(0, 16)}…${s.slice(-26)}` : s;
}

function renderDupeChoices(out, groups, { intro, costText } = {}) {
  const marked = new Set(groups.flatMap((g) => g.close.map((t) => t.id)));
  const scope = () => ($('#dupes-all').checked ? null : win.id);

  const closeIds = async (ids) => {
    if (!ids.length) return;
    await send('closeTabs', { tabIds: ids, windowId: scope() });
    for (const id of ids) marked.delete(id);
    groups = groups
      .map((g) => ({ ...g, tabs: g.tabs.filter((t) => !ids.includes(t.id)) }))
      .filter((g) => g.tabs.length > 1);
    refreshHeader();
    if (!groups.length) put(out, empty('check', 'Erledigt.', 'Mit Rückgängig holst du geschlossene Tabs zurück.'));
    else draw();
  };

  const row = (tab, g) => {
    const box = h('input', { type: 'checkbox', 'aria-label': `${tab.title} schließen`, onchange: (e) => {
      if (e.target.checked) marked.add(tab.id); else marked.delete(tab.id);
      draw();
    } });
    box.checked = marked.has(tab.id);
    const badge = tab.active ? 'aktiv' : tab.pinned ? 'angepinnt' : tab.lastAccessed ? ago(tab.lastAccessed) : '';
    return h('label', { class: `row check-row dupe-row${marked.has(tab.id) ? ' gone' : ''}` },
      box,
      favicon(tab.url),
      h('span', { class: 'txt' }, h('span', { class: 'title' }, tab.title), h('span', { class: 'site', title: tab.url }, shortUrl(tab.url))),
      h('span', { class: 'faint mono', style: { fontSize: '11px' } }, badge));
  };

  const draw = () => {
    const total = [...marked].length;
    put(out,
      intro ? h('p', { class: 'help' }, intro) : null,
      ...groups.map((g) => {
        const chosen = g.tabs.filter((t) => marked.has(t.id)).map((t) => t.id);
        const all = chosen.length === g.tabs.length;
        return h('div', { class: 'dupe' },
          h('div', { class: 'dupe-head' },
            h('span', { class: 'mono faint' }, `${g.tabs.length} Tabs${g.p !== undefined ? '' : ' · gleiche Adresse'}`),
            g.p !== undefined ? meter(g.p, settings.confidence, 'sicher, dass der Inhalt gleich ist') : null),
          ...g.tabs.map((t) => row(t, g)),
          all ? h('p', { class: 'help warn-text' }, 'Alle Tabs dieser Seite sind markiert. Dann ist die Seite ganz zu.') : null,
          h('div', { class: 'dupe-foot' },
            h('button', { class: 'ghost', disabled: !chosen.length, onclick: () => closeIds(chosen) }, icon('x'), chosen.length ? `${chosen.length} hier schließen` : 'nichts markiert')));
      }),
      h('div', { class: 'summary sticky' },
        h('span', { class: costText ? 'mono' : '' }, costText || `${groups.length} ${groups.length === 1 ? 'Seite' : 'Seiten'} mehrfach offen`),
        h('button', { class: 'primary', disabled: !total, onclick: () => closeIds([...marked]) }, icon('x'), `${total} markierte schließen`)));
  };
  draw();
}

async function loadDupes() {
  const out = $('#dupes-out');
  const found = await send('duplicates', { windowId: win.id, allWindows: $('#dupes-all').checked });
  if (!found.length) {
    put(out, empty('check', 'Keine doppelten Tabs.', 'Mit „Ähnliche prüfen“ sucht Jev nach gleichem Inhalt unter anderer Adresse.'));
    return;
  }
  renderDupeChoices(out, found.map((g) => ({ tabs: [g.keep, ...g.close], close: g.close })),
    { intro: 'Markiert ist, was zugeht. Ein Tab pro Seite bleibt vorausgewählt offen.' });
}
$('#dupes-all').addEventListener('change', loadDupes);

function showClean() {
  const mode = document.querySelector('input[name=clean]:checked').value;
  $('#dupes-bar').hidden = mode !== 'dupes';
  $('#suggest-bar').hidden = mode !== 'suggest';
  $('#suggest-jev').closest('label').hidden = !hasKey(settings);
  if (mode === 'dupes') loadDupes();
  else put($('#dupes-out'), empty('bolt', 'Alte und unwichtige Tabs finden.', `Alt heißt: länger als ${settings.cleanupDays} Tage nicht benutzt. Mit Jev zählt auch, ob der Tab zu deinem Fokus passt.`));
}
document.querySelectorAll('input[name=clean]').forEach((r) => r.addEventListener('change', showClean));

$('#suggest-go').addEventListener('click', () => {
  const out = $('#dupes-out');
  run(out, async () => {
    const res = await send('suggestCleanup', { windowId: win.id, useJev: $('#suggest-jev').checked });
    if (!res.items.length) {
      put(out, empty('check', 'Nichts zum Aufräumen.', 'Kein Tab ist alt oder laut Jev überflüssig.'));
      return;
    }
    const marked = new Set(res.items.filter((i) => i.preselect).map((i) => i.id));
    const draw = () => {
      put(out,
        h('p', { class: 'help' }, 'Markiert ist, was zugeht. Alles bleibt im Verlauf.'),
        ...res.items.map((item) => {
          const box = h('input', { type: 'checkbox', 'aria-label': `${item.title} schließen`, onchange: (e) => { if (e.target.checked) marked.add(item.id); else marked.delete(item.id); draw(); } });
          box.checked = marked.has(item.id);
          return h('label', { class: `row check-row dupe-row${marked.has(item.id) ? ' gone' : ''}` },
            box, favicon(item.url),
            h('span', { class: 'txt' }, h('span', { class: 'title' }, item.title), h('span', { class: 'reason-list' }, item.reasons.join(' · '))),
            typeof item.confidence === 'number' ? meter(item.confidence, res.threshold) : h('span', {}));
        }),
        h('div', { class: 'summary sticky' },
          h('span', { class: 'mono' }, res.jev ? cost(res.cost) : 'ohne Jev'),
          h('button', { class: 'primary', disabled: !marked.size, onclick: async () => {
            await send('closeTabs', { tabIds: [...marked], windowId: win.id, label: 'Aufräumen' });
            refreshHeader();
            put(out, empty('check', `${marked.size} Tabs geschlossen.`, 'Mit Rückgängig holst du sie zurück.'));
          } }, icon('x'), `${marked.size} schließen`)));
    };
    draw();
  });
});

$('#similar').addEventListener('click', () => {
  const out = $('#dupes-out');
  run(out, async () => {
    const res = await send('similar', { windowId: win.id, allWindows: $('#dupes-all').checked });
    if (!res.pairs.length) {
      put(out, empty('check', 'Kein gleicher Inhalt gefunden.', 'Jev hat Tabs derselben Website verglichen.'));
      return;
    }
    renderDupeChoices(out, res.pairs.map((pair) => ({ tabs: [pair.a, pair.b], close: [pair.b], p: pair.p })),
      { intro: 'Gleicher Inhalt, andere Adresse. Markiert ist, was zugeht.', costText: cost(res.cost) });
  });
});

// ---------- Wächter ----------

const STATUS = {
  baseline: 'Vergleichsbasis gespeichert',
  same: 'keine Änderung',
  noise: 'geändert, passt nicht',
  match: 'passende Änderung',
  error: 'Fehler',
};

async function loadWatches() {
  const list = $('#watch-list');
  const watches = await send('listWatches');
  if (!watches.length) {
    put(list, empty('bell', 'Noch kein Wächter.', 'Leg unten einen an. Tabwerk prüft die Seite und meldet sich, wenn deine Bedingung eintritt.'));
    $('#newwatch').open = true;
    return;
  }
  put(list, ...watches.map(watchCard));
}

function watchCard(w) {
  const last = w.history?.[0];
  const hit = w.history?.find((x) => x.status === 'match');
  const status = last
    ? h('div', { class: `state ${last.status}` }, h('span', { class: 'dot' }),
      `${ago(last.t)} · ${STATUS[last.status]}${typeof last.p === 'number' ? ` · ${Math.round(last.p * 100)} %` : ''}${last.error ? ` · ${last.error}` : ''}`)
    : h('div', { class: 'state' }, h('span', { class: 'dot' }), 'wird geprüft');
  const act = (ico, label, fn) => h('button', { class: 'ghost icon', title: label, 'aria-label': label, onclick: fn }, icon(ico));
  return h('div', { class: `watch${w.enabled ? '' : ' off'}` },
    h('div', { class: 'head' },
      favicon(w.url),
      h('span', { class: 'site' }, w.site),
      h('span', { class: 'acts' },
        act('refresh', 'Jetzt prüfen', async (e) => { e.currentTarget.disabled = true; await send('checkWatch', { id: w.id }); loadWatches(); refreshHeader(); }),
        act(w.enabled ? 'pause' : 'play', w.enabled ? 'Pausieren' : 'Fortsetzen', async () => { await send('toggleWatch', { id: w.id }); loadWatches(); }),
        act('open', 'Seite öffnen', () => chrome.tabs.create({ url: w.url })),
        act('trash', 'Löschen', async () => { await send('removeWatch', { id: w.id }); loadWatches(); }))),
    h('div', { class: 'cond' }, w.condition),
    h('div', { class: 'state' }, `prüft alle ${describeInterval(w.intervalMin)}`),
    status,
    w.number ? h('div', { class: 'state' }, `Grenze: ${OPS[w.number.op]} ${w.number.limit.toLocaleString('de-DE')}${typeof lastValue(w) === 'number' ? ` · zuletzt ${lastValue(w).toLocaleString('de-DE')}` : ''}`) : null,
    hit ? h('div', { class: 'evidence' }, hit.evidence || 'Passende Änderung', h('span', { class: 'faint mono' }, ` · ${ago(hit.t)}`)) : null,
    diffView(w));
}

const OPS = { below: 'unter', atmost: 'höchstens', above: 'über', atleast: 'mindestens' };
const lastValue = (w) => w.history?.find((x) => typeof x.value === 'number')?.value;

// Änderungen der letzten Prüfung mit Unterschied, wenn eingeschaltet.
function diffView(w) {
  if (!isOn(settings, 'watchDiff')) return null;
  const e = w.history?.find((x) => x.addedLines?.length || x.removedLines?.length);
  if (!e) return null;
  return h('details', {},
    h('summary', {}, `Änderungen ${ago(e.t)}: +${e.added ?? e.addedLines.length} −${e.removed ?? e.removedLines.length} Zeilen`),
    h('div', { class: 'diff' },
      ...e.removedLines.map((l) => h('span', { class: 'del' }, `− ${l}`)),
      ...e.addedLines.map((l) => h('span', { class: 'add' }, `+ ${l}`))));
}

let formSlotReady = false;
function mountWatchForm(url) {
  if (formSlotReady) return;
  formSlotReady = true;
  put($('#watch-form-slot'), watchForm({ url, numbers: isOn(settings, 'watchNumbers'), onDone: () => { $('#newwatch').open = false; loadWatches(); } }));
}

// ---------- Verlauf ----------

const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Heute';
  if (d.toDateString() === yesterday.toDateString()) return 'Gestern';
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
}

// Im Fenster-Modus zählen nur die Werte dieses Fensters.
const view = (entry) => (historyAll() ? entry : { ...entry, ...(entry.win?.[win.id] || {}), windows: 1 });
const historyAll = () => $('#history-all').checked;

function delta(entry, older) {
  if (!older) return null;
  const n = view(entry).tabs - view(older).tabs;
  if (!n) return null;
  return h('span', { class: `delta ${n > 0 ? 'up' : 'down'}` }, n > 0 ? `+${n}` : `−${-n}`);
}

async function loadHistory() {
  const out = $('#history-out');
  let index = await send('listSnapshots');
  if (!historyAll()) {
    // Nur Sicherungen, in denen sich dieses Fenster geändert hat.
    index = index.filter((e, i) => {
      const mine = e.win?.[win.id];
      if (!mine) return false;
      const older = index.slice(i + 1).find((o) => o.win?.[win.id]);
      return !older || older.win[win.id].sig !== mine.sig || e.reason.startsWith('Vor ');
    });
  }
  if (!index.length) {
    put(out, empty('undo', 'Noch keine Sicherung.', 'Sobald sich ein Tab ändert, legt Tabwerk die erste an.'));
    return;
  }
  const nodes = [];
  let day = '';
  index.forEach((entry, i) => {
    const label = dayLabel(entry.t);
    if (label !== day) {
      day = label;
      nodes.push(h('h3', { class: 'day' }, label));
    }
    nodes.push(snapshotItem(entry, index[i + 1]));
  });
  put(out, ...nodes);
}

function counts(entry) {
  const v = view(entry);
  return [
    v.windows > 1 ? `${v.windows} Fenster` : null,
    `${v.tabs} Tabs`,
    v.groups ? `${v.groups} Gr.` : null,
  ].filter(Boolean).join(' · ');
}

function snapshotItem(entry, older) {
  const body = h('div', { class: 'snap-body' });
  const item = h('details', { class: 'snap', ontoggle: () => { if (item.open && !body.childElementCount) fillSnapshot(entry, body); } },
    h('summary', {},
      h('span', { class: 'mono time' }, timeFmt.format(entry.t)),
      h('span', { class: 'reason' }, entry.reason),
      h('span', { class: 'mono counts' }, counts(entry), delta(entry, older))),
    body);
  return item;
}

async function fillSnapshot(entry, body) {
  put(body, skeleton());
  const snap = await send('getSnapshot', { id: entry.id });
  if (!snap) {
    put(body, h('p', { class: 'help' }, 'Diese Sicherung gibt es nicht mehr.'));
    return;
  }
  const windowMode = !historyAll();
  const shown = windowMode ? snap.windows.filter((w) => w.id === win.id) : snap.windows;
  const windows = shown.map((w, i) => {
    const groups = new Map(w.groups.map((g) => [g.id, g]));
    const rows = [];
    let lastGroup = null;
    for (const t of w.tabs.slice(0, 14)) {
      if (t.groupId !== -1 && t.groupId !== lastGroup && groups.has(t.groupId)) {
        const g = groups.get(t.groupId);
        rows.push(reiter({ type: 'existing', name: g.title || 'Ohne Titel', color: g.color }));
      }
      lastGroup = t.groupId;
      rows.push(h('div', { class: 'mini' }, favicon(t.url), h('span', {}, t.title || t.url)));
    }
    if (w.tabs.length > 14) rows.push(h('p', { class: 'help' }, `und ${w.tabs.length - 14} weitere`));
    const label = windowMode ? `Dieses Fenster · ${w.tabs.length} Tabs` : `Fenster ${i + 1}${w.id === win.id ? ' (dieses)' : ''} · ${w.tabs.length} Tabs`;
    return h('div', { class: 'snap-win' }, h('div', { class: 'mono faint' }, label), ...rows);
  });
  const status = h('p', { class: 'help', 'aria-live': 'polite' });
  let armed = false;
  const button = h('button', { class: 'primary', onclick: async () => {
    if (!armed) {
      armed = true;
      button.textContent = 'Wirklich wiederherstellen';
      status.textContent = windowMode
        ? 'Nur dieses Fenster. Tabs, die damals nicht offen waren, bleiben offen und rücken ans Ende.'
        : 'Alle Fenster. Tabs, die damals nicht offen waren, bleiben offen und rücken ans Ende.';
      return;
    }
    button.disabled = true;
    try {
      const r = await send('restoreSnapshot', { id: entry.id, windowId: windowMode ? win.id : null });
      status.textContent = `Fertig. ${r.reused} Tabs zurück an ihrem Platz, ${r.opened} neu geöffnet${r.failed ? `, ${r.failed} nicht möglich` : ''}.`;
      refreshHeader();
      setTimeout(loadHistory, 1800);
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  } }, icon('undo'), windowMode ? 'Fenster zurücksetzen' : 'Alle Fenster zurücksetzen');
  put(body, ...windows, h('div', { class: 'snap-actions' }, button), status);
}

$('#history-all').addEventListener('change', loadHistory);

function showHist() {
  const choice = document.querySelector('input[name=hist]:checked');
  const firstVisible = [...document.querySelectorAll('input[name=hist]')].find((r) => !r.closest('label').hidden);
  if (choice.closest('label').hidden && firstVisible) firstVisible.checked = true;
  const mode = document.querySelector('input[name=hist]:checked').value;
  $('#snaps-view').hidden = mode !== 'snaps';
  $('#sessions-view').hidden = mode !== 'sessions';
  if (mode === 'snaps') loadHistory(); else loadSessions();
}
document.querySelectorAll('input[name=hist]').forEach((r) => r.addEventListener('change', showHist));

async function loadSessions() {
  const out = $('#sessions-out');
  const sessions = await send('listSessions');
  if (!sessions.length) {
    put(out, empty('window', 'Noch keine Sitzung.', 'Speicher dieses Fenster unter einem Namen. Später öffnest du es wieder, mit allen Gruppen.'));
    return;
  }
  put(out, ...sessions.map((s) => {
    const tabs = s.windows.reduce((n, w) => n + w.tabs.length, 0);
    const groups = s.windows.flatMap((w) => w.groups).filter((g) => g.title);
    return h('div', { class: 'session' },
      h('div', { class: 'head' },
        h('span', { class: 'name', title: s.name }, s.name),
        h('span', { class: 'acts' },
          h('button', { class: 'ghost', onclick: async () => { await send('openSession', { id: s.id }); } }, icon('open'), 'Öffnen'),
          h('button', { class: 'ghost icon', title: 'Umbenennen', 'aria-label': 'Umbenennen', onclick: async () => {
            const name = prompt('Neuer Name', s.name);
            if (name) { await send('renameSession', { id: s.id, name }); loadSessions(); }
          } }, icon('edit')),
          h('button', { class: 'ghost icon', title: 'Löschen', 'aria-label': 'Löschen', onclick: async () => { await send('deleteSession', { id: s.id }); loadSessions(); } }, icon('trash')))),
      h('div', { class: 'state' }, `${new Date(s.t).toLocaleDateString('de-DE')} · ${tabs} Tabs${groups.length ? ` · ${groups.slice(0, 3).map((g) => g.title).join(', ')}` : ''}`));
  }));
}

$('#session-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await send('saveSession', { windowId: win.id, name: $('#session-name').value });
  $('#session-name').value = '';
  loadSessions();
});

$('#snap-now').addEventListener('click', async () => {
  await send('saveSnapshot');
  loadHistory();
});

// ---------- Start ----------

const [current] = await chrome.tabs.query({ active: true, windowId: win.id });
mountWatchForm(current?.url?.startsWith('http') ? current.url : '');

let start = 'find';
try { start = localStorage.getItem('panel') || 'find'; } catch {}
const visible = [...document.querySelectorAll('[role=tab]')].filter((t) => !t.hidden).map((t) => t.dataset.panel);
if (visible.length) showPanel(visible.includes(start) ? start : visible[0]);
refreshHeader();
