import { h, icon, send, cost } from '../ui/dom.js';
import { getSettings, saveSettings, getUsage, CHROME_COLORS, PROVIDERS, connection, DEFAULTS } from '../lib/settings.js';

const $ = (sel) => document.querySelector(sel);
let settings = await getSettings();

let savedTimer;
async function save(patch) {
  settings = { ...settings, ...patch };
  await saveSettings(patch);
  $('#saved').textContent = 'Gespeichert';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('#saved').textContent = ''; }, 1600);
}

function showError(text) {
  const el = $('#connect-err');
  el.textContent = text || '';
  el.hidden = !text;
}

// ---------- Verbindung ----------

function renderConnection(extra) {
  const conn = connection(settings);
  document.querySelectorAll('input[name=provider]').forEach((r) => { r.checked = r.value === settings.provider; });
  document.querySelectorAll('.provider').forEach((el) => { el.hidden = el.dataset.provider !== settings.provider; });
  const ok = Boolean(conn.key);
  $('#key-status').className = `status${ok ? ' ok' : ''}`;
  $('#key-status').replaceChildren(
    h('span', { class: 'dot' }),
    h('span', {}, ok ? `Verbunden mit ${conn.name}` : `Kein ${conn.name}-Schlüssel`),
    ok ? h('span', { class: 'mono' }, extra || `Schlüssel …${conn.key.slice(-4)}`) : null,
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
    if (!code) throw new Error('OpenRouter hat keinen Code zurückgegeben.');
    const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.key) throw new Error(`OpenRouter hat den Code abgelehnt (${res.status}).`);
    await save({ apiKey: data.key });
    renderConnection();
  } catch (error) {
    showError(error.message.includes('did not approve') || error.message.includes('closed')
      ? 'Die Anmeldung wurde abgebrochen.'
      : error.message);
  }
});

function bindKey(provider, input, saveBtn, clearBtn) {
  const p = PROVIDERS[provider];
  $(saveBtn).addEventListener('click', async () => {
    const key = $(input).value.trim();
    if (!key || (p.keyPrefix && !key.startsWith(p.keyPrefix))) {
      showError(p.keyPrefix ? `Ein ${p.name}-Schlüssel beginnt mit ${p.keyPrefix}.` : 'Trag einen Schlüssel ein.');
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
    renderConnection(`${res.model} · ${res.ms} ms · ${res.estimated ? '≈ ' : ''}${cost(res.cost)}`);
    renderUsage();
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});

// ---------- Schnellsuche ----------

async function renderShortcut() {
  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'open-palette');
  $('#shortcut').className = `status${cmd?.shortcut ? ' ok' : ''}`;
  $('#shortcut').replaceChildren(
    h('span', { class: 'dot' }),
    h('span', {}, cmd?.shortcut ? 'Tastenkürzel' : 'Kein Tastenkürzel gesetzt. Vielleicht nutzt eine andere Erweiterung es schon.'),
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
        $('#palette-err').textContent = 'Ohne Erlaubnis kann Tabwerk hier nicht suchen.';
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
    const tab = h('span', { class: 'reiter', 'data-c': cat.color, style: { '--c': CHROME_COLORS[cat.color] } }, cat.name || 'Ohne Namen');
    const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Farbe' },
      ...Object.entries(CHROME_COLORS).map(([name, hex]) => h('button', {
        style: { '--sw': hex },
        title: name,
        'aria-label': `Farbe ${name}`,
        'aria-pressed': String(name === cat.color),
        onclick: () => { update(i, { color: name }); renderCats(); },
      })));
    const nameInput = h('input', { type: 'text', class: 'name', value: cat.name, 'aria-label': 'Name der Gruppe',
      oninput: (e) => { tab.textContent = e.target.value || 'Ohne Namen'; },
      onchange: (e) => update(i, { name: e.target.value.trim() }) });
    const hint = h('input', { type: 'text', class: 'hint', value: cat.hint || '', placeholder: 'Wofür ist die Gruppe? z. B. online shops and orders', 'aria-label': 'Beschreibung für Jev',
      onchange: (e) => update(i, { hint: e.target.value.trim() }) });
    const del = h('button', { class: 'ghost icon del', title: 'Entfernen', 'aria-label': `${cat.name} entfernen`,
      onclick: () => { list.splice(i, 1); save({ categories: list }); renderCats(); } }, icon('trash'));
    card.append(h('div', { class: 'pick' }, tab, swatches), nameInput, hint, del);
    return card;
  }));
}

$('#add-cat').addEventListener('click', () => {
  const used = new Set(settings.categories.map((c) => c.color));
  const color = Object.keys(CHROME_COLORS).find((c) => !used.has(c)) || 'grey';
  settings.categories.push({ name: 'Neue Gruppe', color, hint: '' });
  save({ categories: settings.categories });
  renderCats();
  $('#cats').lastElementChild?.querySelector('.name')?.select();
});

// ---------- Priorität ----------

$('#focus').value = settings.priorityFocus;
$('#focus').addEventListener('change', (e) => save({ priorityFocus: e.target.value.trim() }));

function renderLevels() {
  const tags = ['niedrig', 'später', 'relevant', 'hoch'];
  $('#levels').replaceChildren(h('span', { class: 'help' }, 'Stufen von unwichtig bis wichtig. Jev liest sie wörtlich.'),
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
  out.textContent = `${input.value} %`;
  input.addEventListener('input', () => { out.textContent = `${input.value} %`; });
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
  const month = new Date().toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  $('#usage').replaceChildren(
    h('div', {}, h('b', {}, String(usage.requests)), h('span', {}, `Anfragen im ${month}`)),
    h('div', {}, h('b', {}, `${usage.estimated ? '≈ ' : ''}${cost(usage.cost)}`), h('span', {}, usage.estimated ? 'Kosten, teils geschätzt' : 'gemeldete Kosten')),
    h('div', {}, h('b', {}, String(usage.unknownCost)), h('span', {}, 'Anfragen ohne Kostenangabe')),
  );
}

// ---------- Verlauf ----------

async function renderHistory() {
  const index = await send('listSnapshots');
  const bytes = await chrome.storage.local.getBytesInUse(null);
  const oldest = index.at(-1);
  $('#history-stats').replaceChildren(
    h('div', {}, h('b', {}, String(index.length)), h('span', {}, 'Sicherungen')),
    h('div', {}, h('b', {}, oldest ? new Date(oldest.t).toLocaleDateString('de-DE') : '–'), h('span', {}, 'älteste Sicherung')),
    h('div', {}, h('b', {}, bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`), h('span', {}, 'Speicher von Tabwerk')),
  );
}

let clearArmed = false;
$('#clear-history').addEventListener('click', async () => {
  if (!clearArmed) {
    clearArmed = true;
    $('#clear-history').lastChild.textContent = 'Wirklich leeren';
    $('#history-note').textContent = 'Danach gibt es kein Zurück zu früheren Ständen.';
    return;
  }
  const { removed } = await send('clearHistory');
  clearArmed = false;
  $('#clear-history').lastChild.textContent = 'Verlauf leeren';
  $('#history-note').textContent = `${removed} Sicherungen gelöscht.`;
  renderHistory();
});

renderConnection();
renderShortcut();
renderHistory();
renderCats();
renderLevels();
bindRange('#confidence', 'confidence');
bindRange('#notify-at', 'notifyAt');
renderUsage();
