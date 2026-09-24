// Diese Funktionen laufen per chrome.scripting.executeScript in der Seite.
// Chrome überträgt nur den Funktionstext. Deshalb darf keine davon etwas von außen benutzen.

// Liest alle Formularfelder der Seite. Sensible Felder bekommen keinen Wert,
// außer der Schalter „Auch geschützte Felder speichern“ ist an.
export function collectFields(withSensitive = false) {
  const SENSITIVE = /pass|pwd|kennwort|passwort|card|karte|cc-|cvv|cvc|csc|iban|bic|swift|konto|account.?num|pin\b|\btan\b|otp|one-time|token|secret|geheim|ssn|social.?security|steuer.?id|tax.?id|security.?code/i;
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const labelOf = (el) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return text(l);
    }
    const wrap = el.closest('label');
    if (wrap) return text(wrap);
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ').trim();
    const prev = el.previousElementSibling;
    if (prev && /^(LABEL|SPAN|DIV|P|B|STRONG)$/.test(prev.tagName)) return text(prev);
    return '';
  };
  const selectorOf = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) {
      const same = document.querySelectorAll(`${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`);
      if (same.length === 1) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
    }
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      const idx = [...n.parentElement.children].filter((c) => c.tagName === n.tagName).indexOf(n) + 1;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${idx})`);
    }
    return `body > ${parts.join(' > ')}`;
  };
  const fields = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text').toLowerCase();
    if (['submit', 'button', 'reset', 'image', 'hidden', 'file'].includes(type)) continue;
    if (el.disabled || el.readOnly) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && type !== 'radio' && type !== 'checkbox') continue;
    const f = {
      selector: selectorOf(el),
      id: el.id || '',
      name: el.name || '',
      type,
      label: labelOf(el),
      placeholder: el.placeholder || '',
      autocomplete: el.getAttribute('autocomplete') || '',
    };
    if (type === 'select') f.options = [...el.options].map((o) => o.value);
    const sensitive = type === 'password' || /^(cc-|current-password|new-password|one-time-code)/.test(f.autocomplete)
      || SENSITIVE.test([f.name, f.id, f.label, f.autocomplete, f.placeholder].join(' '));
    if (sensitive) f.sensitive = true;
    if (sensitive && !withSensitive) {
      // kein Wert
    } else if (type === 'checkbox') f.value = el.checked;
    else if (type === 'radio') f.value = el.checked ? el.value : null;
    else f.value = el.value;
    fields.push(f);
  }
  return { fields, title: document.title, url: location.href };
}

// Trägt Werte ein. assignments: [{ selector, id, name, type, value }]
export function fillFields(assignments, withSensitive = false) {
  const setNative = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
  };
  const find = (a) => {
    try {
      const el = a.selector && document.querySelector(a.selector);
      if (el) return el;
    } catch {}
    if (a.id) { const el = document.getElementById(a.id); if (el) return el; }
    if (a.name) {
      const list = document.getElementsByName(a.name);
      if (a.type === 'radio') return [...list].find((r) => r.value === a.value) || null;
      if (list.length) return list[0];
    }
    return null;
  };
  let filled = 0;
  const missing = [];
  for (const a of assignments) {
    if (a.value === null || a.value === undefined) continue;
    const el = find(a);
    if (!el || (el.type === 'password' && !withSensitive)) { missing.push(a.label || a.name || a.id); continue; }
    if (el.type === 'checkbox') el.checked = Boolean(a.value);
    else if (el.type === 'radio') el.checked = true;
    else if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => o.value === a.value || o.textContent.trim() === a.value);
      if (!opt) { missing.push(a.label || a.name); continue; }
      setNative(el, opt.value);
    } else setNative(el, String(a.value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.style.transition = 'background-color 600ms';
    const old = el.style.backgroundColor;
    el.style.backgroundColor = 'rgba(31, 79, 216, 0.14)';
    setTimeout(() => { el.style.backgroundColor = old; }, 900);
    filled += 1;
  }
  return { filled, missing };
}
