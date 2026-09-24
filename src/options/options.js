import { h, icon, send, cost } from '../ui/dom.js';
import { getSettings, saveSettings, getUsage, CHROME_COLORS, PROVIDERS, connection, DEFAULTS, hasKey } from '../lib/settings.js';
import { FEATURES, FEATURE_DEFAULTS, isOn } from '../lib/flags.js';
import { toBookmarkHtml } from '../lib/bookmarkfile.js';
import { t, tp, fmtDate, fmtNumber, initI18n, localizeDom, LANGUAGES } from '../lib/i18n.js';

await initI18n();
localizeDom();

const $ = (sel) => document.querySelector(sel);
let settings = await getSettings();

let savedTimer;
async function save(patch) {
  settings = { ...settings, ...patch };
  await saveSettings(patch);
  $('#saved').textContent = t('opt_saved');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('#saved').textContent = ''; }, 1600);
}

function showError(text) {
  const el = $('#connect-err');
  el.textContent = text || '';
  el.hidden = !text;
}

// ---------- Sprache ----------

function renderLanguage() {
  const select = $('#ui-language');
  select.replaceChildren(
    h('option', { value: 'auto' }, t('lang_auto')),
    ...LANGUAGES.map((lang) => h('option', { value: lang }, t(`lang_${lang}`))),
  );
  select.value = settings.uiLanguage || 'auto';
}
$('#ui-language').addEventListener('change', async (e) => {
  await save({ uiLanguage: e.target.value });
  location.reload();
});

// ---------- Verbindung ----------

function renderConnection(extra) {
  const conn = connection(settings);
  document.querySelectorAll('input[name=provider]').forEach((r) => { r.checked = r.value === settings.provider; });
  document.querySelectorAll('.provider').forEach((el) => { el.hidden = el.dataset.provider !== settings.provider; });
  const ok = Boolean(conn.key);
  $('#key-status').className = `status${ok ? ' ok' : ''}`;
  $('#key-status').replaceChildren(
    h('span', { class: 'dot' }),
    h('span', {}, ok ? t('opt_connectedWith', conn.name) : t('opt_noKeyFor', conn.name)),
    ...(ok ? [h('span', { class: 'mono' }, extra || t('opt_keySuffix', conn.key.slice(-4)))] : []),
  );
  const model = $('#model');
  model.replaceChildren(...Object.entries(conn.models).map(([value, label]) => h('option', { value }, label)));
  model.value = conn.model;
}

document.querySelectorAll('input[name=provider]').forEach((r) => r.addEventListener('change', async () => {
  showError('');
  await save({ provider: r.value });
  renderConnection();
}));

$('#model').addEventListener('change', (e) => save({ [connection(settings).modelField]: e.target.value }));

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// OAuth mit PKCE: OpenRouter erzeugt nach Freigabe einen eigenen Schlüssel für Tabwerk.
// https://openrouter.ai/docs/guides/overview/auth/oauth
$('#oauth').addEventListener('click', async () => {
  showError('');
  try {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const auth = new URL('https://openrouter.ai/auth');
    auth.searchParams.set('callback_url', chrome.identity.getRedirectURL('openrouter'));
    auth.searchParams.set('code_challenge', challenge);
    auth.searchParams.set('code_challenge_method', 'S256');
    auth.searchParams.set('key_label', 'Tabwerk');
    const redirect = await chrome.identity.launchWebAuthFlow({ url: auth.toString(), interactive: true });
    const code = new URL(redirect).searchParams.get('code');
    if (!code) throw new Error(t('opt_noOAuthCode'));
    const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.key) throw new Error(t('opt_oauthRejected', res.status));
    await save({ apiKey: data.key });
    renderConnection();
  } catch (error) {
    showError(error.message.includes('did not approve') || error.message.includes('closed')
      ? t('opt_authCancelled')
      : error.message);
  }
});

function bindKey(provider, input, saveBtn, clearBtn) {
  const p = PROVIDERS[provider];
  $(saveBtn).addEventListener('click', async () => {
    const key = $(input).value.trim();
    if (!key || (p.keyPrefix && !key.startsWith(p.keyPrefix))) {
      showError(p.keyPrefix ? t('opt_keyMustStartWith', p.name, p.keyPrefix) : t('opt_enterKey'));
      return;
    }
    showError('');
    await save({ [p.keyField]: key });
    $(input).value = '';
    renderConnection();
  });
  $(clearBtn).addEventListener('click', async () => {
    await save({ [p.keyField]: '' });
    renderConnection();
  });
}
bindKey('openrouter', '#or-key', '#or-save', '#or-clear');
bindKey('typesafe', '#ts-key', '#ts-save', '#ts-clear');

$('#test').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  showError('');
  try {
    const res = await send('testJev');
    renderConnection(`${res.model} · ${fmtNumber(res.ms)} ms · ${res.estimated ? '≈ ' : ''}${cost(res.cost)}`);
    renderUsage();
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});

// ---------- Funktionen ----------

const lines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);

// Zusatzfelder, die unter einer eingeschalteten Funktion erscheinen.
const EXTRAS = {
  autoGroup: () => [
    h('label', { class: 'field' }, h('span', {}, t('opt_autoGroupRulesLabel')),
      h('textarea', { class: 'mono', placeholder: t('opt_autoGroupRulesPlaceholder'), onchange: (e) => save({ groupRules: lines(e.target.value) }) }, settings.groupRules.join('\n'))),
  ],
  dupeGuard: () => {
    const mode = h('select', { onchange: (e) => save({ dupeGuardMode: e.target.value }) },
      h('option', { value: 'switch' }, t('opt_dupeGuardSwitch')), h('option', { value: 'ask' }, t('opt_dupeGuardAsk')));
    mode.value = settings.dupeGuardMode;
    return [
      h('label', { class: 'field' }, h('span', {}, t('opt_dupeGuardModeLabel')), mode),
      h('p', { class: 'help' }, t('opt_dupeGuardHelp')),
      h('label', { class: 'field' }, h('span', {}, t('opt_dupeGuardAllowLabel')),
        h('textarea', { class: 'mono', placeholder: 'mail.google.com', onchange: (e) => save({ dupeGuardAllow: lines(e.target.value) }) }, settings.dupeGuardAllow.join('\n'))),
    ];
  },
  discard: () => [h('label', { class: 'inline' }, t('opt_discardAfterPrefix'),
    h('input', { type: 'number', min: 5, max: 1440, value: settings.discardAfterMin, onchange: (e) => save({ discardAfterMin: Math.max(5, Number(e.target.value) || 60) }) }), t('opt_discardAfterSuffix'))],
  cleanupSuggest: () => [h('label', { class: 'inline' }, t('opt_cleanupDaysPrefix'),
    h('input', { type: 'number', min: 1, max: 60, value: settings.cleanupDays, onchange: (e) => save({ cleanupDays: Math.max(1, Number(e.target.value) || 3) }) }), t('opt_cleanupDaysSuffix'))],
  copyUnlock: () => {
    const input = h('input', { type: 'text', class: 'mono', placeholder: 'bank.example', 'aria-label': t('opt_websiteAriaLabel') });
    const list = h('ul', { class: 'host-list' }, ...(settings.unlockHosts || []).map((host) => h('li', {},
      h('span', { class: 'mono' }, host),
      h('button', { class: 'ghost icon', title: t('opt_remove'), 'aria-label': t('opt_removeNamed', host), onclick: async () => {
        await send('setAlwaysUnlock', { host, on: false });
        settings = await getSettings();
        renderFeatures();
      } }, icon('x')))));
    const add = h('button', { class: 'ghost', onclick: async () => {
      const host = input.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
      if (!host) return;
      // Chrome fragt hier einmal nach dem Leserecht für diese Website.
      if (!(await chrome.permissions.request({ origins: [`*://${host}/*`, `*://*.${host}/*`] }).catch(() => false))) return;
      await send('setAlwaysUnlock', { host, on: true });
      settings = await getSettings();
      renderFeatures();
    } }, icon('plus'), t('opt_add'));
    return [
      h('p', { class: 'help' }, t('opt_copyUnlockHelp')),
      list,
      h('div', { class: 'inline' }, input, add),
    ];
  },
  focus: () => [
    h('label', { class: 'inline' }, t('opt_focusDurationPrefix'),
      h('input', { type: 'number', min: 5, max: 240, value: settings.focusMinutes, onchange: (e) => save({ focusMinutes: Math.max(5, Number(e.target.value) || 25) }) }), t('opt_focusDurationSuffix')),
    h('label', { class: 'field' }, h('span', {}, t('opt_focusBlockLabel')),
      h('textarea', { class: 'mono', onchange: (e) => save({ focusBlock: lines(e.target.value) }) }, settings.focusBlock.join('\n'))),
  ],
};

function renderFeatures() {
  const flags = { ...FEATURE_DEFAULTS, ...(settings.features || {}) };
  const areas = [...new Set(FEATURES.map((f) => f.area))];
  $('#features').replaceChildren(...areas.map((area) => h('div', { class: 'feat-area' },
    h('h3', {}, area),
    ...FEATURES.filter((f) => f.area === area).map((f) => {
      const parentOff = f.parent && !isOn(settings, f.parent);
      const box = h('input', { type: 'checkbox', id: `f-${f.id}`, disabled: parentOff });
      box.checked = flags[f.id];
      box.addEventListener('change', async () => {
        if (box.checked && f.warn && !confirm(`${f.label}\n\n${f.hint}\n\n${t('opt_confirmEnableWarn')}`)) { box.checked = false; return; }
        if (box.checked && f.perm) {
          const granted = await chrome.permissions.request(f.perm);
          if (!granted) { box.checked = false; return; }
          if (f.id === 'paletteHistoryJev') await save({ paletteHistory: true });
        }
        await save({ features: { ...flags, [f.id]: box.checked } });
        renderFeatures();
      });
      const extra = EXTRAS[f.id] && flags[f.id] && !parentOff ? h('div', { class: 'feat-extra' }, ...EXTRAS[f.id]()) : null;
      return h('div', { class: `feat${f.parent ? ' child' : ''}${parentOff ? ' dim' : ''}` },
        box,
        h('label', { for: `f-${f.id}` },
          h('b', {}, f.label),
          f.jev ? h('span', { class: 'tag jev', title: hasKey(settings) ? t('opt_usesJev') : t('opt_needsJevKey') }, 'Jev') : null,
          f.perm ? h('span', { class: 'tag' }, t('opt_permissionTag')) : null,
          h('small', {}, f.hint)),
        extra);
    }))));
}

// ---------- Formulare ----------

async function renderProfiles() {
  const list = await send('listProfiles');
  if (!list.length) {
    $('#profiles').replaceChildren(h('p', { class: 'help' }, t('opt_noProfilesYet')));
    return;
  }
  $('#profiles').replaceChildren(...list.map((p) => {
    const table = h('table', { hidden: true }, ...p.fields.map((f) => h('tr', {}, h('td', {}, f.label || f.name || f.id || f.type), h('td', { class: 'mono' }, f.sensitive ? '••••••' : String(f.value)))));
    return h('div', { class: 'profile' },
      h('div', { class: 'head' },
        h('span', { class: 'name', title: p.name }, p.name),
        h('span', { class: 'mono faint' }, tp('opt_fieldsCount', p.fields.length)),
        h('button', { class: 'ghost', onclick: (e) => { table.hidden = !table.hidden; e.currentTarget.textContent = table.hidden ? t('opt_showValues') : t('opt_hideValues'); } }, t('opt_showValues')),
        h('button', { class: 'ghost icon', title: t('opt_rename'), 'aria-label': t('opt_rename'), onclick: async () => {
          const name = prompt(t('opt_renamePrompt'), p.name);
          if (name) { await send('renameProfile', { id: p.id, name }); renderProfiles(); }
        } }, icon('edit')),
        h('button', { class: 'ghost icon danger', title: t('opt_delete'), 'aria-label': t('opt_delete'), onclick: async () => { await send('deleteProfile', { id: p.id }); renderProfiles(); } }, icon('trash'))),
      table);
  }));
}

// ---------- Export und Import ----------

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

$('#x-export').addEventListener('click', async () => {
  const data = await send('exportAll', { withKeys: $('#x-keys').checked, withHistory: $('#x-history').checked, withForms: $('#x-forms').checked });
  download(`tabwerk-${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
  $('#x-note').textContent = t('opt_exported');
});

$('#x-bookmarks').addEventListener('click', async () => {
  const sessions = await send('listSessions');
  if (!sessions.length) { $('#x-note').textContent = t('opt_noSessionsYet'); return; }
  download(`tabwerk-sitzungen-${stamp()}.html`, toBookmarkHtml(sessions), 'text/html');
  $('#x-note').textContent = tp('opt_sessionsSavedAsBookmarks', sessions.length);
});

$('#x-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const r = await send('importAll', { data });
    // Wächter brauchen ihre Leseerlaubnis zurück.
    if (r.origins.length) await chrome.permissions.request({ origins: r.origins }).catch(() => {});
    $('#x-note').textContent = t('opt_importSummary', fmtNumber(r.sessions), fmtNumber(r.watches), fmtNumber(r.snapshots));
    settings = await getSettings();
  } catch (error) {
    $('#x-note').textContent = t('opt_importFailed', error.message);
  }
  e.target.value = '';
});

$('#open-stats').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/stats/stats.html') }));

// ---------- Schnellsuche ----------

async function renderShortcut() {
  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'open-palette');
  $('#shortcut').className = `status${cmd?.shortcut ? ' ok' : ''}`;
  $('#shortcut').replaceChildren(
    h('span', { class: 'dot' }),
    h('span', {}, cmd?.shortcut ? t('opt_shortcutSet') : t('opt_noShortcut')),
    cmd?.shortcut ? h('span', { class: 'mono' }, cmd.shortcut) : null,
  );
}
$('#change-shortcut').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

// Lesezeichen und Verlauf sind optionale Rechte. Chrome fragt erst, wenn du sie einschaltest.
function bindPermissionToggle(id, key, permission) {
  const box = $(id);
  box.checked = settings[key];
  box.addEventListener('change', async () => {
    $('#palette-err').hidden = true;
    if (box.checked) {
      const granted = await chrome.permissions.request({ permissions: [permission] });
      if (!granted) {
        box.checked = false;
        $('#palette-err').textContent = t('opt_paletteNoPermission');
        $('#palette-err').hidden = false;
        return;
      }
    } else {
      await chrome.permissions.remove({ permissions: [permission] });
    }
    save({ [key]: box.checked });
  });
}
bindPermissionToggle('#p-bookmarks', 'paletteBookmarks', 'bookmarks');
bindPermissionToggle('#p-history', 'paletteHistory', 'history');
$('#p-jev').checked = settings.paletteJev;
$('#p-theme').value = settings.paletteTheme;
$('#p-theme').addEventListener('change', (e) => save({ paletteTheme: e.target.value }));
$('#p-jev').addEventListener('change', (e) => save({ paletteJev: e.target.checked }));

// ---------- Kategorien ----------

function renderCats() {
  const list = settings.categories;
  const update = (i, patch) => {
    list[i] = { ...list[i], ...patch };
    save({ categories: list });
  };
  $('#cats').replaceChildren(...list.map((cat, i) => {
    const card = h('div', { class: 'cat', style: { '--c': CHROME_COLORS[cat.color] } });
    const tab = h('span', { class: 'reiter', 'data-c': cat.color, style: { '--c': CHROME_COLORS[cat.color] } }, cat.name || t('opt_categoryNoName'));
    const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': t('opt_colorGroupLabel') },
      ...Object.entries(CHROME_COLORS).map(([name, hex]) => h('button', {
        style: { '--sw': hex },
        title: name,
        'aria-label': t('opt_colorAriaLabel', name),
        'aria-pressed': String(name === cat.color),
        onclick: () => { update(i, { color: name }); renderCats(); },
      })));
    const nameInput = h('input', { type: 'text', class: 'name', value: cat.name, 'aria-label': t('opt_groupNameAriaLabel'),
      oninput: (e) => { tab.textContent = e.target.value || t('opt_categoryNoName'); },
      onchange: (e) => update(i, { name: e.target.value.trim() }) });
    const hint = h('input', { type: 'text', class: 'hint', value: cat.hint || '', placeholder: t('opt_categoryHintPlaceholder'), 'aria-label': t('opt_categoryHintAriaLabel'),
      onchange: (e) => update(i, { hint: e.target.value.trim() }) });
    const del = h('button', { class: 'ghost icon del', title: t('opt_remove'), 'aria-label': t('opt_removeNamed', cat.name),
      onclick: () => { list.splice(i, 1); save({ categories: list }); renderCats(); } }, icon('trash'));
    card.append(h('div', { class: 'pick' }, tab, swatches), nameInput, hint, del);
    return card;
  }));
}

$('#add-cat').addEventListener('click', () => {
  const used = new Set(settings.categories.map((c) => c.color));
  const color = Object.keys(CHROME_COLORS).find((c) => !used.has(c)) || 'grey';
  settings.categories.push({ name: t('opt_categoryNoName'), color, hint: '' });
  save({ categories: settings.categories });
  renderCats();
  $('#cats').lastElementChild?.querySelector('.name')?.select();
});

// ---------- Priorität ----------

$('#focus').value = settings.priorityFocus;
$('#focus').addEventListener('change', (e) => save({ priorityFocus: e.target.value.trim() }));

function renderLevels() {
  const tags = [t('opt_levelLow'), t('opt_levelLater'), t('opt_levelRelevant'), t('opt_levelHigh')];
  $('#levels').replaceChildren(h('span', { class: 'help' }, t('opt_levelsHelp')),
    ...settings.priorityLevels.map((level, i) => h('label', { class: 'level-row' },
      h('span', { class: 'tag' }, `${i} ${tags[i] || ''}`),
      h('input', { type: 'text', value: level, onchange: (e) => {
        const levels = [...settings.priorityLevels];
        levels[i] = e.target.value.trim() || DEFAULTS.priorityLevels[i];
        save({ priorityLevels: levels });
      } }))));
}

// ---------- Schwellen ----------

function bindRange(id, key) {
  const input = $(id);
  const out = input.nextElementSibling;
  input.value = Math.round(settings[key] * 100);
  out.textContent = fmtNumber(Number(input.value) / 100, { style: 'percent' });
  input.addEventListener('input', () => { out.textContent = fmtNumber(Number(input.value) / 100, { style: 'percent' }); });
  input.addEventListener('change', () => save({ [key]: Number(input.value) / 100 }));
}

// ---------- Datenschutz ----------

$('#excluded').value = settings.excludedHosts.join('\n');
$('#excluded').addEventListener('change', (e) => save({
  excludedHosts: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
}));

// ---------- Verbrauch ----------

async function renderUsage() {
  const usage = await getUsage();
  const month = fmtDate(new Date(), { month: 'long', year: 'numeric' });
  $('#usage').replaceChildren(
    h('div', {}, h('b', {}, fmtNumber(usage.requests)), h('span', {}, tp('opt_requestsInMonth', usage.requests, month))),
    h('div', {}, h('b', {}, `${usage.estimated ? '≈ ' : ''}${cost(usage.cost)}`), h('span', {}, usage.estimated ? t('opt_costsEstimatedLabel') : t('opt_costsReportedLabel'))),
    h('div', {}, h('b', {}, fmtNumber(usage.unknownCost)), h('span', {}, tp('opt_requestsWithoutCostLabel', usage.unknownCost))),
  );
}

// ---------- Verlauf ----------

async function renderHistory() {
  const index = await send('listSnapshots');
  const bytes = await chrome.storage.local.getBytesInUse(null);
  const oldest = index.at(-1);
  $('#history-stats').replaceChildren(
    h('div', {}, h('b', {}, fmtNumber(index.length)), h('span', {}, tp('opt_backupsLabel', index.length))),
    h('div', {}, h('b', {}, oldest ? fmtDate(oldest.t, { dateStyle: 'medium' }) : '–'), h('span', {}, t('opt_oldestBackupLabel'))),
    h('div', {}, h('b', {}, bytes < 1048576 ? `${fmtNumber(Math.max(1, Math.round(bytes / 1024)))} KB` : `${fmtNumber(bytes / 1048576, { maximumFractionDigits: 1 })} MB`), h('span', {}, t('opt_storageUsedLabel'))),
  );
}

let clearArmed = false;
$('#clear-history').addEventListener('click', async () => {
  if (!clearArmed) {
    clearArmed = true;
    $('#clear-history').lastChild.textContent = t('opt_clearHistoryConfirm');
    $('#history-note').textContent = t('opt_clearHistoryNote');
    return;
  }
  const { removed } = await send('clearHistory');
  clearArmed = false;
  $('#clear-history').lastChild.textContent = t('opt_clearHistory');
  $('#history-note').textContent = tp('opt_backupsDeleted', removed);
  renderHistory();
});

renderLanguage();
renderConnection();
renderFeatures();
renderProfiles();
renderShortcut();
renderHistory();
renderCats();
renderLevels();
bindRange('#confidence', 'confidence');
bindRange('#notify-at', 'notifyAt');
renderUsage();
