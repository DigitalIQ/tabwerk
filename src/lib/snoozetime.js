// Weckzeiten für geschlummerte Tabs. Reiner Code.

export const SNOOZE_PRESETS = [
  { id: 'hour', label: 'in 1 Stunde' },
  { id: 'evening', label: 'heute um 18 Uhr' },
  { id: 'tomorrow', label: 'morgen um 9 Uhr' },
  { id: 'monday', label: 'Montag um 9 Uhr' },
  { id: 'week', label: 'in einer Woche' },
];

export function wakeTime(preset, now = Date.now()) {
  const d = new Date(now);
  const at = (days, hour) => { const x = new Date(d); x.setDate(x.getDate() + days); x.setHours(hour, 0, 0, 0); return x.getTime(); };
  switch (preset) {
    case 'hour': return now + 3600e3;
    case 'evening': return d.getHours() < 18 ? at(0, 18) : at(1, 18);
    case 'tomorrow': return at(1, 9);
    case 'monday': { const days = ((8 - d.getDay()) % 7) || 7; return at(days, 9); }
    case 'week': return at(7, 9);
    default: return null;
  }
}
