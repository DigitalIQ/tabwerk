// Gründe für Sicherungen und Namen von Aktionen. Tabwerk speichert sie als Schlüssel,
// damit der Verlauf in jeder Sprache lesbar ist. Einträge aus älteren Versionen haben
// noch deutschen Klartext. Den zeigt Tabwerk unverändert an.

import { t, has } from './i18n.js';

export const REASON = {
  changed: 'hist_reasonChanged',
  auto: 'hist_reasonAuto',
  manual: 'hist_reasonManual',
  first: 'hist_reasonFirst',
  startup: 'hist_reasonStartup',
  restored: 'hist_reasonRestored',
  before: 'hist_reasonBefore',
};

export const LABEL = {
  closeDupes: 'lbl_closeDupes',
  cleanup: 'lbl_cleanup',
  group: 'lbl_group',
  sort: 'lbl_sort',
  sortGroups: 'lbl_sortGroups',
  ungroup: 'lbl_ungroup',
  snooze: 'lbl_snooze',
  restore: 'lbl_restore',
};

const text = (value) => (value && /^[a-z]+_[A-Za-z0-9_]+$/.test(value) && has(value) ? t(value) : value || '');

export const labelText = text;

export function reasonText(entry) {
  if (entry?.reason === REASON.before) return t(REASON.before, text(entry.reasonArgs?.[0]));
  return text(entry?.reason);
}

// Sicherung direkt vor einer Tabwerk-Aktion.
export const isBefore = (entry) => entry?.reason === REASON.before || /^Vor /.test(entry?.reason || '');
