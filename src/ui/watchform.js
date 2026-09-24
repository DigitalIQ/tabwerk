// Formular für einen neuen Wächter. Popup und Kontextmenü-Fenster nutzen dasselbe Formular.

import { h, icon, send } from './dom.js';
import { hasNumericCondition } from '../lib/diff.js';
import { PRESETS, MIN_SECONDS, parseDuration, formatDuration } from '../lib/duration.js';
import { parseNumber } from '../lib/numbers.js';
import { t } from '../lib/i18n.js';

export function watchForm({ url = '', condition = '', selection = '', numbers = false, onDone } = {}) {
  const urlInput = h('input', { type: 'url', required: true, value: url, 'aria-label': t('wf_page') });
  const cond = h('textarea', { required: true, placeholder: t('wf_conditionPlaceholder') });
  cond.value = condition;
  const numHint = h('p', { class: 'help', hidden: !hasNumericCondition(condition) }, icon('info'),
    ` ${t('wf_numericHint')}`);
  cond.addEventListener('input', () => { numHint.hidden = !hasNumericCondition(cond.value); });

  const select = h('select', { 'aria-label': t('wf_checkEvery') },
    ...PRESETS.map((p) => h('option', { value: String(p.minutes), selected: p.minutes === 60 }, p.label)),
    h('option', { value: 'custom' }, t('wf_customOption')));
  const custom = h('input', { type: 'text', class: 'mono', placeholder: t('wf_hhmmssPlaceholder'), value: '00:30:00', inputmode: 'numeric', 'aria-label': t('wf_customInterval'), pattern: '\\d{1,3}:\\d{2}:\\d{2}' });
  const customRow = h('label', { class: 'field', hidden: true }, h('span', {}, t('wf_customIntervalLabel')), custom);
  select.addEventListener('change', () => { customRow.hidden = select.value !== 'custom'; if (!customRow.hidden) custom.focus(); });

  // Zahlen-Wächter: Code vergleicht exakt, Jev sucht nur die gemeinte Zahl auf der Seite.
  const numOn = h('input', { type: 'checkbox' });
  const op = h('select', { 'aria-label': t('wf_compareLabel') },
    h('option', { value: 'below' }, t('wf_opBelow')), h('option', { value: 'atmost' }, t('wf_opAtmost')),
    h('option', { value: 'above' }, t('wf_opAbove')), h('option', { value: 'atleast' }, t('wf_opAtleast')));
  const limit = h('input', { type: 'text', inputmode: 'decimal', class: 'mono', placeholder: t('wf_limitPlaceholder'), 'aria-label': t('wf_limit') });
  const numRow = h('div', { class: 'num-row', hidden: true }, op, limit);
  numOn.addEventListener('change', () => { numRow.hidden = !numOn.checked; numHint.hidden = numOn.checked || !hasNumericCondition(cond.value); });
  const numBlock = numbers ? h('div', { class: 'num-block' },
    h('label', { class: 'check' }, numOn, t('wf_exactCompare')), numRow) : null;

  const error = h('p', { class: 'error-text', hidden: true });
  const submit = h('button', { class: 'primary', type: 'submit' }, t('wf_createWatch'));

  const fail = (text) => {
    error.textContent = text;
    error.hidden = false;
  };

  const form = h('form', { class: 'watch-form' },
    h('label', { class: 'field' }, h('span', {}, t('wf_page')), urlInput),
    selection ? h('blockquote', { class: 'quote' }, h('span', { class: 'faint' }, t('wf_selectedPrefix')), t('wf_selectedQuote', selection)) : null,
    h('label', { class: 'field' }, h('span', {}, t('wf_notifyWhen')), cond),
    numHint,
    numBlock,
    h('label', { class: 'field' }, h('span', {}, t('wf_checkEvery')), select),
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
      fail(t('wf_invalidUrl'));
      return;
    }
    if (!cond.value.trim()) {
      fail(t('wf_missingCondition'));
      return;
    }
    let intervalMin;
    if (select.value === 'custom') {
      const seconds = parseDuration(custom.value);
      if (seconds === null) {
        fail(t('wf_invalidInterval'));
        return;
      }
      if (seconds < MIN_SECONDS) {
        fail(t('wf_intervalTooShort', formatDuration(seconds)));
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
        fail(t('wf_invalidLimit'));
        return;
      }
      number = { op: op.value, limit: value };
    }
    // Die Leseerlaubnis gilt nur für diese eine Website.
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) {
      fail(t('wf_noPermission'));
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
