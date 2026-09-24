// Wird per Tastenkürzel in die aktive Seite gespritzt. Legt die Schnellsuche als iFrame über die Seite.
// Ein zweiter Druck auf das Kürzel schließt sie wieder.
(() => {
  const ID = 'tabwerk-palette-host';
  const existing = document.getElementById(ID);
  if (existing) {
    existing.remove();
    return;
  }
  const host = document.createElement('div');
  host.id = ID;
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
  if (window.__tabwerkPaletteQuery) params.set('q', window.__tabwerkPaletteQuery);
  window.__tabwerkPaletteQuery = undefined;
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL(`src/palette/palette.html?${params}`);
  frame.allow = 'clipboard-write';
  frame.title = chrome.i18n.getMessage('pal_title') || 'Tabwerk Schnellsuche';
  // color-scheme muss beim iFrame-Element und im Dokument darin gleich sein, sonst malt Chrome
  // bei dunklen Seiten (etwa GitHub) einen deckenden Hintergrund. Das Dunkel-Design der Suche
  // hängt an prefers-color-scheme und bleibt davon unberührt.
  frame.style.cssText = 'all:initial;display:block;width:100%;height:100%;border:0;color-scheme:light;background:transparent;';
  frame.setAttribute('allowtransparency', 'true');
  host.appendChild(frame);
  document.documentElement.appendChild(host);
  frame.addEventListener('load', () => frame.focus());
  const onMessage = (event) => {
    if (event.source !== frame.contentWindow || event.data?.tabwerk !== 'close') return;
    host.remove();
    window.removeEventListener('message', onMessage);
  };
  window.addEventListener('message', onMessage);
})();
