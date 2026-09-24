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
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('src/palette/palette.html');
  frame.title = 'Tabwerk Schnellsuche';
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
