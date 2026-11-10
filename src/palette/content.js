// Wird per Tastenkürzel in die aktive Seite gespritzt. Legt die Schnellsuche als iFrame über die Seite.
// Ein zweiter Druck auf das Kürzel schließt sie wieder.
(() => {
  const query = window.__tabwerkPaletteQuery;
  const token = window.__tabwerkPaletteToken;
  window.__tabwerkPaletteQuery = undefined;
  window.__tabwerkPaletteToken = undefined;
  if (window.__tabwerkClosePalette?.()) return;

  function focusedElement(root = document) {
    const el = root.activeElement;
    if (!el || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el;
    const inner = el.contentDocument || chrome.dom?.openOrClosedShadowRoot?.(el);
    return inner?.activeElement ? focusedElement(inner) : el;
  }

  function refocus(el) {
    if (!el?.isConnected) return false;
    // Ein eingebetteter Editor kann im eigenen Dokument noch als fokussiert gelten.
    el.ownerDocument.defaultView?.frameElement?.focus({ preventScroll: true });
    el.focus({ preventScroll: true });
    return focusedElement() === el;
  }

  function rememberEditor(el) {
    if (!el) return null;
    const doc = el.ownerDocument;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const writable = () => el.type !== 'password' && !el.readOnly && !el.matches(':disabled') && el.selectionStart !== null;
      if (!writable()) return null;
      const { value, selectionStart, selectionEnd, selectionDirection } = el;
      return (emoji) => {
        if (!el.isConnected || !writable() || el.value !== value) return false;
        if (!refocus(el) || !writable() || el.value !== value) return false;
        if (el.maxLength >= 0 && value.length - (selectionEnd - selectionStart) + emoji.length > el.maxLength) return false;
        el.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
        // Chrome erzeugt dabei ein input-Event und behält die Undo-Historie.
        return doc.execCommand('insertText', false, emoji);
      };
    }
    if (!el.isContentEditable) return null;
    const root = el.getRootNode();
    const selection = root.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0).cloneRange();
    if (!el.contains(range.commonAncestorContainer)) return null;
    return (emoji) => {
      if (!el.isConnected || !el.isContentEditable || !el.contains(range.commonAncestorContainer)) return false;
      if (!refocus(el) || !el.contains(range.commonAncestorContainer)) return false;
      selection.removeAllRanges();
      selection.addRange(range);
      return doc.execCommand('insertText', false, emoji);
    };
  }

  const previousFocus = focusedElement();
  const insertEmoji = rememberEditor(previousFocus);
  const host = document.createElement('div');
  host.id = 'tabwerk-palette-host';
  // Milchglas: die Seite bleibt zu gut 85 % sichtbar, nur weichgezeichnet.
  // Der Effekt liegt hier auf der Seite, denn ein iFrame kann den Inhalt dahinter nicht weichzeichnen.
  host.style.cssText = [
    'all:initial', 'position:fixed', 'inset:0', 'z-index:2147483647',
    'background:rgba(128,136,150,0.14)',
    'backdrop-filter:blur(9px) saturate(1.25)', '-webkit-backdrop-filter:blur(9px) saturate(1.25)',
  ].join(';');
  // Hell oder dunkel? Hintergrundfarbe der Seite messen, sonst ihr color-scheme lesen.
  const siteIsDark = () => {
    const rgb = (el) => {
      if (!el) return null;
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return null;
      return [m[1], m[2], m[3]].map((v) => Number(v) / 255);
    };
    const c = rgb(document.body) || rgb(document.documentElement);
    if (!c) return /(^|\s)dark/.test(getComputedStyle(document.documentElement).colorScheme || '') && !/light/.test(getComputedStyle(document.documentElement).colorScheme || '');
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] < 0.4;
  };
  const params = new URLSearchParams({
    site: siteIsDark() ? 'dark' : 'light',
    sys: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  });
  // Die Schnellsuche kann mit einer Eingabe starten, etwa „/f “ für Formulare.
  if (query) params.set('q', query);
  const frame = document.createElement('iframe');
  const paletteUrl = chrome.runtime.getURL('src/palette/palette.html');
  const paletteOrigin = new URL(paletteUrl).origin;
  frame.src = `${paletteUrl}?${params}`;
  frame.allow = 'clipboard-write';
  frame.title = chrome.i18n.getMessage('pal_title') || 'Tabwerk Schnellsuche';
  // color-scheme muss beim iFrame-Element und im Dokument darin gleich sein, sonst malt Chrome
  // bei dunklen Seiten (etwa GitHub) einen deckenden Hintergrund. Das Dunkel-Design der Suche
  // hängt an prefers-color-scheme und bleibt davon unberührt.
  frame.style.cssText = 'all:initial;display:block;width:100%;height:100%;border:0;color-scheme:light;background:transparent;';
  frame.setAttribute('allowtransparency', 'true');
  host.appendChild(frame);
  document.documentElement.appendChild(host);
  frame.addEventListener('load', () => {
    // Nur der eigene iFrame mit Tabwerks Origin bekommt das Token, siehe background.js.
    frame.contentWindow.postMessage({ tabwerkToken: token }, paletteOrigin);
    frame.focus();
  }, { once: true });
  const onMessage = (event) => {
    if (event.source === frame.contentWindow && event.origin === paletteOrigin && event.data?.tabwerk === 'close') {
      dismiss(event.data.restoreFocus === true);
    }
  };
  const onInsert = (message, sender, reply) => {
    if (message?.type !== 'paletteInsertEmoji' || sender.id !== chrome.runtime.id || sender.url?.split('?')[0] !== paletteUrl
      || typeof token !== 'string' || message.token !== token || !host.isConnected) return false;
    let inserted = false;
    if (insertEmoji && typeof message.emoji === 'string' && message.emoji.length <= 32) {
      try { inserted = insertEmoji(message.emoji); } catch {}
      if (!inserted) frame.focus();
    }
    reply({ inserted });
    return false;
  };
  function dismiss(restoreFocus = false) {
    const wasOpen = host.isConnected;
    window.removeEventListener('message', onMessage);
    chrome.runtime.onMessage.removeListener(onInsert);
    window.__tabwerkClosePalette = undefined;
    host.remove();
    if (restoreFocus) refocus(previousFocus);
    return wasOpen;
  }
  window.__tabwerkClosePalette = dismiss;
  window.addEventListener('message', onMessage);
  chrome.runtime.onMessage.addListener(onInsert);
})();
