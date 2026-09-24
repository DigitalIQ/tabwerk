// Zahlen und Preise auf einer Seite finden und exakt vergleichen. Reiner Code.
// Jev wählt nur aus, welche Fundstelle gemeint ist.

// "1.299,00", "1,299.00", "189,99", "189.99", "1299"
export function parseNumber(raw) {
  let s = String(raw).replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else if (lastDot > lastComma && lastComma !== -1) s = s.replace(/,/g, '');
  else if (lastComma === -1 && lastDot !== -1 && s.length - lastDot - 1 === 3 && s.split('.').length >= 2) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const CURRENCY = '(?:€|EUR|\\$|USD|£|GBP|CHF)';
const NUM = '\\d{1,3}(?:[.,\\s]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?';
const PATTERN = new RegExp(`(?:${CURRENCY}\\s?(${NUM}))|(?:(${NUM})\\s?${CURRENCY})|(${NUM})\\s?%`, 'g');

// Liefert Fundstellen mit etwas Text drumherum, damit Jev die richtige wählen kann.
export function numberCandidates(text, limit = 40) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split('\n')) {
    PATTERN.lastIndex = 0;
    let m;
    while ((m = PATTERN.exec(line)) && out.length < limit) {
      const raw = m[1] || m[2] || m[3];
      const value = parseNumber(raw);
      if (value === null) continue;
      const context = line.slice(Math.max(0, m.index - 60), m.index + m[0].length + 40).trim();
      const key = `${value}|${context}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ value, match: m[0].trim(), context });
    }
  }
  return out;
}

export function compare(value, op, limit) {
  if (typeof value !== 'number' || typeof limit !== 'number') return false;
  if (op === 'below') return value < limit;
  if (op === 'atmost') return value <= limit;
  if (op === 'above') return value > limit;
  if (op === 'atleast') return value >= limit;
  return false;
}
