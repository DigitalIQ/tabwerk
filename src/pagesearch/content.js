// Seitensuche nach Bedeutung: wird per Tastenkürzel, Schnellsuche oder Popup-Knopf in die
// Seite gespritzt. Zeigt eine kleine, schattenraum-isolierte Leiste, liest die Passagen der
// Seite, schickt sie mit der Suche an den Service Worker (der fragt Jev) und hebt die
// Treffer direkt im Text hervor. Ein zweiter Aufruf des Kürzels schließt die Leiste wieder.
(async () => {
  const ID = 'tabwerk-pagesearch-host';
  const preset = window.__tabwerkPageSearchQuery || '';
  delete window.__tabwerkPageSearchQuery;
  const existing = document.getElementById(ID);
  if (existing && !preset) {
    existing.remove();
    document.getElementById('tabwerk-pagesearch-style')?.remove();
    return;
  }
  // Mit Suchtext ersetzt ein neuer Aufruf die offene Leiste, statt sie nur zu schließen.
  if (existing) existing.dispatchEvent(new CustomEvent('tabwerk-pagesearch-close'));

  const { t, initI18n, localizeDom, language } = await import(chrome.runtime.getURL('src/lib/i18n.js'));
  const { locateSentence } = await import(chrome.runtime.getURL('src/lib/pagesearch.js'));
  const { getSettings, hasKey } = await import(chrome.runtime.getURL('src/lib/settings.js'));
  await initI18n();
  const hasJevKey = hasKey(await getSettings());

  // ---------- Passagen lesen ----------
  // Absatz-, Listen-, Überschriften-, Zitat- und Tabellenzellen-artige Elemente.
  // Verschachtelte Treffer (etwa <li><p>) zählen nur einmal, das äußere Element gewinnt.
  const CANDIDATE = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd, caption, summary, figcaption';
  const SKIP_ANCESTOR = 'nav, script, style, noscript, template, input, textarea, select, [aria-hidden="true"]';

  function isVisible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Baut den Passagentext aus den Textknoten des Elements und merkt sich, welcher
  // Textknoten zu welcher Stelle im Text gehört. Genau dieselbe Stelle nutzt die
  // Hervorhebung später wieder, deshalb keine andere Normalisierung als hier.
  function walkText(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.parentElement || node.parentElement.closest(SKIP_ANCESTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let full = '';
    const ranges = [];
    let node;
    while ((node = walker.nextNode())) {
      const collapsed = (node.textContent || '').replace(/\s+/g, ' ');
      if (!collapsed) continue;
      const start = full.length;
      full += collapsed;
      ranges.push({ node, start, end: full.length });
    }
    const leadTrim = full.length - full.trimStart().length;
    return { text: full.trim(), ranges, leadTrim };
  }

  const items = [];
  const entries = [];

  function extract() {
    items.length = 0;
    entries.length = 0;
    const all = [...document.querySelectorAll(CANDIDATE)].filter((el) => !el.closest(SKIP_ANCESTOR) && el.closest(`#${ID}`) === null);
    const top = all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
    for (const el of top) {
      if (!isVisible(el)) continue;
      const { text, ranges, leadTrim } = walkText(el);
      if (!text) continue;
      items.push({ tag: el.tagName.toLowerCase(), text });
      entries.push({ el, text, ranges, leadTrim });
    }
  }

  // ---------- Hervorhebung ----------
  // Bevorzugt CSS.highlights (kein Eingriff ins DOM), sonst <mark> als Rückfall.
  const useHighlightApi = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';
  let strongHl = null;
  let paleHl = null;
  const marks = [];
  const styleEl = document.createElement('style');
  styleEl.id = 'tabwerk-pagesearch-style';
  styleEl.textContent = `
    ::highlight(tabwerk-ps-pale) { background-color: rgba(70, 200, 120, 0.28); }
    ::highlight(tabwerk-ps-strong) { background-color: rgba(40, 200, 90, 0.62); }
    mark.tabwerk-ps-strong { background: rgba(40, 200, 90, 0.62); color: inherit; }
    .tabwerk-ps-current-el { outline: 2px solid rgba(30, 140, 70, 0.85); outline-offset: 2px; border-radius: 3px; }
  `;
  (document.head || document.documentElement).append(styleEl);

  function rangeFor(entry, start, end) {
    const s = Math.max(0, start + entry.leadTrim);
    const e = Math.max(s, end + entry.leadTrim);
    const startEntry = entry.ranges.find((r) => s >= r.start && s < r.end) || entry.ranges[0];
    const endEntry = [...entry.ranges].reverse().find((r) => e > r.start && e <= r.end) || entry.ranges[entry.ranges.length - 1];
    if (!startEntry || !endEntry) return null;
    try {
      const range = document.createRange();
      range.setStart(startEntry.node, Math.min(startEntry.node.textContent.length, Math.max(0, s - startEntry.start)));
      range.setEnd(endEntry.node, Math.min(endEntry.node.textContent.length, Math.max(0, e - endEntry.start)));
      return range;
    } catch {
      return null;
    }
  }

  function clearHighlights() {
    if (useHighlightApi) {
      CSS.highlights.delete('tabwerk-ps-pale');
      CSS.highlights.delete('tabwerk-ps-strong');
    }
    strongHl = null;
    paleHl = null;
    for (const mark of marks.splice(0)) {
      try { mark.replaceWith(document.createTextNode(mark.textContent)); } catch {}
    }
    for (const entry of entries) entry.el.removeAttribute('data-tabwerk-ps');
    document.querySelector('.tabwerk-ps-current-el')?.classList.remove('tabwerk-ps-current-el');
  }

  function highlight(hit, entry) {
    const full = rangeFor(entry, 0, entry.text.length);
    const loc = locateSentence(entry.text, hit.sentence);
    const strong = loc ? rangeFor(entry, loc.start, loc.end) : null;
    if (useHighlightApi) {
      if (!paleHl) { paleHl = new Highlight(); paleHl.priority = 0; CSS.highlights.set('tabwerk-ps-pale', paleHl); }
      if (!strongHl) { strongHl = new Highlight(); strongHl.priority = 1; CSS.highlights.set('tabwerk-ps-strong', strongHl); }
      if (full) paleHl.add(full);
      if (strong) strongHl.add(strong);
      return;
    }
    // Rückfall ohne CSS.highlights: nur der stärkste Satz bekommt ein <mark>.
    if (strong) {
      try {
        const mark = document.createElement('mark');
        mark.className = 'tabwerk-ps-strong';
        const frag = strong.extractContents();
        mark.append(frag);
        strong.insertNode(mark);
        marks.push(mark);
      } catch {}
    }
  }

  // ---------- Oberfläche ----------
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, sans-serif; }
    :host { color-scheme: light dark; --bg:#fff; --ink:#14181d; --ink-2:#6b7480; --line:#d6dce3; --accent:#1f4fd8; --warn:#a14b00; --warn-soft:#fbeedd; }
    @media (prefers-color-scheme: dark) { :host { --bg:#171a1f; --ink:#e7eaee; --ink-2:#8a939e; --line:#3a424c; --accent:#86a2ff; --warn:#f2a65a; --warn-soft:#33250f; } }
    .bar { display:flex; align-items:center; gap:6px; background:var(--bg); color:var(--ink); border:1px solid var(--line); border-radius:10px; box-shadow:0 12px 32px rgb(10 20 40 / 0.22); padding:6px 8px; width:340px; animation:rise 140ms ease-out; }
    @keyframes rise { from { opacity:0; transform:translateY(-4px); } }
    input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:var(--ink); font-size:13px; padding:6px 4px; }
    .count { font-variant-numeric:tabular-nums; font-size:12px; color:var(--ink-2); white-space:nowrap; padding:0 2px; }
    button { border:0; background:transparent; color:var(--ink-2); cursor:pointer; font-size:14px; line-height:1; padding:6px 7px; border-radius:6px; }
    button:hover:not(:disabled) { background:rgba(128,136,150,0.16); color:var(--ink); }
    button:disabled { opacity:0.4; cursor:default; }
    .hint { font-size:11.5px; color:var(--ink-2); padding:6px 10px 8px; max-width:340px; }
    .hint.warn { color:var(--warn); background:var(--warn-soft); border-radius:8px; margin:0 4px 6px; padding:6px 8px; }
    .wrap { display:flex; flex-direction:column; align-items:flex-end; }
  `;
  root.append(style);

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'search');

  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.placeholder = t('ps_placeholder');
  input.setAttribute('aria-label', t('ps_placeholder'));

  const count = document.createElement('span');
  count.className = 'count';

  const prevBtn = document.createElement('button');
  prevBtn.textContent = '↑';
  prevBtn.title = t('ps_prev');
  prevBtn.setAttribute('aria-label', t('ps_prev'));
  prevBtn.disabled = true;

  const nextBtn = document.createElement('button');
  nextBtn.textContent = '↓';
  nextBtn.title = t('ps_next');
  nextBtn.setAttribute('aria-label', t('ps_next'));
  nextBtn.disabled = true;

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.title = t('ps_close');
  closeBtn.setAttribute('aria-label', t('ps_close'));

  bar.append(input, count, prevBtn, nextBtn, closeBtn);
  wrap.append(bar);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = t('ps_privacyHint');
  wrap.append(hint);

  root.append(wrap);
  document.documentElement.append(host);
  input.focus();

  if (!hasJevKey) {
    input.disabled = true;
    input.placeholder = t('ps_noKey');
    hint.textContent = t('ps_noKey');
    hint.className = 'hint warn';
  }

  // ---------- Suche ----------
  let hits = [];
  let currentIndex = -1;
  let requestId = 0;
  let timer = null;
  let lastQuery = null;

  function setCurrentEl(el) {
    document.querySelector('.tabwerk-ps-current-el')?.classList.remove('tabwerk-ps-current-el');
    el?.classList.add('tabwerk-ps-current-el');
  }

  function goTo(index) {
    if (!hits.length) return;
    currentIndex = ((index % hits.length) + hits.length) % hits.length;
    const hit = hits[currentIndex];
    const entry = entries[hit.index];
    if (entry) {
      entry.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setCurrentEl(entry.el);
    }
    count.textContent = t('ps_count', String(currentIndex + 1), String(hits.length));
  }

  function showHint(text, warn = false) {
    hint.textContent = text;
    hint.className = warn ? 'hint warn' : 'hint';
  }

  function resetHint() {
    showHint(t('ps_privacyHint'));
  }

  async function runSearch(query) {
    const myRequest = ++requestId;
    lastQuery = query;
    clearHighlights();
    hits = [];
    currentIndex = -1;
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    if (!query) {
      count.textContent = '';
      resetHint();
      return;
    }
    count.textContent = t('ps_searching');
    extract();
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'pageSearch', payload: { query, items, locale: language() } });
    } catch {
      if (myRequest !== requestId) return;
      count.textContent = '';
      showHint(t('ps_error', t('dom_noResponse')), true);
      return;
    }
    if (myRequest !== requestId) return;
    if (!res?.ok) {
      count.textContent = '';
      showHint(t('ps_error', res?.error || t('ps_unknownError')), true);
      return;
    }
    hits = (res.data.hits || []).map((h) => ({ ...h, index: Number(h.id.slice(1)) })).filter((h) => entries[h.index]);
    for (const hit of hits) {
      const entry = entries[hit.index];
      entry.el.setAttribute('data-tabwerk-ps', hit.id);
      highlight(hit, entry);
    }
    if (!hits.length) {
      count.textContent = t('ps_noMatch');
      resetHint();
      return;
    }
    prevBtn.disabled = false;
    nextBtn.disabled = false;
    goTo(0);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value.trim();
    timer = setTimeout(() => runSearch(query), 450);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(timer);
      const query = input.value.trim();
      if (query && query === lastQuery && hits.length) goTo(currentIndex + (event.shiftKey ? -1 : 1));
      else runSearch(query);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  prevBtn.addEventListener('click', () => goTo(currentIndex - 1));
  nextBtn.addEventListener('click', () => goTo(currentIndex + 1));
  closeBtn.addEventListener('click', close);

  // Fängt Esc auch ab, wenn der Fokus auf der Seite liegt, nicht in der Leiste.
  // Die Leiste selbst behandelt Esc schon über den input-Listener.
  function onDocKey(event) {
    if (event.key === 'Escape' && document.activeElement !== host) close();
  }
  document.addEventListener('keydown', onDocKey, true);

  function close() {
    document.removeEventListener('keydown', onDocKey, true);
    clearTimeout(timer);
    clearHighlights();
    styleEl.remove();
    host.remove();
  }
  host.addEventListener('tabwerk-pagesearch-close', close);

  localizeDom(root);

  if (preset && hasJevKey) {
    input.value = preset;
    runSearch(preset.trim());
  }
})();
