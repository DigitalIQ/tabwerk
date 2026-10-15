import assert from 'node:assert/strict';
import { encodeExport, decodeExport, jsonBytes } from './adapter.mjs';
import { syntheticExport } from './fixture.mjs';

async function measure(source) {
  const archive = await encodeExport(source);
  assert.deepEqual(await decodeExport(JSON.parse(JSON.stringify(archive))), source);
  return {
    synthetic: true,
    sessions: source.length,
    windowReferences: archive.manifests.reduce((n, m) => n + m.windowsRefs.length, 0),
    storedBlocks: Object.keys(archive.blocks).length,
    compactJsonBytes: jsonBytes(source),
    completeArchiveBytes: jsonBytes(archive),
    roundtrip: 'equal',
  };
}

const repeated = await measure(syntheticExport());
assert.equal(repeated.windowReferences, 4);
assert.equal(repeated.storedBlocks, 3);

// Weitere vollständig erfundene Exporte zeigen den Overhead ohne Blockwiederholung.
const small = {
  id: 'small-one', name: 'Einmaliger kleiner Export', date: 1700000000000,
  lastEditedTime: 1700000000000, sessionStartTime: 1699999990000,
  tag: ['synthetisch'], tabsNumber: 1, windowsNumber: 1,
  windowsInfo: { 1: { id: 1, focused: true, incognito: false, state: 'normal' } },
  windows: { 1: { 2: {
    id: 2, windowId: 1, index: 0, url: 'https://example.org/a',
    title: 'Erfundener erster Tab', pinned: false, active: true,
    groupId: -1, lastAccessed: 1700000000000,
  } } },
};
const changed = structuredClone(small);
changed.id = 'small-two';
changed.name = 'Verändertes einzelnes Fenster';
changed.date += 1000;
changed.lastEditedTime += 1000;
changed.windows[1][2] = {
  ...changed.windows[1][2],
  url: 'https://example.net/andere-seite', title: 'Anderer erfundener Tab',
  pinned: true, lastAccessed: 1700000001000,
};
const once = await measure([small]);
const allChanged = await measure([small, changed]);
assert.equal(once.storedBlocks, 1);
assert.equal(allChanged.storedBlocks, 2);

console.log(JSON.stringify({
  ...repeated,
  unfavorableCases: [
    { case: 'ein-kleines-fenster-einmalig', ...once },
    { case: 'ein-kleines-fenster-in-beiden-sessions-veraendert', ...allChanged },
  ],
}, null, 2));
