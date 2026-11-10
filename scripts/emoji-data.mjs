// Mit `node scripts/emoji-data.mjs` den mitgelieferten Katalog aktualisieren.
import { writeFile } from 'node:fs/promises';

const unicode = 'https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt';
const cldr = 'https://raw.githubusercontent.com/unicode-org/cldr-json/48.2.0/cldr-json';

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return response;
}

async function annotations(language) {
  const sets = await Promise.all(['annotations', 'annotationsDerived'].map(async (key) => {
    const response = await download(`${cldr}/cldr-annotations${key.endsWith('Derived') ? '-derived' : ''}-full/${key}/${language}/annotations.json`);
    return (await response.json())[key].annotations;
  }));
  return Object.assign({}, ...sets);
}

const [test, english, german] = await Promise.all([
  download(unicode).then((response) => response.text()), annotations('en'), annotations('de'),
]);
const rows = [];
let group;
for (const match of test.matchAll(/^(?:# group: (\S+).*|[\dA-F ]+;\s*(?:fully-qualified|component)\s*# (\S+) E[\d.]+ (.+))$/gm)) {
  const [, heading, emoji, fallback] = match;
  if (heading) {
    group = heading.toLowerCase();
    continue;
  }
  const key = emoji.replaceAll('\uFE0F', '');
  const en = english[emoji] ?? english[key];
  const de = german[emoji] ?? german[key];
  const keywords = [...new Set([...(en?.default ?? []), ...(de?.default ?? [])])];
  rows.push([emoji, en?.tts?.[0] ?? fallback, de?.tts?.[0] ?? '', keywords, group]);
}
if (!rows.length) throw new Error('No Unicode emoji found');
await writeFile(new URL('../src/palette/emoji-data.json', import.meta.url), `[\n${rows.map((row) => JSON.stringify(row)).join(',\n')}\n]\n`);
console.log(`${rows.length} Unicode emoji`);
