// Baut die Fragen an Jev. Reine Funktionen, in Node testbar.
// Die Anweisungen sind englisch, weil Jev dort am genauesten ist.
// Tab-Titel und Kategorienamen dürfen deutsch bleiben.
// Regeln aus der Jev-Doku: eine Entscheidung pro Frage, Zustand per Name ansprechen,
// Rechnen und Datumsvergleiche bleiben im Code.

import { describeTab } from './url.js';
import { t } from './i18n.js';

export const tabKey = (tab) => `t${tab.id}`;
export const idFromKey = (key) => Number(key.slice(1));

export function tabState(tabs) {
  return { tabs: Object.fromEntries(tabs.map((tab) => [tabKey(tab), describeTab(tab)])) };
}

// Optionen für die Gruppenfrage: bestehende Gruppen, Kategorien für neue Gruppen, keine.
export function groupOptions(groups, categories, membersByGroup = {}) {
  const criteria = {};
  const meta = {};
  const taken = new Set();
  for (const g of groups) {
    const key = `g${g.id}`;
    const examples = (membersByGroup[g.id] || []).slice(0, 3).map((tab) => tab.title).filter(Boolean);
    criteria[key] = {
      kind: 'existing tab group',
      name: g.title || '(untitled group)',
      ...(examples.length ? { contains_tabs_like: examples } : {}),
    };
    meta[key] = { type: 'existing', groupId: g.id, name: g.title || t('tabs_untitledGroup'), color: g.color };
    if (g.title) taken.add(g.title.trim().toLowerCase());
  }
  categories.forEach((c, i) => {
    if (!c.name || taken.has(c.name.trim().toLowerCase())) return;
    const key = `c${i}`;
    criteria[key] = { kind: 'new tab group', name: c.name, ...(c.hint ? { for: c.hint } : {}) };
    meta[key] = { type: 'new', name: c.name, color: c.color };
  });
  criteria.none = 'None of the other groups fits this tab well';
  meta.none = { type: 'none', name: t('tabs_noGroup') };
  return { criteria, meta };
}

// withExamples: im Zustand steht past_choices mit früheren Zuordnungen des Nutzers.
export function groupQuestion(key, criteria, withExamples = false) {
  const hint = withExamples ? ' `past_choices` shows where I put similar tabs before; follow that habit when a tab is clearly alike.' : '';
  return {
    type: 'choice',
    instructions: `Which tab group should the browser tab \`tabs.${key}\` be placed in? Judge by its title, site and path.${hint}`,
    criteria,
  };
}

export function priorityQuestion(key, levels, focus) {
  const question = `How important is the browser tab \`tabs.${key}\` for me right now? Judge by its title, site and path.`;
  return {
    type: 'score',
    instructions: focus ? { my_current_focus: focus, question } : question,
    criteria: levels,
  };
}

export function groupPriorityQuestion(key, levels, focus) {
  const question = `How important is the tab group \`groups.${key}\` for me right now? Judge by its title and the titles of its tabs.`;
  return {
    type: 'score',
    instructions: focus ? { my_current_focus: focus, question } : question,
    criteria: levels,
  };
}

// Choice hat höchstens 255 Optionen. Aufrufer kürzt die Liste vorher.
export function findRequest(tabs, query) {
  const criteria = Object.fromEntries(tabs.map((tab) => [tabKey(tab), describeTab(tab)]));
  criteria.none = 'No open tab matches the search';
  return {
    state: { search: query },
    questions: {
      match: {
        type: 'choice',
        instructions: 'Which open browser tab is the one described by `search`? Each option is one open tab with its title, site and path.',
        criteria,
      },
    },
  };
}

export function similarQuestion(aKey, bKey) {
  return {
    type: 'noul',
    instructions: `Do \`tabs.${aKey}\` and \`tabs.${bKey}\` show the same article, product, document, video or search?`,
    criteria: {
      true: 'Both tabs show the same content, even if the addresses differ',
      false: 'The tabs show different content, for example two different pages of the same website',
    },
  };
}

export function watchRequest(watch, page, diff) {
  const state = {
    watch_request: watch.condition,
    page: { title: page.title || '', site: page.site || '' },
    removed_lines: diff.removed,
    added_lines: diff.added,
  };
  const questions = {
    notify: {
      type: 'noul',
      instructions: 'Does the change from `removed_lines` to `added_lines` match what `watch_request` asks to be notified about?',
      criteria: {
        true: 'The change is exactly the kind of event described in `watch_request`',
        false: 'The change is unrelated noise, such as timestamps, ads, counters or other content',
      },
    },
  };
  const evidence = diff.added.length ? diff.added : diff.removed;
  const list = diff.added.length ? 'added_lines' : 'removed_lines';
  if (evidence.length >= 2) {
    const criteria = Object.fromEntries(evidence.slice(0, 60).map((line, i) => [`l${i}`, line]));
    criteria.none = 'No line is relevant to `watch_request`';
    questions.evidence = {
      type: 'choice',
      instructions: `Which line in \`${list}\` is the most relevant to \`watch_request\`?`,
      criteria,
    };
  }
  return { state, questions, evidence };
}

// ---------- Seitensuche nach Bedeutung ----------

// passages: [{ id, text }]. Der Zustand trägt die Suche und den Text jeder Passage.
export function pageSearchState(passages, query) {
  return { query, passages: Object.fromEntries(passages.map((p) => [p.id, p.text])) };
}

export function pageSearchQuestion(id) {
  return {
    type: 'noul',
    instructions: `Does the passage \`passages.${id}\` help answer or relate to \`query\`? Judge the passage on its own.`,
    criteria: {
      true: 'The passage contains information relevant to the query',
      false: 'The passage is unrelated to the query',
    },
  };
}

// sentences: die Sätze der Passage. Jev wählt den stärksten aus, erfindet keinen neuen.
export function sentencePickQuestion(id, sentences) {
  const criteria = Object.fromEntries(sentences.map((s, i) => [`s${i}`, s]));
  return {
    type: 'choice',
    instructions: `Which sentence in \`passages.${id}\` best answers \`query\`? Pick the single strongest sentence, word for word.`,
    criteria,
  };
}

// Liest eine Choice-Antwort als Rangliste.
export function ranked(answer, top = 3) {
  return Object.entries(answer.probabilities || {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, top)
    .map(([key, p]) => ({ key, p }));
}
