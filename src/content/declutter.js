// Seite aufräumen, der Teil auf der Seite. Klassisches Skript, kein Modul, weil Chrome
// registrierte Inhaltsskripte nicht als Modul lädt.
// Nach dem Vorbild von Unclutter (https://github.com/kitze/unclutter, MIT, siehe NOTICE).
//
// Das Skript sammelt Beschreibungen möglicher Störer, fragt den Service Worker nach den
// gespeicherten Regeln und blendet passende Elemente umkehrbar aus. Es klickt nichts,
// gibt keine Einwilligung und liest keine Formularwerte.

(() => {
  if (window.__tabwerkDeclutter) return;
  window.__tabwerkDeclutter = true;

  const POLICY_VERSION = 1;
  const MAX = 60;

  // ---------- Seitentyp ----------

  const hash = (value) => {
    let r = 2166136261;
    for (let i = 0; i < value.length; i++) r = Math.imul(r ^ value.charCodeAt(i), 16777619);
    return (r >>> 0).toString(36);
  };

  function structuredTypes() {
    const found = new Set();
    const visit = (item, depth) => {
      if (!item || typeof item !== 'object' || depth > 6) return;
      if (Array.isArray(item)) { for (const child of item.slice(0, 40)) visit(child, depth + 1); return; }
      const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
      for (const type of types) if (typeof type === 'string') found.add(type.toLowerCase());
      for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage']) visit(item[key], depth + 1);
    };
    for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 10)) {
      try { if ((script.textContent || '').length < 100000) visit(JSON.parse(script.textContent || ''), 0); } catch {}
    }
    return [...found];
  }

  // Gleiche Seitentypen teilen Regeln: Artikel einer Rubrik, Produktseiten eines Shops.
  function pageContext() {
    const url = new URL(location.href);
    const segments = url.pathname.split('/').filter(Boolean);
    const types = structuredTypes();
    const og = document.querySelector('meta[property="og:type"]')?.getAttribute('content') || '';
    const hasArticle = types.some((t) => /article|blogposting/.test(t)) || og === 'article'
      || Boolean(document.querySelector('main article h1, article [itemprop="articleBody"], [itemtype$="Article"]'));
    const isSearch = /^(search|find|suche)$/i.test(segments[0] || '') || url.searchParams.has('q') || url.searchParams.has('s');
    const queryArticle = hasArticle && (url.searchParams.has('p') || url.searchParams.has('article'));
    const kind = isSearch ? 'search'
      : segments.length === 0 && !queryArticle ? 'home'
        : types.includes('product') || og.startsWith('product') ? 'product'
          : hasArticle ? 'article'
            : types.some((t) => /collectionpage|itemlist/.test(t)) ? 'listing' : 'page';
    let route = segments.map((s) => (/^\d+$/.test(s) || /^[a-f\d-]{16,}$/i.test(s) ? ':id' : s));
    if (kind === 'article' || kind === 'product') {
      route = route.filter((_, i) => i === segments.length - 1 || !/^\d{1,4}$/.test(segments[i] || ''));
      if (route.length) route[route.length - 1] = ':detail';
    } else if (route.length > 1 && (route.at(-1) || '').split('-').length >= 4) {
      route[route.length - 1] = ':detail';
    }
    const main = document.querySelector('main, [role="main"]');
    const anchor = main?.getAttribute('data-component') || main?.getAttribute('data-testid') || main?.tagName || 'body';
    const shell = `${anchor.slice(0, 100)}|${document.querySelector('article') ? 'article' : ''}`;
    const routeLabel = `/${route.join('/')}`;
    return {
      key: `${url.origin}|v${POLICY_VERSION}|${hash(`${kind}|${routeLabel}|${shell}`)}`,
      label: `${kind} · ${routeLabel}`.slice(0, 200),
      origin: url.origin,
      kind,
    };
  }

  // ---------- Kandidaten und Schutz ----------

  const structural = 'html,body,main,article,nav,[role="main"],[role="navigation"]';
  const sensitive = 'input[type="password"],input[type="email"],input[type="text"],input:not([type]),textarea,[contenteditable="true"]';
  const protectedSelector = `${structural},header,h1,form,input,textarea,select,[contenteditable="true"],dialog`;
  const clutter = /(?:^|[-_\s])(?:ad|ads|advert|advertisement|advertising|sponsor|sponsored|promo|promotion|banner|newsletter|subscribe|subscription|upsell|popup|modal|overlay|share|social|recommendations|recommended|related|trending|popular|outbrain|taboola|teaser|comments?|disqus|discussion|cookie|consent)(?:$|[-_\s])/i;
  // Kommentarbereiche enthalten <article> und ein Antwortfeld. Sie bekommen einen eigenen, engeren Schutz.
  const commentArea = /comments?|disqus|discussion/i;
  const commentProtected = 'html,body,main,nav,h1,[role="main"],[role="navigation"],input[type="password"],dialog';
  const guarded = /paywall|sign[-_ ]?in|log[-_ ]?in|captcha|checkout|payment/i;
  const consentPrefixes = ['sp_message_container_', 'sp_message_iframe_'];
  const stable = (v) => v.length >= 3 && v.length < 90 && /^[a-zA-Z_][\w-]*$/.test(v) && !/\d{4}|[a-f0-9]{8}|^(css|sc|jsx)-/i.test(v);
  const identity = (el) => `${el.id} ${el.getAttribute('class') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('data-component') || ''}`;

  function isCookieNotice(el) {
    if (consentPrefixes.some((p) => el.id.startsWith(p))) return true;
    if (/cookie|consent|onetrust|didomi|privacy[-_ ]?(?:manager|modal|dialog)/i.test(identity(el))) return true;
    if (!el.matches('[role="dialog"],[aria-modal="true"]')) return false;
    const text = el.textContent || '';
    return /cookies|consent|privacy choices|datenschutz/i.test(text) && /accept|reject|agree|manage|preferences|akzeptieren|ablehnen|einstellungen/i.test(text);
  }

  function isProtected(el) {
    const cookie = isCookieNotice(el);
    if (!cookie && commentArea.test(identity(el))) {
      if (el.matches(commentProtected) || el.querySelector(commentProtected)) return true;
      if (el.closest('[contenteditable="true"]') || guarded.test(identity(el))) return true;
      return (el.textContent || '').length > 50000;
    }
    const selector = cookie ? `${structural},${sensitive},dialog` : protectedSelector;
    if (el.matches(selector) || el.querySelector(selector)) return true;
    if (el.closest('[contenteditable="true"]') || (!cookie && el.closest('form'))) return true;
    if (guarded.test(identity(el))) return true;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (/sign in to continue|subscribe to (?:read|continue)|verify you are human|anmelden, um weiterzulesen/i.test(text)) return true;
    if (cookie) return text.length > 20000;
    return text.length > 2000 || [...el.querySelectorAll('p')].some((p) => (p.textContent || '').length > 600);
  }

  // Nur einfache, stabile Selektoren. Nie Positionen, nie etwas, das Jev geschrieben hat.
  function matching(selector) {
    const ordinary = /^[a-z][a-z0-9-]*(?:\[data-(?:testid|component|test|qa)="[\w-]{3,89}"\]|#[\w-]{3,89}|\.[\w-]{3,89})$/;
    const consent = /^(?:div|iframe)\[id\^="(sp_message_container_|sp_message_iframe_)"\]$/;
    if (!ordinary.test(selector) && !consent.test(selector)) return [];
    try {
      const els = [...document.querySelectorAll(selector)];
      return els.length > 20 || els.some(isProtected) ? [] : els;
    } catch {
      return [];
    }
  }

  function selectorFor(el) {
    const tag = el.tagName.toLowerCase();
    const options = [];
    const prefix = consentPrefixes.find((p) => el.id.startsWith(p));
    if (prefix && ['div', 'iframe'].includes(tag)) options.push(`${tag}[id^="${prefix}"]`);
    for (const attr of ['data-testid', 'data-component', 'data-test', 'data-qa']) {
      const v = el.getAttribute(attr);
      if (v && stable(v)) options.push(`${tag}[${attr}="${v}"]`);
    }
    if (stable(el.id)) options.push(`${tag}#${el.id}`);
    options.push(...[...el.classList].filter(stable).sort((a, b) => Number(clutter.test(b)) - Number(clutter.test(a))).map((c) => `${tag}.${c}`));
    return options.find((s) => matching(s).includes(el)) || null;
  }

  const redact = (text) => text
    .replace(/https?:\/\/\S+/g, '[URL]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/\b(?:\d[ -]?){8,}\b/g, '[number]');

  function candidates(keywords) {
    const own = (keywords || []).filter((w) => /^[a-z0-9_-]{3,40}$/.test(w));
    const extra = own.length ? new RegExp(own.join('|'), 'i') : null;
    // Einwilligungs-Dialoge hängen oft ganz am Ende, nach Tausenden Knoten.
    const priority = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[id^="sp_message_"],[id*="cookie" i],[id*="consent" i],#onetrust-banner-sdk,#didomi-host')].slice(0, 100);
    const all = [...new Set([...priority, ...[...document.querySelectorAll('aside,section,div,[role="dialog"],iframe')].slice(0, 6000)])];
    const seen = new Set();
    const out = [];
    for (const el of all) {
      if (out.length >= MAX) break;
      const cookie = isCookieNotice(el);
      const signals = `${cookie ? 'Cookie consent overlay. Hide visually only; do not accept or reject consent. ' : ''}${identity(el)} ${el.getAttribute('role') || ''}`;
      const position = getComputedStyle(el).position;
      if (!cookie && !clutter.test(signals) && !extra?.test(signals) && !el.matches('aside,[role="dialog"],iframe') && !['fixed', 'sticky'].includes(position)) continue;
      if (isProtected(el)) continue;
      const selector = selectorFor(el);
      if (!selector || seen.has(selector)) continue;
      seen.add(selector);
      const copy = el.cloneNode(true);
      copy.querySelectorAll('script,style,noscript,svg,input,textarea,select,[contenteditable]').forEach((n) => n.remove());
      out.push({
        id: `e${out.length}`,
        selector,
        tag: el.tagName.toLowerCase(),
        signals: redact(signals).replace(/\s+/g, ' ').trim().slice(0, 300),
        text: redact((copy.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 450),
        position,
        count: matching(selector).length || 1,
      });
    }
    return out;
  }

  // ---------- Ausblenden, umkehrbar ----------

  const emptyLabel = /^(?:advertisement|advertising|advert|ad|anzeige|werbung|sponsored|sponsored content)?$/i;
  function emptyAfterHiding(el, hidden, depth = 0) {
    if (hidden.has(el) || el.matches('script,style,noscript,template')) return true;
    if (depth > 8 || el.matches('img,video,audio,canvas,svg,iframe,button,input,select,textarea,[role="button"]')) return false;
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none') return false;
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && !emptyLabel.test((node.textContent || '').trim())) return false;
      if (node.nodeType === 1 && !emptyAfterHiding(node, hidden, depth + 1)) return false;
    }
    return true;
  }

  // Leere Werbe-Hüllen um ein ausgeblendetes Element fallen mit weg, nützliche Nachbarn nicht.
  function collapseTargets(roots) {
    const next = new Set(roots);
    for (const root of roots) {
      let parent = root.parentElement;
      for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
        if (!parent.matches('div,section,aside') || isProtected(parent) || !emptyAfterHiding(parent, next)) break;
        next.add(parent);
      }
    }
    return next;
  }

  const attribute = `data-tabwerk-hide-${Math.random().toString(36).slice(2, 10)}`;
  const style = document.createElement('style');
  style.textContent = `[${attribute}]{display:none!important;min-height:0!important;height:0!important;margin:0!important;padding:0!important}`;
  const marked = new Set();
  const overrides = new Map();

  function release(el, prop) {
    const saved = overrides.get(el)?.get(prop);
    if (!saved) return;
    if (el.style.getPropertyValue(prop) === saved.applied && el.style.getPropertyPriority(prop) === saved.appliedPriority) {
      if (saved.value) el.style.setProperty(prop, saved.value, saved.priority);
      else el.style.removeProperty(prop);
    }
    overrides.get(el).delete(prop);
    if (!overrides.get(el).size) overrides.delete(el);
  }

  function override(el, prop, value) {
    const props = overrides.get(el) || new Map();
    const prev = props.get(prop);
    if (!prev || el.style.getPropertyValue(prop) !== prev.applied || el.style.getPropertyPriority(prop) !== prev.appliedPriority) {
      const original = { value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) };
      el.style.setProperty(prop, value, 'important');
      props.set(prop, { ...original, applied: value, appliedPriority: el.style.getPropertyPriority(prop) });
      overrides.set(el, props);
    }
  }

  function restore() {
    for (const el of marked) el.removeAttribute(attribute);
    marked.clear();
    for (const [el, props] of overrides) for (const prop of [...props.keys()]) release(el, prop);
    style.remove();
  }

  function apply(rules) {
    const roots = [...new Set(rules.flatMap((r) => matching(r.selector)))];
    const next = collapseTargets(roots);
    const contains = (el) => [...next].some((h) => h === el || h.contains(el));
    const overlay = roots.some((el) => isCookieNotice(el) || getComputedStyle(el).position === 'fixed');
    // Nie hinter einem fremden offenen Dialog entsperren, etwa Login oder Zahlung.
    const otherModal = [...document.querySelectorAll('dialog[open],[aria-modal="true"],[role="dialog"]')]
      .some((el) => !contains(el) && getComputedStyle(el).display !== 'none' && !el.hasAttribute('hidden'));
    for (const el of [...marked]) {
      if (next.has(el)) continue;
      el.removeAttribute(attribute);
      if (el.style) release(el, 'display');
      marked.delete(el);
    }
    for (const el of next) {
      if (!marked.has(el)) { el.setAttribute(attribute, ''); marked.add(el); }
      if (el.style) override(el, 'display', 'none');
    }
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      if (overlay && !otherModal) {
        const cs = getComputedStyle(el);
        for (const prop of ['overflow-x', 'overflow-y']) {
          if (/hidden|clip/.test(cs.getPropertyValue(prop)) || overrides.get(el)?.has(prop)) override(el, prop, 'auto');
        }
      } else {
        release(el, 'overflow-x');
        release(el, 'overflow-y');
      }
    }
    if (marked.size && !style.isConnected) (document.head || document.documentElement).append(style);
    if (!marked.size) style.remove();
    return [...next].filter((el) => ![...next].some((p) => p !== el && p.contains(el))).length;
  }

  // ---------- Ablauf ----------

  let state = { context: pageContext(), profile: null, enabled: false, hiddenCount: 0, rules: [] };
  let revision = 0;
  let timer;
  let autoTimer;
  let lastUrl = location.href;
  const autoAsked = new Set();
  let dead = false;

  const ask = (type, payload) => chrome.runtime.sendMessage({ type, payload }).then((r) => {
    if (!r?.ok) throw new Error(r?.error || 'no response');
    return r.data;
  });

  function requestAuto(auto) {
    const key = state.context.key;
    if (!auto || document.visibilityState !== 'visible' || autoAsked.has(key)) return;
    autoAsked.add(key);
    clearTimeout(autoTimer);
    // Banner und Werbung, die per Skript kommen, bekommen kurz Zeit. Änderungen am DOM lösen nie eine weitere Anfrage aus.
    autoTimer = setTimeout(() => {
      if (dead || pageContext().key !== key) return;
      ask('declutter:visit', { context: state.context }).catch(() => {});
    }, 1500);
  }

  async function sync() {
    const version = ++revision;
    const context = pageContext();
    if (context.key !== state.context.key || lastUrl !== location.href) { restore(); state.hiddenCount = 0; }
    lastUrl = location.href;
    const result = await ask('declutter:sync', { context });
    if (version !== revision || dead) return state;
    if (result.stop) { shutdown(); return { ...state, enabled: false, hiddenCount: 0 }; }
    state = { context, profile: result.profile, enabled: result.enabled, rules: result.rules, hiddenCount: 0 };
    state.hiddenCount = result.enabled ? apply(result.rules) : (restore(), 0);
    await ask('declutter:count', { context, hiddenCount: state.hiddenCount }).catch(() => {});
    requestAuto(result.auto);
    return state;
  }

  // Gibt die Seite frei und hört auf. Einschalten oder eine Analyse spritzt das Skript neu ein.
  function shutdown() {
    dead = true;
    clearInterval(orphaned);
    clearInterval(urlWatch);
    observer.disconnect();
    clearTimeout(timer);
    clearTimeout(autoTimer);
    restore();
    chrome.runtime.onMessage?.removeListener(onMessage);
    window.__tabwerkDeclutter = false;
  }

  const safeSync = () => sync().catch(() => { restore(); });
  const schedule = () => { clearTimeout(timer); timer = setTimeout(safeSync, 180); };

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'id', 'data-testid', 'data-component', 'content', 'style'],
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') safeSync(); });
  // Seiten, die ohne Neuladen die Adresse wechseln.
  let seenUrl = location.href;
  const urlWatch = setInterval(() => {
    if (location.href === seenUrl) return;
    seenUrl = location.href;
    revision++;
    restore();
    state.hiddenCount = 0;
    schedule();
  }, 500);

  function onMessage(message, sender, reply) {
    if (sender.id !== chrome.runtime.id || !message?.type?.startsWith('declutter:')) return false;
    const run = async () => {
      if (message.type === 'declutter:ping') return { ok: true };
      if (message.type === 'declutter:refresh') return sync();
      if (message.type === 'declutter:snapshot') {
        return { context: pageContext(), candidates: candidates(message.keywords), url: location.href };
      }
      throw new Error('unknown');
    };
    run().then((data) => reply({ ok: true, data }), () => reply({ ok: false, error: 'page' }));
    return true;
  }
  chrome.runtime.onMessage.addListener(onMessage);

  // Wird die Erweiterung neu geladen oder entfernt, hört das alte Skript auf und gibt die Seite frei.
  // Kein Port dafür: Chrome trennt Ports auch, wenn der Service Worker nur schläft.
  const orphaned = setInterval(() => { if (!chrome.runtime?.id) shutdown(); }, 2000);

  safeSync();
})();
