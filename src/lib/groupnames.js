// Kandidaten für Gruppennamen aus Tab-Titeln und Websites. Jev wählt dann einen davon.

const STOP = new Set(('der die das und oder mit von für auf aus bei ist sind ein eine einer eines im in am an zu zum zur den dem des nicht wie was wer '
  + 'the and or with from for on of in at to a an is are how what why your you new home page login sign www com de org net html '
  + 'google docs youtube github amazon wikipedia outlook chrome').split(/\s+/));

export function nameCandidates(tabs, limit = 12) {
  const counts = new Map();
  const add = (word, weight) => {
    const w = word.trim();
    if (w.length < 3 || w.length > 24 || STOP.has(w.toLowerCase()) || /^\d+$/.test(w)) return;
    const key = w.toLowerCase();
    const prev = counts.get(key) || { word: w, n: 0 };
    prev.n += weight;
    counts.set(key, prev);
  };
  for (const t of tabs) {
    const seen = new Set();
    for (const word of (t.title || '').split(/[^\p{L}\p{N}-]+/u)) {
      if (!seen.has(word.toLowerCase())) add(word, 1);
      seen.add(word.toLowerCase());
    }
    try {
      const host = new URL(t.url).hostname.replace(/^www\./, '').split('.');
      if (host.length >= 2) add(host[host.length - 2], 0.5);
    } catch {}
  }
  return [...counts.values()]
    .filter((c) => c.n >= Math.min(2, tabs.length))
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((c) => c.word[0].toUpperCase() + c.word.slice(1));
}
