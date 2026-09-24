// Sortierlogik. Angepinnte Tabs bleiben stehen, Gruppen bleiben zusammen.
// Sortiert wird innerhalb jedes zusammenhängenden Blocks.

import { hostOf } from './url.js';

export function segments(tabs) {
  const list = [...tabs].filter((t) => !t.pinned).sort((a, b) => a.index - b.index);
  const out = [];
  for (const tab of list) {
    const last = out[out.length - 1];
    if (last && last.groupId === tab.groupId && last.tabs[last.tabs.length - 1].index === tab.index - 1) {
      last.tabs.push(tab);
    } else {
      out.push({ groupId: tab.groupId, start: tab.index, tabs: [tab] });
    }
  }
  return out;
}

const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

export const SORTERS = {
  site: (a, b) => collator.compare(hostOf(a.url), hostOf(b.url)) || collator.compare(a.title || '', b.title || ''),
  recent: (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0),
  opened: (a, b) => (a.openedAt ?? a.id) - (b.openedAt ?? b.id),
  title: (a, b) => collator.compare(a.title || '', b.title || ''),
  // score wird vorher von Jev gesetzt. Höher heißt wichtiger und kommt nach vorn.
  priority: (a, b) => (b.score ?? -1) - (a.score ?? -1),
};

// Liefert pro Block die neue Reihenfolge. Blöcke ohne Änderung fallen weg.
export function planSort(tabs, compare) {
  return segments(tabs)
    .map((seg) => ({ ...seg, order: [...seg.tabs].sort(compare).map((t) => t.id) }))
    .filter((seg) => seg.order.some((id, i) => id !== seg.tabs[i].id));
}
