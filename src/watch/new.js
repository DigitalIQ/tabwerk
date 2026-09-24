// Fenster aus dem Kontextmenü: Wächter für die Seite, einen Link oder markierten Text anlegen.
import { h, icon } from '../ui/dom.js';
import { watchForm } from '../ui/watchform.js';
import { getSettings } from '../lib/settings.js';
import { isOn } from '../lib/flags.js';
import { t, initI18n, localizeDom } from '../lib/i18n.js';

await initI18n();
localizeDom();

const settings = await getSettings();

const params = new URLSearchParams(location.search);
const selection = (params.get('sel') || '').trim();
const condition = selection ? t('wnew_sectionChanges', selection) : '';

document.querySelector('#slot').append(watchForm({
  url: params.get('url') || '',
  condition,
  selection,
  numbers: isOn(settings, 'watchNumbers'),
  onDone: (watch) => {
    document.querySelector('#slot').replaceChildren(h('div', { class: 'done' },
      icon('check'), h('b', {}, t('wnew_created')), h('span', {}, t('wnew_willCheck', watch.site))));
    setTimeout(() => window.close(), 1400);
  },
}));
document.querySelector('textarea')?.focus();
