import { encodeExport, decodeExport } from '../tab-session-manager/adapter.mjs';
import { decodeWindow } from '../../packages/session-codec/src/index.js';

const FORMAT = 'tabwerk-garrison-history';
const HASH = /^[0-9a-f]{64}$/;
const pendingAppends = new WeakSet();
const own = (value, key) => Object.hasOwn(value, key);

// Der Container ist ein In-Memory-Vergleichsformat, kein transaktionaler
// Disk-Store. Aufrufer verändern ihn während appendPoint nicht selbst.
export function createArchive() {
  return { format: FORMAT, version: 1, points: [], blocks: {} };
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} muss ein Objekt sein`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`${label} muss ein einfaches JSON-Objekt sein`);
}

function exact(value, keys, label) {
  record(value, label);
  if (Object.keys(value).length !== keys.length || keys.some(key => !own(value, key))) throw new TypeError(`Ungültige Felder in ${label}`);
}

// Unbekannte JSON-Metadaten bleiben erhalten. Keine JSON.stringify-Normalisierung,
// die etwa undefined still entfernt oder einen Getter/toJSON aufruft.
function copyJson(value, ancestors = new Set(), depth = 0) {
  if (depth > 128) throw new RangeError('JSON-Struktur zu tief');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || !value) throw new TypeError('Nur JSON-Daten sind erlaubt');
  if (ancestors.has(value)) throw new TypeError('Zyklische JSON-Daten');
  const array = Array.isArray(value);
  if (array) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('Ungültiger Array-Prototyp');
  } else record(value, 'JSON-Wert');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) throw new TypeError('Symbol-Keys sind keine JSON-Daten');
  if (array && (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) throw new TypeError('Arrays müssen dicht und ohne Zusatzfelder sein');
  ancestors.add(value);
  const entries = [];
  const ordered = array ? Array.from({ length: value.length }, (_, i) => String(i)) : keys;
  for (const key of ordered) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) throw new TypeError('Nur eigene JSON-Datenfelder sind erlaubt');
    entries.push([key, copyJson(descriptor.value, ancestors, depth + 1)]);
  }
  ancestors.delete(value);
  return array ? entries.map(([, entry]) => entry) : Object.fromEntries(entries);
}

function validateReference(ref) {
  exact(ref, ['version', 'id', 'focused', 'incognito', 'state', 'active', 'block'], 'Fensterreferenz');
  if (ref.version !== 1 || typeof ref.block !== 'string' || !HASH.test(ref.block)) throw new TypeError('Ungültige Blockreferenz');
  if (!Number.isSafeInteger(ref.id) || !Number.isSafeInteger(ref.active) || ref.active < -1 || typeof ref.focused !== 'boolean' || typeof ref.incognito !== 'boolean' || typeof ref.state !== 'string') throw new TypeError('Ungültige Fensterreferenz');
}

function validateBlock(key, block) {
  exact(block, ['version', 'encoding', 'hash', 'data'], 'Fensterblock');
  if (!HASH.test(key) || block.hash !== key || block.version !== 1 || block.encoding !== 'gzip-base64' || typeof block.data !== 'string') throw new TypeError('Ungültiger Fensterblock');
}

function references(point) {
  exact(point, ['manifests'], 'Sicherungspunkt');
  if (!Array.isArray(point.manifests)) throw new TypeError('Session-Manifeste fehlen');
  const refs = [];
  for (const manifest of point.manifests) {
    exact(manifest, ['metadata', 'windowsRefs'], 'Session-Manifest');
    record(manifest.metadata, 'Session-Metadaten');
    if (own(manifest.metadata, 'windows')) throw new TypeError('Fenster gehören in die Referenzliste');
    if (!Array.isArray(manifest.windowsRefs)) throw new TypeError('Fensterreferenzen fehlen');
    const keys = new Set();
    for (const entry of manifest.windowsRefs) {
      exact(entry, ['key', 'ref'], 'Fenstereintrag');
      if (typeof entry.key !== 'string' || keys.has(entry.key)) throw new TypeError('Ungültiger oder doppelter Fenster-Key');
      keys.add(entry.key);
      validateReference(entry.ref);
      refs.push(entry.ref);
    }
  }
  return refs;
}

function snapshotArchive(archive) {
  const snapshot = copyJson(archive);
  exact(snapshot, ['format', 'version', 'points', 'blocks'], 'Archiv');
  if (snapshot.format !== FORMAT || snapshot.version !== 1 || !Array.isArray(snapshot.points)) throw new TypeError('Unbekanntes History-Archivformat');
  record(snapshot.blocks, 'Archivblöcke');
  for (const [key, block] of Object.entries(snapshot.blocks)) validateBlock(key, block);
  for (const point of snapshot.points) {
    for (const ref of references(point)) {
      if (!own(snapshot.blocks, ref.block)) throw new Error('Referenzierter Fensterblock fehlt');
    }
  }
  return snapshot;
}

function pointIndex(index, length) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new RangeError('Ungültiger Sicherungspunkt-Index');
}

export async function appendPoint(archive, sourceExportArray) {
  record(archive, 'Archiv');
  if (pendingAppends.has(archive)) throw new Error('appendPoint läuft bereits für dieses Archiv');
  for (const key of ['points', 'blocks']) {
    const descriptor = Object.getOwnPropertyDescriptor(archive, key);
    if (!descriptor || !own(descriptor, 'value') || !descriptor.writable) throw new TypeError('Archiv muss beschreibbare Datenfelder besitzen');
  }
  pendingAppends.add(archive);
  try {
    const before = snapshotArchive(archive);
    const source = copyJson(sourceExportArray);
    const encoded = await encodeExport(source);
    const point = { manifests: encoded.manifests };
    const refs = references(point);
    const additions = {};
    for (const [hash, block] of Object.entries(encoded.blocks)) {
      validateBlock(hash, block);
      if (!own(before.blocks, hash)) additions[hash] = block;
      else if (before.blocks[hash].data !== block.data) {
        // gzip kann bei gleichem Inhalt andere Bytes erzeugen. Einen bestehenden
        // Block nur weiterverwenden, wenn der Codec seinen Inhalt verifiziert.
        const ref = refs.find(candidate => candidate.block === hash);
        if (!ref) throw new Error('Fensterblock ohne Referenz');
        await decodeWindow(ref, before.blocks[hash]);
      }
    }
    const nextBlocks = { ...before.blocks, ...additions };
    for (const ref of refs) if (!own(nextBlocks, ref.block)) throw new Error('Neuer Fensterblock fehlt');
    // Erst nach allen await-/Fehlerpfaden ersetzen. Keine externe I/O und keine
    // Änderung bestehender Points oder Blöcke während der Kodierung.
    const nextPoints = [...before.points, point];
    archive.blocks = nextBlocks;
    archive.points = nextPoints;
    return { newBlockCount: Object.keys(additions).length };
  } finally {
    pendingAppends.delete(archive);
  }
}

export async function restorePoint(archive, index) {
  const snapshot = snapshotArchive(archive);
  pointIndex(index, snapshot.points.length);
  return decodeExport({
    format: 'tabwerk-tsm-offline', version: 1,
    manifests: snapshot.points[index].manifests,
    blocks: snapshot.blocks,
  });
}

export function retainPoints(archive, indices) {
  const snapshot = snapshotArchive(archive);
  if (!Array.isArray(indices)) throw new TypeError('Indices müssen ein Array sein');
  const seen = new Set();
  for (const index of indices) {
    pointIndex(index, snapshot.points.length);
    if (seen.has(index)) throw new TypeError('Doppelte Sicherungspunkt-Indices');
    seen.add(index);
  }
  const points = indices.map(index => snapshot.points[index]);
  const needed = new Set(points.flatMap(point => references(point).map(ref => ref.block)));
  return {
    format: FORMAT, version: 1, points,
    blocks: Object.fromEntries([...needed].map(hash => [hash, snapshot.blocks[hash]])),
  };
}
