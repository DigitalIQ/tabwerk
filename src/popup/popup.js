import { h, icon, send, meter, favicon, cost, ago } from '../ui/dom.js';
import { getSettings, getUsage, CHROME_COLORS, modelShort, connection, hasKey } from '../lib/settings.js';
import { watchForm } from '../ui/watchform.js';
import { describeInterval } from '../lib/duration.js';
import { hostOf } from '../lib/url.js';
import { isOn } from '../lib/flags.js';
import { initI18n, localizeDom, t, tp, fmtNumber, fmtDate, fmtList } from '../lib/i18n.js';
import { reasonText, labelText, isBefore } from '../lib/reasons.js';

await initI18n();
localizeDom();

const $ = (sel) => document.querySelector(sel);
// replaceChildren schreibt null als Text. put filtert leere Einträge heraus.
const put = (el, ...nodes) => el.replaceChildren(...nodes.flat().filter(Boolean));
const win = await chrome.windows.getCurrent();
const settings = await getSettings();

// Vier Prioritätsstufen, von schließen bis jetzt.
const LEVEL_LABELS = [t('popup_levelClose'), t('popup_levelLater'), t('popup_levelRelevant'), t('popup_levelNow')];
// Vergleichsoperatoren für Zahlen-Wächter, dieselben Texte wie im Wächter-Formular.
const OPS = { below: 'wf_opBelow', atmost: 'wf_opAtmost', above: 'wf_opAbove', atleast: 'wf_opAtleast' };

// Ausgeschaltete Funktionen verschwinden. data-flag darf mehrere Schalter mit | nennen.
for (const el of document.querySelectorAll('[data-flag]')) {
  el.hidden = !el.dataset.flag.split('|').some((id) => isOn(settings, id));
}

// ---------- Rahmen ----------

async function refreshHeader() {
  const tabs = await chrome.tabs.query({ windowId: win.id });
  const groups = await chrome.tabGroups.query({ windowId: win.id });
  $('#count').textContent = `${tp('popup_tabsCount', tabs.length)} · ${tp('popup_groupsCount', groups.length)}`;
  const usage = await getUsage();
  const month = fmtDate(new Date(), { month: 'long' });
  $('#usage').textContent = `${modelShort(connection(settings).model)} · ${tp('popup_requests', usage.requests)} · ${usage.estimated ? '≈ ' : ''}${cost(usage.cost)}`;
  $('#usage').title = t('popup_usageTitle', month);
  const lastAction = isOn(settings, 'undo') ? await send('lastAction', { windowId: win.id }) : null;
  $('#undo').hidden = !lastAction;
  if (lastAction) {
    $('#undo').title = t('popup_restoreBefore', labelText(lastAction.label));
    $('#undo-label').textContent = t('popup_undo');
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
  if (name === 'groups') showRuleHints();
}
document.querySelectorAll('[role=tab]').forEach((tab) => tab.addEventListener('click', () => showPanel(tab.dataset.panel)));

const skeleton = () => h('div', { class: 'skel', 'aria-label': t('popup_jevDeciding') }, h('i'), h('i'), h('i'));

function failure(error) {
  const text = error.code === 'no-key' ? t('popup_noKeyError') : error.message;
  return h('div', { class: 'fail', role: 'alert' }, icon('warn'), h('span', {}, text));
}

// Letztes Netz: ein Fehler ohne eigene Behandlung erscheint unten im Popup statt nur in chrome://extensions.
window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  const box = failure(event.reason instanceof Error ? event.reason : new Error(String(event.reason)));
  box.classList.add('float');
  document.querySelector('.fail.float')?.remove();
  document.body.append(box);
  setTimeout(() => box.remove(), 6000);
});

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

// ---------- Lernen ----------

// Merkt sich lokal, wo du Jev gefolgt bist und wo nicht. Fehler hier stören die Aktion nie.
const learn = (events) => (isOn(settings, 'learn') && events.length ? send('learnRecord', { events }).catch(() => {}) : null);

async function showRuleHints() {
  const box = $('#rule-hints');
  if (!isOn(settings, 'learnRules')) { box.hidden = true; return; }
  const rules = await send('learnRules').catch(() => []);
  box.hidden = !rules.length;
  put(box, ...rules.slice(0, 2).map((r) => h('div', { class: 'rule-hint' },
    icon('bolt'),
    h('span', { class: 'txt' }, tp('popup_ruleHint', r.n, r.host, r.group)),
    h('button', { class: 'ghost', onclick: async () => {
      const res = await send('acceptRule', { rule: r.rule });
      put(box, h('p', { class: 'help' }, res.autoGroup ? t('popup_ruleAdded', r.rule) : t('popup_ruleAddedOff', r.rule)));
    } }, t('popup_ruleAccept')),
    h('button', { class: 'ghost icon', title: t('popup_ruleDismiss'), 'aria-label': t('popup_ruleDismiss'), onclick: async () => {
      await send('dismissRule', { rule: r.rule });
      showRuleHints();
    } }, icon('x')))));
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
      put(out, empty('search', t('popup_noTabMatch'), t('popup_noTabMatchHint')));
      return;
    }
    put(out, ...hits.map((hit) => hit.none
      ? h('p', { class: 'help' }, t('popup_noMatchingTab', fmtNumber(hit.p, { style: 'percent', maximumFractionDigits: 0 })))
      : h('button', {
        class: 'row',
        onclick: async () => {
          await learn([{ f: 'find', host: hostOf(top.url), title: top.title, jev: top.title, user: hit.title, conf: top.p, ok: hit.id === top.id }]);
          await send('focusTab', { tabId: hit.id, windowId: hit.windowId });
          window.close();
        },
      },
      favicon(hit.url),
      h('span', { class: 'txt' }, h('span', { class: 'title' }, hit.title), h('span', { class: 'site' }, hostOf(hit.url))),
      meter(hit.p, settings.confidence, t('popup_meterSureTab')))),
    h('p', { class: 'help mono' }, cost(c)));
  });
});

$('#pagesearch-open')?.addEventListener('click', async () => {
  await send('openPageSearch', { windowId: win.id });
  window.close();
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
      put(out, empty('groups', t('popup_nothingToGroup'), t('popup_nothingToGroupHint')));
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
    put(out, h('p', { class: 'help' }, t('popup_named')),
      ...res.groups.map((g) => h('div', { class: 'row', style: { gridTemplateColumns: '1fr auto' } },
        reiter({ type: 'existing', name: g.name, color: g.color }),
        g.confidence !== null ? meter(g.confidence, settings.confidence) : h('span', { class: 'faint mono' }, t('popup_viaCode')))),
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
    const apply = h('button', { class: 'primary', disabled: !selected, onclick: applyPlan }, tp('popup_fileInCount', selected));
    put(out,
      unsure ? h('p', { class: 'help' }, h('span', { class: 'flag' }, icon('warn'), t('popup_reviewCount', fmtNumber(unsure))), ` ${t('popup_unsureHint')}`) : null,
      ...buckets.map((b) => h('div', { class: `bucket${b.opt.type === 'none' ? ' none' : ''}`, style: { '--c': CHROME_COLORS[b.opt.color] } },
        reiter(b.opt),
        h('div', { class: 'list' }, ...b.items.map((item) => groupRow(item))))),
      h('div', { class: 'summary sticky' }, h('span', { class: 'mono' }, cost(res.cost)), apply),
    );
  };

  const groupRow = (item) => {
    const state = plan.get(item.id);
    const box = h('input', { type: 'checkbox', 'aria-label': t('popup_fileTab', item.title), onchange: (e) => { state.on = e.target.checked; draw(); } });
    box.checked = state.on;
    const select = h('select', { 'aria-label': t('popup_changeTarget'), onchange: (e) => { state.target = e.target.value; state.on = e.target.value !== 'none'; draw(); } },
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
    // Lernen: gefolgt, geändert oder abgewählt. Unsichere Vorschläge, die du nicht angefasst hast, sagen nichts.
    learn(res.items.flatMap((item) => {
      const p = plan.get(item.id);
      const taken = p.on && p.target !== 'none';
      const changed = p.target !== item.target;
      if (!item.sure && !taken && !changed) return [];
      return [{
        f: 'groups', host: hostOf(item.url), title: item.title, conf: item.confidence,
        jev: res.options[item.target]?.name, user: taken ? res.options[p.target]?.name : 'none',
        ok: taken && !changed,
      }];
    }));
    await run(out, async () => {
      const { moved } = await send('applyGroups', { windowId: win.id, plan: chosen, options: res.options });
      put(out, empty('check', tp('popup_filedCount', moved), t('popup_undoRestoreHint')));
      showRuleHints();
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
        put(out, empty('groups', t('popup_tooFewGroups'), t('popup_tooFewGroupsHint')));
        return;
      }
      put(out,
        h('p', { class: 'help' }, res.moved ? t('popup_groupsSorted') : t('popup_orderAlreadyFine')),
        ...res.groups.map((g) => h('div', { class: `row${g.confidence < res.threshold ? ' unsure' : ''}`, style: { gridTemplateColumns: '1fr auto' } },
          h('span', { class: 'txt' }, reiter({ type: 'existing', name: g.title, color: g.color }), h('span', { class: 'site' }, tp('popup_tabsCount', g.tabs))),
          h('span', { style: { display: 'grid', gap: '4px', justifyItems: 'end' } },
            h('span', { class: 'level' }, g.levels === 4 ? LEVEL_LABELS[g.level] : t('popup_levelNumber', fmtNumber(g.level))),
            meter(g.confidence, res.threshold)))),
        h('p', { class: 'help mono' }, cost(res.cost)));
      out.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const res = await send('sortTabs', { windowId: win.id, by });
    if (!res.scores) {
      put(out, empty('check', res.segments ? t('popup_sorted') : t('popup_alreadyInOrder')));
      return;
    }
    put(out,
      h('p', { class: 'help' }, t('popup_jevRatingFirst')),
      ...res.scores.map((s) => tabRow(s, h('span', { style: { display: 'grid', gap: '4px', justifyItems: 'end' } },
        h('span', { class: 'level' }, s.levels === 4 ? LEVEL_LABELS[s.level] : t('popup_levelNumber', fmtNumber(s.level))),
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
  const marked = new Set(groups.flatMap((g) => g.close.map((tab) => tab.id)));
  const scope = () => ($('#dupes-all').checked ? null : win.id);

  const closeIds = async (ids) => {
    if (!ids.length) return;
    await send('closeTabs', { tabIds: ids, windowId: scope() });
    for (const id of ids) marked.delete(id);
    groups = groups
      .map((g) => ({ ...g, tabs: g.tabs.filter((tab) => !ids.includes(tab.id)) }))
      .filter((g) => g.tabs.length > 1);
    refreshHeader();
    if (!groups.length) put(out, empty('check', t('popup_done'), t('popup_undoClosedHint')));
    else draw();
  };

  const row = (tab, g) => {
    const box = h('input', { type: 'checkbox', 'aria-label': t('popup_closeTab', tab.title), onchange: (e) => {
      if (e.target.checked) marked.add(tab.id); else marked.delete(tab.id);
      draw();
    } });
    box.checked = marked.has(tab.id);
    const badge = tab.active ? t('popup_active') : tab.pinned ? t('popup_pinned') : tab.lastAccessed ? ago(tab.lastAccessed) : '';
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
        const chosen = g.tabs.filter((tab) => marked.has(tab.id)).map((tab) => tab.id);
        const all = chosen.length === g.tabs.length;
        return h('div', { class: 'dupe' },
          h('div', { class: 'dupe-head' },
            h('span', { class: 'mono faint' }, g.p !== undefined ? tp('popup_tabsCount', g.tabs.length) : `${tp('popup_tabsCount', g.tabs.length)} · ${t('popup_sameAddress')}`),
            g.p !== undefined ? meter(g.p, settings.confidence, t('popup_meterSureSameContent')) : null),
          ...g.tabs.map((tab) => row(tab, g)),
          all ? h('p', { class: 'help warn-text' }, t('popup_allMarkedWarning')) : null,
          h('div', { class: 'dupe-foot' },
            h('button', { class: 'ghost', disabled: !chosen.length, onclick: () => closeIds(chosen) }, icon('x'), chosen.length ? tp('popup_closeHereCount', chosen.length) : t('popup_nothingMarked'))));
      }),
      h('div', { class: 'summary sticky' },
        h('span', { class: costText ? 'mono' : '' }, costText || tp('popup_multipleOpenCount', groups.length)),
        h('button', { class: 'primary', disabled: !total, onclick: () => closeIds([...marked]) }, icon('x'), tp('popup_closeMarkedCount', total))));
  };
  draw();
}

async function loadDupes() {
  const out = $('#dupes-out');
  const found = await send('duplicates', { windowId: win.id, allWindows: $('#dupes-all').checked });
  if (!found.length) {
    put(out, empty('check', t('popup_noDupes'), t('popup_noDupesHint', t('popup_checkSimilar'))));
    return;
  }
  renderDupeChoices(out, found.map((g) => ({ tabs: [g.keep, ...g.close], close: g.close })),
    { intro: t('popup_dupeIntro') });
}
$('#dupes-all').addEventListener('change', loadDupes);

function showClean() {
  const mode = document.querySelector('input[name=clean]:checked').value;
  $('#dupes-bar').hidden = mode !== 'dupes';
  $('#suggest-bar').hidden = mode !== 'suggest';
  $('#suggest-jev').closest('label').hidden = !hasKey(settings);
  if (mode === 'dupes') loadDupes();
  else put($('#dupes-out'), empty('bolt', t('popup_findOldTabs'), tp('popup_oldMeansHint', settings.cleanupDays)));
}
document.querySelectorAll('input[name=clean]').forEach((r) => r.addEventListener('change', showClean));

$('#suggest-go').addEventListener('click', () => {
  const out = $('#dupes-out');
  run(out, async () => {
    const res = await send('suggestCleanup', { windowId: win.id, useJev: $('#suggest-jev').checked });
    if (!res.items.length) {
      put(out, empty('check', t('popup_nothingToClean'), t('popup_nothingToCleanHint')));
      return;
    }
    const marked = new Set(res.items.filter((i) => i.preselect).map((i) => i.id));
    const draw = () => {
      put(out,
        h('p', { class: 'help' }, t('popup_markedWillCloseHint')),
        ...res.items.map((item) => {
          const box = h('input', { type: 'checkbox', 'aria-label': t('popup_closeTab', item.title), onchange: (e) => { if (e.target.checked) marked.add(item.id); else marked.delete(item.id); draw(); } });
          box.checked = marked.has(item.id);
          return h('label', { class: `row check-row dupe-row${marked.has(item.id) ? ' gone' : ''}` },
            box, favicon(item.url),
            h('span', { class: 'txt' }, h('span', { class: 'title' }, item.title), h('span', { class: 'reason-list' }, item.reasons.join(' · '))),
            typeof item.confidence === 'number' ? meter(item.confidence, res.threshold) : h('span', {}));
        }),
        h('div', { class: 'summary sticky' },
          h('span', { class: 'mono' }, res.jev ? cost(res.cost) : t('popup_withoutJev')),
          h('button', { class: 'primary', disabled: !marked.size, onclick: async () => {
            learn(res.items.filter((i) => typeof i.confidence === 'number').map((i) => ({
              f: 'cleanup', host: hostOf(i.url), title: i.title, conf: i.confidence,
              jev: i.jevClose ? 'close' : 'keep', user: marked.has(i.id) ? 'close' : 'keep', ok: i.jevClose === marked.has(i.id),
            })));
            await send('closeTabs', { tabIds: [...marked], windowId: win.id, label: 'lbl_cleanup' });
            refreshHeader();
            put(out, empty('check', tp('popup_closedTabs', marked.size), t('popup_undoBringBackHint')));
          } }, icon('x'), tp('popup_closeCount', marked.size))));
    };
    draw();
  });
});

$('#similar').addEventListener('click', () => {
  const out = $('#dupes-out');
  run(out, async () => {
    const res = await send('similar', { windowId: win.id, allWindows: $('#dupes-all').checked });
    if (!res.pairs.length) {
      put(out, empty('check', t('popup_noSameContent'), t('popup_noSameContentHint')));
      return;
    }
    renderDupeChoices(out, res.pairs.map((pair) => ({ tabs: [pair.a, pair.b], close: [pair.b], p: pair.p })),
      { intro: t('popup_similarIntro'), costText: cost(res.cost) });
  });
});

// ---------- Wächter ----------

const STATUS = {
  baseline: t('popup_statusBaseline'),
  same: t('popup_statusSame'),
  noise: t('popup_statusNoise'),
  match: t('popup_statusMatch'),
  error: t('popup_statusError'),
};

async function loadWatches() {
  const list = $('#watch-list');
  const watches = await send('listWatches');
  if (!watches.length) {
    put(list, empty('bell', t('popup_noWatchers'), t('popup_noWatchersHint')));
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
      `${ago(last.t)} · ${STATUS[last.status]}${typeof last.p === 'number' ? ` · ${fmtNumber(last.p, { style: 'percent', maximumFractionDigits: 0 })}` : ''}${last.error ? ` · ${last.error}` : ''}`)
    : h('div', { class: 'state' }, h('span', { class: 'dot' }), t('popup_checking'));
  const act = (ico, label, fn) => h('button', { class: 'ghost icon', title: label, 'aria-label': label, onclick: fn }, icon(ico));
  return h('div', { class: `watch${w.enabled ? '' : ' off'}` },
    h('div', { class: 'head' },
      favicon(w.url),
      h('span', { class: 'site' }, w.site),
      h('span', { class: 'acts' },
        act('refresh', t('popup_checkNow'), async (e) => { e.currentTarget.disabled = true; await send('checkWatch', { id: w.id }); loadWatches(); refreshHeader(); }),
        act(w.enabled ? 'pause' : 'play', w.enabled ? t('popup_pause') : t('popup_resume'), async () => { await send('toggleWatch', { id: w.id }); loadWatches(); }),
        act('open', t('popup_openPage'), () => chrome.tabs.create({ url: w.url })),
        act('trash', t('popup_delete'), async () => { await send('removeWatch', { id: w.id }); loadWatches(); }))),
    h('div', { class: 'cond' }, w.condition),
    h('div', { class: 'state' }, t('popup_checksEvery', describeInterval(w.intervalMin))),
    status,
    w.number ? h('div', { class: 'state' }, `${t('wf_limit')}: ${t(OPS[w.number.op])} ${fmtNumber(w.number.limit)}${typeof lastValue(w) === 'number' ? ` · ${t('popup_lastValue', fmtNumber(lastValue(w)))}` : ''}`) : null,
    hit ? h('div', { class: 'evidence' }, hit.evidence || t('popup_matchingChange'), h('span', { class: 'faint mono' }, ` · ${ago(hit.t)}`)) : null,
    feedbackRow(w),
    diffView(w));
}

// Daumen zur letzten Bewertung durch Jev. Einmal beantwortet, verschwindet die Frage.
function feedbackRow(w) {
  if (!isOn(settings, 'learnFeedback')) return null;
  const e = w.history?.find((x) => typeof x.p === 'number');
  if (!e || e.feedback) return null;
  const answer = (ok) => async (ev) => {
    ev.currentTarget.closest('.feedback').replaceChildren(h('span', { class: 'faint' }, t('popup_feedbackThanks')));
    await send('watchFeedback', { id: w.id, t: e.t, ok }).catch(() => {});
  };
  return h('div', { class: 'feedback' },
    h('span', { class: 'faint' }, e.status === 'match' ? t('popup_feedbackAskMatch') : t('popup_feedbackAskNoise')),
    h('button', { class: 'ghost', onclick: answer(true) }, icon('check'), t('popup_feedbackYes')),
    h('button', { class: 'ghost', onclick: answer(false) }, icon('x'), t('popup_feedbackNo')));
}

const lastValue = (w) => w.history?.find((x) => typeof x.value === 'number')?.value;

// Änderungen der letzten Prüfung mit Unterschied, wenn eingeschaltet.
function diffView(w) {
  if (!isOn(settings, 'watchDiff')) return null;
  const e = w.history?.find((x) => x.addedLines?.length || x.removedLines?.length);
  if (!e) return null;
  return h('details', {},
    h('summary', {}, t('popup_diffSummary', ago(e.t), fmtNumber(e.added ?? e.addedLines.length), fmtNumber(e.removed ?? e.removedLines.length))),
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

function dayLabel(at) {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return t('popup_today');
  if (d.toDateString() === yesterday.toDateString()) return t('popup_yesterday');
  return fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' });
}

// Im Fenster-Modus zählen nur die Werte dieses Fensters.
const view = (entry) => (historyAll() ? entry : { ...entry, ...(entry.win?.[win.id] || {}), windows: 1 });
const historyAll = () => $('#history-all').checked;

function delta(entry, older) {
  if (!older) return null;
  const n = view(entry).tabs - view(older).tabs;
  if (!n) return null;
  return h('span', { class: `delta ${n > 0 ? 'up' : 'down'}` }, n > 0 ? `+${fmtNumber(n)}` : `−${fmtNumber(-n)}`);
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
      return !older || older.win[win.id].sig !== mine.sig || isBefore(e);
    });
  }
  if (!index.length) {
    put(out, empty('undo', t('popup_noSnapshotsYet'), t('popup_noSnapshotsYetHint')));
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
    v.windows > 1 ? tp('popup_windowsCount', v.windows) : null,
    tp('popup_tabsCount', v.tabs),
    v.groups ? tp('popup_groupsAbbrCount', v.groups) : null,
  ].filter(Boolean).join(' · ');
}

function snapshotItem(entry, older) {
  const body = h('div', { class: 'snap-body' });
  const item = h('details', { class: 'snap', ontoggle: () => { if (item.open && !body.childElementCount) fillSnapshot(entry, body); } },
    h('summary', {},
      h('span', { class: 'mono time' }, fmtDate(entry.t, { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
      h('span', { class: 'reason' }, reasonText(entry)),
      h('span', { class: 'mono counts' }, counts(entry), delta(entry, older))),
    body);
  return item;
}

async function fillSnapshot(entry, body) {
  put(body, skeleton());
  const snap = await send('getSnapshot', { id: entry.id });
  if (!snap) {
    put(body, h('p', { class: 'help' }, t('popup_snapshotGone')));
    return;
  }
  const windowMode = !historyAll();
  const shown = windowMode ? snap.windows.filter((w) => w.id === win.id) : snap.windows;
  const windows = shown.map((w, i) => {
    const groups = new Map(w.groups.map((g) => [g.id, g]));
    const rows = [];
    let lastGroup = null;
    for (const tab of w.tabs.slice(0, 14)) {
      if (tab.groupId !== -1 && tab.groupId !== lastGroup && groups.has(tab.groupId)) {
        const g = groups.get(tab.groupId);
        rows.push(reiter({ type: 'existing', name: g.title || t('popup_noTitle'), color: g.color }));
      }
      lastGroup = tab.groupId;
      rows.push(h('div', { class: 'mini' }, favicon(tab.url), h('span', {}, tab.title || tab.url)));
    }
    if (w.tabs.length > 14) rows.push(h('p', { class: 'help' }, tp('popup_andMoreCount', w.tabs.length - 14)));
    const marker = w.id === win.id ? t('popup_thisMarker') : '';
    const label = windowMode
      ? `${t('popup_thisWindow')} · ${tp('popup_tabsCount', w.tabs.length)}`
      : `${t('popup_windowNumber', fmtNumber(i + 1))}${marker} · ${tp('popup_tabsCount', w.tabs.length)}`;
    return h('div', { class: 'snap-win' }, h('div', { class: 'mono faint' }, label), ...rows);
  });
  const status = h('p', { class: 'help', 'aria-live': 'polite' });
  let armed = false;
  const button = h('button', { class: 'primary', onclick: async () => {
    if (!armed) {
      armed = true;
      button.textContent = t('popup_confirmRestore');
      status.textContent = windowMode
        ? t('popup_restoreWindowOnlyWarning')
        : t('popup_restoreAllWarning');
      return;
    }
    button.disabled = true;
    try {
      const r = await send('restoreSnapshot', { id: entry.id, windowId: windowMode ? win.id : null });
      const failedSuffix = r.failed ? t('popup_restoreFailedSuffix', fmtNumber(r.failed)) : '';
      status.textContent = t('popup_restoreDone', fmtNumber(r.reused), fmtNumber(r.opened), failedSuffix);
      refreshHeader();
      setTimeout(loadHistory, 1800);
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  } }, icon('undo'), windowMode ? t('popup_resetWindowButton') : t('popup_resetAllButton'));
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
    put(out, empty('window', t('popup_noSessionsYet'), t('popup_noSessionsYetHint')));
    return;
  }
  put(out, ...sessions.map((s) => {
    const tabs = s.windows.reduce((n, w) => n + w.tabs.length, 0);
    const groups = s.windows.flatMap((w) => w.groups).filter((g) => g.title);
    return h('div', { class: 'session' },
      h('div', { class: 'head' },
        h('span', { class: 'name', title: s.name }, s.name),
        h('span', { class: 'acts' },
          h('button', { class: 'ghost', onclick: async () => { await send('openSession', { id: s.id }); } }, icon('open'), t('popup_open')),
          h('button', { class: 'ghost icon', title: t('popup_rename'), 'aria-label': t('popup_rename'), onclick: async () => {
            const name = prompt(t('popup_newNameLabel'), s.name);
            if (name) { await send('renameSession', { id: s.id, name }); loadSessions(); }
          } }, icon('edit')),
          h('button', { class: 'ghost icon', title: t('popup_delete'), 'aria-label': t('popup_delete'), onclick: async () => { await send('deleteSession', { id: s.id }); loadSessions(); } }, icon('trash')))),
      h('div', { class: 'state' }, `${fmtDate(s.t, { dateStyle: 'medium' })} · ${tp('popup_tabsCount', tabs)}${groups.length ? ` · ${fmtList(groups.slice(0, 3).map((g) => g.title))}` : ''}`));
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
const visible = [...document.querySelectorAll('[role=tab]')].filter((tab) => !tab.hidden).map((tab) => tab.dataset.panel);
if (visible.length) showPanel(visible.includes(start) ? start : visible[0]);
refreshHeader();
