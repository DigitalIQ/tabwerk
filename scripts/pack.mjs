// Baut das ZIP für den Chrome Web Store: nur die Dateien, die die Extension zur Laufzeit braucht.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(`${root}manifest.json`, 'utf8'));
mkdirSync(`${root}dist`, { recursive: true });
const out = `${root}dist/tabwerk-${version}.zip`;
// Nur das aktuelle Paket bleibt liegen, damit beim Hochladen keine alte Version erwischt wird.
for (const f of readdirSync(`${root}dist`)) if (/^tabwerk-.*\.zip$/.test(f)) rmSync(`${root}dist/${f}`);
execFileSync('zip', ['-r', '-X', '-q', out, 'manifest.json', 'LICENSE', 'NOTICE', '_locales', 'src', 'assets', 'icons', '-x', '*.DS_Store'], { cwd: root });
const list = execFileSync('unzip', ['-l', out], { encoding: 'utf8' });
console.log(list.trim().split('\n').slice(-1)[0].trim(), '->', out);
