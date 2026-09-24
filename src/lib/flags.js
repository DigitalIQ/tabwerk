// Jede Funktion lässt sich in den Einstellungen ein- und ausschalten.
// parent: die Funktion wirkt nur, wenn die übergeordnete an ist.
// jev: braucht einen Schlüssel für Jev. perm: braucht eine optionale Chrome-Erlaubnis.

import { t } from './i18n.js';

export const FEATURES = [
  { id: 'palette', get area() { return t('ft_area_search'); }, get label() { return t('ft_palette_label'); }, get hint() { return t('ft_palette_hint'); }, def: true },
  { id: 'paletteFulltext', parent: 'palette', get area() { return t('ft_area_search'); }, get label() { return t('ft_paletteFulltext_label'); }, get hint() { return t('ft_paletteFulltext_hint'); }, def: false, perm: { origins: ['https://*/*', 'http://*/*'] } },
  { id: 'paletteHistoryJev', parent: 'palette', get area() { return t('ft_area_search'); }, get label() { return t('ft_paletteHistoryJev_label'); }, get hint() { return t('ft_paletteHistoryJev_hint'); }, def: false, jev: true, perm: { permissions: ['history'] } },
  { id: 'find', get area() { return t('ft_area_search'); }, get label() { return t('ft_find_label'); }, get hint() { return t('ft_find_hint'); }, def: true, jev: true },

  { id: 'groups', get area() { return t('ft_area_organize'); }, get label() { return t('ft_groups_label'); }, get hint() { return t('ft_groups_hint'); }, def: true, jev: true },
  { id: 'groupNames', parent: 'groups', get area() { return t('ft_area_organize'); }, get label() { return t('ft_groupNames_label'); }, get hint() { return t('ft_groupNames_hint'); }, def: true, jev: true },
  { id: 'autoGroup', get area() { return t('ft_area_organize'); }, get label() { return t('ft_autoGroup_label'); }, get hint() { return t('ft_autoGroup_hint'); }, def: false },
  { id: 'autoGroupJev', parent: 'autoGroup', get area() { return t('ft_area_organize'); }, get label() { return t('ft_autoGroupJev_label'); }, get hint() { return t('ft_autoGroupJev_hint'); }, def: false, jev: true },
  { id: 'sort', get area() { return t('ft_area_organize'); }, get label() { return t('ft_sort_label'); }, get hint() { return t('ft_sort_hint'); }, def: true },
  { id: 'focus', get area() { return t('ft_area_organize'); }, get label() { return t('ft_focus_label'); }, get hint() { return t('ft_focus_hint'); }, def: true },
  { id: 'notes', get area() { return t('ft_area_organize'); }, get label() { return t('ft_notes_label'); }, get hint() { return t('ft_notes_hint'); }, def: true },
  { id: 'copyLinks', get area() { return t('ft_area_organize'); }, get label() { return t('ft_copyLinks_label'); }, get hint() { return t('ft_copyLinks_hint'); }, def: true },

  { id: 'cleanup', get area() { return t('ft_area_cleanup'); }, get label() { return t('ft_cleanup_label'); }, get hint() { return t('ft_cleanup_hint'); }, def: true },
  { id: 'similar', parent: 'cleanup', get area() { return t('ft_area_cleanup'); }, get label() { return t('ft_similar_label'); }, get hint() { return t('ft_similar_hint'); }, def: true, jev: true },
  { id: 'cleanupSuggest', parent: 'cleanup', get area() { return t('ft_area_cleanup'); }, get label() { return t('ft_cleanupSuggest_label'); }, get hint() { return t('ft_cleanupSuggest_hint'); }, def: true },
  { id: 'dupeGuard', get area() { return t('ft_area_cleanup'); }, get label() { return t('ft_dupeGuard_label'); }, get hint() { return t('ft_dupeGuard_hint'); }, def: false },
  { id: 'discard', get area() { return t('ft_area_cleanup'); }, get label() { return t('ft_discard_label'); }, get hint() { return t('ft_discard_hint'); }, def: false },
  { id: 'snooze', get area() { return t('ft_area_cleanup'); }, get label() { return t('ft_snooze_label'); }, get hint() { return t('ft_snooze_hint'); }, def: true },

  { id: 'history', get area() { return t('ft_area_backup'); }, get label() { return t('ft_history_label'); }, get hint() { return t('ft_history_hint'); }, def: true },
  { id: 'undo', parent: 'history', get area() { return t('ft_area_backup'); }, get label() { return t('ft_undo_label'); }, get hint() { return t('ft_undo_hint'); }, def: true },
  { id: 'sessions', get area() { return t('ft_area_backup'); }, get label() { return t('ft_sessions_label'); }, get hint() { return t('ft_sessions_hint'); }, def: true },
  { id: 'transfer', get area() { return t('ft_area_backup'); }, get label() { return t('ft_transfer_label'); }, get hint() { return t('ft_transfer_hint'); }, def: true },
  { id: 'stats', get area() { return t('ft_area_backup'); }, get label() { return t('ft_stats_label'); }, get hint() { return t('ft_stats_hint'); }, def: true },

  { id: 'watches', get area() { return t('ft_area_watch'); }, get label() { return t('ft_watches_label'); }, get hint() { return t('ft_watches_hint'); }, def: true },
  { id: 'watchDiff', parent: 'watches', get area() { return t('ft_area_watch'); }, get label() { return t('ft_watchDiff_label'); }, get hint() { return t('ft_watchDiff_hint'); }, def: true },
  { id: 'watchNumbers', parent: 'watches', get area() { return t('ft_area_watch'); }, get label() { return t('ft_watchNumbers_label'); }, get hint() { return t('ft_watchNumbers_hint'); }, def: true, jev: true },

  { id: 'copyUnlock', get area() { return t('ft_area_bookmarksForms'); }, get label() { return t('ft_copyUnlock_label'); }, get hint() { return t('ft_copyUnlock_hint'); }, def: true },
  { id: 'bookmarkFolder', get area() { return t('ft_area_bookmarksForms'); }, get label() { return t('ft_bookmarkFolder_label'); }, get hint() { return t('ft_bookmarkFolder_hint'); }, def: false, jev: true, perm: { permissions: ['bookmarks'] } },
  { id: 'forms', get area() { return t('ft_area_bookmarksForms'); }, get label() { return t('ft_forms_label'); }, get hint() { return t('ft_forms_hint'); }, def: true },
  { id: 'formsTestData', parent: 'forms', get area() { return t('ft_area_bookmarksForms'); }, get label() { return t('ft_formsTestData_label'); }, get hint() { return t('ft_formsTestData_hint'); }, def: true },
  { id: 'formsSensitive', parent: 'forms', get area() { return t('ft_area_bookmarksForms'); }, get label() { return t('ft_formsSensitive_label'); }, get hint() { return t('ft_formsSensitive_hint'); }, def: false, warn: true },
  { id: 'formsJev', parent: 'forms', get area() { return t('ft_area_bookmarksForms'); }, get label() { return t('ft_formsJev_label'); }, get hint() { return t('ft_formsJev_hint'); }, def: false, jev: true },

  { id: 'learn', get area() { return t('ft_area_learn'); }, get label() { return t('ft_learn_label'); }, get hint() { return t('ft_learn_hint'); }, def: true },
  { id: 'learnRules', parent: 'learn', get area() { return t('ft_area_learn'); }, get label() { return t('ft_learnRules_label'); }, get hint() { return t('ft_learnRules_hint'); }, def: true },
  { id: 'learnThreshold', parent: 'learn', get area() { return t('ft_area_learn'); }, get label() { return t('ft_learnThreshold_label'); }, get hint() { return t('ft_learnThreshold_hint'); }, def: true },
  { id: 'learnExamples', parent: 'learn', get area() { return t('ft_area_learn'); }, get label() { return t('ft_learnExamples_label'); }, get hint() { return t('ft_learnExamples_hint'); }, def: true, jev: true },
  { id: 'learnFeedback', parent: 'learn', get area() { return t('ft_area_learn'); }, get label() { return t('ft_learnFeedback_label'); }, get hint() { return t('ft_learnFeedback_hint'); }, def: true },
];

export const FEATURE_DEFAULTS = Object.fromEntries(FEATURES.map((f) => [f.id, f.def]));
const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));

export const feature = (id) => BY_ID.get(id);

// An, wenn die Funktion selbst und alle übergeordneten an sind.
export function isOn(settings, id) {
  const flags = { ...FEATURE_DEFAULTS, ...(settings.features || {}) };
  for (let f = BY_ID.get(id); f; f = f.parent ? BY_ID.get(f.parent) : null) {
    if (!flags[f.id]) return false;
  }
  return true;
}
