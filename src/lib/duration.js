// Intervalle für Wächter. Reine Funktionen, in Node testbar.
// Chrome weckt Erweiterungen frühestens alle 30 Sekunden.

import { tp } from './i18n.js';

export const MIN_SECONDS = 30;
export const PRESETS = [
  { minutes: 5, get label() { return tp('dur_minutes', 5); } },
  { minutes: 15, get label() { return tp('dur_minutes', 15); } },
  { minutes: 60, get label() { return tp('dur_hours', 1); } },
  { minutes: 360, get label() { return tp('dur_hours', 6); } },
  { minutes: 1440, get label() { return tp('dur_hours', 24); } },
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
  if (s % 3600 === 0) return tp('dur_hours', s / 3600);
  if (s % 60 === 0) return tp('dur_minutes', s / 60);
  return formatDuration(s);
}
