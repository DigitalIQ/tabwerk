// Prüft das tatsächliche npm-Archiv und das Extension-ZIP ohne Veröffentlichung.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(root, '.tmp'), { recursive: true });
const out = mkdtempSync(join(root, '.tmp/codec-distribution-'));
const packageDir = join(root, 'packages/session-codec');
const run = (program, args, cwd = root) => execFileSync(program, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out], packageDir));
assert.ok(packed.files.some((f) => f.path === 'src/index.js'));
assert.ok(packed.files.some((f) => f.path === 'src/legacy.js'));
for (const required of ['README.md', 'SECURITY.md', 'LICENSE', 'src/index.d.ts', 'src/legacy.d.ts']) {
  assert.ok(packed.files.some((f) => f.path === required), `Paketdatei fehlt: ${required}`);
}
for (const file of packed.files) {
  assert.ok(/^(package\.json|README\.md|SECURITY\.md|LICENSE|src\/.+\.(js|d\.ts))$/.test(file.path), `Unerwartete Paketdatei: ${file.path}`);
}

const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).private, true, 'Das Extension-Root ist kein npm-Paket.');
assert.equal(manifest.publishConfig?.registry, 'https://registry.npmjs.org/');
assert.equal(manifest.publishConfig?.access, 'public');
assert.deepEqual(manifest.dependencies ?? {}, {});
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(manifest.scripts?.[hook], undefined);

const consumer = join(out, 'consumer');
mkdirSync(consumer);
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
run('npm', ['install', join(out, packed.filename), '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--cache', join(out, 'npm-cache')], consumer);
const sample = { id: 1, focused: true, incognito: false, state: 'normal', tabs: [{ id: 2, url: 'https://example.test/', title: 'Beispiel', active: true, pinned: false, groupId: -1 }], groups: [] };
writeFileSync(join(consumer, 'check.mjs'), `
import assert from 'node:assert/strict';
import { encodeWindow, decodeWindow } from ${JSON.stringify(manifest.name)};
import { splitWindow, joinWindow, gzip } from ${JSON.stringify(`${manifest.name}/legacy`)};
const window = ${JSON.stringify(sample)};
const {ref, block} = await encodeWindow(window);
assert.deepEqual(await decodeWindow(ref, block), window);
const old = await splitWindow(window);
assert.deepEqual(await joinWindow(old.ref, await gzip(old.body)), window);
console.log('Isolierter npm-Consumer: v1 und Legacy bestanden.');
`);
console.log(run(process.execPath, ['check.mjs'], consumer).trim());

const zip = join(out, 'tabwerk-review.zip');
run(process.execPath, ['scripts/pack.mjs', zip]);
const entries = run('unzip', ['-Z1', zip]).trim().split('\n');
assert.ok(entries.includes('packages/session-codec/src/legacy.js'));
assert.ok(!entries.some((p) => /(^|\/)(node_modules|tests?|\.tmp)(\/|$)/.test(p)));
const extension = join(out, 'extension');
mkdirSync(extension);
run('unzip', ['-q', zip, '-d', extension]);
// Node prüft dieselben relativen ESM-Pfade, die Chrome im ausgepackten ZIP lädt.
writeFileSync(join(extension, 'package.json'), '{"type":"module"}\n');
writeFileSync(join(extension, 'check.mjs'), `
import assert from 'node:assert/strict';
import { splitWindow, joinWindow, gzip, BLOCK_PREFIX } from './src/lib/histstore.js';
import { planRetention } from './src/lib/retention.js';
const window = ${JSON.stringify(sample)};
const {ref, body} = await splitWindow(window);
assert.equal(BLOCK_PREFIX, 'hwin:');
assert.deepEqual(await joinWindow(ref, await gzip(body)), window);
assert.equal(planRetention([{t: 1000}], 1000).keep.length, 1);
console.log('Extension-ZIP: ESM-Auflösung, Snapshot und Retention bestanden.');
`);
console.log(run(process.execPath, ['check.mjs'], extension).trim());
writeFileSync(join(out, 'result.json'), JSON.stringify({ tarball: join(out, packed.filename), zip, packageFiles: packed.files.map((f) => f.path), extension, checks: ['isolated-offline-npm-install', 'v1-roundtrip', 'legacy-roundtrip', 'zip-native-esm-resolution', 'retention'] }, null, 2));
console.log(`Prüfarbeitsverzeichnis: ${out}`);
