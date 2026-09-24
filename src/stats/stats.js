import { h, send, favicon, ago } from '../ui/dom.js';
import { t, tp, fmtNumber, fmtDate, initI18n, localizeDom } from '../lib/i18n.js';

await initI18n();
localizeDom();

const $ = (s) => document.querySelector(s);
const data = await send('stats');
$('#stamp').textContent = t('stats_asOf', fmtDate(new Date(), { hour: '2-digit', minute: '2-digit' }));

const tile = (value, label) => h('div', { class: 'tile' }, h('b', {}, fmtNumber(value)), h('span', {}, label));
$('#tiles').replaceChildren(
  tile(data.total, tp('stats_tabsOpen', data.total)),
  tile(data.windows.length, tp('stats_windows', data.windows.length)),
  tile(data.groups, tp('stats_groups', data.groups)),
  tile(data.discarded, tp('stats_discarded', data.discarded)),
);

const max = Math.max(1, ...data.hosts.map(([, n]) => n));
$('#hosts').replaceChildren(...data.hosts.map(([host, n]) => h('li', { title: tp('stats_hostTabsTitle', n, host) },
  h('span', { class: 'name' }, host),
  h('span', { class: 'track' }, h('span', { class: 'fill', style: { width: `${(n / max) * 100}%`, display: 'block' } })),
  h('span', { class: 'val' }, fmtNumber(n)))));

if (!data.daily.length) {
  $('#daily').replaceWith(h('p', { class: 'empty-note' }, t('stats_noHistory')));
} else {
  const top = Math.max(1, ...data.daily.map(([, n]) => n));
  const fmt = (d) => fmtDate(`${d}T12:00`, { day: 'numeric', month: 'numeric' });
  $('#daily').setAttribute('aria-label', tp('stats_dailyChartLabel', data.daily.length));
  $('#daily').replaceChildren(...data.daily.map(([d, n], i) => h('div', { class: 'col', title: tp('stats_dayColumnTitle', n, fmt(d)) },
    h('span', {}, fmtNumber(n)),
    h('i', { style: { height: `${(n / top) * 110}px` } }),
    i % 2 === data.daily.length % 2 || data.daily.length < 8 ? h('em', {}, fmt(d)) : null)));
  $('#daily-table tbody').replaceChildren(...data.daily.map(([d, n]) => h('tr', {}, h('td', {}, d), h('td', {}, fmtNumber(n)))));
}

$('#oldest').replaceChildren(...data.oldest.map((tab) => h('li', {},
  h('button', { onclick: () => send('focusTab', { tabId: tab.id, windowId: tab.windowId }) },
    favicon(tab.url), h('span', { class: 't' }, tab.title || tab.url), h('span', { class: 'mono faint' }, ago(tab.lastAccessed))))));
