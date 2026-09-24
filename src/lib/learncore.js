// Lernen aus deinen Entscheidungen. Reine Funktionen, in Node testbar.
// Ein Ereignis: { f, t, host, title, jev, user, conf, ok }
//   f     Funktion: groups, cleanup, find, watch
//   jev   was Jev vorgeschlagen hat, user was du gewählt hast (Gruppenname, close/keep, …)
//   conf  Jevs Sicherheit (choice/score) oder Wahrscheinlichkeit (noul, bei watch)
//   ok    true, wenn du Jev gefolgt bist oder „passt“ gesagt hast
// Nichts davon verlässt den Rechner. Nur Beispiele für die Gruppenfrage gehen, wenn eingeschaltet, mit an Jev.

export const LOG_MAX = 1000;
export const MIN_EVENTS = 10;
export const TARGET_PRECISION = 0.9;
const GRID = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

export function append(log, events, max = LOG_MAX) {
  return [...events, ...log].slice(0, max);
}

// Schwelle für „ohne Nachfrage übernehmen“: die niedrigste Stufe, ab der Jev in deinen
// Entscheidungen zu mindestens 90 % richtig lag. Zu wenig Daten: null, dann gilt die Einstellung.
export function calibrate(events, { min = MIN_EVENTS, precision = TARGET_PRECISION } = {}) {
  const rated = events.filter((e) => typeof e.conf === 'number' && typeof e.ok === 'boolean');
  if (rated.length < min) return null;
  let lastTested = null;
  for (const t of GRID) {
    const above = rated.filter((e) => e.conf >= t);
    if (above.length < Math.ceil(min / 2)) continue;
    const right = above.filter((e) => e.ok).length;
    if (right / above.length >= precision) return { threshold: t, n: rated.length, precision: right / above.length };
    lastTested = t;
  }
  // Keine Stufe reicht: eine Stufe über der höchsten, bei der Jev zu oft danebenlag.
  if (lastTested === null) return null;
  const next = GRID.find((t) => t > lastTested) ?? 0.95;
  return { threshold: next, n: rated.length, precision: null };
}

// Wächter: Jev gibt eine Wahrscheinlichkeit. Gesucht ist die Grenze, die deine Urteile am besten trifft.
// truth = du hättest eine Meldung gewollt.
export function calibrateNoul(events, { min = MIN_EVENTS } = {}) {
  const rated = events.filter((e) => typeof e.conf === 'number' && typeof e.truth === 'boolean');
  if (rated.length < min || !rated.some((e) => e.truth) || !rated.some((e) => !e.truth)) return null;
  let best = null;
  for (const t of GRID) {
    const right = rated.filter((e) => (e.conf >= t) === e.truth).length;
    if (!best || right > best.right) best = { threshold: t, right };
  }
  return { threshold: best.threshold, n: rated.length, precision: best.right / rated.length };
}

const ruleHost = (rule) => (rule.split('=')[0] || '').trim().toLowerCase().replace(/^www\./, '');

// Regel vorschlagen, wenn du Tabs einer Website mindestens dreimal in dieselbe Gruppe gelegt hast
// und sie in mindestens drei von vier Fällen dort gelandet sind.
export function suggestRules(events, rules = [], dismissed = [], { min = 3, share = 0.75 } = {}) {
  const have = new Set(rules.map(ruleHost));
  const no = new Set(dismissed.map((d) => d.toLowerCase()));
  const byHost = new Map();
  for (const e of events) {
    if (e.f !== 'groups' || !e.host || !e.user || e.user === 'none') continue;
    const m = byHost.get(e.host) || new Map();
    m.set(e.user, (m.get(e.user) || 0) + 1);
    byHost.set(e.host, m);
  }
  const out = [];
  for (const [host, counts] of byHost) {
    if (have.has(host)) continue;
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const [group, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (n >= min && n / total >= share && !no.has(`${host} = ${group}`.toLowerCase())) out.push({ host, group, n, rule: `${host} = ${group}` });
  }
  return out.sort((a, b) => b.n - a.n);
}

// Beispiele für die Gruppenfrage: deine letzten Zuordnungen, zuerst Korrekturen und Websites,
// die gerade offen sind. Höchstens max Stück, damit Jev nicht in Nebensachen ertrinkt.
export function pickExamples(events, hosts = [], max = 8) {
  const open = new Set(hosts);
  const seen = new Set();
  const pool = events.filter((e) => e.f === 'groups' && e.user && e.user !== 'none' && e.title);
  const rank = (e) => (open.has(e.host) ? 2 : 0) + (e.ok === false ? 1 : 0);
  const sorted = pool.map((e, i) => ({ e, i })).sort((a, b) => rank(b.e) - rank(a.e) || a.i - b.i);
  const out = [];
  for (const { e } of sorted) {
    const key = `${e.title}|${e.user}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tab: e.host ? `${e.title} — ${e.host}` : e.title, placed_in_group: e.user });
    if (out.length >= max) break;
  }
  return out;
}

// JSONL für eigene Auswertungen: eine Zeile pro Ereignis.
export const toJsonl = (events) => events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
