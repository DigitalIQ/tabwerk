// Zeitangaben in Suchen wie „von letzter Woche“ in einen Zeitraum übersetzen.
// Datumsrechnung bleibt im Code, Jev bekommt nur die Treffer im Zeitraum.

const DAY = 864e5;

export function timeWindow(query, now = Date.now()) {
  const q = (query || '').toLowerCase();
  const start = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const today = start(now);
  if (/\bheute\b|\btoday\b/.test(q)) return { from: today, to: now, label: 'heute' };
  if (/\bgestern\b|\byesterday\b/.test(q)) return { from: today - DAY, to: today, label: 'gestern' };
  if (/vorgestern/.test(q)) return { from: today - 2 * DAY, to: today - DAY, label: 'vorgestern' };
  if (/letzte[nr]? woche|last week|vorige[nr]? woche/.test(q)) {
    const dow = (new Date(today).getDay() + 6) % 7;
    const thisMonday = today - dow * DAY;
    return { from: thisMonday - 7 * DAY, to: thisMonday, label: 'letzte Woche' };
  }
  if (/diese[nr]? woche|this week/.test(q)) {
    const dow = (new Date(today).getDay() + 6) % 7;
    return { from: today - dow * DAY, to: now, label: 'diese Woche' };
  }
  if (/letzte[nr]? monat|last month|vorige[nr]? monat/.test(q)) {
    const d = new Date(today);
    const from = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
    const to = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return { from, to, label: 'letzter Monat' };
  }
  const m = /vor (\d+) tagen|(\d+) days ago/.exec(q);
  if (m) {
    const n = Number(m[1] || m[2]);
    return { from: today - n * DAY - DAY, to: today - n * DAY + DAY, label: `vor ${n} Tagen` };
  }
  return { from: now - 90 * DAY, to: now, label: 'letzte 90 Tage' };
}
