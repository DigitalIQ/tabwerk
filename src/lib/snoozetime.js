// Weckzeiten für geschlummerte Tabs. Reiner Code.

import { t, fmtDate } from './i18n.js';

// Wochentagsname des nächsten Montags, über Intl. So passt der Name zur Sprache.
function nextMondayName(now) {
  const d = new Date(now);
  const days = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + days);
  return fmtDate(d, { weekday: 'long' });
}

export const SNOOZE_PRESETS = [
  { id: 'hour', get label() { return t('snooze_inOneHour'); } },
  { id: 'evening', get label() { return t('snooze_todayEvening'); } },
  { id: 'tomorrow', get label() { return t('snooze_tomorrowMorning'); } },
  { id: 'monday', get label() { return t('snooze_weekdayMorning', nextMondayName(Date.now())); } },
  { id: 'week', get label() { return t('snooze_inOneWeek'); } },
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
