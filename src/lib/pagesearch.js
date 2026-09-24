// Seitensuche nach Bedeutung: reine Funktionen, in Node testbar.
// Die Seite liefert rohe Passagen (Absätze, Listenpunkte, Überschriften, Zitate, Tabellenzellen),
// Jev bewertet jede Passage und wählt pro Treffer den stärksten Satz. Tabwerk selbst
// zählt, kürzt, teilt Sätze und ordnet Sätze wieder ihrer Stelle im Text zu.

// Grenzen wie bei Needle: höchstens 160 Passagen, 60.000 Zeichen insgesamt,
// 2.200 Zeichen pro Passage. Zu große Passagen fallen ganz weg, nicht gekürzt,
// damit spätere Satz-Offsets immer zum Original passen.
export const MAX_PASSAGES = 160;
export const MAX_TOTAL_CHARS = 60000;
export const MAX_PASSAGE_CHARS = 2200;
// Ab dieser Relevanz zeigt Tabwerk einen Treffer.
export const RELEVANCE_THRESHOLD = 0.58;
// So viele Treffer bekommen einen Satz von Jev zugewiesen. Hält die Zahl der Anfragen klein.
export const MAX_RESULTS = 20;

// items: [{ tag, text }], roh aus der Seite, in der Reihenfolge, in der content.js sie
// gesammelt hat. Die Id `pN` ist der ursprüngliche Index, nicht die Position in der
// gekürzten Liste: content.js hält seine eigene Elementliste in derselben Reihenfolge
// und findet einen Treffer so über seinen Index wieder, auch wenn andere Passagen wegfallen.
// Fasst Weißraum zusammen, wirft leere und zu große Passagen weg und stoppt bei der Gesamtgrenze.
export function buildPassages(items) {
  const passages = [];
  let totalChars = 0;
  let omittedOversized = 0;
  let omittedLimit = 0;
  (items || []).forEach((raw, i) => {
    const text = String(raw?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (text.length > MAX_PASSAGE_CHARS) { omittedOversized += 1; return; }
    if (passages.length >= MAX_PASSAGES || totalChars + text.length > MAX_TOTAL_CHARS) { omittedLimit += 1; return; }
    passages.push({ id: `p${i}`, tag: raw?.tag || '', text });
    totalChars += text.length;
  });
  return { passages, omittedOversized, omittedLimit, totalChars };
}

// Teilt einen Text in Sätze, nach den Regeln der übergebenen Sprache.
export function splitSentences(text, locale = 'en') {
  if (!text) return [];
  let segmenter;
  try {
    segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  } catch {
    segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  }
  return [...segmenter.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
}

// Findet einen Satz im Passagentext wieder, als Zeichen-Offset. Sätze kommen aus
// splitSentences(text) und sind fast immer ein genauer Teilstring; getrimmt zur Sicherheit.
export function locateSentence(text, sentence) {
  if (!text || !sentence) return null;
  const idx = text.indexOf(sentence);
  if (idx !== -1) return { start: idx, end: idx + sentence.length };
  const trimmed = sentence.trim();
  if (!trimmed) return null;
  const idx2 = text.indexOf(trimmed);
  if (idx2 === -1) return null;
  return { start: idx2, end: idx2 + trimmed.length };
}

// answers: { [passageId]: { noul: number } }. Filtert nach Schwelle und sortiert nach Relevanz.
export function rankPassages(passages, answers, threshold = RELEVANCE_THRESHOLD) {
  return passages
    .map((p) => ({ ...p, relevance: answers?.[p.id]?.noul ?? 0 }))
    .filter((p) => p.relevance >= threshold)
    .sort((a, b) => b.relevance - a.relevance);
}
