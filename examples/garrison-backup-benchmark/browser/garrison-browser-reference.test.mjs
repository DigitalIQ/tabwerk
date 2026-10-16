import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { compileOriginal, GARRISON_COMMIT } from './garrison-browser-reference.mjs';

const base = new URL('../../../.tmp/garrison-browser-reference/runtime/', import.meta.url);
const source = async path => readFile(new URL(path, base), 'utf8');
const fflate = await import(new URL('dependencies/fflate/esm/browser.js', base));
const log = { log() {}, info() {}, warn() {}, error() {} };
const example = (id, date = 100) => ({ id, date, lastEditedTime: date, name: 'Prüfung', tag: ['regular'],
  windowsNumber: 1, tabsNumber: 1, sessionStartTime: 1,
  windows: { 1: { 2: { id: 2, windowId: 1, title: 'Änderung', url: 'https://example.test/', groupId: 4,
    unknown: { untouched: ['a', 1, false] } } } }, tabGroups: [{ id: 4, title: 'vorhanden' }],
  customField: { nested: 'unverändert' } });

async function fixture() {
  let records = [];
  let manifest = { complete: [], session: {}, incremental: [] };
  const output = [];
  const listeners = new Set();
  const browser = { downloads: {
    async download(details) { output.push({ ...details, bytes: new Uint8Array(await (await fetch(details.url)).arrayBuffer()) }); return output.length; },
    onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
  }, storage: { local: {
    async get() { return { BackupManifest: structuredClone(manifest) }; },
    async set(value) { manifest = structuredClone(value.BackupManifest); },
  } } };
  const Sessions = { async getAll(keys) { return keys ? records.map(s => Object.fromEntries(keys.map(k => [k, s[k]]))) : structuredClone(records); } };
  const getSessions = compileOriginal(await source('src/background/getSessions.js'), { Sessions, log }, 'getSessions', { defaultName: 'getSessions' });
  const zip = compileOriginal(await source('src/background/backupZip.js'), { browser, log, ...fflate }, '{ buildZip, writeBackupFile }');
  const metadata = compileOriginal(await source('src/background/backupManifest.js'), { browser, log }, '{ addEntry, getManifest }');
  const backup = compileOriginal(await source('src/background/backup.js'), { browser, log, Sessions, getSessions, ...zip, ...metadata,
    moment: () => ({ format: () => '2026-10-16 12-34-56' }),
    getSettings: key => ({ backupFolder: 'Tab_Session_Garrison_Backup' })[key],
    setSettings() {}, exportSessions() { throw new Error('Unexpected legacy export'); },
  }, '{ backupComplete, getSessionsFingerprint }');
  return { ...backup, output, setRecords: value => { records = structuredClone(value); },
    manifest: () => manifest, finish() { for (const listener of [...listeners]) listener({ id: output.length, state: { current: 'complete' } }); } };
}

test('fixed official sources and dependencies match saved hashes', async () => {
  const manifest = JSON.parse(await source('reference-manifest.json'));
  assert.equal(manifest.commit, GARRISON_COMMIT);
  assert.equal(manifest.dependencies.fflate.version, '0.8.3');
  for (const [path, entry] of Object.entries(manifest.entries)) {
    const bytes = await readFile(new URL(path, base));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, path);
    assert.equal(bytes.length, entry.bytes);
  }
  for (const [path, entry] of Object.entries(manifest.generated)) {
    const bytes = await readFile(new URL(path, base));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, path);
    assert.equal(entry.sourceSha256, manifest.entries[entry.source].sha256);
  }
});

test('prepared static ESM factories parse without browser eval', async () => {
  for (const name of ['sessions','getSessions','backupZip','backupManifest','export','backup','tabGroupUtils','makeSearchInfo']) {
    assert.equal(typeof (await import(new URL(`generated/${name}.mjs`, base))).default, 'function');
  }
  const moment = (await import(new URL('generated/moment.mjs', base))).default;
  assert.equal(moment.version, '2.29.4');
  const logger = (await import(new URL('generated/loglevel.mjs', base))).default;
  assert.equal(typeof logger.setLevel, 'function');
});

async function pipelineFixture() {
  const values = {};
  let records = [];
  let now = 101;
  const deliveries = [];
  const listeners = new Set();
  const storage = { async get(key) { return { [key]: structuredClone(values[key]) }; }, async set(v) { Object.assign(values, structuredClone(v)); } };
  const browser = { storage: { local: storage, session: storage },
    i18n: { getMessage: key => key }, downloads: {
      async download(details) { deliveries.push({ ...details, bytes: new Uint8Array(await (await fetch(details.url)).arrayBuffer()) }); return deliveries.length; },
      async erase() {}, onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    } };
  const Sessions = { async getAll(keys) { return keys ? records.map(s => Object.fromEntries(keys.map(k => [k,s[k]]))) : structuredClone(records); },
    async get(id) { return structuredClone(records.find(s => s.id === id)); } };
  const factory = async name => (await import(new URL(`generated/${name}.mjs`, base))).default;
  const getSessions = (await factory('getSessions'))({ Sessions, log });
  const zip = (await factory('backupZip'))({ browser, log, ...fflate });
  const metadata = (await factory('backupManifest'))({ browser, log });
  const settings = { ifBackup: true, backupComplete: false, individualBackup: true, backupFolder: 'Backup', dateFormat: 'YYYY.MM.DD HH:mm:ss' };
  const moment = (await import(new URL('generated/moment.mjs', base))).default;
  const exporter = (await factory('export'))({ browser, log, getSessions, getSettings: k => settings[k], moment, init: async () => {} });
  const backup = (await factory('backup'))({ browser, log, Sessions, getSessions, ...zip, ...metadata, moment,
    Date: { now: () => now }, getSettings: k => settings[k], setSettings: (k,v) => { settings[k] = v; }, exportSessions: exporter.exportSessions });
  return { settings, deliveries, values, setRecords: v => { records = structuredClone(v); }, setClock: v => { now = v; },
    async run() { const offset = deliveries.length; await backup.backupSessions(); await backup.drain();
      const current = deliveries.slice(offset);
      for (let i = offset; i < deliveries.length; i++) {
        const event = { id: i + 1, state: { current: 'complete' } };
        for (const listener of [...listeners]) listener(event);
        await exporter.handleDownloadsChanged(event);
      }
      return current;
    } };
}

test('native default is incremental individual JSON with persistent replay cutoff', async () => {
  const ref = await pipelineFixture();
  ref.setRecords([example('a',100)]);
  let delivered = await ref.run();
  assert.equal(delivered.length, 1);
  assert.ok(delivered[0].filename.endsWith('.json'));
  assert.deepEqual(JSON.parse(fflate.strFromU8(delivered[0].bytes)), [example('a',100)]);
  assert.equal(ref.settings.lastBackupTime, 101);
  ref.setRecords([example('a',100),example('b',200)]); ref.setClock(201);
  delivered = await ref.run();
  assert.equal(delivered.length, 1);
  assert.deepEqual(JSON.parse(fflate.strFromU8(delivered[0].bytes)), [example('b',200)]);
  assert.equal(ref.settings.lastBackupTime, 201);
  assert.deepEqual(await ref.run(), []);
});

test('native additive mode produces complete ZIP and default individual JSON', async () => {
  const ref = await pipelineFixture();
  ref.settings.backupComplete = true;
  ref.setRecords([example('a',100)]);
  const delivered = await ref.run();
  assert.equal(delivered.length, 2);
  assert.ok(delivered[0].filename.endsWith('.zip'));
  assert.ok(delivered[1].filename.endsWith('.json'));
  assert.equal(ref.values.BackupManifest.complete.length, 1);
});

test('native legacy-all JSON runs once per browser session and preserves its guard', async () => {
  const ref = await pipelineFixture();
  ref.settings.individualBackup = false;
  ref.setRecords([example('a',100)]);
  assert.equal((await ref.run()).length, 1);
  ref.setRecords([example('a',100),example('b',200)]); ref.setClock(201);
  assert.deepEqual(await ref.run(), []);
  assert.equal(ref.values.didBackupAllSessions, true);
});

test('original CompleteZIP stores all current sessions as pretty UTF-8 JSON and metadata', async () => {
  const ref = await fixture();
  const records = [example('manual'), example('regular', 200)];
  ref.setRecords(records);
  await ref.backupComplete();
  assert.equal(ref.output.length, 1);
  const delivered = ref.output[0];
  assert.equal(delivered.conflictAction, 'uniquify');
  assert.equal(delivered.saveAs, false);
  assert.equal(delivered.filename, 'Tab_Session_Garrison_Backup/complete/TSG-complete-2026-10-16 12-34-56.zip');
  const entries = fflate.unzipSync(delivered.bytes);
  const text = fflate.strFromU8(entries['TSG-complete-2026-10-16 12-34-56.json']);
  assert.equal(text, JSON.stringify(records, null, '  '));
  assert.deepEqual(JSON.parse(text), records);
  assert.equal(ref.manifest().complete[0].sessionsCount, 2);
  assert.equal(ref.manifest().complete[0].downloadId, 1);
  ref.finish();
});

test('original fingerprint skips unchanged DB and is order independent', async () => {
  const ref = await fixture();
  const a = example('a'), b = example('b', 200);
  ref.setRecords([a, b]);
  const fingerprint = await ref.getSessionsFingerprint();
  await ref.backupComplete(); ref.finish();
  ref.setRecords([b, a]);
  assert.equal(await ref.getSessionsFingerprint(), fingerprint);
  await ref.backupComplete();
  assert.equal(ref.output.length, 1);
});

test('edited timestamps append full snapshots; historical ZIP contents survive DB edits', async () => {
  const ref = await fixture();
  const a = example('a');
  ref.setRecords([a]); await ref.backupComplete(); ref.finish();
  a.lastEditedTime++;
  a.windows[1][2].unknown.untouched.push('neu');
  ref.setRecords([a, example('b', 200)]); await ref.backupComplete(); ref.finish();
  assert.equal(ref.output.length, 2);
  assert.equal(ref.manifest().complete.length, 2);
  const first = JSON.parse(fflate.strFromU8(Object.values(fflate.unzipSync(ref.output[0].bytes))[0]));
  assert.deepEqual(first, [example('a')]);
  const second = JSON.parse(fflate.strFromU8(Object.values(fflate.unzipSync(ref.output[1].bytes))[0]));
  assert.deepEqual(second, [a, example('b', 200)]);
});

test('empty DB emits no CompleteZIP', async () => {
  const ref = await fixture();
  await ref.backupComplete();
  assert.equal(ref.output.length, 0);
});

test('original export filters unreferenced groups, preserving all other data', async () => {
  const { referencedTabGroups } = compileOriginal(await source('src/common/tabGroupUtils.js'), {}, '{ referencedTabGroups }');
  const value = example('a');
  value.tabGroups.push({ id: 88, title: 'verwaist' });
  const filtered = referencedTabGroups(value.tabGroups, value.windows);
  assert.deepEqual(filtered, [{ id: 4, title: 'vorhanden' }]);
  assert.equal(value.tabGroups.length, 2);
});

test('actual import skips newer duplicates and changes imported edit times', async () => {
  const writes = [];
  const old = example('existing', 100);
  const fresh = example('new', 200);
  const importSessions = compileOriginal(await source('src/background/import.js'), {
    log, Sessions: { async search() { return [old]; } }, saveSession: s => writes.push(structuredClone(s)),
  }, 'importSessions');
  await importSessions([structuredClone(old), fresh]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, 'new');
  assert.ok(writes[0].lastEditedTime > 200);
});
