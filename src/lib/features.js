// Die Tab-Funktionen. Läuft im Service Worker, damit nichts abbricht, wenn das Popup schließt.

import { decide, decideChunked } from './jev.js';
import { getSettings, hostMatches } from './settings.js';
import { findDuplicates, similarCandidates, hostOf } from './url.js';
import { planSort, SORTERS } from './order.js';
import * as P from './prompts.js';
import { beforeAction } from './history.js';

async function openedTimes() {
  const { openedAt = {} } = await chrome.storage.session.get('openedAt');
  return openedAt;
}

export async function trackOpened(tabId) {
  const openedAt = await openedTimes();
  openedAt[tabId] = Date.now();
  await chrome.storage.session.set({ openedAt });
}

async function windowTabs(windowId, allWindows = false) {
  const tabs = await chrome.tabs.query(allWindows ? {} : { windowId });
  const opened = await openedTimes();
  return tabs.map((t) => ({ ...t, openedAt: opened[t.id] }));
}

// Tabs von ausgeschlossenen Websites und Tabwerks eigene Seiten gehen nie an Jev.
async function shareable(tabs) {
  const { excludedHosts } = await getSettings();
  const own = chrome.runtime.getURL('');
  return tabs.filter((t) => !(t.url || '').startsWith(own) && !hostMatches(hostOf(t.url), excludedHosts));
}

function brief(tab) {
  return { id: tab.id, title: tab.title || tab.url, url: tab.url, windowId: tab.windowId, groupId: tab.groupId, active: tab.active, pinned: tab.pinned, lastAccessed: tab.lastAccessed };
}

// ---------- Doppelte ----------

export async function duplicates({ windowId, allWindows }) {
  const tabs = await windowTabs(windowId, allWindows);
  return findDuplicates(tabs).map((g) => ({ key: g.key, keep: brief(g.keep), close: g.close.map(brief) }));
}

export async function similar({ windowId, allWindows }) {
  const settings = await getSettings();
  const tabs = await shareable(await windowTabs(windowId, allWindows));
  const pairs = similarCandidates(tabs);
  if (!pairs.length) return { pairs: [] };
  const involved = [...new Map(pairs.flat().map((t) => [t.id, t])).values()];
  const questions = Object.fromEntries(pairs.map(([a, b], i) => [`p${i}`, P.similarQuestion(P.tabKey(a), P.tabKey(b))]));
  const result = await decide(P.tabState(involved), questions);
  const found = pairs
    .map(([a, b], i) => ({ a: brief(a), b: brief(b), p: result.answers[`p${i}`].noul }))
    .filter((x) => x.p >= settings.notifyAt)
    .sort((x, y) => y.p - x.p);
  return { pairs: found, cost: result.cost };
}

// windowId null heißt: Tabs aus mehreren Fenstern, Rückgängig gilt dann für alle.
// Tabs können zwischen Anzeige und Klick schon zu sein. Chrome bricht dann den ganzen Aufruf ab.
export async function liveTabIds(tabIds) {
  const open = new Set((await chrome.tabs.query({})).map((t) => t.id));
  return tabIds.filter((id) => open.has(id));
}

export async function closeTabs({ tabIds, windowId = null, label = 'Doppelte schließen' }) {
  const ids = await liveTabIds(tabIds);
  if (!ids.length) return { closed: 0, gone: tabIds.length };
  await beforeAction(label, windowId);
  await chrome.tabs.remove(ids);
  return { closed: ids.length, gone: tabIds.length - ids.length };
}

// ---------- Finden ----------

export async function find({ query }) {
  const all = await shareable(await chrome.tabs.query({}));
  // Choice erlaubt höchstens 255 Optionen. Bei mehr Tabs zählen die zuletzt benutzten.
  const tabs = all.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)).slice(0, 250);
  const req = P.findRequest(tabs, query);
  const result = await decide(req.state, req.questions);
  const answer = result.answers.match;
  const byKey = new Map(tabs.map((t) => [P.tabKey(t), t]));
  const hits = P.ranked(answer, 4)
    .filter((r) => r.p >= 0.05)
    .map((r) => (r.key === 'none' ? { none: true, p: r.p } : { ...brief(byKey.get(r.key)), p: r.p }));
  return { hits, confidence: answer.confidence, cost: result.cost };
}

export async function focusTab({ tabId, windowId }) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('Dieser Tab ist schon geschlossen.');
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId ?? windowId, { focused: true });
  return { ok: true };
}

// ---------- Gruppieren ----------

export async function proposeGroups({ windowId, onlyUngrouped }) {
  const settings = await getSettings();
  const tabs = await windowTabs(windowId);
  const groups = await chrome.tabGroups.query({ windowId });
  const members = {};
  for (const t of tabs) if (t.groupId !== -1) (members[t.groupId] ||= []).push(t);
  const { criteria, meta } = P.groupOptions(groups, settings.categories, members);

  const candidates = (await shareable(tabs)).filter((t) => !t.pinned && (!onlyUngrouped || t.groupId === -1));
  if (!candidates.length) return { items: [], options: meta };

  const byKey = new Map(candidates.map((t) => [P.tabKey(t), t]));
  const { answers, cost } = await decideChunked(
    [...byKey.keys()],
    (keys) => P.tabState(keys.map((k) => byKey.get(k))),
    (key) => P.groupQuestion(key, criteria),
  );
  const items = [...byKey].map(([key, tab]) => {
    const a = answers[key];
    return {
      ...brief(tab),
      target: a.choice,
      confidence: a.confidence,
      sure: a.confidence >= settings.confidence,
      current: tab.groupId === -1 ? null : `g${tab.groupId}`,
    };
  });
  return { items, options: meta, cost, threshold: settings.confidence };
}

// plan: [{tabId, target}] mit target = gX, cY oder none.
export async function applyGroups({ windowId, plan, options }) {
  await beforeAction('Gruppieren', windowId);
  const live = new Set(await liveTabIds(plan.map((p) => p.tabId)));
  const byTarget = new Map();
  for (const { tabId, target } of plan) {
    if (target === 'none' || !live.has(tabId)) continue;
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target).push(tabId);
  }
  for (const [target, tabIds] of byTarget) {
    const opt = options[target];
    if (opt.type === 'existing') {
      // Die Gruppe kann inzwischen weg sein. Dann gilt sie als neue Gruppe mit ihrem Namen.
      const group = await chrome.tabGroups.get(opt.groupId).catch(() => null);
      if (group) {
        await chrome.tabs.group({ groupId: opt.groupId, tabIds });
        continue;
      }
      if (!opt.name) continue;
    }
    const existing = (await chrome.tabGroups.query({ windowId })).find((g) => (g.title || '').toLowerCase() === opt.name.toLowerCase());
    if (existing) {
      await chrome.tabs.group({ groupId: existing.id, tabIds });
    } else {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: opt.name, color: opt.color || 'grey' });
    }
  }
  return { moved: plan.filter((p) => p.target !== 'none' && live.has(p.tabId)).length };
}

// ---------- Sortieren ----------

export async function sortTabs({ windowId, by }) {
  const settings = await getSettings();
  let tabs = await windowTabs(windowId);
  let scores = null;
  let cost;
  if (by === 'priority') {
    const candidates = (await shareable(tabs)).filter((t) => !t.pinned);
    const byKey = new Map(candidates.map((t) => [P.tabKey(t), t]));
    const result = await decideChunked(
      [...byKey.keys()],
      (keys) => P.tabState(keys.map((k) => byKey.get(k))),
      (key) => P.priorityQuestion(key, settings.priorityLevels, settings.priorityFocus),
    );
    cost = result.cost;
    scores = Object.fromEntries(Object.entries(result.answers).map(([k, a]) => [P.idFromKey(k), { score: a.score, confidence: a.confidence }]));
    // Jev braucht ein paar Sekunden. In der Zeit können Tabs zu- oder aufgehen.
    tabs = (await windowTabs(windowId)).map((t) => ({ ...t, score: scores[t.id]?.score }));
  }
  const plan = planSort(tabs, SORTERS[by]);
  if (plan.length) await beforeAction('Sortieren', windowId);
  for (const seg of plan) {
    await chrome.tabs.move(seg.order, { index: seg.start });
    // Verschieben kann Tabs aus einer Gruppe lösen oder in eine fremde ziehen.
    if (seg.groupId !== -1) await chrome.tabs.group({ groupId: seg.groupId, tabIds: seg.order });
    else {
      const moved = await Promise.all(seg.order.map((id) => chrome.tabs.get(id)));
      const stray = moved.filter((t) => t.groupId !== -1).map((t) => t.id);
      if (stray.length) await chrome.tabs.ungroup(stray);
    }
  }
  const levels = settings.priorityLevels.length;
  const list = scores
    ? Object.entries(scores)
      .map(([id, s]) => ({ ...brief(tabs.find((t) => t.id === Number(id))), level: Math.round(s.score), levels, ...s }))
      .sort((a, b) => b.score - a.score)
    : null;
  return { segments: plan.length, scores: list, cost, threshold: settings.confidence };
}

// ---------- Gruppen nach Priorität ----------

// Jev bewertet jede Gruppe als Ganzes: Titel plus einige Tab-Titel.
// Wichtige Gruppen rücken nach vorn, Tabs ohne Gruppe bleiben dahinter.
export async function sortGroups({ windowId }) {
  const settings = await getSettings();
  const tabs = await windowTabs(windowId);
  const groups = await chrome.tabGroups.query({ windowId });
  if (groups.length < 2) return { groups: [], moved: false };
  const shared = new Set((await shareable(tabs)).map((t) => t.id));
  const members = {};
  for (const t of [...tabs].sort((a, b) => a.index - b.index)) {
    if (t.groupId !== -1) (members[t.groupId] ||= []).push(t);
  }
  const state = {
    groups: Object.fromEntries(groups.map((g) => [`g${g.id}`, {
      title: g.title || '(untitled group)',
      tabs: (members[g.id] || []).filter((t) => shared.has(t.id)).slice(0, 8).map((t) => t.title),
    }])),
  };
  const questions = Object.fromEntries(groups.map((g) => [`g${g.id}`, P.groupPriorityQuestion(`g${g.id}`, settings.priorityLevels, settings.priorityFocus)]));
  const result = await decide(state, questions);
  const ranked = groups
    .map((g) => ({ id: g.id, title: g.title || 'Ohne Titel', color: g.color, first: Math.min(...(members[g.id] || []).map((t) => t.index)), ...result.answers[`g${g.id}`] }))
    .sort((a, b) => b.score - a.score || a.first - b.first);
  const current = [...groups].sort((a, b) => Math.min(...(members[a.id] || []).map((t) => t.index)) - Math.min(...(members[b.id] || []).map((t) => t.index)));
  const changed = ranked.some((g, i) => g.id !== current[i].id);
  if (changed) {
    await beforeAction('Gruppen sortieren', windowId);
    let index = tabs.filter((t) => t.pinned).length;
    for (const g of ranked) {
      await chrome.tabGroups.move(g.id, { index });
      index += (members[g.id] || []).length;
    }
  }
  const levels = settings.priorityLevels.length;
  return {
    groups: ranked.map((g) => ({ id: g.id, title: g.title, color: g.color, score: g.score, level: Math.round(g.score), levels, confidence: g.confidence, tabs: (members[g.id] || []).length })),
    moved: changed,
    cost: result.cost,
    threshold: settings.confidence,
  };
}

