import { h, send, favicon, ago } from '../ui/dom.js';

const $ = (s) => document.querySelector(s);
const data = await send('stats');
$('#stamp').textContent = `Stand ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;

const tile = (value, label) => h('div', { class: 'tile' }, h('b', {}, String(value)), h('span', {}, label));
$('#tiles').replaceChildren(
  tile(data.total, 'Tabs offen'),
  tile(data.windows.length, data.windows.length === 1 ? 'Fenster' : 'Fenster'),
  tile(data.groups, 'Gruppen'),
  tile(data.discarded, 'Tabs entladen'),
);

const max = Math.max(1, ...data.hosts.map(([, n]) => n));
$('#hosts').replaceChildren(...data.hosts.map(([host, n]) => h('li', { title: `${host}: ${n} Tabs` },
  h('span', { class: 'name' }, host),
  h('span', { class: 'track' }, h('span', { class: 'fill', style: { width: `${(n / max) * 100}%`, display: 'block' } })),
  h('span', { class: 'val' }, String(n)))));

if (!data.daily.length) {
  $('#daily').replaceWith(h('p', { class: 'empty-note' }, 'Noch keine Sicherungen im Verlauf.'));
} else {
  const top = Math.max(1, ...data.daily.map(([, n]) => n));
  const fmt = (d) => new Date(`${d}T12:00`).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
  $('#daily').setAttribute('aria-label', `Höchste Tab-Zahl pro Tag, ${data.daily.length} Tage`);
  $('#daily').replaceChildren(...data.daily.map(([d, n], i) => h('div', { class: 'col', title: `${fmt(d)}: höchstens ${n} Tabs` },
    h('span', {}, String(n)),
    h('i', { style: { height: `${(n / top) * 110}px` } }),
    i % 2 === data.daily.length % 2 || data.daily.length < 8 ? h('em', {}, fmt(d)) : null)));
  $('#daily-table tbody').replaceChildren(...data.daily.map(([d, n]) => h('tr', {}, h('td', {}, d), h('td', {}, String(n)))));
}

$('#oldest').replaceChildren(...data.oldest.map((t) => h('li', {},
  h('button', { onclick: () => send('focusTab', { tabId: t.id, windowId: t.windowId }) },
    favicon(t.url), h('span', { class: 't' }, t.title || t.url), h('span', { class: 'mono faint' }, ago(t.lastAccessed))))));
