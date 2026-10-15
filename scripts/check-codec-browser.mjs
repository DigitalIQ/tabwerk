// Lädt das geprüfte Extension-ZIP in ein eigenes Chrome-Profil, nur mit synthetischen Daten.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { chromePath } from './chrome.mjs';

if (!process.argv[2]) throw new Error('Pfad zur result.json aus test:distribution angeben.');
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const directory = dirname(process.argv[2]);
const context = await chromium.launchPersistentContext(join(directory, 'browser-profile'), {
  executablePath: chromePath(), headless: true,
  args: [`--disable-extensions-except=${result.extension}`, `--load-extension=${result.extension}`],
});
try {
  await context.route(/^https?:\/\//, (route) => route.abort());
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`chrome-extension://${id}/src/popup/popup.html`);
  const checks = await page.evaluate(async () => {
    const codec = await import('../../packages/session-codec/src/index.js');
    const legacy = await import('../lib/histstore.js');
    const history = await import('../lib/history.js');
    const w = { id: 17, focused: true, incognito: false, state: 'normal', tabs: [
      { id: 8, url: 'https://example.test/', title: 'Größe 漢字', active: true, pinned: false, groupId: -1 },
    ], groups: [] };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const { ref, block } = await codec.encodeWindow(w);
    const v1 = await codec.decodeWindow(ref, block);
    // Reihenfolge der Objektfelder ist keine semantische Gleichheit.
    const normalize = (x) => Array.isArray(x) ? x.map(normalize) : x && typeof x === 'object'
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, normalize(x[k])])) : x;
    const equal = (a, b) => same(normalize(a), normalize(b));
    const old = await legacy.splitWindow(w);
    const gzip = await legacy.gzip(old.body);
    const legacyRoundtrip = equal(await legacy.joinWindow(old.ref, gzip), w);
    const t = Date.now();
    const inline = { id: 'codec-inline-test', t, reason: 'manual', windows: [w] };
    await chrome.storage.local.set({
      histIndex: [{ id: inline.id, t, windows: 1, tabs: 1, groups: 0 }],
      [`hist:${inline.id}`]: inline,
      'hist:codec-block-test': { id: 'codec-block-test', t, windows: [old.ref] },
      [`hwin:${old.block}`]: gzip,
    });
    const oldBlockRead = equal((await history.getSnapshot('codec-block-test')).windows[0], w);
    const inlineRead = equal((await history.getSnapshot(inline.id)).windows[0], w);
    await history.compactHistory();
    const inlineMigrated = equal((await history.getSnapshot(inline.id)).windows[0], w);
    const written = await chrome.storage.local.get(`hist:${inline.id}`);
    return {
      v1Roundtrip: equal(v1, w), legacyRoundtrip, oldBlockRead, inlineRead, inlineMigrated,
      migrationUsesBlocks: Boolean(written[`hist:${inline.id}`].windows[0].block),
      browser: navigator.userAgent,
    };
  });
  for (const [name, value] of Object.entries(checks)) if (name !== 'browser') assert.equal(value, true, name);
  assert.deepEqual(pageErrors, [], 'Keine unbehandelten Popup-Fehler.');
  const report = { ...checks, pageErrors, extension: result.extension };
  writeFileSync(join(directory, 'browser-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close();
}
