// Unscharfe Suche für die Schnellsuche. Reiner Code, keine Jev-Anfrage.
// Jedes Wort der Eingabe muss vorkommen, als Teilwort oder als Buchstabenfolge mit Lücken.
// Ganze Treffer am Wortanfang zählen am meisten.

export function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const BOUNDARY = /[\s\-_./:?#&=|·–()[\]]/;

function tokenScore(token, text) {
  if (!token) return 0;
  const at = text.indexOf(token);
  if (at !== -1) {
    let score = 10 + token.length * 2;
    if (at === 0) score += 12;
    else if (BOUNDARY.test(text[at - 1])) score += 8;
    return score;
  }
  // Buchstabenfolge mit Lücken: "gbr" findet "GitHub Repo".
  // Jeder mögliche Startpunkt wird probiert, der beste zählt.
  let best = null;
  for (let start = text.indexOf(token[0]); start !== -1; start = text.indexOf(token[0], start + 1)) {
    const s = subsequence(token, text, start);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}

function subsequence(token, text, start) {
  let score = 0;
  let pos = start - 1;
  let run = 0;
  let good = 0;
  for (const ch of token) {
    const next = text.indexOf(ch, pos + 1);
    if (next === -1) return null;
    if (next === pos + 1 && pos >= start) {
      run += 1;
      good += 1;
      score += 2 + run;
    } else {
      run = 0;
      const boundary = next === 0 || BOUNDARY.test(text[next - 1]);
      if (boundary) good += 1;
      score += boundary ? 3 : 1;
      if (pos >= start) score -= Math.min(3, (next - pos - 1) / 8);
    }
    pos = next;
  }
  // Weit verstreute Buchstaben sind Zufall, außer sie sitzen an Wortanfängen wie bei „gh tw“.
  if (pos - start + 1 > token.length * 3 + 2 && good < Math.ceil(token.length / 2)) return null;
  return score > 0 ? score : null;
}

// Liefert null, wenn ein Wort fehlt, sonst eine Punktzahl. Höher ist besser.
export function fuzzyScore(query, text) {
  const q = normalize(query).trim();
  if (!q) return 0;
  const t = normalize(text);
  let total = 0;
  for (const token of q.split(/\s+/)) {
    const s = tokenScore(token, t);
    if (s === null) return null;
    total += s;
  }
  return total;
}

// Bewertet einen Eintrag über mehrere Felder. Titel zählt mehr als Adresse.
export function scoreItem(query, fields) {
  let best = null;
  for (const [text, weight] of fields) {
    const s = fuzzyScore(query, text);
    if (s !== null && (best === null || s * weight > best)) best = s * weight;
  }
  // Wörter dürfen auf Titel und Adresse verteilt sein, jedes Wort aber in einem Feld.
  if (best === null) {
    let total = 0;
    for (const token of normalize(query).trim().split(/\s+/)) {
      let tokenBest = null;
      for (const [text, weight] of fields) {
        const s = tokenScore(token, normalize(text));
        if (s !== null && (tokenBest === null || s * weight > tokenBest)) tokenBest = s * weight;
      }
      if (tokenBest === null) return null;
      total += tokenBest;
    }
    best = total * 0.7;
  }
  return best;
}

// Filter wie bei Omni: "/t", "/tabs", "/a", "/b", "/h" am Anfang.
const PREFIXES = {
  t: 'tab', tabs: 'tab', a: 'action', actions: 'action', b: 'bookmark', bookmarks: 'bookmark', h: 'history', history: 'history',
  n: 'note', notes: 'note', s: 'session', sessions: 'session', z: 'snooze', snooze: 'snooze', f: 'form', forms: 'form',
};

// "/N" mit großem N legt eine Notiz zum aktiven Tab an. "/n" sucht in Notizen.
export function parseQuery(raw) {
  const m = /^\/(\w+)\s*(.*)$/.exec(raw || '');
  if (m && m[1] === 'N') return { only: null, create: 'note', text: m[2] };
  if (m && PREFIXES[m[1].toLowerCase()]) return { only: PREFIXES[m[1].toLowerCase()], text: m[2] };
  return { only: null, text: raw || '' };
}
