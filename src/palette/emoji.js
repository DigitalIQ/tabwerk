import { normalize } from '../lib/fuzzy.js';

const words = (text) => normalize(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

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
