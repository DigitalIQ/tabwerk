import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeExport, decodeExport, jsonBytes } from './adapter.mjs';
import { syntheticExport } from './fixture.mjs';

test('TSM-Exportarray bleibt einschließlich unbekannter Felder und Metadaten erhalten', async () => {
  const source = syntheticExport();
  const before = structuredClone(source);
  const archive = await encodeExport(source);
  assert.deepEqual(await decodeExport(JSON.parse(JSON.stringify(archive))), source);
  assert.deepEqual(source, before);
  assert.equal(archive.manifests.length, 2);
  assert.equal(Object.keys(archive.blocks).length, 3);
  assert.equal(archive.manifests[0].windowsRefs[1].ref.block, archive.manifests[1].windowsRefs[1].ref.block);
  assert.notEqual(archive.manifests[0].windowsRefs[0].ref.block, archive.manifests[1].windowsRefs[0].ref.block);
});

test('fehlende Pflichtwerte werden nur im Codec-Envelope ergänzt', async () => {
  const source = [{ id: 'minimal', windows: { 7: { 8: { url: 'https://example.org', future: { keep: 1 } } } } }];
  assert.deepEqual(await decodeExport(await encodeExport(source)), source);
});

test('ein anderer aktiver Tab braucht keinen neuen Inhaltsblock', async () => {
  const source = syntheticExport();
  source[1].windows[20][200].active = false;
  source[1].windows[20][201].active = true;
  const archive = await encodeExport(source);
  assert.equal(Object.keys(archive.blocks).length, 3);
  assert.deepEqual(await decodeExport(archive), source);
});

test('ungültiges active wird abgewiesen statt still verändert', async () => {
  const source = [{ windows: { 1: { 2: { active: 'true' } } } }];
  await assert.rejects(encodeExport(source), /Boolean/);
});

test('Tabreihenfolge aus index und originale Tab-ID-Keys bleiben erhalten', async () => {
  const source = syntheticExport().slice(0, 1);
  source[0].windows[10][100].index = 5;
  source[0].windows[10][105].index = 0;
  assert.deepEqual(await decodeExport(await encodeExport(source)), source);
});

test('fehlender oder beschädigter referenzierter Block wird abgewiesen', async () => {
  const archive = await encodeExport(syntheticExport());
  const hash = archive.manifests[0].windowsRefs[0].ref.block;
  const missing = structuredClone(archive);
  delete missing.blocks[hash];
  await assert.rejects(decodeExport(missing), /fehlt/);
  archive.blocks[hash].data = 'beschädigter Block';
  await assert.rejects(decodeExport(archive));
});

test('Browser-IDs und lastAccessed können Deduplizierung verhindern', async () => {
  const source = syntheticExport();
  source[1].windows[20][200].lastAccessed += 1;
  const archive = await encodeExport(source);
  assert.equal(Object.keys(archive.blocks).length, 4);
  assert.deepEqual(await decodeExport(archive), source);
});

test('synthetische Messung zählt kompaktes JSON und das komplette Blockarchiv', async t => {
  const source = syntheticExport();
  const archive = await encodeExport(source);
  t.diagnostic(JSON.stringify({ synthetic: true, sessions: source.length, windowsBefore: 4, storedBlocks: Object.keys(archive.blocks).length, compactJsonBytes: jsonBytes(source), completeArchiveBytes: jsonBytes(archive) }));
});
