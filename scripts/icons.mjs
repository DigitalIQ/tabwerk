// Rendert das Tabwerk-Zeichen in die PNG-Größen, die Chrome braucht.
// Das Zeichen: drei Registerreiter, von kurz nach lang sortiert.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { chromePath } from './chrome.mjs';

const svg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <rect x="4" y="4" width="120" height="120" rx="28" fill="#1f4fd8"/>
  <g transform="translate(3 -4)">
  <path d="M28 44 a6 6 0 0 1 6 -6 h22 a6 6 0 0 1 6 6 v6 h-34 z" fill="#ffffff" opacity="0.55"/>
  <path d="M28 66 a6 6 0 0 1 6 -6 h36 a6 6 0 0 1 6 6 v6 h-48 z" fill="#ffffff" opacity="0.78"/>
  <path d="M28 88 a6 6 0 0 1 6 -6 h54 a6 6 0 0 1 6 6 v6 h-66 z" fill="#ffffff"/>
  <rect x="28" y="94" width="66" height="4" rx="2" fill="#ffffff"/>
  </g>
</svg>`;

const browser = await chromium.launch({ executablePath: chromePath() });
const page = await browser.newPage();
writeFileSync(new URL('../assets/logo.svg', import.meta.url), svg(128).trim() + '\n');
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(new URL(`../icons/icon${size}.png`, import.meta.url), png);
}
await browser.close();
console.log('icons ok');
