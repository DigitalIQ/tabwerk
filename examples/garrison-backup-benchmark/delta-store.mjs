import { constants } from 'node:fs';
import { mkdir, lstat, open, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createDeltaArchive, createDeltaHistoryValidator, inspectDeltaFrame } from './delta-archive.mjs';

// Lokaler POSIX-Prototyp, braucht python3 mit fcntl.flock. Kein Network-Zugriff.
// Jeder Aufruf liest unter demselben OS-Lock den aktuellen Commit. Der Helper
// hält das Lock und führt ALLE Mutationen aus. Bei Prozess-Tod schließen Pipes
// und flock gibt das Lock frei. Die Lock-Datei wird niemals ersetzt/gelöscht.
// CURRENT ist der atomare Commit-Punkt. Ein Fehler nach dessen Rename kann einen
// Commit enthalten (error.committed); erst der letzte Directory-fsync bestätigt
// Haltbarkeit (error.durable). Ein Retry ist nicht automatisch idempotent.
// Stirbt der Helper ohne Outcome nach gesendetem Commit-Plan, ist committed=null
// und commitUnknown=true. Der Aufrufer muss den aktuellen Stand neu lesen.
// Format v2: kleine Manifeste referenzieren immutable, hashverknüpfte Index-
// segmente mit höchstens 32 Entries. Append ersetzt nur das letzte Segment.
// Metadaten-Schreiben ist damit beschränkt; Lesen bleibt bewusst O(n).
// FORMAT bezeichnet den Container: v1 bleibt bei migrierten Stores erhalten.
// Maßgeblich für den Index ist manifest.version. V1 wird nur nach explizitem
// migrateMetadata() verändert; die Migration lässt sämtliche Frames unverändert.
// Jeder Aufruf validiert die gesamte History in einem Durchlauf. Append baut
// den Writer aus höchstens einer frisch geprüften Checkpoint-Kette auf und
// vergleicht die regenerierten Frame-Hashes. Retain rebasiert die
// Auswahl in chronologischer Reihenfolge und erhält logische IDs. Alte Dateien
// bleiben als Orphans liegen; Retention allein gibt keinen Plattenplatz frei.
// faultInjector(phase, context) darf async warten oder werfen. Hook-Namen siehe
// DELTA_STORE_FAULT_PHASES. context enthält operation/generation/committed.
export const DELTA_STORE_FAULT_PHASES = Object.freeze([
  'locked', 'before-frame-write', 'after-frame-write', 'after-frame-fsync',
  'before-index-write', 'after-index-write', 'after-index-fsync',
  'before-manifest-write', 'after-manifest-write', 'after-manifest-fsync',
  'before-directory-fsync', 'after-directory-fsync',
  'before-pointer-write', 'after-pointer-write', 'after-pointer-fsync',
  'before-commit', 'after-commit', 'after-commit-fsync',
]);
export const DELTA_STORE_GC_FAULT_PHASES = Object.freeze(['before-gc-unlink', 'after-gc-unlink', 'after-gc-fsync']);
const FORMATS = ['tabwerk-delta-store-v1\n', 'tabwerk-delta-store-v2\n'];
const INDEX_ENTRIES = 32;
const MAX_INDEX_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FRAME_NAME = new RegExp(`^frame-${UUID}\\.bin$`);
const MANIFEST_NAME = new RegExp(`^manifest-${UUID}\\.json$`);
const INDEX_NAME = new RegExp(`^index-${UUID}\\.json$`);
const POINTER_NAME = new RegExp(`^pointer-${UUID}\\.tmp$`);
const HASH = /^[0-9a-f]{64}$/;
const safe = n => Number.isSafeInteger(n) && n >= 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
function parseStoreJSON(bytes) {
  try { return JSON.parse(bytes); }
  catch { throw new Error('Invalid store JSON'); }
}

// stdin ist ein exklusiver Command-Kanal. Jeder Hook braucht eine Bestätigung,
// sodass EOF nach SIGKILL die nächste Mutation verhindert. Bei einem Kill direkt
// am Commit sind alter oder neuer Stand zulässig, niemals ein Teilstand.
const HELPER = String.raw`
import os, sys, json, base64, fcntl, stat, hashlib, uuid
stats = dict(frameWrites=0, indexWrites=0, indexBytesWritten=0, manifestWrites=0, pointerWrites=0, fileFsyncs=0, directoryFsyncs=0, bytesWritten=0, fileUnlinks=0)
committed = False
durable = False
def output(value):
    print(json.dumps(value), flush=True)
def command():
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError('Parent disconnected')
    value = json.loads(line)
    if value.get('abort'):
        raise RuntimeError('Transaction aborted')
    return value
def event(phase, **context):
    output(dict(event=phase, committed=committed, durable=durable, stats=stats, **context))
    return command()
def directory_sync():
    os.fsync(root)
    stats['directoryFsyncs'] += 1
def ensure_format():
    try:
        os.stat('FORMAT', dir_fd=root, follow_symlinks=False)
        return
    except FileNotFoundError:
        pass
    temporary = 'format-' + str(uuid.uuid4()) + '.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)
    data = b'tabwerk-delta-store-v2\n'
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
        os.fsync(fd)
        stats['fileFsyncs'] += 1
        stats['bytesWritten'] += len(data)
    finally:
        os.close(fd)
    os.replace(temporary, 'FORMAT', src_dir_fd=root, dst_dir_fd=root)
    directory_sync()
def write_file(name, data, category):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
        stats[category] += 1
        stats['bytesWritten'] += len(data)
        if category == 'indexWrites':
            stats['indexBytesWritten'] += len(data)
        event('after-' + ('frame' if category == 'frameWrites' else 'index' if category == 'indexWrites' else 'manifest' if category == 'manifestWrites' else 'pointer') + '-write')
        os.fsync(fd)
        stats['fileFsyncs'] += 1
    finally:
        os.close(fd)
try:
    path = sys.argv[1]
    root = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = os.open('.writer.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=root)
    info = os.fstat(lock)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError('Unsafe lock file')
    fcntl.flock(lock, fcntl.LOCK_EX)
    request = event('locked')
    plan = request.get('plan')
    if plan is not None:
        for frame in plan['frames']:
            event('before-frame-write')
            write_file(frame['file'], base64.b64decode(frame['data'], validate=True), 'frameWrites')
            event('after-frame-fsync')
        for index in plan['indices']:
            event('before-index-write')
            write_file(index['file'], base64.b64decode(index['data'], validate=True), 'indexWrites')
            event('after-index-fsync')
        event('before-manifest-write')
        write_file(plan['manifestFile'], base64.b64decode(plan['manifest'], validate=True), 'manifestWrites')
        event('after-manifest-fsync')
        event('before-directory-fsync')
        directory_sync()
        event('after-directory-fsync')
        event('before-pointer-write')
        write_file(plan['pointerFile'], base64.b64decode(plan['pointer'], validate=True), 'pointerWrites')
        event('after-pointer-fsync')
        event('before-commit')
        os.replace(plan['pointerFile'], 'CURRENT', src_dir_fd=root, dst_dir_fd=root)
        committed = True
        # Genesis muss vor seinem beobachtbaren Postcommit-Hook auch FORMAT
        # publizieren. Normale Mutationen haben bereits einen durable Marker.
        if request.get('ensureFormat'):
            ensure_format()
        event('after-commit')
        directory_sync()
        durable = True
        event('after-commit-fsync')
    if request.get('ensureFormat'):
        ensure_format()
    garbage = request.get('gc')
    if garbage:
        for item in garbage:
            event('before-gc-unlink', file=item['file'])
            fd = os.open(item['file'], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise RuntimeError('Unsafe garbage file')
                with os.fdopen(fd, 'rb', closefd=False) as stream:
                    actual = hashlib.file_digest(stream, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(stream.read()).hexdigest()
                if actual != item['sha256']:
                    raise RuntimeError('Garbage hash mismatch')
            finally:
                os.close(fd)
            os.unlink(item['file'], dir_fd=root)
            stats['fileUnlinks'] += 1
            event('after-gc-unlink', file=item['file'])
        directory_sync()
        durable = True
        event('after-gc-fsync')
    output(dict(done=True, committed=committed, durable=durable, stats=stats))
except Exception as error:
    try:
        output(dict(error=type(error).__name__ + ': ' + str(error), committed=committed, durable=durable, stats=stats))
    except Exception:
        pass
    sys.exit(1)
`;

async function readRegular(directory, name, maxBytes = Infinity) {
  const handle = await open(`${directory}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new Error('Unsafe or oversized store file');
    return await handle.readFile();
  } finally { await handle.close(); }
}

function validIndexRef(ref) {
  return ref && typeof ref.file === 'string' && INDEX_NAME.test(ref.file) && typeof ref.sha256 === 'string' && HASH.test(ref.sha256);
}

function validateManifest(manifest, checkpointInterval) {
  if (!manifest || ![1, 2].includes(manifest.version) || !safe(manifest.generation) || !safe(manifest.nextId) || !safe(manifest.checkpointInterval) || manifest.checkpointInterval < 1) throw new Error('Invalid committed manifest');
  if (manifest.checkpointInterval !== checkpointInterval) throw new Error('Store checkpointInterval differs from requested interval');
  if (manifest.previous !== undefined && (!manifest.previous || typeof manifest.previous.manifest !== 'string' || !MANIFEST_NAME.test(manifest.previous.manifest) || typeof manifest.previous.sha256 !== 'string' || !HASH.test(manifest.previous.sha256))) throw new Error('Invalid previous manifest reference');
  if (manifest.version === 1) {
    if (!Array.isArray(manifest.entries)) throw new Error('Invalid committed manifest');
  } else if (!safe(manifest.entryCount) || manifest.entryCount > manifest.nextId || (manifest.entryCount === 0 ? manifest.indexRoot !== null : !validIndexRef(manifest.indexRoot)) || 'entries' in manifest) throw new Error('Invalid committed index root');
}

function validateEntry(entry) {
  if (!entry || !safe(entry.id) || !safe(entry.index) || typeof entry.file !== 'string' || !FRAME_NAME.test(entry.file) || typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)) throw new Error('Invalid committed entry');
}

async function readIndex(directory, reference) {
  if (!validIndexRef(reference)) throw new Error('Invalid index reference');
  const bytes = await readRegular(directory, reference.file, MAX_INDEX_BYTES);
  if (hash(bytes) !== reference.sha256) throw new Error('Committed index hash mismatch');
  const node = parseStoreJSON(bytes);
  if (!node || node.version !== 2 || !Array.isArray(node.entries) || !node.entries.length || node.entries.length > INDEX_ENTRIES || (node.previous !== null && !validIndexRef(node.previous))) throw new Error('Invalid index segment');
  let previous;
  for (const entry of node.entries) {
    validateEntry(entry);
    if (previous && (entry.index !== previous.index + 1 || entry.id <= previous.id)) throw new Error('Invalid index entry range');
    previous = entry;
  }
  return { ...reference, node, bytes: bytes.length };
}

async function readCommittedIndex(directory, manifest, manifestBytes) {
  const indices = [], seen = new Set();
  let reference = manifest.indexRoot, count = 0, nextStart = manifest.entryCount, totalBytes = manifestBytes;
  while (reference) {
    if (seen.has(reference.file) || indices.length >= manifest.entryCount) throw new Error('Invalid index cycle');
    seen.add(reference.file);
    const index = await readIndex(directory, reference);
    totalBytes += index.bytes;
    if (totalBytes > MAX_METADATA_BYTES) throw new RangeError('Metadata byte limit exceeded');
    const entries = index.node.entries;
    count += entries.length;
    if (count > manifest.entryCount || entries.at(-1).index !== nextStart - 1) throw new Error('Invalid index entry range');
    nextStart = entries[0].index;
    indices.push(index);
    reference = index.node.previous;
  }
  if (count !== manifest.entryCount || nextStart !== 0) throw new Error('Invalid index entry count');
  return { indices, entries: indices.toReversed().flatMap(index => index.node.entries) };
}

async function load(directory, checkpointInterval, limits, onPoint) {
  let marker;
  try { marker = await readRegular(directory, 'FORMAT', 128); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (marker && !FORMATS.includes(marker.toString())) throw new Error('Invalid store format');
  let pointer;
  try { pointer = await readRegular(directory, 'CURRENT', 1024); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (marker) throw new Error('Missing committed CURRENT');
    return { manifest: { version: 2, generation: 0, nextId: 0, checkpointInterval, entryCount: 0, indexRoot: null, entries: [] }, indices: [], metadata: [], frameBytes: 0, manifestBytes: 0, indexBytes: 0, pointerBytes: 0, markerBytes: 0 };
  }
  const ref = parseStoreJSON(pointer);
  if (!ref || typeof ref.manifest !== 'string' || !MANIFEST_NAME.test(ref.manifest) || !HASH.test(ref.sha256)) throw new Error('Invalid CURRENT');
  const bytes = await readRegular(directory, ref.manifest, 64 * 1024 * 1024);
  if (hash(bytes) !== ref.sha256) throw new Error('Committed manifest hash mismatch');
  const manifest = parseStoreJSON(bytes);
  validateManifest(manifest, checkpointInterval);
  const index = manifest.version === 2 ? await readCommittedIndex(directory, manifest, bytes.length) : { indices: [], entries: manifest.entries };
  manifest.entries = index.entries;
  const metadata = [], filenames = new Set();
  const validator = createDeltaHistoryValidator({ checkpointInterval, ...limits });
  let lastId = -1, frameBytes = 0;
  for (const [index, entry] of manifest.entries.entries()) {
    validateEntry(entry);
    if (entry.id <= lastId || entry.id >= manifest.nextId || entry.index !== index || filenames.has(entry.file)) throw new Error('Invalid committed entry');
    filenames.add(entry.file); lastId = entry.id;
    const frame = await readRegular(directory, entry.file, limits.maxFrameBytes);
    let meta, point;
    // Auch State-Hashes und Dependencies jedes historischen Frames prüfen.
    // Der Validator entpackt und rekonstruiert jeden Punkt nur einmal.
    try { ({ metadata: meta, point } = validator.append(frame, { expectedFrameHash: entry.sha256 })); }
    catch (error) {
      if (error.message === 'History frame hash mismatch') throw new Error('Committed frame hash mismatch');
      throw new Error('Committed point validation failed');
    }
    if (meta.index !== index || meta.checkpointInterval !== checkpointInterval) throw new Error('Committed frame metadata mismatch');
    metadata.push(meta); frameBytes += frame.length;
    onPoint?.(entry, meta, point, manifest);
  }
  return { manifest, indices: index.indices, metadata, frameBytes, manifestFile: ref.manifest, manifestHash: ref.sha256, manifestBytes: bytes.length, indexBytes: index.indices.reduce((sum, item) => sum + item.bytes, 0), pointerBytes: pointer.length, markerBytes: marker?.length ?? 0 };
}

function newIndex(entries, previous) {
  const bytes = encode({ version: 2, entries, previous });
  if (bytes.length > MAX_INDEX_BYTES) throw new RangeError('Index byte limit exceeded');
  return { file: `index-${randomUUID()}.json`, sha256: hash(bytes), bytes };
}

function rebuildIndex(entries) {
  const indices = [];
  let indexRoot = null;
  for (let start = 0; start < entries.length; start += INDEX_ENTRIES) {
    const index = newIndex(entries.slice(start, start + INDEX_ENTRIES), indexRoot);
    indices.push(index);
    indexRoot = { file: index.file, sha256: index.sha256 };
  }
  return { indices, indexRoot };
}

function requireV2(manifest) {
  if (manifest.version !== 2) throw new Error('Legacy store is read-only until migrateMetadata() commits format v2');
}

function planFor(manifest, frames, indices = [], indexBytes = 0) {
  const persisted = { ...manifest };
  if (persisted.version === 2) delete persisted.entries;
  const manifestFile = `manifest-${randomUUID()}.json`, bytes = encode(persisted);
  if (bytes.length + indexBytes > MAX_METADATA_BYTES) throw new RangeError('Metadata byte limit exceeded');
  return {
    frames: frames.map(({ file, bytes: frame }) => ({ file, data: frame.toString('base64') })),
    indices: indices.map(({ file, bytes: index }) => ({ file, data: index.toString('base64') })),
    manifestFile, manifest: bytes.toString('base64'), pointerFile: `pointer-${randomUUID()}.tmp`,
    pointer: encode({ manifest: manifestFile, sha256: hash(bytes) }).toString('base64'),
  };
}

/** Alle Methoden außer close() lesen den aktuellen Commit unter OS-flock neu. */
export async function openDeltaStore(directory, options = {}) {
  const checkpointInterval = options.checkpointInterval ?? 5;
  const limits = { maxFrameBytes: options.maxFrameBytes ?? 64 * 1024 * 1024, maxPayloadBytes: options.maxPayloadBytes ?? 256 * 1024 * 1024 };
  if (!safe(checkpointInterval) || checkpointInterval < 1) throw new TypeError('Invalid checkpointInterval');
  for (const value of Object.values(limits)) if (!safe(value) || value < 1) throw new TypeError('Invalid decode limits');
  directory = resolve(directory);
  const firstCreated = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Store directory must not be a symlink');
  // Persistiere neu angelegte Verzeichniseinträge bis zum vorhandenen Parent.
  if (firstCreated) {
    let path = directory;
    const stop = resolve(firstCreated, '..');
    while (true) {
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
      if (path === stop) break;
      path = resolve(path, '..');
    }
  }
  const fault = options.faultInjector ?? options.fault;
  if (fault !== undefined && typeof fault !== 'function') throw new TypeError('faultInjector must be a function');
  let closed = false, queue = Promise.resolve();
  const counters = { transactions: 0, frameWrites: 0, indexWrites: 0, indexBytesWritten: 0, manifestWrites: 0, pointerWrites: 0, fileFsyncs: 0, directoryFsyncs: 0, bytesWritten: 0, fileUnlinks: 0 };

  async function transaction(operation, task, onPoint) {
    if (closed) throw new Error('Store is closed');
    const run = async () => {
      if (closed) throw new Error('Store is closed');
      const child = spawn(options.pythonExecutable ?? 'python3', ['-u', '-c', HELPER, directory], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      let stderr = '', taskResult, failure, committed = false, durable = false, latestStats = {}, generation;
      let planSent = false, outcomeKnown = false, intentionalAbort = false;
      child.stderr.on('data', bytes => { if (stderr.length < 2048) stderr += bytes.toString().slice(0, 2048 - stderr.length); });
      const exited = new Promise(resolveExit => {
        child.on('error', error => resolveExit({ error }));
        child.on('exit', (code, signal) => resolveExit({ code, signal }));
      });
      try {
        for await (const line of createInterface({ input: child.stdout })) {
          const message = JSON.parse(line);
          committed = message.committed ?? committed; durable = message.durable ?? durable;
          latestStats = message.stats ?? latestStats;
          if (message.error) { outcomeKnown = true; failure ??= new Error(`Store helper: ${message.error}`); continue; }
          if (message.done) { outcomeKnown = true; continue; }
          if (!message.event) throw new Error('Invalid helper protocol');
          if (message.event === 'locked') {
            const state = await load(directory, checkpointInterval, limits, onPoint);
            generation = state.manifest.generation;
            try { await fault?.('locked', { operation, generation, committed, durable }); }
            catch (error) { intentionalAbort = true; throw error; }
            const result = await task(state);
            taskResult = result.result;
            generation = result.manifest?.generation ?? generation;
            const plan = result.manifest ? planFor(result.manifest, result.frames, result.indices, result.indexBytes) : null;
            planSent = Boolean(plan);
            child.stdin.write(`${JSON.stringify({ plan, gc: result.gc, ensureFormat: operation === 'open' })}\n`);
          } else {
            try { await fault?.(message.event, { operation, generation, committed, durable, ...(message.file ? { file: message.file } : {}) }); }
            catch (error) { intentionalAbort = true; throw error; }
            child.stdin.write('{}\n');
          }
        }
      } catch (error) {
        failure = error;
        child.stdin.destroy();
      }
      child.stdin.end();
      const exit = await exited;
      if (!outcomeKnown && !failure) failure = new Error('Store helper ended without outcome');
      counters.transactions++;
      for (const [name, value] of Object.entries(latestStats)) counters[name] += value;
      if (failure || exit.error || exit.code !== 0) {
        const error = failure ?? exit.error ?? new Error(`Store helper exited (${exit.code ?? exit.signal})${stderr ? ': ' + stderr.trim() : ''}`);
        const commitUnknown = planSent && !outcomeKnown && !intentionalAbort && !committed;
        if (commitUnknown) committed = null;
        error.committed = committed; error.durable = durable;
        error.commitUnknown = commitUnknown;
        throw error;
      }
      return taskResult;
    };
    const pending = queue.then(run, run);
    queue = pending.catch(() => {});
    return pending;
  }

  await transaction('open', async state => state.manifestFile ? { result: undefined } : { manifest: state.manifest, frames: [], result: undefined });
  return Object.freeze({
    directory,
    async migrateMetadata() {
      return transaction('migrateMetadata', async ({ manifest, manifestFile, manifestHash }) => {
        if (manifest.version === 2) return { result: { migrated: false, version: 2 } };
        if (!safe(manifest.generation + 1)) throw new RangeError('Store generations exhausted');
        const { indices, indexRoot } = rebuildIndex(manifest.entries);
        const next = { version: 2, generation: manifest.generation + 1, nextId: manifest.nextId, checkpointInterval, entryCount: manifest.entries.length, indexRoot, previous: { manifest: manifestFile, sha256: manifestHash } };
        return { manifest: next, frames: [], indices, indexBytes: indices.reduce((sum, item) => sum + item.bytes.length, 0), result: { migrated: true, version: 2 } };
      });
    },
    async append(point) {
      let resumePoints = [];
      return transaction('append', async ({ manifest, metadata, manifestFile, manifestHash, indices, indexBytes }) => {
        requireV2(manifest);
        if (!Number.isSafeInteger(manifest.nextId + 1) || !Number.isSafeInteger(manifest.generation + 1)) throw new RangeError('Store IDs exhausted');
        const startIndex = resumePoints[0]?.index ?? metadata.length;
        const writer = createDeltaArchive({ checkpointInterval, startIndex });
        for (const { index, point: restored } of resumePoints) {
          const regenerated = writer.append(restored);
          if (hash(regenerated) !== manifest.entries[index].sha256) throw new Error('Writer resume frame mismatch');
        }
        const bytes = writer.append(point);
        // Der Store muss seine eigenen Frames mit denselben Limits wieder lesen.
        inspectDeltaFrame(bytes, limits);
        const file = `frame-${randomUUID()}.bin`, id = manifest.nextId;
        const entry = { id, index: manifest.entries.length, file, sha256: hash(bytes) };
        const tail = indices[0];
        const index = tail && tail.node.entries.length < INDEX_ENTRIES ? newIndex([...tail.node.entries, entry], tail.node.previous) : newIndex([entry], manifest.indexRoot);
        const next = { ...manifest, generation: manifest.generation + 1, nextId: id + 1, entryCount: manifest.entries.length + 1, indexRoot: { file: index.file, sha256: index.sha256 }, ...(manifestFile ? { previous: { manifest: manifestFile, sha256: manifestHash } } : {}) };
        return { manifest: next, frames: [{ file, bytes }], indices: [index], indexBytes: indexBytes + index.bytes.length - (tail && tail.node.entries.length < INDEX_ENTRIES ? tail.bytes : 0), result: id };
      }, (entry, meta, restored) => {
        if (meta.kind === 'checkpoint') resumePoints = [];
        resumePoints.push({ index: entry.index, point: restored });
      });
    },
    async list() { return transaction('list', async ({ manifest }) => ({ result: manifest.entries.map(entry => entry.id) })); },
    async restore(id) {
      let restored;
      return transaction('restore', async ({ manifest }) => {
        const entry = manifest.entries.find(item => item.id === id);
        if (!entry) throw new RangeError('Point outside retained history');
        // Der öffentliche Restore bleibt ein unabhängig veränderbarer Snapshot.
        return { result: structuredClone(restored) };
      }, (entry, _meta, point) => { if (entry.id === id) restored = point; });
    },
    async retain(ids) {
      if (!Array.isArray(ids) || ids.some(id => !safe(id)) || new Set(ids).size !== ids.length) throw new TypeError('retain requires distinct numeric IDs');
      // Kopie vor dem ersten await schützt gegen spätere Änderungen des Aufrufers.
      const wanted = new Set(ids);
      const writer = createDeltaArchive({ checkpointInterval }), replacements = [], entries = [];
      return transaction('retain', async ({ manifest, manifestFile, manifestHash }) => {
        if (wanted.size !== manifest.entries.filter(entry => wanted.has(entry.id)).length) throw new RangeError('Cannot retain missing IDs');
        const kept = manifest.entries.filter(entry => wanted.has(entry.id)), removedIds = manifest.entries.filter(entry => !wanted.has(entry.id)).map(entry => entry.id);
        if (!removedIds.length) return { result: { retainedIds: kept.map(entry => entry.id), removedIds } };
        requireV2(manifest);
        if (!Number.isSafeInteger(manifest.generation + 1)) throw new RangeError('Store generations exhausted');
        const { indices, indexRoot } = rebuildIndex(entries);
        const next = { ...manifest, generation: manifest.generation + 1, entryCount: entries.length, indexRoot, previous: { manifest: manifestFile, sha256: manifestHash } };
        return { manifest: next, frames: replacements, indices, indexBytes: indices.reduce((sum, item) => sum + item.bytes.length, 0), result: { retainedIds: entries.map(entry => entry.id), removedIds } };
      }, (entry, _meta, point, manifest) => {
        if (wanted.size >= manifest.entries.length || !wanted.has(entry.id)) return;
        const bytes = writer.append(point);
        inspectDeltaFrame(bytes, limits);
        const file = `frame-${randomUUID()}.bin`;
        entries.push({ id: entry.id, index: entries.length, file, sha256: hash(bytes) });
        replacements.push({ file, bytes });
      });
    },
    async collectGarbage() {
      return transaction('collectGarbage', async ({ manifest, manifestFile, indices }) => {
        // Nur Dateien aus der hashverknüpften Commit-Historie gehören sicher dem
        // Store. Namensähnliche fremde Dateien und uncommittete Orphans bleiben.
        const live = new Set([manifestFile, ...indices.map(index => index.file), ...manifest.entries.map(entry => entry.file)]);
        const liveFrameHashes = new Map(manifest.entries.map(entry => [entry.file, entry.sha256]));
        const older = [], candidates = new Map(), obsoleteIndices = new Map(), seen = new Set([manifestFile]);
        // Diese Map lebt ausschließlich in diesem frisch validierten GC-Aufruf.
        // Gleiche Nodes müssen bei vielen historischen Roots nur einmal gelesen
        // werden; widersprüchliche Referenzhashes bleiben ein harter Fehler.
        const checkedIndices = new Map(indices.map(index => [index.file, index]));
        async function proveFrame(entry) {
          validateEntry(entry);
          if (live.has(entry.file)) {
            if (liveFrameHashes.get(entry.file) !== entry.sha256) throw new Error('Conflicting historic frame reference');
            return;
          }
          if (candidates.has(entry.file)) {
            if (candidates.get(entry.file).sha256 !== entry.sha256) throw new Error('Conflicting historic frame reference');
            return;
          }
          let frame;
          try { frame = await readRegular(directory, entry.file, limits.maxFrameBytes); }
          catch (error) { if (error.code === 'ENOENT') return; throw error; }
          if (hash(frame) !== entry.sha256) throw new Error('Historic frame hash mismatch');
          candidates.set(entry.file, { file: entry.file, sha256: entry.sha256, bytes: frame.length });
        }
        async function proveIndex(root) {
          const path = new Set();
          let reference = root, upper = Infinity;
          while (reference) {
            if (!validIndexRef(reference) || path.has(reference.file)) throw new Error('Invalid historic index history');
            path.add(reference.file);
            const known = checkedIndices.get(reference.file);
            if (known && known.sha256 !== reference.sha256) throw new Error('Conflicting historic index reference');
            let index = known;
            if (!index) {
              try { index = await readIndex(directory, reference); }
              catch (error) { if (error.code === 'ENOENT') break; throw error; }
              checkedIndices.set(index.file, index);
            }
            if (index.node.entries.at(-1).index >= upper) throw new Error('Invalid historic index entry range');
            upper = index.node.entries[0].index;
            if (known) break; // Dessen gesamte vorhandene Kette wurde bewiesen.
            for (const entry of index.node.entries) await proveFrame(entry);
            if (!live.has(index.file)) obsoleteIndices.set(index.file, { file: index.file, sha256: index.sha256, bytes: index.bytes, start: upper });
            reference = index.node.previous;
          }
        }
        let reference = manifest.previous;
        let newerGeneration = manifest.generation;
        while (reference) {
          if (!MANIFEST_NAME.test(reference.manifest) || !HASH.test(reference.sha256) || seen.has(reference.manifest)) throw new Error('Invalid manifest history');
          seen.add(reference.manifest);
          let bytes;
          try { bytes = await readRegular(directory, reference.manifest, 64 * 1024 * 1024); }
          catch (error) { if (error.code === 'ENOENT') break; throw error; }
          if (hash(bytes) !== reference.sha256) throw new Error('Historic manifest hash mismatch');
          const historic = parseStoreJSON(bytes);
          validateManifest(historic, checkpointInterval);
          if (historic.generation >= newerGeneration) throw new Error('Invalid historic manifest');
          newerGeneration = historic.generation;
          older.push({ file: reference.manifest, sha256: reference.sha256, bytes: bytes.length });
          if (historic.version === 2) await proveIndex(historic.indexRoot);
          else for (const entry of historic.entries) await proveFrame(entry);
          reference = historic.previous;
        }
        // Frames zuerst, dann Index-Abhängigkeiten vor deren Eltern, zuletzt
        // Manifeste vom ältesten zum jüngsten. Ein fehlender historischer Node
        // beendet nur diesen Zweig; andere Roots bleiben weiterhin auswertbar.
        const gc = [...candidates.values(), ...[...obsoleteIndices.values()].sort((a, b) => a.start - b.start), ...older.reverse()];
        return { gc, result: { deletedFiles: gc.length, reclaimedBytes: gc.reduce((sum, entry) => sum + entry.bytes, 0) } };
      });
    },
    async inspect() {
      return transaction('inspect', async state => {
        const { manifest, metadata } = state;
        const referenced = new Set(['CURRENT', 'FORMAT', '.writer.lock', state.manifestFile, ...state.indices.map(index => index.file), ...manifest.entries.map(entry => entry.file)]);
        let totalFileBytes = 0, orphanBytes = 0, otherBytes = 0, orphanFiles = 0;
        for (const name of await readdir(directory)) {
          const info = await lstat(`${directory}/${name}`);
          if (!info.isFile()) continue;
          totalFileBytes += info.size;
          if (!referenced.has(name)) {
            if (FRAME_NAME.test(name) || MANIFEST_NAME.test(name) || INDEX_NAME.test(name) || POINTER_NAME.test(name)) { orphanBytes += info.size; orphanFiles++; }
            else otherBytes += info.size;
          }
        }
        const referencedFrameBytes = state.frameBytes;
        const referencedManifestBytes = state.manifestBytes + state.indexBytes;
        const accounting = { referencedFrameBytes, referencedManifestBytes, referencedIndexBytes: state.indexBytes, currentPointerBytes: state.pointerBytes, formatBytes: state.markerBytes, referencedBytes: referencedFrameBytes + referencedManifestBytes + state.pointerBytes + state.markerBytes, totalFileBytes, orphanBytes, orphanFiles, otherBytes };
        return { result: { version: manifest.version, generation: manifest.generation, nextId: manifest.nextId, checkpointInterval, ids: manifest.entries.map(entry => entry.id), entries: manifest.entries.map((entry, index) => ({ ...entry, ...metadata[index] })), accounting, counters: { ...counters } } };
      });
    },
    async close() { await queue; closed = true; },
  });
}
