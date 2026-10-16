import { readFile, stat, mkdir, mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 64 * 1024 * 1024;
const sources = new Set(['garrison', 'tsm']);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);

// Quelle ist eine ausdrückliche Angabe. Gleiche Dateischemata beweisen keinen Fork.
export function prepareSessions(sessions, { source, maxPoints = 60 } = {}) {
  if (!sources.has(source)) throw new Error('Quelle muss ausdrücklich garrison oder tsm sein.');
  if (!Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > 300) throw new Error('Punktezahl muss zwischen 2 und 300 liegen.');
  if (!Array.isArray(sessions) || sessions.length === 0 || sessions.length > 10000) throw new Error('Erwartet wird ein JSON-Exportarray mit 1 bis 10000 Sessions.');
  if (sessions.some(s => !record(s) || !record(s.windows))) throw new Error('Export enthält eine ungültige Sessionstruktur.');
  const regular = sessions.filter(s => Array.isArray(s.tag) && s.tag.includes('regular'));
  const seen = new Set();
  for (const session of regular) {
    if (typeof session.id !== 'string' || !session.id || seen.has(session.id)) throw new Error('Autosave-IDs fehlen oder sind doppelt; Verlauf zuerst klären.');
    seen.add(session.id);
    if (!Number.isSafeInteger(session.date) || session.date < 0 || !Number.isFinite(new Date(session.date).getTime())) throw new Error('Autosave-Erstellungszeit fehlt oder ist ungültig.');
    for (const tabs of Object.values(session.windows)) {
      if (!record(tabs) || Object.values(tabs).some(tab => !record(tab))) throw new Error('Ungültige Fenster-/Tabstruktur im Autosave.');
    }
  }
  if (regular.length < 2) throw new Error('Weniger als zwei reguläre Autosaves vorhanden. Benötigt wird ein zeitlicher Verlauf.');
  const selected = [...regular].sort((a, b) => a.date - b.date).slice(-maxPoints);
  const windows = selected.map(s => Object.keys(s.windows).length);
  const tabs = selected.map(s => Object.values(s.windows).reduce((n, w) => n + Object.keys(w).length, 0));
  if (windows.some(n => n === 0) || tabs.some(n => n === 0)) throw new Error('Leerer Autosave gefunden; Datenumfang zuerst klären.');
  const dates = selected.map(s => s.date);
  const summary = {
    declaredSource: source,
    sourceAuthenticated: false,
    exportedSessions: sessions.length,
    regularAutosavesAvailable: regular.length,
    selectedPoints: selected.length,
    excludedOtherSessions: sessions.length - regular.length,
    selection: 'latest consecutive regular-tagged sessions by original creation date; no deduplication or field removal',
    firstDate: new Date(dates[0]).toISOString(),
    lastDate: new Date(dates.at(-1)).toISOString(),
    spanHours: (dates.at(-1) - dates[0]) / 3600000,
    equalTimestampPairs: dates.slice(1).filter((d, i) => d === dates[i]).length,
    windowCountRange: [Math.min(...windows), Math.max(...windows)],
    tabCountRange: [Math.min(...tabs), Math.max(...tabs)],
    contentIncludedInSummary: false,
  };
  return { format: 'tabwerk-local-history-input', version: 1, summary, history: selected.map(s => [s]) };
}

async function readBounded(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('JSON-Datei fehlt oder überschreitet 64 MiB.');
  const bytes = await readFile(path);
  if (bytes.length > MAX_BYTES) throw new Error('JSON-Datei überschreitet 64 MiB.');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Datei ist kein gültiges UTF-8-JSON. ZIP zuvor lokal entpacken.'); }
  return { value, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function loadPrepared(path) {
  const { value } = await readBounded(path);
  if (!record(value) || value.format !== 'tabwerk-local-history-input' || value.version !== 1 || !record(value.summary) || !Array.isArray(value.history)) throw new Error('Unbekanntes vorbereitetes Eingabeformat.');
  if (value.history.some(point => !Array.isArray(point) || point.length !== 1)) throw new Error('Jeder Zeitpunkt muss genau eine Originalsession enthalten.');
  // Neu prüfen, statt Dateimetadaten als Datenbeweis zu übernehmen.
  const checked = prepareSessions(value.history.map(point => point[0]), { source: value.summary.declaredSource, maxPoints: 300 });
  if (JSON.stringify(checked.history) !== JSON.stringify(value.history)) throw new Error('Vorbereiteter Verlauf ist nicht chronologisch.');
  return { ...checked, summary: { ...checked.summary, originalExportSha256: value.summary.originalExportSha256 } };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const path = option('--input');
  const source = option('--source');
  if (!path || !source) throw new Error('Aufruf: node real-input.mjs --input /pfad/export.json --source garrison|tsm [--max-points 60]');
  const { value, sha256 } = await readBounded(path);
  const prepared = prepareSessions(value, { source, maxPoints: Number(option('--max-points', 60)) });
  prepared.summary.originalExportSha256 = sha256;
  const root = resolve(option('--output-root', resolve(import.meta.dirname, '../../.tmp/garrison-real-data')));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(join(root, 'prepared-'));
  await chmod(output, 0o700);
  await writeFile(join(output, 'prepared.json'), JSON.stringify(prepared), { flag: 'wx', mode: 0o600 });
  await writeFile(join(output, 'summary.json'), JSON.stringify(prepared.summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ preparedDirectory: output, ...prepared.summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Keine Eingabeobjekte oder JSON-Parser-Auszüge mit privaten URLs ausgeben.
    console.error(error instanceof Error ? error.message : 'Lokale Vorbereitung fehlgeschlagen.');
    process.exitCode = 1;
  });
}
