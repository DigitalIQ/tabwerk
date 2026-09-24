// Kleine DOM-Helfer für Popup und Einstellungen.

import { t, fmtNumber, fmtRelative } from '../lib/i18n.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') {
      // Custom Properties wie --c gehen nur über setProperty.
      for (const [prop, v] of Object.entries(value)) {
        if (v === undefined) continue;
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    }
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const icon = (name) => h('span', { class: `ico i-${name}`, 'aria-hidden': 'true' });

export async function send(type, payload) {
  const res = await chrome.runtime.sendMessage({ type, payload });
  if (!res) throw new Error(t('dom_noResponse'));
  if (!res.ok) {
    const error = new Error(res.error);
    error.code = res.code;
    error.detail = res.detail;
    throw error;
  }
  return res.data;
}

const pct = (confidence) => fmtNumber(confidence ?? 0, { style: 'percent', maximumFractionDigits: 0 });

// Jevs Sicherheit als fünf Striche und Prozentzahl.
export function meter(confidence, threshold = 0.8, label = t('dom_meterSure')) {
  const on = Math.round((confidence ?? 0) * 5);
  const unsure = (confidence ?? 0) < threshold;
  return h('span', {
    class: `meter${unsure ? ' unsure' : ''}`,
    title: t('dom_meterTitle', pct(confidence), label),
  },
  h('span', { class: 'ticks', 'aria-hidden': 'true' }, ...[0, 1, 2, 3, 4].map((i) => h('i', { class: i < on ? 'on' : '' }))),
  pct(confidence));
}

export function favicon(url) {
  const src = new URL(chrome.runtime.getURL('/_favicon/'));
  src.searchParams.set('pageUrl', url || '');
  src.searchParams.set('size', '32');
  return h('img', { class: 'fav', src: src.toString(), alt: '' });
}

export function cost(value) {
  if (typeof value !== 'number') return t('dom_costUnknown');
  return fmtNumber(value, { style: 'currency', currency: 'USD', maximumSignificantDigits: 2 });
}

export function ago(at) {
  if (!at) return t('dom_agoNever');
  return fmtRelative(at - Date.now());
}
