import { normalize } from '../lib/fuzzy.js';

const words = (text) => normalize(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const withoutTone = (emoji) => emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
const sequenceKey = (emoji) => emoji.replaceAll('\uFE0F', '');
// Bei einigen Paaren nutzt Unicode für gemischte Hauttöne eine andere Grundsequenz.
const mixedToneBases = new Map([
  ['🫱‍🫲', '🤝'], ['🧑‍🐰‍🧑', '👯'], ['👨‍🐰‍👨', '👯‍♂'], ['👩‍🐰‍👩', '👯‍♀'],
  ['🧑‍🫯‍🧑', '🤼'], ['👨‍🫯‍👨', '🤼‍♂'], ['👩‍🫯‍👩', '🤼‍♀'],
  ['👩‍🤝‍👩', '👭'], ['👩‍🤝‍👨', '👫'], ['👨‍🤝‍👨', '👬'],
  ['🧑‍❤‍💋‍🧑', '💏'], ['🧑‍❤‍🧑', '💑'],
]);

export const emojiDefaultKey = (emoji) => `emojiDefault:${emoji}`;

export function indexEmojiVariants(catalog) {
  const bases = new Map(catalog.filter(({ emoji }) => withoutTone(emoji) === emoji).map((item) => [sequenceKey(item.emoji), item]));
  const index = new Map();
  for (const item of catalog) {
    const plain = withoutTone(item.emoji);
    if (plain === item.emoji || !plain) continue;
    const key = sequenceKey(plain);
    const base = bases.get(mixedToneBases.get(key) ?? key);
    if (!base) continue;
    const family = index.get(base.emoji) ?? { base, choices: [base] };
    family.choices.push(item);
    index.set(base.emoji, family);
    index.set(item.emoji, family);
  }
  return index;
}

export function preferredEmoji(family, defaults) {
  return family.choices.find(({ emoji }) => emoji === defaults[emojiDefaultKey(family.base.emoji)]) ?? family.base;
}

export function emojiTiles(matches, index, defaults, { query = '', keepUsedTone = false } = {}) {
  const search = query.trim().replace(/:$/, '').trim();
  const found = new Set(matches.map(({ emoji }) => emoji));
  const seen = new Set();
  return matches.flatMap((item) => {
    const family = index.get(item.emoji);
    if (!family) return [item];
    if (seen.has(family.base.emoji)) return [];
    seen.add(family.base.emoji);
    // Eine gezielte Suche kann einen anderen Hautton anzeigen als den gespeicherten.
    if (search && item !== family.base && (item.emoji === search || !found.has(family.base.emoji))) return [item];
    if (keepUsedTone && !defaults[emojiDefaultKey(family.base.emoji)]) return [item];
    return [preferredEmoji(family, defaults)];
  });
}

export async function loadEmoji(language) {
  const response = await fetch(new URL('./emoji-data.json', import.meta.url));
  if (!response.ok) throw new Error(`Emoji catalog: ${response.status}`);
  const rows = await response.json();
  return rows.map(([emoji, en, de, keywords, group]) => {
    const names = [words(en), words(de)].filter(Boolean);
    const terms = [...new Set([...names, ...keywords.map(words)].filter(Boolean))];
    return {
      kind: 'emoji', emoji, group, title: language === 'de' ? de || en : en,
      compactNames: names.map((name) => name.replaceAll(' ', '')),
      terms, numericAliases: keywords.filter((term) => /^[+-]\d+$/.test(term)),
    };
  });
}

export function searchEmoji(catalog, raw) {
  const query = raw.trim().replace(/:$/, '').trim();
  if (!query) return catalog;
  const normalized = words(query);
  const compact = normalized.replaceAll(' ', '');
  const tokens = normalized.split(' ');
  const matches = [[], [], [], []];
  for (const item of catalog) {
    if (item.emoji === query || item.numericAliases.includes(query) || (compact && item.compactNames.includes(compact))) matches[0].push(item);
    else if (normalized && item.terms.includes(normalized)) matches[1].push(item);
    else if (compact && (item.compactNames.some((name) => name.startsWith(compact))
      || tokens.every((token) => item.terms.some((term) => term.startsWith(token) || term.includes(` ${token}`))))) matches[2].push(item);
    else if (normalized && tokens.every((token) => item.terms.some((term) => term.includes(token)))) matches[3].push(item);
  }
  return matches.flat();
}
