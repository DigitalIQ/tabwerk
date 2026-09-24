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
let lastJevBody = null;
const tmp = mkdtempSync(join(tmpdir(), 'tabwerk-e2e-'));
chmodSync(tmp, 0o700);

// Seite aufräumen: offline ordnet der Stub nach den Klassennamen der Testseite zu.
function fakeDeclutter(body, id) {
  const signals = body.state?.elements?.[id]?.signals || '';
  const choice = /ad-banner|advert/.test(signals) ? 'ad'
    : /cookie|consent/.test(signals) ? 'cookie'
      : /comment/.test(signals) ? 'comments'
        : /outbrain|recommended/.test(signals) ? 'related' : 'keep';
  return { type: 'choice', choice, confidence: 1, probabilities: { [choice]: 1 } };
}

function fakeAnswers(body) {
  const answers = {};
  for (const [id, q] of Object.entries(body.questions)) {
    if (q.type === 'choice' && q.criteria?.cookie && q.criteria?.comments) answers[id] = fakeDeclutter(body, id);
    else if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.9 };
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

const LOCKED_PAGE = `<!doctype html><title>Gesperrte Seite</title><style>body{user-select:none;-webkit-user-select:none}</style><body oncontextmenu="return false"><p id=t>Diesen Text darf man nicht kopieren.</p><script>window.__blocked=0;document.addEventListener('copy',(e)=>{e.preventDefault();window.__blocked++;});document.addEventListener('contextmenu',(e)=>e.preventDefault());</script></body>`;
const server = createServer((req, res) => {
  if (req.url === '/decisions' && req.method === 'POST') {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', async () => {
      jevCalls += 1;
      try {
        lastJevBody = JSON.parse(data);
        const answer = await askJev(lastJevBody);
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
  if (req.url.startsWith('/clutter')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Artikel – Beispielzeitung</title><meta property="og:type" content="article"><body>
      <nav>Start · Politik · Sport</nav>
      <main><article><h1 id="headline">Klare Berichte schreiben</h1><p id="body">Wer klar schreibt, wird verstanden. Dieser Artikel zeigt sieben Regeln.</p></article>
      <div class="ad-banner" id="ad">Anzeige: 30 % auf Reisen</div>
      <aside class="article-context" id="context">Hintergrund: Quellen und Methoden dieses Artikels.</aside>
      <section id="comments"><article class="comment"><p>Anna: Sehr hilfreich!</p></article><form><textarea name="reply" aria-label="Antwort"></textarea></form></section>
      <div class="outbrain-widget" id="outbrain">Das könnte dich auch interessieren: 10 Promis, die sich verändert haben</div></main>
      <div id="cookie-consent" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:20px">Wir nutzen Cookies. <button>Akzeptieren</button> <button>Ablehnen</button></div>
      </body>`);
    return;
  }
  if (req.url.startsWith('/locked')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOCKED_PAGE);
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
manifest.host_permissions.push('http://127.0.0.1/*', 'https://*/*', 'http://*/*');
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
const LOCKED = `<!doctype html><title>Gesperrte Seite</title><style>body{user-select:none;-webkit-user-select:none}</style><body oncontextmenu="return false"><p id=t>Diesen Text darf man nicht kopieren.</p><script>window.__blocked=0;document.addEventListener('copy',(e)=>{e.preventDefault();window.__blocked++;});document.addEventListener('contextmenu',(e)=>e.preventDefault());</script></body>`;
await context.route(/^https:\/\/(?!openrouter)/, (route) => {
  if (route.request().url().includes('locked-test')) {
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: LOCKED });
    return;
  }
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

// Die Tests prüfen deutsche Texte. Chrome for Testing läuft oft auf Englisch, deshalb fest Deutsch.
await worker.evaluate(() => chrome.storage.local.set({ uiLanguage: 'de' }));

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
const learnedGroups = await popup.evaluate(async () => ((await chrome.storage.local.get('learnLog')).learnLog || []).filter((e) => e.f === 'groups'));
check('Lernen: Gruppen-Entscheidungen lokal gemerkt', learnedGroups.length > 0 && learnedGroups.every((e) => typeof e.ok === 'boolean' && e.title), `${learnedGroups.length} Einträge`);

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
// Die Quellen laden im Hintergrund nach. Kurz warten, bis der Treffer steht.
await palette.waitForFunction(() => /tabwerk/i.test(document.querySelector('#list .item .title')?.textContent || ''), null, { timeout: 2000 }).catch(() => {});
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

// Geschlossene Tabs: Aktionen mit alter Tab-ID dürfen nicht abbrechen
{
  const gone = await context.newPage();
  await gone.goto('about:blank');
  const goneId = await popup.evaluate(async () => (await chrome.tabs.query({ url: 'about:blank' })).at(-1)?.id);
  await gone.close();
  const res = await call('closeTabs', { tabIds: [goneId], windowId: null });
  check('Schließen mit schon geschlossenem Tab bricht nicht ab', res.closed === 0 && res.gone === 1, JSON.stringify(res));
  const focus = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'focusTab', payload: { tabId: id } }), goneId);
  check('Wechsel zu geschlossenem Tab meldet verständlichen Fehler', !focus.ok && /schon geschlossen/.test(focus.error), focus.error);
}

// Sprache: Englisch einstellen, dann zurück auf Deutsch
{
  const textsIn = async (lang) => {
    await popup.evaluate((l) => chrome.storage.local.set({ uiLanguage: l }), lang);
    await popup.reload();
    await popup.waitForSelector('[data-panel=find]');
    return popup.evaluate(() => ({ lang: document.documentElement.lang, find: document.querySelector('[data-panel=find]').textContent.trim(), keys: document.body.innerText.match(/\b[a-z]+_[a-zA-Z0-9_]+\b/g) || [] }));
  };
  const en = await textsIn('en');
  const de = await textsIn('de');
  check('Sprache Englisch: Popup wechselt die Sprache', en.lang === 'en' && de.lang === 'de' && en.find !== de.find, `${en.find} / ${de.find}`);
  check('Sprache: keine rohen Schlüssel im Popup', !en.keys.length && !de.keys.length, [...en.keys, ...de.keys].slice(0, 5).join(', '));
  const menu = await worker.evaluate(async () => {
    await chrome.storage.local.set({ uiLanguage: 'en' });
    await new Promise((r) => setTimeout(r, 400));
    const { i18nProbe } = await chrome.storage.session.get('i18nProbe');
    await chrome.storage.local.set({ uiLanguage: 'de' });
    await new Promise((r) => setTimeout(r, 400));
    return i18nProbe || null;
  });
  if (menu) check('Sprache: Service Worker lädt die neue Sprache', menu === 'en', menu);
}

// Schalter: ausgeschaltete Funktion verschwindet aus dem Popup
await setFeatures({ find: false });
await popup.reload();
// Das Popup lädt erst Sprache und Einstellungen. Kurz warten, bis es fertig ist.
await popup.waitForSelector('[data-panel=find]', { state: 'hidden', timeout: 3000 }).catch(() => {});
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
await noteWin.waitForFunction(() => document.querySelector('#text')?.value, null, { timeout: 3000 }).catch(() => {});
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
// Die erste Prüfung nach dem Anlegen kann mit echtem Jev noch laufen. Dann kurz warten.
let numAfter;
for (let i = 0; i < 30; i++) {
  numAfter = await call('checkWatch', { id: numWatch.id });
  if (!numAfter.busy) break;
  await popup.waitForTimeout(500);
}
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

// Formulare: mit Schalter auch geschützte Felder
await setFeatures({ formsSensitive: true });
await form.reload();
await form.fill('#vn', 'Max');
await form.fill('#pw', 'geheim456');
await form.fill('#iban', 'DE89370400440532013000');
const savedAll = await call('saveForm', { windowId: formWin });
const allNames = savedAll.profile.fields.map((f) => f.name || f.id);
check('Formular mit Schalter: Passwort und IBAN gespeichert und markiert', allNames.includes('pw') && allNames.includes('iban') && savedAll.profile.fields.find((f) => f.name === 'pw').sensitive === true, allNames.join(','));
await form.reload();
await call('fillForm', { windowId: formWin, profileId: savedAll.profile.id });
check('Formular mit Schalter: Passwort kommt zurück', (await form.inputValue('#pw')) === 'geheim456');
await form.reload();
await call('fillTestData', { windowId: formWin });
check('Testdaten mit Schalter: Beispiel-IBAN im IBAN-Feld', (await form.inputValue('#iban')) === 'DE89370400440532013000');
await setFeatures({ formsSensitive: false });
await form.close();

// Kopieren erlauben: für einen Tab
const blockedState = (p) => p.evaluate(() => {
  const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  document.getElementById('t').dispatchEvent(menu);
  const copy = new ClipboardEvent('copy', { bubbles: true, cancelable: true });
  document.getElementById('t').dispatchEvent(copy);
  return { menuBlocked: menu.defaultPrevented, copyBlocked: copy.defaultPrevented, select: getComputedStyle(document.body).userSelect };
});
const locked = await context.newPage();
await locked.goto(`${local}/locked`);
const lockedBefore = await blockedState(locked);
check('Gesperrte Testseite sperrt wirklich', lockedBefore.menuBlocked && lockedBefore.copyBlocked && lockedBefore.select === 'none', JSON.stringify(lockedBefore));
const lockedTab = await popup.evaluate(async () => (await chrome.tabs.query({})).find((t) => (t.url || '').includes('/locked')).id);
await call('unlockTab', { tabId: lockedTab });
const lockedAfter = await blockedState(locked);
check('Kopieren erlauben: Rechtsklick, Kopieren und Markieren gehen', !lockedAfter.menuBlocked && !lockedAfter.copyBlocked && lockedAfter.select === 'text', JSON.stringify(lockedAfter));
await locked.close();

// Kopieren erlauben: immer auf einer Website
await call('setAlwaysUnlock', { host: 'locked-test.example', on: true });
const always = await context.newPage();
await always.goto('https://www.locked-test.example/artikel');
const alwaysState = await blockedState(always);
check('Kopieren immer erlaubt: gilt direkt beim Laden', !alwaysState.menuBlocked && !alwaysState.copyBlocked, JSON.stringify(alwaysState));
await call('setAlwaysUnlock', { host: 'locked-test.example', on: false });
await always.reload();
check('Kopieren immer erlaubt: wieder aus', (await blockedState(always)).menuBlocked);
await always.close();

// Schnellsuche: /N speichert eine Notiz zum aktiven Tab
const noteTarget = await context.newPage();
await noteTarget.goto('https://www.spiegel.de/notiz-test');
const noteWinId = await popup.evaluate(async () => (await chrome.tabs.query({})).find((t) => (t.url || '').includes('notiz-test')).windowId);
const pal3 = await context.newPage();
await pal3.goto(`chrome-extension://${id}/src/palette/palette.html?standalone=1&win=${noteWinId}`);
await noteTarget.bringToFront();
await pal3.waitForSelector('#list .item');
await pal3.fill('#q', '/N');
check('/N ohne Text bietet das Notiz-Fenster an', /Notiz-Fenster/.test(await pal3.textContent('#list .item .title')));
await pal3.fill('#q', '/N Angebot bis Freitag prüfen');
check('/N mit Text zeigt die Notiz als Treffer', /Angebot bis Freitag/.test(await pal3.textContent('#list .item .title')));
await pal3.press('#q', 'Enter');
await pal3.waitForTimeout(500);
const quick = await call('getNote', { url: 'https://www.spiegel.de/notiz-test' });
check('/N speichert die Notiz ohne Fenster', quick?.text === 'Angebot bis Freitag prüfen', quick?.text);
if (!pal3.isClosed()) await pal3.close();
await noteTarget.close();

// Verlauf: Fenster als gepackte Blöcke, unveränderte Fenster nur einmal
const store = await popup.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const snaps = Object.keys(all).filter((k) => k.startsWith('hist:'));
  const blocks = Object.keys(all).filter((k) => k.startsWith('hwin:'));
  const newest = all[snaps.sort().at(-1)];
  return { snaps: snaps.length, blocks: blocks.length, refsOnly: newest.windows.every((w) => w.block && !w.tabs), windows: newest.windows.length };
});
check('Verlauf speichert Fenster als Blöcke', store.refsOnly && store.blocks > 0, JSON.stringify(store));
check('Verlauf: weniger Blöcke als Fenster in allen Sicherungen', store.blocks < store.snaps * store.windows, `${store.blocks} Blöcke, ${store.snaps} Sicherungen`);
// Altes Format wird umgebaut
await popup.evaluate(async () => {
  const idx = (await chrome.storage.local.get('histIndex')).histIndex;
  const old = { id: '1000', t: Date.now() - 3600e3, reason: 'Altformat', sig: 'x', windows: [{ id: 1, focused: true, incognito: false, state: 'normal', tabs: [{ id: 1, url: 'https://example.com/alt', title: 'Alt', pinned: false, active: true, groupId: -1 }], groups: [] }] };
  await chrome.storage.local.set({ 'hist:1000': old, histIndex: [...idx, { id: '1000', t: old.t, reason: 'Altformat', sig: 'x', windows: 1, tabs: 1, groups: 0 }].sort((a, b) => b.t - a.t) });
});
const compacted = await call('compactHistory');
const oldBack = await call('getSnapshot', { id: '1000' });
check('Altes Verlaufsformat wird umgebaut und bleibt lesbar', compacted.compacted >= 1 && oldBack.windows[0].tabs[0].url === 'https://example.com/alt', JSON.stringify(compacted));

// Lernen: Regelvorschlag, gelernte Schwelle, Beispiele an Jev, Daumen beim Wächter
{
  await call('clearLearn');
  const same = Array.from({ length: 3 }, (_, i) => ({ f: 'groups', host: 'lerntest.example', title: `Lerntest ${i}`, jev: 'Arbeit', user: 'Recherche', conf: 0.6, ok: false }));
  const sure = Array.from({ length: 12 }, (_, i) => ({ f: 'groups', host: 'sicher.example', title: `Sicher ${i}`, jev: 'Arbeit', user: 'Arbeit', conf: 0.62, ok: true }));
  await call('learnRecord', { events: [...same, ...sure] });
  const rules = await call('learnRules');
  check('Lernen: Regel nach drei gleichen Korrekturen', rules.some((r) => r.rule === 'lerntest.example = Recherche'), rules.map((r) => r.rule).join(', '));
  await call('acceptRule', { rule: 'lerntest.example = Recherche' });
  const afterRule = await popup.evaluate(async () => (await chrome.storage.local.get('groupRules')).groupRules || []);
  check('Lernen: übernommene Regel steht in den Regeln', afterRule.includes('lerntest.example = Recherche'));
  check('Lernen: Regel wird danach nicht mehr vorgeschlagen', !(await call('learnRules')).some((r) => r.host === 'lerntest.example'));
  const state = await call('learnState');
  check('Lernen: Schwelle für Gruppen gelernt', state.per.groups.learned?.threshold === 0.65, JSON.stringify(state.per.groups.learned));
  await call('proposeGroups', { windowId: win1, onlyUngrouped: false }).catch(() => null);
  const past = lastJevBody?.state?.past_choices || [];
  check('Lernen: frühere Zuordnungen gehen als Beispiele an Jev', past.length > 0 && past.length <= 8 && /past_choices/.test(JSON.stringify(lastJevBody.questions)), `${past.length} Beispiele`);
  await setFeatures({ learnExamples: false });
  await call('proposeGroups', { windowId: win1, onlyUngrouped: false }).catch(() => null);
  check('Lernen: ohne Schalter keine Beispiele an Jev', !lastJevBody?.state?.past_choices);
  await setFeatures({ learnExamples: true });
  const judged = (await call('listWatches')).map((w) => ({ w, e: w.history?.find((x) => typeof x.p === 'number') })).find((x) => x.e);
  if (judged) {
    await call('watchFeedback', { id: judged.w.id, t: judged.e.t, ok: false });
    const log = await popup.evaluate(async () => ((await chrome.storage.local.get('learnLog')).learnLog || []).filter((e) => e.f === 'watch'));
    check('Lernen: Daumen beim Wächter gemerkt', log.length === 1 && log[0].ok === false && typeof log[0].truth === 'boolean');
  } else check('Lernen: Daumen beim Wächter gemerkt', false, 'kein bewerteter Wächter');
  const jsonl = await call('learnJsonl');
  check('Lernen: Export als JSONL', jsonl.trim().split('\n').length === 16, `${jsonl.trim().split('\n').length} Zeilen`);
}

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

// ---------- Seite aufräumen ----------

await setFeatures({ declutter: true, declutterAuto: false });
await popup.waitForTimeout(600);
const registered = await popup.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
check('Aufräumen: Seitenskript beim Einschalten angemeldet', registered.includes('tabwerk-declutter'), registered.join(','));
const clutterWin = await popup.evaluate(async (url) => (await chrome.windows.create({ url })).id, `${local}/clutter/artikel-eins`);
await popup.waitForTimeout(1500);
const clutter = context.pages().find((p) => p.url().includes('/clutter/artikel-eins'));
const shown = (sel) => clutter.evaluate((s) => { const el = document.querySelector(s); return Boolean(el) && getComputedStyle(el).display !== 'none'; }, sel);
const clutterTab = await popup.evaluate(async (w) => (await chrome.tabs.query({ windowId: w }))[0].id, clutterWin);
const callsBefore = jevCalls;
const analyzed = await call('declutterAnalyze', { tabId: clutterTab });
await clutter.waitForTimeout(500);
check('Aufräumen: Analyse speichert Regeln', analyzed.rules >= 2, `${analyzed.rules} Regeln, ${jevCalls - callsBefore} Anfragen`);
check('Aufräumen: Werbung ausgeblendet', !(await shown('#ad')));
check('Aufräumen: Cookie-Banner ausgeblendet, nichts geklickt', !(await shown('#cookie-consent')));
check('Aufräumen: Überschrift und Artikel bleiben', (await shown('#headline')) && (await shown('#body')));
check('Aufräumen: Hintergrund-Kasten bleibt', await shown('#context'));
check('Aufräumen: Kommentare bleiben, solange die Kategorie aus ist', await shown('#comments'));
const sentBody = JSON.stringify(lastJevBody || {});
check('Aufräumen: keine Adresse und kein Artikeltext an Jev', !sentBody.includes('127.0.0.1') && !sentBody.includes('sieben Regeln'));

await popup.evaluate(() => chrome.storage.local.set({ declutterHidden: ['ad', 'cookie', 'promotion', 'newsletter', 'social', 'comments', 'related'] }));
await clutter.waitForTimeout(800);
check('Aufräumen: Kommentare verschwinden nach dem Einschalten der Kategorie', !(await shown('#comments')));
check('Aufräumen: Empfehlungen verschwinden nach dem Einschalten der Kategorie', !(await shown('#outbrain')));

// Gleicher Seitentyp: Regeln gelten ohne neue Anfrage.
const callsReuse = jevCalls;
await clutter.goto(`${local}/clutter/artikel-zwei`);
await clutter.waitForTimeout(1200);
check('Aufräumen: gleicher Seitentyp ohne neue Jev-Anfrage aufgeräumt', !(await shown('#ad')) && jevCalls === callsReuse, `${jevCalls - callsReuse} Anfragen`);

// Wieder einblenden: sichtbar und als Lern-Ereignis gemerkt.
await call('declutterRule', { tabId: clutterTab, selector: 'div.ad-banner', enabled: false });
await clutter.waitForTimeout(500);
check('Aufräumen: Häkchen weg blendet wieder ein', await shown('#ad'));
const dcLearn = await popup.evaluate(async () => ((await chrome.storage.local.get('learnLog')).learnLog || []).filter((e) => e.f === 'declutter'));
check('Aufräumen: Wiedereinblenden als Korrektur gelernt', dcLearn.some((e) => e.ok === false && e.jev === 'ad'), `${dcLearn.length} Ereignisse`);
const dcThreshold = await popup.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'learnState' })).data.per.declutter.fallback);
check('Aufräumen: Schwelle startet bei 90 %', dcThreshold === 0.9, String(dcThreshold));

// Popup: Bereich „Seite“ für den aktiven Tab im Aufräum-Fenster.
const dcPopupTab = await popup.evaluate(async ([w, url]) => (await chrome.tabs.create({ windowId: w, url, active: false })).id, [clutterWin, `chrome-extension://${id}/src/popup/popup.html`]);
await popup.waitForTimeout(800);
const dcPopup = context.pages().find((p) => p.url().endsWith('/src/popup/popup.html') && p !== popup);
dcPopup.on('pageerror', (e) => errors.push(e.message));
await dcPopup.setViewportSize({ width: 408, height: 600 });
await dcPopup.click('[data-panel=page]');
await dcPopup.waitForSelector('.dc-card');
const dcText = await dcPopup.textContent('#panel-page');
check('Popup: Bereich Seite zeigt Status und Regeln', /Gespeichert/.test(dcText) && /Regel/.test(dcText), dcText.replace(/\s+/g, ' ').slice(0, 80));
await dcPopup.screenshot({ path: join(out, '10-seite-aufraeumen.png') });
const stripOverflow = await dcPopup.evaluate(() => document.querySelector('.strip').scrollWidth > document.querySelector('.strip').clientWidth + 1);
check('Popup: Reiter passen auch mit „Seite“ in die Leiste', !stripOverflow);
await popup.evaluate((t) => chrome.tabs.remove(t), dcPopupTab);

// Nie aufräumen: nichts mehr ausgeblendet, danach wieder erlaubt.
await call('declutterRule', { tabId: clutterTab, selector: 'div.ad-banner', enabled: true });
await call('declutterNever', { host: '127.0.0.1', on: true });
await clutter.waitForTimeout(600);
check('Aufräumen: „Nie aufräumen“ zeigt alles wieder', (await shown('#cookie-consent')) && (await shown('#ad')));
await call('declutterNever', { host: '127.0.0.1', on: false });
await clutter.waitForTimeout(600);
check('Aufräumen: wieder erlaubt blendet erneut aus', !(await shown('#ad')));

// Schnellsuche kennt den Befehl.
const dcActions = await call('paletteActions');
check('Schnellsuche: Befehl „Seite aufräumen“', dcActions.some((a) => a.id === 'declutter.page' && a.jev));

// Ausschalten: Skript abgemeldet, Seite frei.
await setFeatures({ declutter: false });
await popup.waitForTimeout(800);
const afterOff = await popup.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
check('Aufräumen: Ausschalten meldet das Skript ab und zeigt alles', !afterOff.includes('tabwerk-declutter') && (await shown('#ad')));
await popup.evaluate((w) => chrome.windows.remove(w), clutterWin);

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
