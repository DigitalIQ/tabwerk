// Wie lange der Verlauf Sicherungen behält. Reine Funktion, in Node testbar.
//   letzte 24 Stunden: jede Sicherung, höchstens 400
//   bis 7 Tage:        eine pro Stunde
//   bis 90 Tage:       eine pro Tag
//   älter:             weg
// Sicherungen vor einer Tabwerk-Aktion zählen wie jede andere.

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const RECENT_MAX = 400;

export function planRetention(index, now = Date.now()) {
  const keep = [];
  const drop = [];
  const buckets = new Set();
  let recent = 0;
  for (const entry of index) {
    const age = now - entry.t;
    let ok;
    if (age <= DAY) ok = recent++ < RECENT_MAX;
    else if (age <= 7 * DAY) ok = !buckets.has(`h${Math.floor(entry.t / HOUR)}`) && buckets.add(`h${Math.floor(entry.t / HOUR)}`);
    else if (age <= 90 * DAY) ok = !buckets.has(`d${Math.floor(entry.t / DAY)}`) && buckets.add(`d${Math.floor(entry.t / DAY)}`);
    else ok = false;
    (ok ? keep : drop).push(entry);
  }
  return { keep, drop };
}
