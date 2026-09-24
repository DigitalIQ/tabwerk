// Intervalle für Wächter. Reine Funktionen, in Node testbar.
// Chrome weckt Erweiterungen frühestens alle 30 Sekunden.

export const MIN_SECONDS = 30;
export const PRESETS = [
  { minutes: 5, label: '5 Minuten' },
  { minutes: 15, label: '15 Minuten' },
  { minutes: 60, label: '1 Stunde' },
  { minutes: 360, label: '6 Stunden' },
  { minutes: 1440, label: '24 Stunden' },
];

// "hh:mm:ss", "mm:ss" oder "ss" in Sekunden. null bei ungültiger Eingabe.
export function parseDuration(text) {
  const m = /^\s*(?:(\d{1,3}):)?(?:(\d{1,2}):)?(\d{1,2})\s*$/.exec(text || '');
  if (!m) return null;
  const parts = (text.trim().split(':')).map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  while (parts.length < 3) parts.unshift(0);
  const [h, min, s] = parts;
  if (min > 59 || s > 59) return null;
  return h * 3600 + min * 60 + s;
}

export function formatDuration(seconds) {
  const s = Math.round(seconds);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function describeInterval(minutes) {
  const preset = PRESETS.find((p) => p.minutes === minutes);
  if (preset) return preset.label;
  const s = Math.round(minutes * 60);
  if (s % 3600 === 0) return `${s / 3600} Stunden`;
  if (s % 60 === 0) return `${s / 60} Minuten`;
  return formatDuration(s);
}
