// End-to-End-Probelauf: lädt Tabwerk in Chrome for Testing, öffnet erfundene Tabs und klickt alle Bereiche durch.
//
// Jev-Anfragen gehen an einen lokalen Proxy. Der Proxy antwortet je nach Umgebung:
//   OPENROUTER_API_KEY gesetzt: echte Anfrage an die OpenRouter Decisions API
//   JEV_HELPER gesetzt:         Pfad zu einem eigenen Skript, das eine Anfrage-Datei an Jev schickt
//                               und JSON mit "response" und "cost_usd" ausgibt
//   sonst:                      feste Testantworten, ohne Netz
// Die Extension selbst bekommt nur einen Platzhalter als Schlüssel.
//
// Aufruf: npm run e2e            (Screenshots landen in test-results/)
//         JEV_OFFLINE=1 npm run e2e

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromePath } from './chrome.mjs';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'test-results');
mkdirSync(out, { recursive: true });
const helper = process.env.JEV_HELPER && existsSync(process.env.JEV_HELPER) ? process.env.JEV_HELPER : null;
const orKey = process.env.OPENROUTER_API_KEY || null;
const live = !process.env.JEV_OFFLINE && Boolean(helper || orKey);
const log = (...a) => console.log('·', ...a);
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(ok ? '✓' : '✗', name, info); };
// Prüfungen, die echte Jev-Antworten brauchen. Offline werden sie übersprungen.
const checkJev = (name, ok, info = '') => (live ? check(name, ok, info) : console.log('–', name, '(übersprungen, offline)'));

// ---------- Lokaler Server: Testseiten und Jev-Proxy ----------

let stock = 'Derzeit nicht verfügbar';
let price = '349,00 €';
let jevCalls = 0;
let jevCost = 0;
const tmp = mkdtempSync(join(tmpdir(), 'tabwerk-e2e-'));
chmodSync(tmp, 0o700);

function fakeAnswers(body) {
  const answers = {};
  for (const [id, q] of Object.entries(body.questions)) {
    if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.9 };
    else if (q.type === 'score') answers[id] = { type: 'score', score: 1, confidence: 0.9, probabilities: {} };
    else {
      const first = Object.keys(q.criteria)[0];
      answers[id] = { type: 'choice', choice: first, confidence: 0.9, probabilities: { [first]: 0.9, none: 0.1 } };
    }
  }
  return { model: 'offline-stub', answers, usage: { cost: 0 } };
}

async function askJev(body) {
  if (!live) return fakeAnswers(body);
  if (!helper) {
    const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Jev-Fehler ${res.status}: ${json.error?.message || ''}`);
    jevCost += json.usage?.cost || 0;
    return json;
  }
  const file = join(tmp, `req-${jevCalls}.json`);
  writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
  let raw;
  try {
    raw = execFileSync('python3', [helper, file, '--data-permission', 'synthetic'], { encoding: 'utf8' });
  } catch (error) {
    raw = error.stdout;
  }
  const res = JSON.parse(raw);
  if (!res.response) throw new Error(`Jev-Fehler: ${raw}`);
  jevCost += res.cost_usd || 0;
  return res.response;
}

const server = createServer((req, res) => {
  if (req.url === '/decisions' && req.method === 'POST') {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', async () => {
      jevCalls += 1;
      try {
        const answer = await askJev(JSON.parse(data));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer));
      } catch (error) {
        res.writeHead(500);
        res.end(String(error.message));
      }
    });
    return;
  }
  if (req.url.startsWith('/form')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Kontakt – Beispiel</title><body><form>
      <label for="vn">Vorname</label><input id="vn" name="vorname">
      <label>E-Mail <input name="email" type="email"></label>
      <label for="pw">Passwort</label><input id="pw" type="password" name="pw">
      <label for="iban">IBAN</label><input id="iban" name="iban">
      <label for="ort">Ort</label><select id="ort" name="ort"><option value="">–</option><option>Berlin</option><option>Köln</option></select>
      <label><input type="checkbox" name="news"> Newsletter</label>
      <textarea name="nachricht" aria-label="Nachricht"></textarea></form></body>`);
    return;
  }
  if (req.url.startsWith('/shop')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Sony WH-1000XM6 – Beispielshop</title><body><nav>Start · Kopfhörer</nav>
      <h1>Sony WH-1000XM6</h1><p>${stock}</p><p>Unser Preis: ${price}</p><p>Versand: 4,95 €</p><p>Zuletzt aktualisiert: ${new Date().toLocaleTimeString('de-DE')}</p>
      <footer>Impressum</footer></body>`);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const local = `http://127.0.0.1:${port}`;

// ---------- Extension-Kopie mit Testanpassungen ----------

const ext = join(tmp, 'ext');
cpSync(root, ext, { recursive: true, filter: (src) => !/node_modules|test-results|\.git(\/|$)/.test(src) });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*', 'https://*/*');
// Optionale Rechte fest vergeben, weil der Test keine Chrome-Rückfrage bestätigen kann.
manifest.permissions.push('history', 'bookmarks');
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
const settingsFile = join(ext, 'src/lib/settings.js');
const patched = readFileSync(settingsFile, 'utf8').replace("'https://openrouter.ai/api/alpha/decisions'", `'${local}/decisions'`);
if (!patched.includes(`${local}/decisions`)) throw new Error('Endpunkt für den Test nicht gefunden');
writeFileSync(settingsFile, patched);

// ---------- Browser ----------

const context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
  executablePath: chromePath(),
  headless: process.env.HEADED ? false : true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 1280, height: 800 },
});

// Erfundene Websites. Kein Aufruf verlässt den Rechner, außer der Jev-Proxy.
const pages = [
  ['https://outlook.office.com/mail/inbox', 'Posteingang (12) – Outlook'],
  ['https://www.schreibwerkstatt-blog.de/klare-berichte?utm_source=newsletter', 'Klare Berichte schreiben: 7 Regeln'],
  ['https://github.com/example/tabwerk/blob/main/src/lib/jev.js', 'tabwerk/src/lib/jev.js at main · example/tabwerk'],
  ['https://www.idealo.de/preisvergleich/OffersOfProduct/123456.html', 'Sony WH-1000XM6 Kopfhörer: Preisvergleich'],
  ['https://www.youtube.com/watch?v=abc123', 'Lo-fi beats to study to – YouTube'],
  ['https://www.flytap.com/de-de/buchen', 'Flug Berlin – Lissabon buchen | TAP'],
  ['https://schreibwerkstatt-blog.de/klare-berichte/#regel-5', 'Klare Berichte schreiben: 7 Regeln'],
  ['https://developer.chrome.com/docs/extensions/reference/api/tabGroups', 'chrome.tabGroups | Chrome for Developers'],
  ['https://docs.google.com/document/d/quartalsbericht-q3/edit', 'Quartalsbericht Q3 – Google Docs'],
  ['https://www.amazon.de/dp/B0TEST1234', 'Bosch Akkuschrauber GSR 18V – Amazon.de'],
];
await context.route(/^https:\/\/(?!openrouter)/, (route) => {
  if (route.request().url().includes('dark-theme-test')) {
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta name="color-scheme" content="dark"><title>Dunkle Seite</title><style>:root{color-scheme:dark}body{background:#0d1117;color:#e6edf3;font:16px sans-serif;margin:0;padding:40px}p{max-width:60ch}</style><h1>Dunkle Testseite</h1>' + '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. </p>'.repeat(20) });
    return;
  }
  const hit = pages.find(([u]) => route.request().url().split('#')[0] === u.split('#')[0]);
  route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><title>${hit ? hit[1] : 'Seite'}</title><body><h1>${hit ? hit[1] : ''}</h1></body>` });
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const id = new URL(worker.url()).host;
log('Extension', id, live ? '· Jev live' : '· Jev offline');

// Die Einstellungsseite öffnet sich bei der Installation von selbst.
await new Promise((r) => setTimeout(r, 800));
for (const p of context.pages()) if (p.url().includes('options.html') || p.url() === 'about:blank') await p.close().catch(() => {});

const opened = [];
for (const [url] of pages) {
  const p = await context.newPage();
  await p.goto(url);
  opened.push(p);
}

const popup = await context.newPage();
const errors = [];
popup.on('pageerror', (e) => errors.push(e.message));
popup.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await popup.setViewportSize({ width: 408, height: 600 });
await popup.goto(`chrome-extension://${id}/src/popup/popup.html`);
// Platzhalter-Schlüssel. Der Proxy ignoriert ihn.
await popup.evaluate(() => chrome.storage.local.set({ apiKey: 'sk-or-e2e-placeholder', priorityFocus: 'Ich schreibe heute den Quartalsbericht für mein Team.' }));
await popup.reload();
await popup.bringToFront();

const shot = (name) => popup.screenshot({ path: join(out, `${name}.png`) });
const panel = async (name) => { await popup.click(`[data-panel=${name}]`); await popup.waitForTimeout(200); };

// Finden
await panel('find');
await popup.fill('#find-q', 'wo war die Seite mit dem Preis für die Kopfhörer');
await popup.click('#find-form button[type=submit]');
await popup.waitForSelector('#find-out button.row, #find-out .fail, #find-out .empty', { timeout: 30000 });
const firstHit = await popup.textContent('#find-out button.row .title').catch(() => '');
checkJev('Finden liefert den Preisvergleich zuerst', /Preisvergleich/.test(firstHit || ''), firstHit);
await shot('1-finden');

// Doppelte
await panel('dupes');
await popup.waitForSelector('#dupes-out .dupe, #dupes-out .empty');
const dupeCount = await popup.locator('#dupes-out .dupe').count();
check('Doppelte: genau eine Seite doppelt', dupeCount === 1, `${dupeCount}`);
await shot('2-doppelte');
await popup.click('#similar');
await popup.waitForSelector('#dupes-out .dupe, #dupes-out .empty, #dupes-out .fail', { timeout: 30000 });
await shot('2b-aehnliche');
await panel('dupes');
await popup.waitForSelector('#dupes-out .dupe');
// Pro Eintrag entscheiden: Auswahl umdrehen, also den vorgeschlagenen Tab behalten und den anderen schließen.
const rows = popup.locator('#dupes-out .dupe-row');
const keptBefore = await rows.nth(0).locator('.site').getAttribute('title');
const closedBefore = await rows.nth(1).locator('.site').getAttribute('title');
await rows.nth(0).locator('input').check();
await rows.nth(1).locator('input').uncheck();
await shot('2c-doppelte-auswahl');
await popup.click('#dupes-out .sticky button.primary');
await popup.waitForSelector('#dupes-out .empty');
const urlsAfterDupes = await popup.evaluate(async () => (await chrome.tabs.query({ currentWindow: true })).map((t) => t.url));
check('Doppelte schließen entfernt einen Tab', urlsAfterDupes.length === pages.length, `${urlsAfterDupes.length} Tabs`);
check('Doppelte: eigene Auswahl zählt', urlsAfterDupes.includes(closedBefore) && !urlsAfterDupes.includes(keptBefore), `offen: ${closedBefore}`);

// Gruppen
await panel('groups');
await popup.click('#propose');
await popup.waitForSelector('#groups-out .bucket, #groups-out .fail', { timeout: 60000 });
const buckets = await popup.locator('#groups-out .bucket').count();
checkJev('Gruppen: Vorschlag mit mehreren Gruppen', buckets >= 3, `${buckets} Gruppen`);
await shot('3-gruppen-vorschlag');
await popup.click('#groups-out .sticky button.primary');
await popup.waitForSelector('#groups-out .empty');
const groups = await popup.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => g.title));
checkJev('Gruppen angelegt', groups.length >= 3, groups.join(', '));

// Zweites Fenster: darf von allem in Fenster 1 unberührt bleiben.
const win1 = await popup.evaluate(async () => (await chrome.windows.getCurrent()).id);
const win2 = await popup.evaluate(async () => (await chrome.windows.create({ url: 'https://www.youtube.com/watch?v=zweites', focused: false })).id);
await popup.waitForTimeout(500);

// Gruppen nach Priorität
await panel('sort');
await popup.check('input[name=sort][value=groups]');
await popup.click('#sort-go');
await popup.waitForSelector('#sort-out .reiter, #sort-out .fail, #sort-out .empty', { timeout: 60000 });
const groupOrder = await popup.evaluate(async (id) => {
  const tabs = (await chrome.tabs.query({ windowId: id })).sort((a, b) => a.index - b.index);
  const seen = [];
  for (const t of tabs) if (t.groupId !== -1 && !seen.includes(t.groupId)) seen.push(t.groupId);
  return Promise.all(seen.map(async (g) => (await chrome.tabGroups.get(g)).title));
}, win1);
checkJev('Gruppen nach Priorität: Arbeit vorn, Medien hinten', groupOrder[0] === 'Arbeit' && groupOrder.indexOf('Medien') > 1, groupOrder.join(' > '));
await shot('4a-gruppen-prioritaet');

// Verlauf pro Fenster: nach dem Snapshot neuer Tab in Fenster 2, dann Fenster 1 zurück auf "Vor Gruppieren"
await popup.evaluate((id) => chrome.tabs.create({ windowId: id, url: 'https://www.flytap.com/de-de/buchen', active: false }), win2);
await popup.waitForTimeout(1800);
await panel('history');
await popup.waitForSelector('#history-out .snap');
await popup.locator('#history-out .snap', { hasText: 'Vor Gruppieren' }).first().locator('summary').click();
await popup.waitForSelector('#history-out .snap[open] .snap-actions button');
const winBtn = popup.locator('#history-out .snap[open] .snap-actions button');
await winBtn.click();
await winBtn.click();
await popup.waitForFunction(() => /Fertig/.test(document.querySelector('#history-out .snap[open] p[aria-live]')?.textContent || ''), null, { timeout: 20000 });
const groupsAfter = await popup.evaluate(async (id) => (await chrome.tabGroups.query({ windowId: id })).length, win1);
const win2Tabs = await popup.evaluate(async (id) => (await chrome.tabs.query({ windowId: id })).length, win2);
check('Verlauf pro Fenster: Fenster 1 ohne Gruppen', groupsAfter === 0, `${groupsAfter}`);
check('Verlauf pro Fenster: Fenster 2 bleibt unberührt', win2Tabs === 2, `${win2Tabs} Tabs`);

// Sortieren nach Priorität
const titles = () => popup.evaluate(async () => (await chrome.tabs.query({ currentWindow: true })).sort((a, b) => a.index - b.index).map((t) => t.title));
const orderBefore = await titles();
await panel('sort');
await popup.check('input[name=sort][value=priority]');
await popup.click('#sort-go');
await popup.waitForSelector('#sort-out .row, #sort-out .empty, #sort-out .fail', { timeout: 60000 });
const order = await popup.evaluate(async () => (await chrome.tabs.query({ currentWindow: true })).sort((a, b) => a.index - b.index).map((t) => t.title));
const reportFirst = order.findIndex((t) => /Quartalsbericht/.test(t)) < order.findIndex((t) => /YouTube/.test(t));
checkJev('Priorität: Quartalsbericht vor YouTube', reportFirst, order.slice(0, 3).join(' | '));
await shot('4-sortieren');

// Rückgängig nach dem Sortieren
await popup.click('#undo');
await popup.waitForTimeout(800);
const orderUndone = await titles();
check('Rückgängig stellt die alte Reihenfolge her', JSON.stringify(orderUndone) === JSON.stringify(orderBefore), orderUndone.slice(0, 2).join(' | '));

// Verlauf: schnelle Änderungen hintereinander, dann zum ersten Stand zurück
for (let i = 0; i < 5; i++) {
  await popup.evaluate(async (n) => {
    const tabs = (await chrome.tabs.query({ currentWindow: true })).filter((t) => !t.url.startsWith('chrome-extension'));
    await chrome.tabs.move(tabs[n].id, { index: -1 });
  }, i);
  await popup.waitForTimeout(1700);
}
await panel('history');
await popup.waitForSelector('#history-out .snap');
const snaps = await popup.locator('#history-out .snap').count();
check('Verlauf: jede Änderung einzeln gesichert', snaps >= 8, `${snaps} Sicherungen`);
await popup.locator('#history-out .snap', { hasText: 'Vor Doppelte schließen' }).first().locator('summary').click();
await popup.waitForSelector('#history-out .snap[open] .snap-actions button');
await shot('6-verlauf');
const restoreBtn = popup.locator('#history-out .snap[open] .snap-actions button');
await restoreBtn.click();
await restoreBtn.click();
await popup.waitForFunction(() => /Fertig/.test(document.querySelector('#history-out .snap[open] p[aria-live]')?.textContent || ''), null, { timeout: 20000 });
const restored = await popup.evaluate(async () => (await chrome.tabs.query({ currentWindow: true })).map((t) => t.url || t.pendingUrl));
const dupesBack = restored.filter((u) => /klare-berichte/.test(u)).length;
check('Verlauf: Stand vor dem Schließen holt den Doppel-Tab zurück', dupesBack === 2, `${restored.length} Tabs`);

// Wächter
await panel('watch');
const wf = '#watch-form-slot .watch-form';
await popup.fill(`${wf} input[type=url]`, `${local}/shop`);
await popup.fill(`${wf} textarea`, 'der Kopfhörer wieder lieferbar ist');
await popup.selectOption(`${wf} select[aria-label="Prüfen alle"]`, 'custom');
await popup.fill(`${wf} input[aria-label="Eigenes Intervall"]`, '00:00:20');
await popup.click(`${wf} button[type=submit]`);
const tooShort = await popup.textContent(`${wf} .error-text`);
check('Individuelles Intervall: unter 30 Sekunden abgelehnt', /30 Sekunden/.test(tooShort), tooShort);
await popup.fill(`${wf} input[aria-label="Eigenes Intervall"]`, '00:02:00');
await popup.click(`${wf} button[type=submit]`);
await popup.waitForSelector('#watch-list .watch');
const intervalText = await popup.textContent('#watch-list .watch');
check('Individuelles Intervall: 2 Minuten gespeichert', /prüft alle 2 Minuten/.test(intervalText));
await popup.waitForTimeout(1500);
stock = 'Auf Lager – Lieferung morgen';
await panel('watch');
await popup.click('#watch-list .watch button[title="Jetzt prüfen"]');
await popup.waitForSelector('#watch-list .state.match, #watch-list .state.noise, #watch-list .state.error', { timeout: 30000 });
const watchState = await popup.textContent('#watch-list .state.match, #watch-list .state.noise, #watch-list .state.error');
check('Wächter erkennt die passende Änderung', /passende Änderung/.test(watchState), watchState);
await shot('5-waechter');

// Dunkles Design
await popup.emulateMedia({ colorScheme: 'dark' });
await panel('groups');
await popup.click('#propose');
await popup.waitForSelector('#groups-out .bucket, #groups-out .fail', { timeout: 60000 });
await shot('7-gruppen-dunkel');
await popup.emulateMedia({ colorScheme: 'light' });

// Schnellsuche als eigenes Fenster (so wie auf chrome://-Seiten)
const palette = await context.newPage();
palette.on('pageerror', (e) => errors.push(e.message));
await palette.setViewportSize({ width: 680, height: 520 });
await palette.goto(`chrome-extension://${id}/src/palette/palette.html?standalone=1&win=${win1}`);
await palette.waitForSelector('#list .item');
await palette.fill('#q', 'kopfhor preis');
await palette.waitForTimeout(100);
const palTop = await palette.textContent('#list .item .title');
check('Schnellsuche findet per Code den Preisvergleich', /Preisvergleich/.test(palTop), palTop);
await palette.fill('#q', 'gh tabw');
await palette.waitForTimeout(100);
const palGh = await palette.textContent('#list .item .title');
check('Schnellsuche: Abkürzung „gh tabw“ trifft GitHub', /tabwerk/.test(palGh), palGh);
await palette.fill('#q', '/a sortier');
await palette.waitForTimeout(100);
const palKinds = await palette.locator('#list .item .kind').allTextContents();
check('Schnellsuche: Filter /a zeigt nur Aktionen', palKinds.length > 0 && palKinds.every((k) => k === 'Aktion' || k === 'Jev'), palKinds.join(','));
await palette.fill('#q', 'kopfhörer');
await palette.screenshot({ path: join(out, '9a-schnellsuche.png') });
await palette.close();

// Wächter aus dem Kontextmenü: Fenster mit vorausgefüllter Seite und Markierung
const wnew = await context.newPage();
wnew.on('pageerror', (e) => errors.push(e.message));
await wnew.setViewportSize({ width: 460, height: 560 });
await wnew.goto(`chrome-extension://${id}/src/watch/new.html?${new URLSearchParams({ url: `${local}/shop`, sel: 'Auf Lager – Lieferung morgen' })}`);
await wnew.waitForSelector('.watch-form');
const prefilled = await wnew.inputValue('.watch-form textarea');
check('Kontextmenü-Fenster übernimmt die Markierung', /Auf Lager/.test(prefilled), prefilled);
await wnew.selectOption('.watch-form select[aria-label="Prüfen alle"]', '5');
await wnew.screenshot({ path: join(out, '5b-waechter-kontextmenue.png') });
await wnew.click('.watch-form button[type=submit]');
await wnew.waitForSelector('.done', { timeout: 10000 }).catch(() => {});
const watchCount = await popup.evaluate(async () => (await chrome.storage.local.get('watches')).watches.length);
check('Kontextmenü-Fenster legt den Wächter an', watchCount === 2, `${watchCount} Wächter`);
if (!wnew.isClosed()) await wnew.close();

// Schnellsuche als Overlay über einer Seite
const host = opened.find((p) => !p.isClosed() && /idealo/.test(p.url())) || opened.find((p) => !p.isClosed());
await host.bringToFront();
await popup.evaluate(async (url) => {
  const [tab] = (await chrome.tabs.query({})).filter((t) => t.url.startsWith(url));
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/palette/content.js'] });
}, host.url().split('#')[0]);
const frame = await (await host.waitForSelector('#tabwerk-palette-host iframe')).contentFrame();
await frame.waitForSelector('#list .item');
await frame.fill('#q', 'bericht');
await host.waitForTimeout(150);
await host.screenshot({ path: join(out, '9b-schnellsuche-overlay.png') });
await frame.press('#q', 'Escape');
await host.waitForTimeout(200);
check('Overlay schließt mit Esc', (await host.$('#tabwerk-palette-host')) === null);

// Milchglas auf einer dunklen Seite wie GitHub: der Hintergrund muss dunkel durchscheinen.
const dark = await context.newPage();
await dark.goto('https://github.com/example/dark-theme-test');
await dark.bringToFront();
await popup.evaluate(async () => {
  const [tab] = (await chrome.tabs.query({})).filter((t) => t.url.includes('dark-theme-test'));
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/palette/content.js'] });
});
const darkFrame = await (await dark.waitForSelector('#tabwerk-palette-host iframe')).contentFrame();
await darkFrame.waitForSelector('#list .item');
await dark.waitForTimeout(250);
const darkShot = await dark.screenshot({ path: join(out, '9c-schnellsuche-dunkle-seite.png') });
const probe = await context.newPage();
const corner = await probe.evaluate(async (b64) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const [r, g, b] = ctx.getImageData(40, img.height - 40, 1, 1).data;
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}, darkShot.toString('base64'));
await probe.close();
check('Milchglas auf dunkler Seite: Seite scheint durch', corner < 90, `Helligkeit ${corner}`);
await dark.close();

// ---------- Neue Funktionen (0.4) ----------
const call = async (type, payload = {}) => {
  const r = await popup.evaluate(([t, p]) => chrome.runtime.sendMessage({ type: t, payload: p }), [type, payload]);
  if (!r?.ok) throw new Error(`${type}: ${r?.error}`);
  return r.data;
};
const setFeatures = (features) => popup.evaluate(async (f) => {
  const { features: cur = {} } = await chrome.storage.local.get('features');
  await chrome.storage.local.set({ features: { ...cur, ...f } });
}, features);
const tabsIn = (wid) => popup.evaluate(async (w) => (await chrome.tabs.query({ windowId: w })).map((t) => ({ id: t.id, url: t.url || t.pendingUrl, groupId: t.groupId, discarded: t.discarded })), wid);

// Schalter: ausgeschaltete Funktion verschwindet aus dem Popup
await setFeatures({ find: false });
await popup.reload();
check('Schalter: „Finden“ aus blendet den Reiter aus', await popup.locator('[data-panel=find]').isHidden());
await setFeatures({ find: true });
await popup.reload();

// Farbmodus der Schnellsuche
const themeOf = async (query) => {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${id}/src/palette/palette.html?${query}`);
  await p.waitForSelector('#q');
  const t = await p.evaluate(() => document.documentElement.dataset.theme);
  await p.close();
  return t;
};
check('Farbmodus automatisch: dunkle Seite ergibt dunkle Suche', (await themeOf('site=dark&sys=light')) === 'dark');
await popup.evaluate(() => chrome.storage.local.set({ paletteTheme: 'light' }));
check('Farbmodus „immer hell“ gewinnt gegen dunkle Seite', (await themeOf('site=dark&sys=dark')) === 'light');
await popup.evaluate(() => chrome.storage.local.set({ paletteTheme: 'system' }));
check('Farbmodus „System“ folgt dem System', (await themeOf('site=light&sys=dark')) === 'dark');
await popup.evaluate(() => chrome.storage.local.set({ paletteTheme: 'site' }));

// Neue Tabs automatisch einsortieren (Regel)
await popup.evaluate(() => chrome.storage.local.set({ groupRules: ['amazon.de = Einkaufen'] }));
await setFeatures({ autoGroup: true });
const auto = await context.newPage();
await auto.goto('https://www.amazon.de/dp/B0AUTOGROUP');
await auto.waitForTimeout(1500);
const autoGroup = await popup.evaluate(async () => {
  const [t] = (await chrome.tabs.query({})).filter((x) => x.url.includes('B0AUTOGROUP'));
  return t.groupId === -1 ? null : (await chrome.tabGroups.get(t.groupId)).title;
});
check('Neuer Tab landet per Regel in „Einkaufen“', autoGroup === 'Einkaufen', String(autoGroup));
await auto.close();
await setFeatures({ autoGroup: false });

// Doppelte beim Öffnen abfangen
await setFeatures({ dupeGuard: true });
// Nach dem Wiederherstellen ist der Schutz kurz still. Für den Test sofort scharf schalten.
await popup.evaluate(() => chrome.storage.session.remove(['dupeQuietUntil', 'dupeLast']));
const countYt = async () => (await popup.evaluate(async () => (await chrome.tabs.query({})).filter((t) => (t.url || '').includes('watch?v=abc123')).length));
const before = await countYt();
const d1 = await context.newPage();
await d1.goto('https://www.youtube.com/watch?v=abc123').catch(() => {});
await popup.waitForTimeout(1200);
check('Doppel-Schutz: zweiter Tab derselben Seite geht zu', (await countYt()) === before, `${await countYt()} offen`);
const d2 = await context.newPage();
await d2.goto('https://www.youtube.com/watch?v=abc123').catch(() => {});
await popup.waitForTimeout(1200);
check('Doppel-Schutz: sofort nochmal öffnen behält beide', (await countYt()) === before + 1, `${await countYt()} offen`);
if (!d2.isClosed()) await d2.close();
await setFeatures({ dupeGuard: false });

// Notizen
const ytTab = await popup.evaluate(async () => (await chrome.tabs.query({})).find((t) => (t.url || '').includes('flytap')));
await call('setNote', { url: ytTab.url, title: ytTab.title, text: 'Rückflug noch offen' });
const noteBack = await call('getNote', { url: ytTab.url });
check('Notiz wird zur Adresse gespeichert', noteBack?.text === 'Rückflug noch offen');
const noteWin = await context.newPage();
await noteWin.goto(`chrome-extension://${id}/src/note/note.html?${new URLSearchParams({ url: ytTab.url, title: ytTab.title })}`);
check('Notiz-Fenster zeigt die gespeicherte Notiz', (await noteWin.inputValue('#text')) === 'Rückflug noch offen');
await noteWin.setViewportSize({ width: 440, height: 360 });
await noteWin.screenshot({ path: join(out, '10-notiz.png') });
await noteWin.close();

// Gruppennamen vorschlagen
const unnamed = await popup.evaluate(async (w) => {
  const tabs = (await chrome.tabs.query({ windowId: w })).filter((t) => /docs\.google|outlook/.test(t.url || ''));
  return chrome.tabs.group({ tabIds: tabs.map((t) => t.id) });
}, win1);
const named = await call('suggestGroupNames', { windowId: win1 });
const newTitle = await popup.evaluate((g) => chrome.tabGroups.get(g).then((x) => x.title), unnamed);
check('Gruppe ohne Titel bekommt einen Namen', Boolean(newTitle), `${newTitle} (${named.groups[0]?.confidence ?? 'Code'})`);
await popup.evaluate(async (w) => chrome.tabs.ungroup((await chrome.tabs.query({ windowId: w })).filter((t) => t.groupId !== -1).map((t) => t.id)), win1);

// Aufräum-Vorschlag
if (live) {
  const clean = await call('suggestCleanup', { windowId: win1, useJev: true });
  checkJev('Aufräum-Vorschlag: Jev markiert Tabs, die weg können', clean.items.some((i) => i.preselect), clean.items.map((i) => i.title).slice(0, 3).join(' | '));
}
await panel('dupes');
await popup.click('label:has(input[name=clean][value=suggest])');
await popup.click('#suggest-go');
await popup.waitForSelector('#dupes-out .dupe-row, #dupes-out .empty, #dupes-out .fail', { timeout: 60000 });
await shot('11-aufraeumen-vorschlag');

// Sitzungen
const session = await call('saveSession', { windowId: win2, name: 'Test-Sitzung' });
check('Sitzung gespeichert', session.name === 'Test-Sitzung' && session.windows[0].tabs.length === 2);
const windowsBefore = await popup.evaluate(async () => (await chrome.windows.getAll()).length);
await call('openSession', { id: session.id });
await popup.waitForTimeout(800);
check('Sitzung öffnet ein neues Fenster', (await popup.evaluate(async () => (await chrome.windows.getAll()).length)) === windowsBefore + 1);
await panel('history');
await popup.click('label:has(input[name=hist][value=sessions])');
await popup.waitForSelector('#sessions-out .session');
await shot('12-sitzungen');

// Fokus-Modus
await call('startFocus', { windowId: win1, minutes: 5 });
const blocked = await context.newPage();
await blocked.goto('https://www.youtube.com/watch?v=fokus').catch(() => {});
await blocked.waitForURL(/blocked\.html/, { timeout: 5000 }).catch(() => {});
check('Fokus sperrt ablenkende Seiten', /blocked\.html/.test(blocked.url()), blocked.url().slice(0, 60));
await blocked.setViewportSize({ width: 900, height: 600 });
await blocked.screenshot({ path: join(out, '13-fokus-gesperrt.png') });
await blocked.close();
await call('endFocus');

// Schlummern
const napPage = await context.newPage();
await napPage.goto('https://developer.chrome.com/docs/extensions/reference/api/tabGroups?nap=1');
const napTab = await popup.evaluate(async () => (await chrome.tabs.query({})).find((t) => (t.url || '').includes('nap=1')).id);
await call('snoozeTab', { tabId: napTab, preset: 'tomorrow' });
const snoozed = await call('listSnoozed');
check('Schlummern: Tab zu und gemerkt', snoozed.length === 1 && napPage.isClosed());
await call('wakeSnoozed', { id: snoozed[0].id });
await popup.waitForTimeout(500);
check('Schlummern: Wecken öffnet ihn wieder', await popup.evaluate(async () => (await chrome.tabs.query({})).some((t) => (t.url || t.pendingUrl || '').includes('nap=1'))));

// Linkliste kopieren
const copied = await call('runAction', { id: 'links.md', windowId: win2 });
check('Linkliste als Markdown', /^- \[.+\]\(https:\/\//.test(copied.copy), copied.copy.split('\n')[0]);

// Inaktive Tabs entladen. Echtes Entladen bringt das Test-Chrome ohne Fenster zum Absturz,
// deshalb zählt der Test nur, welche Tabs es treffen würde.
const disc = await call('discardInactive', { windowId: win1, all: true, dryRun: true });
check('Inaktive Tabs: Kandidaten erkannt', disc.discarded > 0, `${disc.discarded} Tabs`);

// Lesezeichen mit Ordner-Vorschlag
const bm = await call('runAction', { id: 'bookmark.add', windowId: win1 });
check('Lesezeichen gesetzt', /Gespeichert in/.test(bm.message), bm.message);

// Statistik
const stats = await context.newPage();
await stats.setViewportSize({ width: 1000, height: 900 });
await stats.goto(`chrome-extension://${id}/src/stats/stats.html`);
await stats.waitForSelector('.tile');
check('Statistik zeigt Kennzahlen', (await stats.locator('.tile').count()) === 4);
await stats.screenshot({ path: join(out, '14-statistik.png'), fullPage: true });
await stats.close();

// Wächter: Änderungen anzeigen und Zahlen vergleichen
await panel('watch');
const diffShown = await popup.locator('#watch-list details summary', { hasText: 'Änderungen' }).count();
check('Wächter zeigt die Änderungen', diffShown > 0);
const numWatch = await call('createWatch', { url: `${local}/shop?preis`, condition: 'der Preis des Kopfhörers', intervalMin: 60, number: { op: 'below', limit: 300 } });
await popup.waitForTimeout(1200);
price = '279,99 €';
const numAfter = await call('checkWatch', { id: numWatch.id });
checkJev('Zahlen-Wächter: 279,99 € liegt unter 300', numAfter.history[0].status === 'match' && numAfter.history[0].value === 279.99, `${numAfter.history[0].status} ${numAfter.history[0].value}`);

// Formulare: speichern ohne Passwort und IBAN, dann ausfüllen und Testdaten
const form = await context.newPage();
await form.goto(`${local}/form`);
await form.fill('#vn', 'Erika');
await form.fill('input[name=email]', 'erika@example.org');
await form.fill('#pw', 'geheim123');
await form.fill('#iban', 'DE00 1234');
await form.selectOption('#ort', 'Köln');
await form.check('input[name=news]');
await form.bringToFront();
const formWin = await popup.evaluate(async () => (await chrome.tabs.query({})).find((t) => (t.url || '').includes('/form')).windowId);
const saved = await call('saveForm', { windowId: formWin });
const savedNames = saved.profile.fields.map((f) => f.name || f.id);
check('Formular: Passwort und IBAN werden nicht gespeichert', !savedNames.includes('pw') && !savedNames.includes('iban') && savedNames.includes('vorname'), savedNames.join(','));
await form.reload();
const filled = await call('fillForm', { windowId: formWin, profileId: saved.profile.id });
check('Formular: gespeicherte Werte kommen zurück', (await form.inputValue('#vn')) === 'Erika' && (await form.inputValue('#ort')) === 'Köln' && (await form.isChecked('input[name=news]')), filled.message);
check('Formular: Passwortfeld bleibt leer', (await form.inputValue('#pw')) === '');
await form.reload();
await call('fillTestData', { windowId: formWin });
check('Testdaten: E-Mail-Feld bekommt eine Beispieladresse', /@example\.com$/.test(await form.inputValue('input[name=email]')));
await form.close();

// Export und Import
const exported = await call('exportAll', { withKeys: false });
check('Export enthält Sitzungen und keinen Schlüssel', exported.sessions.length >= 1 && !('apiKey' in exported.settings));
const imported = await call('importAll', { data: exported });
check('Import führt zusammen, ohne zu verdoppeln', imported.sessions === exported.sessions.length);

// Volltext in offenen Tabs
await setFeatures({ paletteFulltext: true });
const fullPage = await context.newPage();
await fullPage.goto('https://github.com/example/dark-theme-test?volltext');
const texts = await call('tabTexts');
check('Volltext: Seitentext wird gelesen', texts.some((t) => /consectetur adipiscing/.test(t.text)));
const pal2 = await context.newPage();
await pal2.goto(`chrome-extension://${id}/src/palette/palette.html?standalone=1&win=${win1}`);
await pal2.waitForSelector('#list .item');
await pal2.waitForTimeout(800);
await pal2.fill('#q', 'consectetur adipiscing');
await pal2.waitForTimeout(200);
const fullHit = await pal2.textContent('#list .item .sub').catch(() => '');
check('Volltext: Schnellsuche findet Text auf der Seite', /consectetur/i.test(fullHit || ''), (fullHit || '').slice(0, 50));
await pal2.close();
await fullPage.close();

// Verlauf in Alltagssprache
if (live) {
  await setFeatures({ paletteHistoryJev: true });
  const hist = await call('findHistory', { query: 'die Seite mit dem Preisvergleich für Kopfhörer von heute' });
  checkJev('Verlauf in Alltagssprache findet den Preisvergleich', /idealo/.test(hist.hits[0]?.url || ''), hist.hits[0]?.title);
}

// Einstellungen
const options = await context.newPage();
options.on('pageerror', (e) => errors.push(e.message));
await options.setViewportSize({ width: 1100, height: 900 });
await options.goto(`chrome-extension://${id}/src/options/options.html`);
await options.waitForSelector('.cat');
await options.screenshot({ path: join(out, '8-einstellungen.png'), fullPage: true });
await options.setViewportSize({ width: 390, height: 844 });
await options.screenshot({ path: join(out, '9-einstellungen-schmal.png'), fullPage: true });
const overflow = await options.evaluate(() => {
  const wide = [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1);
  return wide.length ? wide.slice(0, 3).map((el) => `${el.tagName}.${el.className}`).join(', ') : false;
});
check('Einstellungen ohne seitliches Scrollen bei 390 px', !overflow, overflow || '');

check('Keine Fehler in der Konsole', errors.length === 0, errors.join(' | '));

await context.close();
server.close();
rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} bestanden · ${jevCalls} Jev-Anfragen · ${live ? `${jevCost.toPrecision(3)} $` : 'offline'}`);
process.exit(failed ? 1 : 0);
