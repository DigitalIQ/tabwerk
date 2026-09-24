// Fenster aus dem Kontextmenü: Wächter für die Seite, einen Link oder markierten Text anlegen.
import { h, icon } from '../ui/dom.js';
import { watchForm } from '../ui/watchform.js';
import { getSettings } from '../lib/settings.js';
import { isOn } from '../lib/flags.js';

const settings = await getSettings();

const params = new URLSearchParams(location.search);
const selection = (params.get('sel') || '').trim();
const condition = selection ? `sich der Abschnitt „${selection}“ ändert` : '';

document.querySelector('#slot').append(watchForm({
  url: params.get('url') || '',
  condition,
  selection,
  numbers: isOn(settings, 'watchNumbers'),
  onDone: (watch) => {
    document.querySelector('#slot').replaceChildren(h('div', { class: 'done' },
      icon('check'), h('b', {}, 'Wächter angelegt.'), h('span', {}, `Tabwerk prüft ${watch.site} und meldet sich.`)));
    setTimeout(() => window.close(), 1400);
  },
}));
document.querySelector('textarea')?.focus();
