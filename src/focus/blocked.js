import { send } from '../ui/dom.js';
import { tp, fmtNumber, initI18n, localizeDom } from '../lib/i18n.js';

await initI18n();
localizeDom();

const params = new URLSearchParams(location.search);
const url = params.get('u') || '';
const until = Number(params.get('until')) || Date.now();
const $ = (s) => document.querySelector(s);
$('#site').textContent = url;

function tick() {
  const left = Math.max(0, until - Date.now());
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  $('#left').textContent = `${fmtNumber(m, { minimumIntegerDigits: 2 })}:${fmtNumber(s, { minimumIntegerDigits: 2 })}`;
  $('#left').setAttribute('aria-label', `${tp('focus_minutesLeft', m)} ${tp('focus_secondsLeft', s)}`);
  if (left <= 0) location.replace(url);
}
tick();
setInterval(tick, 1000);

$('#back').addEventListener('click', () => (history.length > 1 ? history.back() : window.close()));
$('#once').addEventListener('click', async () => { await send('allowOnce', { url }); location.replace(url); });
$('#end').addEventListener('click', async () => { await send('endFocus'); location.replace(url); });
