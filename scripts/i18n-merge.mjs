// Führt Teil-Dateien aus i18n-parts/*.json in _locales/<sprache>/messages.json zusammen.
// Für neue Texte: Teil-Datei anlegen, npm run i18n, Teil-Datei wieder löschen. _locales ist die Quelle.
// Format einer Teil-Datei: { "schluessel": { "de": "…", "en": "…", "description": "…" } }
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const langs = ['de', 'en'];
const out = Object.fromEntries(langs.map((l) => {
  const file = `${root}_locales/${l}/messages.json`;
  return [l, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}];
}));
const seen = new Map();
let problems = 0;
const parts = existsSync(`${root}i18n-parts`) ? readdirSync(`${root}i18n-parts`).filter((f) => f.endsWith('.json')).sort() : [];
for (const name of parts) {
  const part = JSON.parse(readFileSync(`${root}i18n-parts/${name}`, 'utf8'));
  for (const [key, entry] of Object.entries(part)) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) { console.error(`${name}: ungültiger Schlüssel ${key}`); problems++; continue; }
    const low = key.toLowerCase();
    if (seen.has(low) && seen.get(low).file !== name && seen.get(low).de !== entry.de) {
      console.error(`${name}: ${key} gibt es schon in ${seen.get(low).file} mit anderem Text`);
      problems++;
    }
    seen.set(low, { file: name, de: entry.de });
    for (const l of langs) {
      if (typeof entry[l] !== 'string' || !entry[l]) { console.error(`${name}: ${key} fehlt ${l}`); problems++; continue; }
      // Chrome liest $…$ als benannten Platzhalter. Ohne Definition lädt die ganze Extension nicht.
      if (/\$[A-Za-z0-9_]+\$/.test(entry[l]) && !entry.placeholders) { console.error(`${name}: ${key} hat $…$ ohne Platzhalter-Definition, etwa $1$2`); problems++; }
      out[l][key] = { message: entry[l], ...(entry.description ? { description: entry.description } : {}) };
    }
  }
}
for (const l of langs) {
  const sorted = Object.fromEntries(Object.entries(out[l]).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(`${root}_locales/${l}/messages.json`, `${JSON.stringify(sorted, null, 2)}\n`);
}
console.log(`${Object.keys(out.de).length} Texte je Sprache${problems ? `, ${problems} Probleme` : ''}`);
process.exit(problems ? 1 : 0);
