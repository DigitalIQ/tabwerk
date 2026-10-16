// Lokaler Referenzadapter. Upstream-Funktionen bleiben bis auf Modulsyntax unverändert.
export const GARRISON_COMMIT = '850099b1b0b8a03bef1743c2e21f42f951e08e2e';
const cache = new Map();
const clone = value => structuredClone(value);
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

export function originalModuleBody(source, { defaultName } = {}) {
  let body = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '');
  if (defaultName) body = body.replace(/export default /, `const ${defaultName} = `);
  else body = body.replace(/export default (?=(?:async )?function\b)/g, '').replace(/^export default [^;]+;\s*$/gm, '');
  body = body.replace(/\bexport (?=(?:const|let|var|async function|function)\b)/g, '');
  return body;
}

export function compileOriginal(source, bindings, expression, options = {}) {
  const body = originalModuleBody(source, options);
  return new Function(...Object.keys(bindings), `"use strict";\n${body}\nreturn (${expression});`)(...Object.values(bindings));
}

const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const transactionDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onerror = tx.onabort = () => reject(tx.error || new Error('Reference transaction aborted'));
});

async function localStorageShim(name) {
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore('values');
  const db = await request(opening);
  return {
    async get(key) { return { [key]: await request(db.transaction('values').objectStore('values').get(key)) }; },
    async set(values) {
      const tx = db.transaction('values', 'readwrite');
      for (const [key, value] of Object.entries(values)) tx.objectStore('values').put(value, key);
      await transactionDone(tx);
    },
    async remove(key) {
      const tx = db.transaction('values', 'readwrite');
      tx.objectStore('values').delete(key);
      await transactionDone(tx);
    },
    close() { db.close(); },
  };
}

export async function loadGarrisonRuntime({ runtimeBase = new URL('../reference/', import.meta.url) } = {}) {
  const base = new URL(runtimeBase, import.meta.url);
  if (cache.has(base.href)) return cache.get(base.href);
  const loading = (async () => {
    const manifestResponse = await fetch(new URL('reference-manifest.json', base));
    if (!manifestResponse.ok) throw new Error('Reference manifest unavailable; run prepare-garrison-reference.mjs');
    const manifest = await manifestResponse.json();
    if (manifest.commit !== GARRISON_COMMIT || manifest.dependencies.fflate.version !== '0.8.3') throw new Error('Reference version mismatch');
    const files = {};
    for (const [path, entry] of Object.entries(manifest.entries)) {
      const response = await fetch(new URL(path, base));
      if (!response.ok) throw new Error(`Reference source unavailable: ${path}`);
      const buffer = await response.arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (digest !== entry.sha256 || buffer.byteLength !== entry.bytes) throw new Error(`Reference source integrity mismatch: ${path}`);
      files[path] = new TextDecoder().decode(buffer);
    }
    for (const [path, entry] of Object.entries(manifest.generated)) {
      const response = await fetch(new URL(path, base));
      if (!response.ok) throw new Error(`Generated reference unavailable: ${path}`);
      const buffer = await response.arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (digest !== entry.sha256) throw new Error(`Generated reference integrity mismatch: ${path}`);
    }
    const factories = {};
    for (const name of ['tabGroupUtils','makeSearchInfo','sessions','getSessions','backupZip','backupManifest','export','backup']) {
      factories[name] = (await import(new URL(`generated/${name}.mjs`, base))).default;
    }
    // Die lokal geprüften statischen ESM-Dateien benötigen kein eval.
    const fflate = await import(new URL(manifest.dependencies.fflate.file, base));
    const moment = (await import(new URL('generated/moment.mjs', base))).default;
    const loglevel = (await import(new URL('generated/loglevel.mjs', base))).default;
    const group = factories.tabGroupUtils({});
    const search = factories.makeSearchInfo({});
    const packRecords = records => {
      const entries = {};
      if (!Array.isArray(records)) throw new Error('Portable records must be an array of {file,bytes}');
      for (const { file, bytes } of records) {
        if (typeof file !== 'string' || !(bytes instanceof Uint8Array) || Object.hasOwn(entries, file)) throw new Error('Invalid or duplicate portable record');
        entries[file] = bytes;
      }
      return fflate.zipSync(entries, { level: 6 });
    };
    const unpackRecords = bytes => Object.entries(fflate.unzipSync(bytes)).map(([file, bytes]) => ({ file, bytes }));
    const transformSessions = sessions => clone(sessions).map(session => {
      if (session.tabGroups) session.tabGroups = group.referencedTabGroups(session.tabGroups, session.windows);
      return session;
    });
    const transformationAudit = sessions => {
      const transformed = transformSessions(sessions);
      return {
        equal: canonical(sessions) === canonical(transformed),
        changedSessionCount: sessions.filter((s, i) => canonical(s) !== canonical(transformed[i])).length,
        removedTabGroupCount: sessions.reduce((sum, s, i) => sum + (s.tabGroups?.length || 0) - (transformed[i].tabGroups?.length || 0), 0),
      };
    };
    return { manifest, files, factories, fflate, moment, loglevel, ...group, ...search, packRecords, unpackRecords, transformSessions, transformationAudit };
  })();
  cache.set(base.href, loading);
  try { return await loading; } catch (e) { cache.delete(base.href); throw e; }
}

export async function createGarrisonReference(options = {}) {
  const runtime = await loadGarrisonRuntime(options);
  const { factories, fflate, moment, referencedTabGroups, makeSearchInfo } = runtime;
  const metadataName = `garrison-reference-metadata-${crypto.randomUUID()}`;
  const storage = await localStorageShim(metadataName);
  const listeners = new Set();
  const deliveries = [];
  let nextId = 1;
  let clock = null;
  // Original loglevel wird stillgesetzt, damit Sitzungsinhalte nie in Browserlogs landen.
  const log = runtime.loglevel;
  log.setLevel('silent');
  const browser = {
    storage: { local: storage, session: storage },
    downloads: {
      async download(details) {
        const response = await fetch(details.url);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const id = nextId++;
        const delivery = { id, bytes, filename: details.filename, mimeType: response.headers.get('content-type'),
          conflictAction: details.conflictAction, saveAs: details.saveAs };
        if (options.downloadSink) await options.downloadSink(delivery);
        deliveries.push(delivery);
        return id;
      },
      onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
      async erase() {},
    },
    alarms: { create() {} },
    i18n: { getMessage(key) { return key; } },
  };
  const sessionModule = factories.sessions({ browser, log, referencedTabGroups, makeSearchInfo });
  const Sessions = sessionModule.Sessions;
  await Sessions.init();
  const getSessions = factories.getSessions({ log, Sessions });
  const zip = factories.backupZip({ browser, log, zipSync: fflate.zipSync, strToU8: fflate.strToU8 });
  const manifestModule = factories.backupManifest({ browser, log });
  const settings = { backupFolder: 'Tab_Session_Garrison_Backup', backupInterval: 30, ifBackup: true,
    backupComplete: false, individualBackup: true, dateFormat: 'YYYY.MM.DD HH:mm:ss' };
  const referenceDate = { now: () => clock ?? Date.now() };
  const referenceMoment = (...args) => args.length ? moment(...args) : moment(referenceDate.now());
  const exporter = factories.export({ browser, moment: referenceMoment, log, getSessions,
    getSettings: key => settings[key], init: async () => {} });
  const backup = factories.backup({
    browser, moment: referenceMoment, Date: referenceDate, log, Sessions, getSettings: key => settings[key], setSettings: (key, value) => { settings[key] = value; },
    exportSessions: exporter.exportSessions, getSessions,
    ...zip, addEntry: manifestModule.addEntry, getManifest: manifestModule.getManifest,
  });
  let disposed = false;
  return {
    provenance: { commit: GARRISON_COMMIT, dependencyVersions: Object.fromEntries(Object.entries(runtime.manifest.dependencies).map(([k,v]) => [k,v.version])),
      originalSourceVerified: true, realSessionIndexedDB: true, extensionStorageShim: 'IndexedDB', downloadSink: 'Blob URL fetch to in-memory Uint8Array; no OS download',
      exposedPrivateFunction: 'backupComplete', moduleSyntaxOnlyAdapted: true },
    packRecords: runtime.packRecords, unpackRecords: runtime.unpackRecords,
    transformSessions: runtime.transformSessions, transformationAudit: runtime.transformationAudit,
    async seedDatabase(sessions) {
      await Sessions.deleteAll();
      for (const session of sessions) await Sessions.put(clone(session));
    },
    async readDatabase() { return getSessions(); },
    async fingerprint() { return backup.getSessionsFingerprint(); },
    async backupComplete() {
      const before = deliveries.length;
      await backup.backupComplete();
      const delivered = deliveries.length > before ? deliveries.at(-1) : null;
      if (delivered) for (const listener of [...listeners]) listener({ id: delivered.id, state: { current: 'complete' } });
      const manifest = await manifestModule.getManifest();
      return { skipped: !delivered, bytes: delivered?.bytes, filename: delivered?.filename,
        manifestEntry: manifest.complete.at(-1), manifest, delivery: delivered ? { conflictAction: delivered.conflictAction, saveAs: delivered.saveAs, mimeType: delivered.mimeType } : null };
    },
    async backup(mode, { now } = {}) {
      if (now !== undefined && (!Number.isSafeInteger(now) || now < 0)) throw new Error('Invalid replay backup time');
      clock = now ?? null;
      const modes = {
        'individual-json': { backupComplete: false, individualBackup: true },
        'complete-plus-individual-json': { backupComplete: true, individualBackup: true },
        'legacy-all-json': { backupComplete: false, individualBackup: false },
        'complete-zip': null,
      };
      if (!Object.hasOwn(modes, mode)) throw new Error('Unknown native Garrison backup mode');
      const before = deliveries.length;
      if (mode === 'complete-zip') await backup.backupComplete();
      else {
        Object.assign(settings, modes[mode]);
        await backup.backupSessions();
        await backup.drain();
      }
      const emitted = deliveries.slice(before);
      for (const delivery of emitted) {
        for (const listener of [...listeners]) listener({ id: delivery.id, state: { current: 'complete' } });
        await exporter.handleDownloadsChanged({ id: delivery.id, state: { current: 'complete' } });
      }
      const manifest = await manifestModule.getManifest();
      return { mode, skipped: emitted.length === 0,
        deliveries: emitted.map(delivery => ({ ...delivery, format: delivery.filename.endsWith('.zip') ? 'zip' : 'json' })), manifest,
        lastBackupTime: settings.lastBackupTime, replayTime: referenceDate.now() };
    },
    readDeliveryArchive(delivery) {
      if (delivery.filename.endsWith('.zip')) return this.readArchive(delivery.bytes);
      const sessions = JSON.parse(fflate.strFromU8(delivery.bytes));
      if (!Array.isArray(sessions)) throw new Error('Native JSON backup payload is not a sessions array');
      return { sessions, jsonName: delivery.filename, jsonBytes: delivery.bytes };
    },
    readArchive(bytes) {
      const entries = fflate.unzipSync(bytes);
      const names = Object.keys(entries);
      if (names.length !== 1 || !/^TSG-complete-.*\.json$/.test(names[0])) throw new Error('Not a single-entry Garrison CompleteZIP');
      const jsonBytes = entries[names[0]];
      const sessions = JSON.parse(fflate.strFromU8(jsonBytes));
      if (!Array.isArray(sessions)) throw new Error('Garrison archive payload is not a sessions array');
      return { sessions, jsonName: names[0], jsonBytes };
    },
    async getManifest() { return manifestModule.getManifest(); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      sessionModule.close(); storage.close();
      await request(indexedDB.deleteDatabase('sessions'));
      await request(indexedDB.deleteDatabase(metadataName));
    },
  };
}
