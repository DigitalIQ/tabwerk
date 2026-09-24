// Übersetzung (i18n) und Formate je Sprache (l10n).
// Die Texte stehen im Chrome-Format in _locales/<sprache>/messages.json.
// Standard ist die Sprache des Browsers über chrome.i18n. Die Einstellung „Sprache“
// kann das überschreiben. Dann lädt Tabwerk die Datei dieser Sprache selbst.
//
// Nutzung:
//   t('popup_undo')                  Text
//   t('hist_restored', label)        Text mit $1 … $9
//   tp('common_tabs', n)             Mehrzahl: sucht common_tabs_one, common_tabs_other usw.
//   fmtDate(t, { dateStyle: 'short' }), fmtNumber(n), fmtRelative(ms), fmtList(items)
//   localizeDom(root)                füllt data-i18n, data-i18n-placeholder, -title, -aria-label, -alt

export const LANGUAGES = ['de', 'en'];
export const FALLBACK = 'en';

let dict = null;
let chosen = null;

const api = () => globalThis.chrome?.i18n;

// Sprache für Intl-Formate und das lang-Attribut.
export function locale() {
  return chosen || api()?.getUILanguage?.() || FALLBACK;
}

// Nur die Grundsprache, etwa "de" aus "de-AT".
export const language = () => locale().split(/[-_]/)[0].toLowerCase();

// Lädt die Datei einer fest eingestellten Sprache. "auto" heißt: Sprache des Browsers.
export async function initI18n() {
  dict = null;
  chosen = null;
  let setting = 'auto';
  try {
    ({ uiLanguage: setting = 'auto' } = await chrome.storage.local.get('uiLanguage'));
  } catch {}
  if (!setting || setting === 'auto' || !LANGUAGES.includes(setting)) return locale();
  try {
    const res = await fetch(chrome.runtime.getURL(`_locales/${setting}/messages.json`));
    dict = await res.json();
    chosen = setting;
  } catch {}
  return locale();
}

// Setzt $name$-Platzhalter und $1 … $9 ein, wie chrome.i18n.getMessage.
function fill(entry, subs) {
  let msg = entry.message;
  if (entry.placeholders) {
    for (const [name, ph] of Object.entries(entry.placeholders)) {
      msg = msg.replace(new RegExp(`\\$${name}\\$`, 'gi'), ph.content);
    }
  }
  return msg.replace(/\$(\d)/g, (_, n) => (subs[n - 1] ?? '')).replace(/\$\$/g, '$');
}

export function t(key, ...subs) {
  const list = subs.map((s) => String(s ?? ''));
  const entry = dict?.[key] || dict?.[key.toLowerCase()];
  if (entry) return fill(entry, list);
  const msg = api()?.getMessage?.(key, list);
  return msg || key;
}

export function has(key) {
  return Boolean(dict?.[key] || api()?.getMessage?.(key));
}

// Mehrzahl nach den Regeln der Sprache. Fehlt eine Form, gilt _other.
export function tp(key, n, ...subs) {
  const form = new Intl.PluralRules(locale()).select(n);
  const k = has(`${key}_${form}`) ? `${key}_${form}` : `${key}_other`;
  return t(k, fmtNumber(n), ...subs);
}

export const fmtNumber = (n, opts) => new Intl.NumberFormat(locale(), opts).format(n);
export const fmtDate = (value, opts = { dateStyle: 'medium', timeStyle: 'short' }) => new Intl.DateTimeFormat(locale(), opts).format(new Date(value));
export const fmtList = (items, type = 'conjunction') => new Intl.ListFormat(locale(), { style: 'long', type }).format(items);

// "vor 5 Minuten", "in 2 Stunden". ms ist die Differenz zu jetzt, negativ heißt Vergangenheit.
export function fmtRelative(ms) {
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const abs = Math.abs(ms);
  const units = [['day', 864e5], ['hour', 36e5], ['minute', 6e4], ['second', 1e3]];
  for (const [unit, size] of units) {
    if (abs >= size || unit === 'second') return rtf.format(Math.round(ms / size), unit);
  }
  return '';
}

const ATTRS = [['i18nPlaceholder', 'placeholder'], ['i18nTitle', 'title'], ['i18nAriaLabel', 'aria-label'], ['i18nAlt', 'alt']];

// Füllt statische Texte in HTML. data-i18n ersetzt den Textinhalt, also nur an Elementen ohne Kinder.
export function localizeDom(root = document) {
  if (root === document) {
    document.documentElement.lang = language();
    document.documentElement.dir = ['ar', 'he', 'fa', 'ur'].includes(language()) ? 'rtl' : 'ltr';
  }
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const [data, attr] of ATTRS) {
    for (const el of root.querySelectorAll(`[data-${data.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`)) {
      el.setAttribute(attr, t(el.dataset[data]));
    }
  }
}
