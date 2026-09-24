// Prüft die Übersetzungen: gleiche Schlüssel in allen Sprachen, gleiche Platzhalter,
// und jeder feste Schlüssel aus dem Code steht in den Dateien.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const load = (l) => JSON.parse(readFileSync(join(root, '_locales', l, 'messages.json'), 'utf8'));
const langs = readdirSync(join(root, '_locales')).filter((d) => statSync(join(root, '_locales', d)).isDirectory());
const base = load('en');

function files(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(js|html)$/.test(f)) out.push(p);
  }
  return out;
}

test('alle Sprachen haben dieselben Schlüssel', () => {
  for (const l of langs) {
    const m = load(l);
    assert.deepEqual(Object.keys(m).sort(), Object.keys(base).sort(), `Sprache ${l}`);
  }
});

test('kein $…$ ohne Definition, sonst lädt Chrome die Extension nicht', () => {
  for (const l of langs) {
    for (const [k, v] of Object.entries(load(l))) {
      const named = [...v.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1].toLowerCase());
      const defined = Object.keys(v.placeholders || {}).map((n) => n.toLowerCase());
      for (const n of named) assert.ok(defined.includes(n), `${l}: ${k} nutzt $${n}$`);
    }
  }
});

test('Platzhalter $1 bis $9 stimmen überein', () => {
  const marks = (s) => [...new Set(s.match(/\$\d/g) || [])].sort().join();
  for (const l of langs) {
    const m = load(l);
    for (const [k, v] of Object.entries(base)) assert.equal(marks(m[k].message), marks(v.message), `${l}: ${k}`);
  }
});

test('jeder feste Schlüssel aus dem Code existiert', () => {
  const keys = new Set(Object.keys(base).map((k) => k.toLowerCase()));
  const missing = [];
  // i18n.js selbst nennt Beispielschlüssel in Kommentaren.
  const ext = ['manifest.json', ...files(join(root, 'src')).filter((f) => !f.endsWith('/lib/i18n.js'))];
  for (const f of ext) {
    const text = readFileSync(f.startsWith('/') ? f : join(root, f), 'utf8');
    for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) if (!keys.has(m[1].toLowerCase())) missing.push(`${f}: ${m[1]}`);
    for (const m of text.matchAll(/\btp\(\s*'([A-Za-z0-9_]+)'/g)) if (!keys.has(`${m[1]}_other`.toLowerCase())) missing.push(`${f}: ${m[1]}_other`);
    for (const m of text.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)) if (!keys.has(m[1].toLowerCase())) missing.push(`${f}: ${m[1]}`);
    for (const m of text.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) if (!keys.has(m[1].toLowerCase())) missing.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(missing, []);
});

// Eine Variable namens t verdeckt die Übersetzungsfunktion. Dann meldet Chrome „t is not a function“.
test('keine Variable t, wo t() übersetzt', () => {
  const bad = [];
  for (const f of files(join(root, 'src'))) {
    if (!f.endsWith('.js') || f.endsWith('/lib/i18n.js')) continue;
    const text = readFileSync(f, 'utf8');
    if (!/import \{[^}]*\bt\b[^}]*\} from '[^']*i18n\.js'/.test(text)) continue;
    for (const [n, line] of text.split('\n').entries()) {
      if (/\b(const|let|var) t\b|for \((const|let) t of|\(t(, \w+)?\) =>|\[t\] =|\.\.\.t\b/.test(line)) bad.push(`${f}:${n + 1}`);
    }
  }
  assert.deepEqual(bad, []);
});
