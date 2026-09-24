// Erzeugt Screenshots (1280x800) und das kleine Werbebild (440x280) für den Chrome Web Store.
// Grundlage sind die Bilder aus test-results/, also vorher npm run e2e ausführen.
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { chromePath } from './chrome.mjs';

const root = new URL('..', import.meta.url).pathname;
const results = `${root}test-results`;
const out = `${root}store/images`;
mkdirSync(out, { recursive: true });
const b64 = (file) => readFileSync(file).toString('base64');
const font = b64(`${root}assets/fonts/Geist-Variable.woff2`);
const logo = b64(`${root}icons/icon128.png`);

const css = `
@font-face { font-family: Geist; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
body { width: 1280px; height: 800px; font-family: Geist, sans-serif; background: #eceff3; color: #14181d; overflow: hidden; }
.wrap { display: grid; grid-template-columns: 470px 1fr; height: 100%; }
.copy { padding: 96px 20px 0 80px; display: grid; align-content: start; gap: 18px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 650; font-size: 18px; }
.brand img { width: 28px; height: 28px; }
h1 { font-size: 44px; line-height: 1.08; letter-spacing: -0.025em; font-weight: 680; }
p { font-size: 19px; line-height: 1.45; color: #4b5461; max-width: 25ch; }
.shot { display: grid; place-items: center; }
.shot img { border-radius: 14px; box-shadow: 0 30px 80px rgba(20,40,80,0.22), 0 2px 8px rgba(20,40,80,0.10); border: 1px solid #d6dce3; }
.full { width: 1280px; height: 800px; position: relative; }
.full > img { width: 1280px; height: 800px; display: block; }
.badge { position: absolute; left: 48px; bottom: 44px; background: rgba(20,24,29,0.88); color: #fff; padding: 16px 22px; border-radius: 12px; display: grid; gap: 4px; }
.badge b { font-size: 26px; font-weight: 650; letter-spacing: -0.01em; }
.badge span { font-size: 16px; color: #c9d1db; }
`;

const shots = [
  { name: '1-schnellsuche', full: '9c-schnellsuche-dunkle-seite.png', title: 'Schnellsuche über jeder Seite', text: 'Tabs, Aktionen, Lesezeichen und Verlauf. Per Tastenkürzel, ohne die Seite zu verlassen.' },
  { name: '2-gruppen', img: '3-gruppen-vorschlag.png', title: 'Tabs sortieren sich in Gruppen', text: 'Vorschläge mit sichtbarer Sicherheit. Unsicheres bleibt abgewählt, bis du es prüfst.' },
  { name: '3-aufraeumen', img: '11-aufraeumen-vorschlag.png', title: 'Aufräumen mit einem Klick', text: 'Alte und überflüssige Tabs erkennen, doppelte Seiten einzeln schließen.' },
  { name: '4-verlauf', img: '6-verlauf.png', title: 'Jeder Stand ist gesichert', text: 'Nach jeder Änderung eine Sicherung. Zurück zu jedem Stand, pro Fenster.' },
  { name: '5-waechter', img: '5-waechter.png', title: 'Seiten beobachten in Alltagssprache', text: '„Sag mir Bescheid, wenn der Kopfhörer wieder lieferbar ist.“ Auch mit exakten Preisgrenzen.' },
];

const browser = await chromium.launch({ executablePath: chromePath() });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
for (const s of shots) {
  const file = `${results}/${s.full || s.img}`;
  if (!existsSync(file)) { console.log('fehlt', file); continue; }
  const html = s.full
    ? `<div class="full"><img src="data:image/png;base64,${b64(file)}"><div class="badge"><b>${s.title}</b><span>${s.text}</span></div></div>`
    : `<div class="wrap"><div class="copy"><div class="brand"><img src="data:image/png;base64,${logo}">Tabwerk</div><h1>${s.title}</h1><p>${s.text}</p></div><div class="shot"><img src="data:image/png;base64,${b64(file)}" width="428"></div></div>`;
  await page.setContent(`<html><head><style>${css}</style></head><body>${html}</body></html>`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${out}/${s.name}.png` });
}

// Kleines Werbebild 440x280
await page.setViewportSize({ width: 440, height: 280 });
await page.setContent(`<html><head><style>${css}
body { width: 440px; height: 280px; background: #1f4fd8; color: #fff; }
.tile { height: 100%; display: grid; align-content: center; gap: 12px; padding: 0 40px; }
.tile .brand { font-size: 30px; gap: 14px; }
.tile .brand img { width: 52px; height: 52px; border-radius: 12px; box-shadow: 0 0 0 2px rgba(255,255,255,0.35); }
.tile p { color: #dbe4ff; font-size: 18px; max-width: 30ch; }
</style></head><body><div class="tile"><div class="brand"><img src="data:image/png;base64,${logo}">Tabwerk</div><p>Viele Tabs, klar geordnet. Mit Schnellsuche, Verlauf und Wächtern.</p></div></body></html>`);
await page.screenshot({ path: `${out}/promo-440x280.png` });
await browser.close();
console.log('Bilder in', out);
