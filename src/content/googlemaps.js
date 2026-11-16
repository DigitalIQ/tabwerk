// Ergänzt ausschließlich die Suchnavigation. Suchbegriffe bleiben lokal bis zum Klick.
(() => {
  if (window.__tabwerkGoogleMaps) { window.__tabwerkGoogleMaps.refresh(); return; }

  let enabled = false;
  let revision = 0;
  let timer;
  let item;
  let link;
  const own = 'data-tabwerk-google-maps';
  const navigation = '#hdtb-sc, #hdtb-msb, [role="navigation"], [role="tablist"]';
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const googleHost = (host) => /^(?:www\.|maps\.)?google\.(?:com|de|at|ch)$/.test(host);

  function searchURL() {
    const url = new URL(location.href);
    return url.protocol === 'https:' && /^www\.google\.(?:com|de|at|ch)$/.test(url.hostname)
      && url.pathname === '/search' ? url : null;
  }

  function mapsURL() {
    const query = searchURL()?.searchParams.get('q');
    if (!query?.trim()) return null;
    const url = new URL('https://www.google.com/maps/search/');
    url.searchParams.set('api', '1');
    url.searchParams.set('query', query);
    return url.href;
  }

  function isMaps(anchor) {
    try {
      const url = new URL(anchor.href, location.href);
      return googleHost(url.hostname) && (/^\/maps(?:\/|$)/.test(url.pathname)
        || url.hostname.startsWith('maps.') || url.searchParams.get('tbm') === 'map');
    } catch { return false; }
  }

  function isSearchTab(anchor) {
    try {
      const url = new URL(anchor.href, location.href);
      return url.origin === location.origin && url.pathname === '/search'
        && url.searchParams.get('udm') !== '50'
        && (url.searchParams.has('udm') || url.searchParams.has('tbm'));
    } catch { return false; }
  }

  function remove() {
    item?.remove();
    for (const stale of document.querySelectorAll(`[${own}]`)) stale.remove();
    item = link = null;
  }

  function update() {
    if (!enabled) return;
    const href = mapsURL();
    if (!href) { remove(); return; }
    const navs = [...document.querySelectorAll(navigation)].filter(visible);
    // Google kann eine Navigation samt unserem Element kopieren und die alte ersetzen.
    for (const stale of document.querySelectorAll(`[${own}]`)) if (stale !== item) stale.remove();
    if (navs.some((nav) => [...nav.querySelectorAll('a[href]')].some((a) => !a.closest(`[${own}]`) && visible(a) && isMaps(a)))) {
      remove(); return;
    }
    if (item?.isConnected && navs.some((nav) => nav.contains(item))) {
      if (link.href !== href) link.href = href;
      return;
    }
    remove();
    const template = navs.flatMap((nav) => [...nav.querySelectorAll('a[href]')])
      .find((a) => visible(a) && isSearchTab(a) && a.getAttribute('aria-current') !== 'page' && a.getAttribute('aria-selected') !== 'true');
    if (!template) return;

    const nav = template.closest(navigation);
    const all = [...nav.querySelectorAll('a, span, div, [role="tab"]')]
      .find((el) => visible(el) && /^(Alle|All)$/.test(el.textContent.trim()));
    let row = template.closest('[role="list"], [role="tablist"], #hdtb-msb') || template.parentElement;
    if (all) while (row.parentElement && !row.contains(all)) row = row.parentElement;
    const directChild = (element) => {
      while (element.parentElement && element.parentElement !== row) element = element.parentElement;
      return element;
    };
    const source = directChild(template);
    const after = all ? directChild(all) : null;

    // Die Textstruktur trägt bei Google oft Padding und Höhe. Nur diesen Pfad nachbauen,
    // ohne Handler, Tracking, IDs, Icons oder den aktiven Zustand eines anderen Tabs.
    const walker = document.createTreeWalker(template, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (text.textContent.trim() && !text.parentElement.closest('svg, script, style, [aria-hidden="true"]')) break;
    }
    let label = text?.parentElement || template;
    const path = [];
    for (let element = label; element; element = element.parentElement) {
      path.unshift(element);
      if (element === source) break;
    }
    let parent;
    for (const original of path) {
      const tag = original === template ? 'a' : ['DIV', 'SPAN', 'LI'].includes(original.tagName) ? original.tagName.toLowerCase() : 'span';
      const copy = document.createElement(tag);
      copy.className = original.className;
      if (original.hasAttribute('style')) copy.setAttribute('style', original.getAttribute('style'));
      if (original.getAttribute('role') === 'listitem') copy.setAttribute('role', 'listitem');
      if (parent) parent.append(copy); else item = copy;
      if (original === template) link = copy;
      parent = copy;
    }
    parent.textContent = 'Maps';
    link.href = href;
    link.title = 'Google Maps';
    link.setAttribute('aria-label', 'Google Maps');
    link.style.whiteSpace = 'nowrap';
    item.style.flexShrink = '0';
    link.addEventListener('click', () => { const current = mapsURL(); if (current) link.href = current; });
    item.setAttribute(own, '');
    if (after) after.after(item); else source.before(item);
  }

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(update, 100);
  });

  function stop() {
    revision++;
    enabled = false;
    observer.disconnect();
    clearTimeout(timer);
    remove();
  }

  async function refresh() {
    const current = ++revision;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'googleMapsState', payload: { url: location.href } });
      if (current !== revision) return;
      if (!result?.ok || !result.data?.enabled) { stop(); return; }
      enabled = true;
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
      update();
    } catch { if (current === revision) stop(); }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'googleMaps:stop') stop();
  });
  window.addEventListener('popstate', () => { if (enabled) update(); });
  window.__tabwerkGoogleMaps = { refresh };
  refresh();
})();
