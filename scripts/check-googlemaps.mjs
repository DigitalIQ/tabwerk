// Isolierter Chrome-Test mit lokal beantworteten Google-URLs. Kein Google-Live-Nachweis.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromePath } from './chrome.mjs';

const root = new URL('..', import.meta.url).pathname;
mkdirSync(join(root, '.tmp'), { recursive: true });
const temp = mkdtempSync(join(root, '.tmp/maps-check-'));
const ext = join(temp, 'ext');
mkdirSync(ext);
for (const name of ['src', '_locales', 'icons', 'assets', 'packages', 'manifest.json']) cpSync(join(root, name), join(ext, name), { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
// Host-Rechte im Test vorab vergeben. Der echte Dialog bleibt Chromes Aufgabe.
manifest.host_permissions.push(...['com', 'de', 'at', 'ch'].map((domain) => `https://www.google.${domain}/*`));
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(join(temp, 'profile'), {
  executablePath: chromePath(), headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 1280, height: 800 },
});
const errors = [];
const requests = [];
const fixture = `<!doctype html><html lang="de"><meta charset="utf-8"><title>Google-Suche: lokale Testseite</title>
<style>
body { margin: 0; background: #fff; color: #202124; font: 14px Arial, sans-serif; }
header { padding: 28px 24px; } input { padding: 14px 24px; border: 1px solid #dadce0; border-radius: 30px; width: min(580px, 70vw); font: 16px Arial; }
nav { border-bottom: 1px solid #dadce0; overflow-x: auto; } [role=list] { display: flex; padding: 0 24px; width: max-content; gap: 8px; }
[role=listitem] { display: flex; } nav a, nav span.selected { display: inline-flex; align-items: center; padding: 16px 12px; text-decoration: none; color: #5f6368; font: 14px/20px Arial; }
nav a.nested, nav span.selected.nested { display: block; padding: 0; } .tab-label { display: inline-flex; align-items: center; padding: 16px 12px; font: 14px/20px Arial; }
nav a:hover { color: #1a73e8; } nav a:focus-visible { outline: 2px solid #1a73e8; outline-offset: -3px; } .selected { border-bottom: 3px solid #1a73e8; }
main { padding: 26px; max-width: 650px; line-height: 1.6; } h2 { color: #1a0dab; font-size: 20px; font-weight: normal; }
@media(prefers-color-scheme:dark) { body { background:#202124; color:#e8eaed; } nav a, nav span.selected { color:#bdc1c6; } nav { border-color:#5f6368; } h2 { color:#8ab4f8; } }
</style><header><input aria-label="Suche" value="Café &amp; Museum München"></header>
<nav id="hdtb-sc" role="navigation"><div role="list"><div role="listitem"><a class="nested" href="/search?q=test&udm=50"><div class="tab-label">KI-Modus</div></a></div><div role="listitem"><span class="selected nested"><span class="tab-label">Alle</span></span></div><div role="listitem"><a class="nested" href="/search?q=test&udm=2" data-ved="tracking" ping="https://example.invalid/track"><div class="tab-label"><span>Bilder</span></div></a></div><div role="listitem"><a class="nested" href="/search?q=test&udm=7"><div class="tab-label">Videos</div></a></div><div role="listitem"><a class="nested" href="/search?q=test&tbm=nws"><div class="tab-label">News</div></a></div><div role="listitem"><a class="nested" href="/search?q=test&udm=28"><div class="tab-label">Shopping</div></a></div></div></nav>
<main><h2>Lokale Testseite</h2><p>Die Navigation bildet typische Google-Strukturen nach. Sie ist keine gespeicherte Google-Seite.</p><a href="https://www.google.com/maps/place/Berlin">Maps-Link im Suchergebnis</a></main></html>`;
try {
  await context.route('https://**/*', async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  options.on('pageerror', (error) => errors.push(error.message));
  await options.goto(`chrome-extension://${id}/src/options/options.html`);
  await options.locator('#f-googleMaps').waitFor();
  assert.equal(await options.locator('#f-googleMaps').isChecked(), false);
  await options.locator('#f-googleMaps').check();
  await options.waitForFunction(() => document.querySelector('#saved').textContent.length > 0);
  assert.equal(await options.evaluate(async () => (await chrome.storage.local.get('features')).features.googleMaps), true);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const query = 'Café & Museum München #1 / +';
  await page.goto(`https://www.google.de/search?q=${encodeURIComponent(query)}`);
  const button = page.getByRole('link', { name: 'Google Maps', exact: true });
  await button.waitFor({ timeout: 10000 }).catch(async (error) => {
    console.error(JSON.stringify(await options.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.google.de/search*' });
      return {
        stored: await chrome.storage.local.get('features'),
        grants: await chrome.permissions.getAll(),
        url: tab.url,
        state: await chrome.runtime.sendMessage({ type: 'googleMapsState', payload: { url: tab.url } }),
        scripts: await chrome.scripting.getRegisteredContentScripts(),
        page: await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ loaded: !!window.__tabwerkGoogleMaps, nav: document.querySelector('nav')?.outerHTML }) }),
      };
    })));
    throw error;
  });
  assert.equal(new URL(await button.getAttribute('href')).searchParams.get('query'), query);
  assert.equal(await button.count(), 1);
  assert.equal(new URL(await button.getAttribute('href')).searchParams.get('api'), '1');
  await button.focus();
  assert.ok(await button.evaluate((el) => el === document.activeElement));
  console.log('PASS: Schalter, Registrierung, Sonderzeichen, Tastaturfokus und Ergebnis-Link');

  for (const [width, colorScheme] of [[1280, 'light'], [390, 'light'], [1280, 'dark']]) {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ colorScheme });
    await page.reload();
    await button.waitFor();
    const box = await button.boundingBox();
    assert.ok(box.width >= 40 && box.height >= 40);
    const geometry = await page.evaluate(() => {
      const links = [...document.querySelectorAll('nav a')];
      const maps = links.find((a) => a.textContent.trim() === 'Maps');
      const images = links.find((a) => a.textContent.trim() === 'Bilder');
      const baseline = (el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        range.selectNodeContents(walker.nextNode());
        return range.getBoundingClientRect().bottom;
      };
      return {
        order: [...document.querySelector('[role=list]').children].map((el) => el.textContent.trim()),
        baselineDifference: Math.abs(baseline(maps) - baseline(images)),
        heightDifference: Math.abs(maps.getBoundingClientRect().height - images.getBoundingClientRect().height),
        attributes: [...maps.attributes].map((attr) => attr.name),
      };
    });
    assert.deepEqual(geometry.order.slice(0, 4), ['KI-Modus', 'Alle', 'Maps', 'Bilder']);
    assert.ok(geometry.baselineDifference < 1, JSON.stringify(geometry));
    assert.ok(geometry.heightDifference < 1, JSON.stringify(geometry));
    assert.ok(!geometry.attributes.includes('ping') && !geometry.attributes.includes('data-ved'));
    const style = await button.evaluate((el) => ({ font: getComputedStyle(el).fontSize, color: getComputedStyle(el).color }));
    assert.equal(style.font, '14px');
    assert.equal(style.color, colorScheme === 'dark' ? 'rgb(189, 193, 198)' : 'rgb(95, 99, 104)');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.MAPS_SCREENSHOTS) {
      mkdirSync(process.env.MAPS_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.MAPS_SCREENSHOTS, `maps-${width}-${colorScheme}.png`) });
    }
  }
  console.log('PASS: direkt nach Alle, Text auf gleicher Höhe, verschachtelte Labels, Layout 1280/390 px, Hell/Dunkel, keine Tracking-Attribute');
  await page.evaluate(() => { history.pushState({}, '', '/search?q=Hamburg'); document.querySelector('main p').textContent = 'Neue Ergebnisse'; });
  await page.waitForFunction(() => document.querySelector('[aria-label="Google Maps"]')?.href.includes('query=Hamburg'));
  await page.evaluate(() => { const nav = document.querySelector('nav'); nav.replaceWith(nav.cloneNode(true)); });
  await page.waitForFunction(() => document.querySelectorAll('[data-tabwerk-google-maps]').length === 1);
  assert.equal(await button.count(), 1);
  await options.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.google.de/search*' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/googlemaps.js'] });
  });
  assert.equal(await button.count(), 1);
  console.log('PASS: Suchwechsel, ersetzte Navigation und wiederholte Injektion');

  await page.evaluate(() => { const a = document.createElement('a'); a.href = 'https://www.google.com/maps?query=Hamburg'; a.textContent = 'Maps'; a.id = 'native-maps'; document.querySelector('[role=list]').append(a); });
  await button.waitFor({ state: 'detached' });
  assert.equal(await page.locator('#native-maps').count(), 1);
  await page.locator('#native-maps').evaluate((el) => el.remove());
  await button.waitFor();
  await options.locator('#f-googleMaps').uncheck();
  await button.waitFor({ state: 'detached' });
  await options.locator('#f-googleMaps').check();
  await button.waitFor();
  console.log('PASS: vorhandener Maps-Link, Ausschalten und erneutes Einschalten ohne Reload');

  await page.evaluate(() => {
    document.querySelector('nav').outerHTML = '<nav id="hdtb-msb"><div class="hdtb-mitem"><a href="/search?q=Hamburg&tbm=isch">Bilder</a></div><div class="hdtb-mitem"><a href="/search?q=Hamburg&tbm=nws">News</a></div></nav>';
  });
  await button.waitFor();
  assert.equal(await button.evaluate((el) => el.parentElement.parentElement.id), 'hdtb-msb');
  await page.evaluate(() => document.querySelector('nav').remove());
  await button.waitFor({ state: 'detached' });
  await page.evaluate(() => {
    const nav = document.createElement('nav');
    nav.setAttribute('role', 'tablist');
    nav.innerHTML = '<a href="/search?q=Hamburg&udm=2">Bilder</a><a href="/search?q=Hamburg&udm=7">Videos</a>';
    document.querySelector('header').after(nav);
  });
  await button.waitFor();
  console.log('PASS: ältere Navigation und verzögert eingefügte Tab-Leiste');

  await button.click();
  await page.waitForURL('https://www.google.com/maps/search/**');
  assert.equal(new URL(page.url()).searchParams.get('query'), 'Hamburg');
  assert.equal(await button.count(), 0);
  await page.goto('https://www.google.de/search?q=');
  await options.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.google.de/search*' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/googlemaps.js'] });
  });
  assert.equal(await button.count(), 0);
  await page.goto('https://www.google.co.uk/search?q=London');
  assert.equal(await button.count(), 0);
  assert.ok(requests.every((url) => /^https:\/\/www\.google\.(de|com|co\.uk)\//.test(url)));
  assert.deepEqual(errors, []);
  console.log('PASS: echter Link-Klick, leere Suche, fremder Host, keine fremden Requests oder JS-Fehler');
} finally {
  await context.close();
  rmSync(temp, { recursive: true, force: true });
}
