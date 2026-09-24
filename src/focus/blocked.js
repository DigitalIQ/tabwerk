import { send } from '../ui/dom.js';

const params = new URLSearchParams(location.search);
const url = params.get('u') || '';
const until = Number(params.get('until')) || Date.now();
const $ = (s) => document.querySelector(s);
$('#site').textContent = url;

function tick() {
  const left = Math.max(0, until - Date.now());
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  $('#left').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (left <= 0) location.replace(url);
}
tick();
setInterval(tick, 1000);

$('#back').addEventListener('click', () => (history.length > 1 ? history.back() : window.close()));
$('#once').addEventListener('click', async () => { await send('allowOnce', { url }); location.replace(url); });
$('#end').addEventListener('click', async () => { await send('endFocus'); location.replace(url); });
