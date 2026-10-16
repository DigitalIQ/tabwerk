import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { methods, fileBytes } from './baselines.mjs';
import { saveArchive, loadArchive } from './persistence.mjs';

test('every compressed baseline restores each distinct serialized point', () => {
  const history = [[{ id: 'one', value: '字', nested: [1, false] }], [{ id: 'two', value: 'ä', nested: [null, 3] }]];
  for (const [id, method] of Object.entries(methods)) {
    const packed = method.append ? history.map(method.append) : method.build(history);
    assert.ok(fileBytes(packed) > 0);
    history.forEach((point, i) => assert.deepEqual(method.restore(packed, i), point, id));
    if (Array.isArray(packed)) assert.equal(fileBytes(packed), packed.reduce((sum, b) => sum + b.length, 0));
  }
});

test('interrupted staged replacement preserves the previous committed archive', async () => {
  const root = resolve(import.meta.dirname, '../../.tmp');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'garrison-persistence-test-'));
  const path = join(dir, 'archive.json');
  await saveArchive(path, { version: 1, points: ['old'] });
  const original = await readFile(path);
  await assert.rejects(saveArchive(path, { version: 1, points: ['new'] }, {
    beforeRename: () => { throw new Error('simulated interruption before commit'); },
  }), /simulated interruption/);
  assert.deepEqual(await readFile(path), original);
  await saveArchive(path, { version: 1, points: ['old', 'new'] });
  assert.deepEqual(await loadArchive(path), { version: 1, points: ['old', 'new'] });
});
