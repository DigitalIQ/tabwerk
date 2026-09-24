// Formular für einen neuen Wächter. Popup und Kontextmenü-Fenster nutzen dasselbe Formular.

import { h, icon, send } from './dom.js';
import { hasNumericCondition } from '../lib/diff.js';
import { PRESETS, MIN_SECONDS, parseDuration, formatDuration } from '../lib/duration.js';
import { parseNumber } from '../lib/numbers.js';

export function watchForm({ url = '', condition = '', selection = '', numbers = false, onDone } = {}) {
  const urlInput = h('input', { type: 'url', required: true, value: url, 'aria-label': 'Seite' });
  const cond = h('textarea', { required: true, placeholder: 'der Kopfhörer wieder lieferbar ist' });
  cond.value = condition;
  const numHint = h('p', { class: 'help', hidden: !hasNumericCondition(condition) }, icon('info'),
    ' Jev rechnet nicht genau. Bei Zahlen und Preisen erkennt es die Änderung, vergleicht aber keine Beträge.');
  cond.addEventListener('input', () => { numHint.hidden = !hasNumericCondition(cond.value); });

  const select = h('select', { 'aria-label': 'Prüfen alle' },
    ...PRESETS.map((p) => h('option', { value: String(p.minutes), selected: p.minutes === 60 }, p.label)),
    h('option', { value: 'custom' }, 'Individuell …'));
  const custom = h('input', { type: 'text', class: 'mono', placeholder: 'hh:mm:ss', value: '00:30:00', inputmode: 'numeric', 'aria-label': 'Eigenes Intervall', pattern: '\\d{1,3}:\\d{2}:\\d{2}' });
  const customRow = h('label', { class: 'field', hidden: true }, h('span', {}, 'Eigenes Intervall (hh:mm:ss, mindestens 00:00:30)'), custom);
  select.addEventListener('change', () => { customRow.hidden = select.value !== 'custom'; if (!customRow.hidden) custom.focus(); });

  // Zahlen-Wächter: Code vergleicht exakt, Jev sucht nur die gemeinte Zahl auf der Seite.
  const numOn = h('input', { type: 'checkbox' });
  const op = h('select', { 'aria-label': 'Vergleich' },
    h('option', { value: 'below' }, 'unter'), h('option', { value: 'atmost' }, 'höchstens'),
    h('option', { value: 'above' }, 'über'), h('option', { value: 'atleast' }, 'mindestens'));
  const limit = h('input', { type: 'text', inputmode: 'decimal', class: 'mono', placeholder: '199,99', 'aria-label': 'Grenze' });
  const numRow = h('div', { class: 'num-row', hidden: true }, op, limit);
  numOn.addEventListener('change', () => { numRow.hidden = !numOn.checked; numHint.hidden = numOn.checked || !hasNumericCondition(cond.value); });
  const numBlock = numbers ? h('div', { class: 'num-block' },
    h('label', { class: 'check' }, numOn, 'Zahl oder Preis exakt vergleichen'), numRow) : null;

  const error = h('p', { class: 'error-text', hidden: true });
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Wächter anlegen');

  const fail = (text) => {
    error.textContent = text;
    error.hidden = false;
  };

  const form = h('form', { class: 'watch-form' },
    h('label', { class: 'field' }, h('span', {}, 'Seite'), urlInput),
    selection ? h('blockquote', { class: 'quote' }, h('span', { class: 'faint' }, 'Markiert: '), `„${selection}“`) : null,
    h('label', { class: 'field' }, h('span', {}, 'Sag mir Bescheid, wenn …'), cond),
    numHint,
    numBlock,
    h('label', { class: 'field' }, h('span', {}, 'Prüfen alle'), select),
    customRow,
    error,
    submit);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    let origin;
    try {
      const u = new URL(urlInput.value.trim());
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      origin = u.origin;
    } catch {
      fail('Gib eine Adresse mit http:// oder https:// ein.');
      return;
    }
    if (!cond.value.trim()) {
      fail('Beschreib, worauf Tabwerk achten soll.');
      return;
    }
    let intervalMin;
    if (select.value === 'custom') {
      const seconds = parseDuration(custom.value);
      if (seconds === null) {
        fail('Schreib das Intervall als hh:mm:ss, zum Beispiel 00:10:00.');
        return;
      }
      if (seconds < MIN_SECONDS) {
        fail(`Chrome prüft höchstens alle 30 Sekunden. Du hast ${formatDuration(seconds)} eingetragen.`);
        return;
      }
      intervalMin = seconds / 60;
    } else {
      intervalMin = Number(select.value);
    }
    let number = null;
    if (numbers && numOn.checked) {
      const value = parseNumber(limit.value);
      if (value === null) {
        fail('Trag die Grenze als Zahl ein, zum Beispiel 199,99.');
        return;
      }
      number = { op: op.value, limit: value };
    }
    // Die Leseerlaubnis gilt nur für diese eine Website.
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) {
      fail('Ohne Leseerlaubnis für diese Website kann Tabwerk nicht prüfen.');
      return;
    }
    submit.disabled = true;
    try {
      const watch = await send('createWatch', { url: urlInput.value.trim(), condition: cond.value, intervalMin, number });
      cond.value = '';
      onDone?.(watch);
    } catch (e) {
      fail(e.message);
    } finally {
      submit.disabled = false;
    }
  });

  return form;
}
