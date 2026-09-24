// Notiz an einem Tab. Gespeichert wird zur Adresse, damit sie einen Neustart übersteht.
import { send, favicon, h } from '../ui/dom.js';
import { initI18n, localizeDom } from '../lib/i18n.js';

await initI18n();
localizeDom();

const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const title = params.get('title') || url;
const $ = (s) => document.querySelector(s);

$('#page').replaceChildren(favicon(url), h('span', { title: url }, title));
const note = await send('getNote', { url });
if (note) {
  $('#text').value = note.text;
  $('#remove').hidden = false;
}
$('#text').focus();

async function save(text) {
  await send('setNote', { url, title, text });
  window.close();
}
$('#save').addEventListener('click', () => save($('#text').value));
$('#remove').addEventListener('click', () => save(''));
$('#text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save($('#text').value);
  if (e.key === 'Escape') window.close();
});
