// Strict IndexedDB persistence for one coordinated incremental stream. Values
// remain binary. Every mutation compares its validated read set atomically.
const equal = (a, b) => a === undefined ? b === undefined : b instanceof Uint8Array && a.length === b.length && a.every((v, i) => v === b[i]);
const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError')); tx.onerror = () => {}; });
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

export async function openIncrementalPersistence({ name, fault }) {
  if (typeof name !== 'string' || !name.length || name.length > 256) throw new TypeError('Incremental persistence name required');
  if (!globalThis.indexedDB || !globalThis.navigator?.locks?.request) throw new Error('IndexedDB and Web Locks are required');
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore('records');
  const db = await request(opening);
  db.onversionchange = () => db.close();
  let transactionDurability = 'unobserved', closed = false;
  const counters = { readTransactions: 0, recordReads: 0, bytesRead: 0, commits: 0, recordWrites: 0, bytesWritten: 0, recordDeletes: 0, bytesDeleted: 0, abortedTransactions: 0, compareBytes: 0, compareMs: 0, serializationBytes: 0, serializationMs: 0, hashBytes: 0, hashMs: 0, parseBytes: 0, parseMs: 0, base64Bytes: 0, base64Ms: 0, base64DecodeBytes: 0, base64DecodeMs: 0, validationBytes: 0, validationMs: 0 };
  function check() { if (closed) throw new Error('Incremental persistence closed'); }
  return {
    lock(fn) { check(); return navigator.locks.request(`tabwerk-incremental:${name}`, { mode: 'exclusive' }, fn); },
    async read(keys) {
      check(); const tx = db.transaction('records', 'readonly'), completed = done(tx), store = tx.objectStore('records');
      const values = await Promise.all(keys.map(key => request(store.get(key)))); await completed;
      counters.readTransactions++; counters.recordReads += keys.length;
      for (const value of values) { if (value !== undefined && !(value instanceof Uint8Array)) throw new Error('Invalid incremental persisted bytes'); counters.bytesRead += value?.length ?? 0; }
      return new Map(keys.map((key, i) => [key, values[i]]));
    },
    async commit(operation, expected, writes, deletions = []) {
      check(); await fault?.('before-commit', { operation, committed: false });
      const tx = db.transaction('records', 'readwrite', { durability: 'strict' }), completed = done(tx), store = tx.objectStore('records');
      transactionDurability = tx.durability ?? 'default'; let failure;
      function hook(phase) {
        const result = fault?.(phase, { operation, committed: false, transaction: tx });
        if (result && typeof result.then === 'function') { result.catch(() => {}); throw new TypeError('In-transaction fault hooks must be synchronous'); }
      }
      const abort = error => { failure = error; try { tx.abort(); } catch {} };
      function enqueue() {
        try { for (const [key, bytes] of writes) store.put(bytes, key); for (const key of deletions) store.delete(key); hook('transaction-enqueued'); }
        catch (error) { abort(error); }
      }
      try {
        if (transactionDurability !== 'strict') throw new Error('IndexedDB strict durability is required');
        hook('transaction-started'); let remaining = expected.size + (operation === 'init' ? 1 : 0);
        if (!remaining) enqueue();
        if (operation === 'init') {
          const count = store.count();
          count.onsuccess = () => {
            if (count.result !== 0) { abort(new Error('Incremental persisted head missing from nonempty store')); return; }
            if (--remaining === 0) enqueue();
          };
        }
        for (const [key, bytes] of expected) {
          const req = store.get(key);
          req.onsuccess = () => {
            try {
              const started = performance.now(), matches = equal(bytes, req.result);
              counters.compareMs += performance.now() - started; counters.compareBytes += bytes?.length ?? 0;
              counters.recordReads++; counters.bytesRead += req.result?.length ?? 0;
              if (!matches) throw new Error('Incremental persistence changed during operation');
              if (--remaining === 0) enqueue();
            } catch (error) { abort(error); }
          };
        }
      } catch (error) { abort(error); }
      try { await completed; } catch (error) { counters.abortedTransactions++; throw failure ?? error; }
      counters.commits++; counters.recordWrites += writes.size; counters.bytesWritten += [...writes.values()].reduce((sum, bytes) => sum + bytes.length, 0); counters.recordDeletes += deletions.length; counters.bytesDeleted += deletions.reduce((sum, key) => sum + (expected.get(key)?.length ?? 0), 0);
      try { await fault?.('after-commit', { operation, committed: true }); }
      catch (error) { error.committed = true; throw error; }
    },
    account(kind, bytes, ms) { counters[`${kind}Bytes`] += bytes; counters[`${kind}Ms`] += ms; },
    inspect() { return { counters: { ...counters }, transactionDurability }; },
    close() { closed = true; db.close(); },
  };
}
