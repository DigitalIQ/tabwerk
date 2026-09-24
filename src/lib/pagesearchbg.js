// Seitensuche nach Bedeutung: läuft im Service Worker. Die Seite liefert rohe Passagen,
// Tabwerk bewertet sie in Blöcken über Jev (`noul`) und wählt für die Treffer per `choice`
// den stärksten Satz. Angelehnt an „Needle“, aber ohne eigenen Server: Jev läuft über
// Tabwerks vorhandene Verbindung zu OpenRouter oder TypeSafe.

import { decide, decideChunked } from './jev.js';
import { getSettings, hasKey } from './settings.js';
import { isOn } from './flags.js';
import * as P from './prompts.js';
import { buildPassages, splitSentences, rankPassages, MAX_RESULTS } from './pagesearch.js';
import { t } from './i18n.js';

const SUPPORTED = /^https?:\/\//;

export function supported(tab) {
  return Boolean(tab?.url) && SUPPORTED.test(tab.url) && !tab.url.startsWith(chrome.runtime.getURL(''));
}

// items: rohe Passagen aus der Seite ([{ tag, text }]), von content.js gesammelt.
export async function evaluate({ query, items, locale }) {
  const settings = await getSettings();
  if (!isOn(settings, 'pageSearch')) throw new Error(t('ps_featureOff'));
  if (!hasKey(settings)) throw new Error(t('ps_noKey'));
  const q = (query || '').trim();
  const { passages, omittedOversized, omittedLimit } = buildPassages(items);
  if (!q || !passages.length) {
    return { hits: [], passageCount: passages.length, omittedOversized, omittedLimit, cost: 0 };
  }

  // 1) Relevanz je Passage, in Blöcken. Jev bekommt nur Passagen-Text und die Suche.
  const relevance = await decideChunked(
    passages.map((p) => p.id),
    (ids) => P.pageSearchState(passages.filter((p) => ids.includes(p.id)), q),
    (id) => P.pageSearchQuestion(id),
  );
  let cost = relevance.cost || 0;
  let model = relevance.model;

  const ranked = rankPassages(passages, relevance.answers).slice(0, MAX_RESULTS);
  if (!ranked.length) {
    return { hits: [], passageCount: passages.length, omittedOversized, omittedLimit, cost, model };
  }

  // 2) Stärksten Satz je Treffer wählen. Ein Satz braucht keine Frage an Jev.
  const withSentences = ranked.map((p) => ({ ...p, sentences: splitSentences(p.text, locale) }));
  const trivial = new Map();
  const multi = [];
  for (const p of withSentences) {
    if (p.sentences.length <= 1) trivial.set(p.id, { sentence: p.sentences[0] || p.text, confidence: 1 });
    else multi.push(p);
  }
  const chosen = new Map(trivial);
  if (multi.length) {
    const state = P.pageSearchState(multi, q);
    const questions = Object.fromEntries(multi.map((p) => [p.id, P.sentencePickQuestion(p.id, p.sentences)]));
    const result = await decide(state, questions);
    cost += result.cost || 0;
    model = result.model || model;
    for (const p of multi) {
      const answer = result.answers[p.id];
      const idx = Number((answer?.choice || 's0').slice(1)) || 0;
      chosen.set(p.id, { sentence: p.sentences[idx] ?? p.text, confidence: answer?.confidence ?? 0 });
    }
  }

  const hits = withSentences.map((p) => ({
    id: p.id,
    tag: p.tag,
    text: p.text,
    relevance: p.relevance,
    sentence: chosen.get(p.id)?.sentence || p.text,
    confidence: chosen.get(p.id)?.confidence ?? null,
  }));

  return { hits, passageCount: passages.length, omittedOversized, omittedLimit, cost, model };
}

function centered(base, width, height, top = 90) {
  return {
    type: 'popup', width, height,
    left: Math.round((base.left ?? 0) + ((base.width ?? width) - width) / 2),
    top: Math.round((base.top ?? 0) + top),
  };
}

// Spritzt die Suchoberfläche in die Seite. Ein zweiter Aufruf des Kürzels schließt sie
// wieder (siehe pagesearch/content.js). Auf chrome://, im Web Store und im PDF-Betrachter
// lässt Chrome keine Erweiterung etwas einblenden, dann öffnet ein kleines Hinweisfenster.
// Mit "query" (aus "/F Suchtext" in der Schnellsuche) startet die Suche sofort.
export async function openPageSearch({ tab, windowId, query }) {
  const settings = await getSettings();
  if (!isOn(settings, 'pageSearch')) return { ok: false };
  const target = tab || (await chrome.tabs.query({ active: true, windowId }))[0];
  if (target?.id && supported(target)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: target.id },
        func: (q) => { window.__tabwerkPageSearchQuery = q; },
        args: [query ? String(query) : null],
      });
      await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ['src/pagesearch/content.js'] });
      return { ok: true };
    } catch {}
  }
  const base = target?.windowId ? await chrome.windows.get(target.windowId) : await chrome.windows.getLastFocused();
  await chrome.windows.create({ url: chrome.runtime.getURL('src/pagesearch/unsupported.html'), ...centered(base, 380, 220) });
  return { ok: false, unsupported: true };
}
