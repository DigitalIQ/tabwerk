// Erlaubt Kopieren, Einfügen, Markieren und Rechtsklick auf Seiten, die das sperren.
// Läuft in der Welt der Seite (world: MAIN), damit auch per Skript gesetzte Sperren fallen.
// Tabwerk hängt sich vor die Sperren der Seite und hält deren Handler für diese Ereignisse an.
(() => {
  if (window.__tabwerkUnlocked) return;
  window.__tabwerkUnlocked = true;

  const TYPES = ['copy', 'cut', 'paste', 'beforecopy', 'beforecut', 'beforepaste', 'contextmenu', 'selectstart', 'dragstart'];
  const stop = (event) => event.stopImmediatePropagation();
  for (const type of TYPES) window.addEventListener(type, stop, true);

  // Nur die Tastenkürzel zum Kopieren und Einfügen. Andere Tastenkürzel der Seite bleiben.
  const KEYS = new Set(['a', 'c', 'v', 'x']);
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && KEYS.has((event.key || '').toLowerCase())) event.stopImmediatePropagation();
  }, true);

  const style = document.createElement('style');
  style.textContent = '*,*::before,*::after{-webkit-user-select:text!important;user-select:text!important}';
  (document.head || document.documentElement).append(style);

  const ATTRS = ['oncopy', 'oncut', 'onpaste', 'oncontextmenu', 'onselectstart', 'ondragstart'];
  const clear = () => {
    for (const target of [window, document, document.documentElement, document.body]) {
      if (!target) continue;
      for (const a of ATTRS) { try { target[a] = null; } catch {} }
    }
    for (const el of document.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(','))) {
      for (const a of ATTRS) el.removeAttribute(a);
    }
  };
  clear();
  document.addEventListener('DOMContentLoaded', clear);
  window.addEventListener('load', clear);
})();
