// Verlauf: sichert Fenster, Tabs und Gruppen nach jeder Änderung und vor jeder Tabwerk-Aktion.
// Jeder Stand lässt sich wiederherstellen. Tabs, die im alten Stand fehlen, bleiben offen und rücken ans Ende.

import { normalizeUrl } from './url.js';
import { planRetention } from './retention.js';
import { getSettings } from './settings.js';
import { isOn } from './flags.js';
import { REASON, LABEL } from './reasons.js';
import { BLOCK_PREFIX, splitWindow, joinWindow, gzip, orphanBlocks } from './histstore.js';
import { t } from './i18n.js';

const INDEX = 'histIndex';
const QUIET_MS = 1500;
let timer = null;
let suppress = 0;
let queue = Promise.resolve();

// Nacheinander ausführen, damit sich Sicherungen und Wiederherstellungen nicht überholen.
const serial = (fn) => (queue = queue.then(fn, fn));

export async function listSnapshots() {
  const { [INDEX]: index = [] } = await chrome.storage.local.get(INDEX);
  return index;
}

export async function getSnapshot(id) {
  const key = `hist:${id}`;
  const { [key]: snap } = await chrome.storage.local.get(key);
  return snap ? inflate(snap) : null;
}

// Setzt eine Sicherung aus ihren Fenster-Blöcken zusammen. Alte Sicherungen haben die Tabs noch direkt drin.
async function inflate(snap) {
  const refs = snap.windows.filter((w) => w.block);
  if (!refs.length) return snap;
  const blocks = await chrome.storage.local.get([...new Set(refs.map((w) => BLOCK_PREFIX + w.block))]);
  const windows = [];
  for (const w of snap.windows) {
    if (!w.block) windows.push(w);
    else if (blocks[BLOCK_PREFIX + w.block]) windows.push(await joinWindow(w, blocks[BLOCK_PREFIX + w.block]));
  }
  if (!windows.length) throw new Error(t('hist_snapshotCorrupted'));
  return { ...snap, windows };
}

// Zerlegt Fenster in Blöcke und schreibt nur die, die es noch nicht gibt.
async function packWindows(windows) {
  const parts = await Promise.all(windows.map(splitWindow));
  const keys = [...new Set(parts.map((p) => BLOCK_PREFIX + p.block))];
  const have = await chrome.storage.local.get(keys);
  const writes = {};
  for (const p of parts) {
    const key = BLOCK_PREFIX + p.block;
    if (!have[key] && !writes[key]) writes[key] = await gzip(p.body);
  }
  return { refs: parts.map((p) => p.ref), blocks: [...new Set(parts.map((p) => p.block))], writes };
}

async function capture() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const groups = await chrome.tabGroups.query({});
  return windows.map((w) => shapeWindow(w, groups));
}

// Ein einzelnes Fenster im selben Format, etwa für benannte Sitzungen.
export async function captureWindow(windowId) {
  const w = await chrome.windows.get(windowId, { populate: true });
  return shapeWindow(w, await chrome.tabGroups.query({ windowId }));
}

function shapeWindow(w, groups) {
  return ({
    id: w.id,
    focused: w.focused,
    incognito: w.incognito,
    state: w.state,
    tabs: [...w.tabs].sort((a, b) => a.index - b.index).map((tab) => ({
      id: tab.id,
      url: tab.url || tab.pendingUrl || '',
      title: tab.title || '',
      pinned: tab.pinned,
      active: tab.active,
      groupId: tab.groupId,
    })),
    groups: groups.filter((g) => g.windowId === w.id).map((g) => ({ id: g.id, title: g.title || '', color: g.color, collapsed: g.collapsed })),
  });
}

// Kurzer Fingerabdruck. Gleicher Aufbau heißt: keine neue Sicherung nötig.
function hash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

function windowSignature(w) {
  return hash(JSON.stringify([w.tabs.map((tab) => [tab.url, tab.pinned, tab.groupId]), w.groups.map((g) => [g.id, g.title, g.color])]));
}

function signature(windows) {
  return hash(windows.map(windowSignature).join('|'));
}

function summarize(windows) {
  return {
    windows: windows.length,
    tabs: windows.reduce((n, w) => n + w.tabs.length, 0),
    groups: windows.reduce((n, w) => n + w.groups.length, 0),
    // Pro Fenster, damit der Verlauf im Popup nur die Änderungen dieses Fensters zeigt.
    win: Object.fromEntries(windows.map((w) => [w.id, { sig: windowSignature(w), tabs: w.tabs.length, groups: w.groups.length }])),
  };
}

// reason ist ein Schlüssel aus REASON. args: Werte für den Text, etwa der Name der Aktion.
export function takeSnapshot(reason, { force = false, args } = {}) {
  return serial(async () => {
    const windows = await capture();
    if (!windows.length) return null;
    const sig = signature(windows);
    const index = await listSnapshots();
    if (!force && index[0]?.sig === sig) {
      // Gleicher Stand. Die Aktion zeigt trotzdem auf diese Sicherung.
      if (reason === REASON.before && (index[0].reason !== reason || index[0].reasonArgs?.[0] !== args?.[0])) {
        index[0] = { ...index[0], reason, reasonArgs: args };
        await chrome.storage.local.set({ [INDEX]: index });
      }
      return index[0];
    }
    const now = Date.now();
    const { refs, blocks, writes } = await packWindows(windows);
    const entry = { id: String(now), t: now, reason, ...(args ? { reasonArgs: args } : {}), sig, ...summarize(windows), blocks };
    const next = [entry, ...index];
    const { keep, drop } = planRetention(next, now);
    // Erst die Blöcke, dann Sicherung und Liste. So zeigt nie eine Sicherung auf einen fehlenden Block.
    await chrome.storage.local.set(writes);
    await chrome.storage.local.set({ [`hist:${entry.id}`]: { ...entry, windows: refs }, [INDEX]: keep });
    if (drop.length) {
      await chrome.storage.local.remove([...drop.map((e) => `hist:${e.id}`), ...orphanBlocks(keep, drop).map((b) => BLOCK_PREFIX + b)]);
    }
    return entry;
  });
}

// Viele Ereignisse in kurzer Zeit ergeben eine Sicherung, sobald es 1,5 Sekunden ruhig ist.
export function scheduleSnapshot() {
  if (suppress) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (isOn(await getSettings(), 'history')) takeSnapshot(REASON.changed).catch(() => {});
  }, QUIET_MS);
}

export async function clearHistory() {
  const index = await listSnapshots();
  await chrome.storage.local.remove([INDEX, ...index.map((e) => `hist:${e.id}`), ...orphanBlocks([], index).map((b) => BLOCK_PREFIX + b)]);
  return { removed: index.length };
}

// Bringt Sicherungen im alten Format (alle Tabs direkt drin) ins Block-Format.
// Läuft nach einem Update einmal durch, in kleinen Portionen.
export function compactHistory() {
  return serial(async () => {
    const index = await listSnapshots();
    const todo = index.filter((e) => !e.blocks);
    let done = 0;
    for (let i = 0; i < todo.length; i += 20) {
      const part = todo.slice(i, i + 20);
      const snaps = await chrome.storage.local.get(part.map((e) => `hist:${e.id}`));
      for (const e of part) {
        const snap = snaps[`hist:${e.id}`];
        if (!snap || snap.windows.some((w) => w.block)) continue;
        const { refs, blocks, writes } = await packWindows(snap.windows);
        await chrome.storage.local.set(writes);
        await chrome.storage.local.set({ [`hist:${e.id}`]: { ...snap, windows: refs, blocks } });
        e.blocks = blocks;
        done += 1;
      }
    }
    if (done) {
      // serial hält neue Sicherungen so lange an. Die Liste ist also noch aktuell.
      await chrome.storage.local.set({ [INDEX]: index });
    }
    return { compacted: done };
  });
}

// ---------- Wiederherstellen ----------

// windowId gesetzt: nur dieses Fenster zurücksetzen, andere Fenster bleiben unberührt.
export async function restoreSnapshot({ id, windowId = null }) {
  let snap = await getSnapshot(id);
  if (!snap) throw new Error(t('hist_snapshotGone'));
  if (windowId !== null) {
    const win = snap.windows.find((w) => w.id === windowId);
    if (!win) throw new Error(t('hist_windowNotInSnapshot'));
    snap = { ...snap, windows: [win], only: windowId };
  }
  const before = await takeSnapshot(REASON.before, { args: [LABEL.restore] });
  // Der Doppel-Schutz soll wiederhergestellte Tabs nicht gleich wieder schließen.
  await chrome.storage.session.set({ dupeQuietUntil: Date.now() + 60e3 });
  suppress += 1;
  clearTimeout(timer);
  const report = { reused: 0, opened: 0, failed: 0 };
  try {
    await serial(() => restore(snap, report));
  } finally {
    suppress -= 1;
  }
  await takeSnapshot(REASON.restored);
  return { ...report, before: before?.id };
}

async function restore(snap, report) {
  const live = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const liveWindows = new Set(live.map((w) => w.id));
  // Pro Fenster: nur Tabs dieses Fensters wiederverwenden, nichts aus anderen Fenstern holen.
  const liveTabs = live.filter((w) => !snap.only || w.id === snap.only).flatMap((w) => w.tabs);
  const byId = new Map(liveTabs.map((tab) => [tab.id, tab]));
  const used = new Set();

  // Erst dieselbe Tab-ID mit derselben Adresse, dann irgendein freier Tab mit derselben Adresse.
  const resolve = (saved) => {
    const key = normalizeUrl(saved.url);
    const same = byId.get(saved.id);
    if (same && !used.has(same.id) && normalizeUrl(same.url || same.pendingUrl) === key) return same;
    return liveTabs.find((tab) => !used.has(tab.id) && normalizeUrl(tab.url || tab.pendingUrl) === key);
  };

  for (const win of snap.windows) {
    const matches = win.tabs.map((saved) => {
      const tab = resolve(saved);
      if (tab) used.add(tab.id);
      return tab;
    });

    let windowId = liveWindows.has(win.id) ? win.id : null;
    if (windowId === null) {
      const first = matches.find(Boolean);
      const created = first
        ? await chrome.windows.create({ tabId: first.id, focused: false, incognito: win.incognito })
        : await chrome.windows.create({ url: win.tabs[0]?.url, focused: false, incognito: win.incognito });
      windowId = created.id;
      if (!first && win.tabs[0]) {
        matches[0] = created.tabs[0];
        report.opened += 1;
      }
    }

    const ids = [];
    for (let i = 0; i < win.tabs.length; i++) {
      const saved = win.tabs[i];
      let tab = matches[i];
      try {
        if (tab) {
          await chrome.tabs.move(tab.id, { windowId, index: i });
          report.reused += 1;
        } else {
          tab = await chrome.tabs.create({ windowId, url: saved.url, index: i, active: false, pinned: saved.pinned });
          report.opened += 1;
        }
        if (tab.pinned !== saved.pinned) await chrome.tabs.update(tab.id, { pinned: saved.pinned });
        ids[i] = tab.id;
      } catch {
        report.failed += 1;
      }
    }

    // Gruppen: bestehende Gruppe wiederverwenden, sonst neu anlegen.
    const liveGroups = await chrome.tabGroups.query({ windowId });
    for (const g of win.groups) {
      const tabIds = win.tabs.map((tab, i) => (tab.groupId === g.id ? ids[i] : null)).filter(Boolean);
      if (!tabIds.length) continue;
      const existing = liveGroups.find((x) => x.id === g.id);
      const groupId = existing
        ? await chrome.tabs.group({ groupId: existing.id, tabIds })
        : await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: g.title, color: g.color, collapsed: g.collapsed });
    }
    const loose = win.tabs.map((tab, i) => (tab.groupId === -1 ? ids[i] : null)).filter(Boolean);
    if (loose.length) {
      const now = await Promise.all(loose.map((tabId) => chrome.tabs.get(tabId)));
      const stray = now.filter((tab) => tab.groupId !== -1).map((tab) => tab.id);
      if (stray.length) await chrome.tabs.ungroup(stray);
    }

    const activeIndex = win.tabs.findIndex((tab) => tab.active);
    if (ids[activeIndex]) await chrome.tabs.update(ids[activeIndex], { active: true });
  }
}

// ---------- Aktionen absichern ----------

// Jede Tabwerk-Aktion sichert vorher den Stand. Rückgängig springt genau dorthin zurück.
// label ist ein Schlüssel aus LABEL in reasons.js.
export async function beforeAction(label, windowId = null) {
  if (!isOn(await getSettings(), 'undo')) return null;
  const entry = await takeSnapshot(REASON.before, { args: [label] });
  if (entry) await setLastAction(windowId, { id: entry.id, label, windowId });
  return entry;
}

// Wiederherstellen aus dem Verlauf lässt sich selbst wieder rückgängig machen.
export async function restoreFromHistory({ id, windowId = null }) {
  const result = await restoreSnapshot({ id, windowId });
  if (result.before) await setLastAction(windowId, { id: result.before, label: LABEL.restore, windowId });
  return result;
}

// Rückgängig merkt sich die letzte Aktion pro Fenster. null steht für alle Fenster.
const actionKey = (windowId) => `lastAction:${windowId ?? 'all'}`;

async function setLastAction(windowId, value) {
  await chrome.storage.session.set({ [actionKey(windowId)]: value });
}

export async function getLastAction({ windowId }) {
  const keys = [actionKey(windowId), actionKey(null)];
  const found = await chrome.storage.session.get(keys);
  return found[keys[0]] || found[keys[1]] || null;
}

export async function undoLastAction({ windowId = null } = {}) {
  const last = await getLastAction({ windowId });
  if (!last) return { ok: false };
  const result = await restoreSnapshot({ id: last.id, windowId: last.windowId ?? null });
  await chrome.storage.session.remove(actionKey(last.windowId ?? null));
  return { ok: true, label: last.label, ...result };
}
