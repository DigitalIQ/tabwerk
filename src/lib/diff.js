// Textvergleich für Wächter. Zeilenbasiert und reihenfolgeunabhängig:
// verschobene Blöcke zählen nicht als Änderung.

export const MAX_SNAPSHOT = 60000;
const MAX_LINES = 80;
const MAX_LINE = 300;

export function toLines(text) {
  return (text || '')
    .slice(0, MAX_SNAPSHOT)
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 1);
}

function counts(lines) {
  const map = new Map();
  for (const line of lines) map.set(line, (map.get(line) || 0) + 1);
  return map;
}

function minus(a, b) {
  const rest = counts(b);
  const out = [];
  for (const line of a) {
    const n = rest.get(line) || 0;
    if (n > 0) rest.set(line, n - 1);
    else out.push(line.length > MAX_LINE ? line.slice(0, MAX_LINE) + '…' : line);
  }
  return out;
}

export function diffLines(before, after) {
  const a = toLines(before);
  const b = toLines(after);
  const added = minus(b, a);
  const removed = minus(a, b);
  return {
    added: added.slice(0, MAX_LINES),
    removed: removed.slice(0, MAX_LINES),
    addedTotal: added.length,
    removedTotal: removed.length,
    changed: added.length + removed.length > 0,
  };
}

// Jev rechnet nicht zuverlässig. Bedingungen mit Zahlen bekommen einen Hinweis.
export function hasNumericCondition(text) {
  return /\d/.test(text || '') && /(unter|über|mehr|weniger|kleiner|größer|ab|bis|<|>|€|\$|%|prozent|preis)/i.test(text || '');
}
