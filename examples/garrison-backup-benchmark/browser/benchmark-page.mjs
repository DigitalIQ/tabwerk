const status = document.querySelector('#status');
const result = document.querySelector('#result');
const buttons = [...document.querySelectorAll('button')];
async function post(route, payload) {
  const response = await fetch(new URL(`../${route}`, import.meta.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Local endpoint failed: ${response.status}`);
  return response.json();
}
async function run(kind) {
  buttons.forEach(button => { button.disabled = true; });
  status.textContent = `${kind}: läuft`;
  result.textContent = 'Daten werden lokal geladen.';
  const onProgress = async event => {
    status.textContent = `${kind}: ${typeof event === 'string' ? event : JSON.stringify(event)}`;
    await post('progress', { kind, event });
  };
  try {
    const input = await (await fetch(new URL('../input.json', import.meta.url))).json();
    const report = kind === 'tests'
      ? await (await import('./browser-tests.mjs')).runBrowserTests(input, { onProgress, verifyNode: payload => post('verify-node', payload) })
      : await (await import('./browser-benchmark.mjs')).runBrowserBenchmark(input, { pairs: 5, warmupPairs: 1, onProgress, caseName: 'prepared10-growing' });
    await post('result', { kind, ok: true, report });
    status.textContent = `${kind}: abgeschlossen`;
    result.textContent = JSON.stringify(report, null, 2);
  } catch (error) {
    const report = { name: error.name, message: error.message, stack: error.stack };
    await post('result', { kind, ok: false, report });
    status.textContent = `${kind}: fehlgeschlagen`;
    result.textContent = `${error.name}: ${error.message}`;
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}
document.querySelector('#tests').addEventListener('click', () => run('tests'));
document.querySelector('#benchmark').addEventListener('click', () => run('benchmark'));
