import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { originalModuleBody } from './garrison-browser-reference.mjs';

export const GARRISON_COMMIT = '850099b1b0b8a03bef1743c2e21f42f951e08e2e';
const repo = 'superuser-miguel/Tab-Session-Garrison';
const sources = [
  'src/background/backup.js', 'src/background/backupZip.js',
  'src/background/backupManifest.js', 'src/background/getSessions.js',
  'src/background/sessions.js', 'src/background/import.js',
  'src/background/save.js', 'src/background/autoSave.js',
  'src/background/export.js', 'src/common/tabGroupUtils.js',
  'src/common/makeSearchInfo.js', 'src/options/components/ImportSessionsComponent.js',
  'src/settings/defaultSettings.js', 'package.json', 'package-lock.json', 'LICENSE',
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function download(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'tabwerk-local-reference-research' } });
  if (!response.ok) throw new Error(`Reference HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function prepareReference(root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))) {
  const directory = join(root, '.tmp/garrison-browser-reference');
  const runtime = join(directory, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const entries = {};
  const current = await download(`https://api.github.com/repos/${repo}/commits/main`);
  const currentCommit = JSON.parse(current).sha;
  await writeFile(join(directory, 'current-main.json'), current, { mode: 0o600 });
  for (const path of sources) {
    const url = `https://raw.githubusercontent.com/${repo}/${GARRISON_COMMIT}/${path}`;
    const bytes = await download(url);
    const target = join(runtime, path);
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
    entries[path] = { sha256: sha(bytes), bytes: bytes.length, url };
  }
  const lock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8'));
  const dependencyFiles = { fflate: 'esm/browser.js', moment: 'moment.js', loglevel: 'lib/loglevel.js' };
  const dependencies = {};
  for (const [name, file] of Object.entries(dependencyFiles)) {
    const pkg = lock.packages[`node_modules/${name}`];
    const bytes = await download(pkg.resolved);
    const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    if (actual !== pkg.integrity) throw new Error(`Dependency integrity failed: ${name}`);
    const tgz = join(directory, `${name}-${pkg.version}.tgz`);
    await writeFile(tgz, bytes, { mode: 0o600 });
    const destination = join(runtime, 'dependencies', name);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    execFileSync('tar', ['-xzf', tgz, '--strip-components=1', '-C', destination]);
    const key = `dependencies/${name}/${file}`;
    const source = await readFile(join(runtime, key));
    entries[key] = { sha256: sha(source), bytes: source.length, url: pkg.resolved };
    dependencies[name] = { version: pkg.version, integrity: pkg.integrity, tarSha256: sha(bytes), file: key };
  }
  const generated = {};
  const factories = {
    tabGroupUtils: ['src/common/tabGroupUtils.js', [], '{ referencedTabGroups }'],
    makeSearchInfo: ['src/common/makeSearchInfo.js', [], '{ makeSearchInfo }'],
    sessions: ['src/background/sessions.js', ['browser','log','referencedTabGroups','makeSearchInfo'], '{ Sessions, close: () => DB?.close() }'],
    getSessions: ['src/background/getSessions.js', ['log','Sessions'], 'getSessions', { defaultName: 'getSessions' }],
    backupZip: ['src/background/backupZip.js', ['browser','log','zipSync','strToU8'], '{ buildZip, writeBackupFile }'],
    backupManifest: ['src/background/backupManifest.js', ['browser','log'], '{ getManifest, saveManifest, addEntry }'],
    export: ['src/background/export.js', ['browser','moment','log','getSessions','getSettings','init'], '{ exportSessions, handleDownloadsChanged }', { defaultName: null }],
    backup: ['src/background/backup.js', ['browser','moment','Date','log','Sessions','getSettings','setSettings','exportSessions','getSessions','buildZip','writeBackupFile','addEntry','getManifest'], '{ backupComplete, getSessionsFingerprint, backupSessions, drain: () => Promise.all(pendingOperations.splice(0)) }'],
  };
  await mkdir(join(runtime, 'generated'), { recursive: true, mode: 0o700 });
  for (const [name, [path, bindings, expression, options]] of Object.entries(factories)) {
    let body = originalModuleBody(await readFile(join(runtime, path), 'utf8'), options);
    if (name === 'backup') {
      for (const fn of ['backupIndividualSessions','backupAllSessions']) {
        body = body.replace(`const ${fn} = async`, `const untracked_${fn} = async`);
      }
      body += '\nconst pendingOperations = [];\n';
      for (const fn of ['backupIndividualSessions','backupAllSessions']) {
        body += `const ${fn} = (...args) => { const result = untracked_${fn}(...args); pendingOperations.push(result); return result; };\n`;
      }
    }
    const bytes = Buffer.from(`// Generated locally from ${repo}@${GARRISON_COMMIT}/${path}.\nexport default function instantiate({${bindings.join(',')}}) {\n${body}\nreturn (${expression});\n}\n`);
    const key = `generated/${name}.mjs`;
    await writeFile(join(runtime, key), bytes, { mode: 0o600 });
    generated[key] = { sha256: sha(bytes), source: path, sourceSha256: entries[path].sha256 };
  }
  for (const name of ['moment', 'loglevel']) {
    const path = dependencies[name].file;
    const bytes = Buffer.from(`const module = {exports:{}};\nconst exports = module.exports;\n${await readFile(join(runtime, path), 'utf8')}\nexport default module.exports;\n`);
    const key = `generated/${name}.mjs`;
    await writeFile(join(runtime, key), bytes, { mode: 0o600 });
    generated[key] = { sha256: sha(bytes), source: path, sourceSha256: entries[path].sha256 };
  }
  const manifest = { version: 1, repo, commit: GARRISON_COMMIT, currentMainCommit: currentCommit,
    checkedAt: new Date().toISOString(), entries, dependencies, generated };
  await writeFile(join(runtime, 'reference-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { directory, runtime, commit: GARRISON_COMMIT, currentMainCommit: currentCommit,
    upstreamStillCurrent: currentCommit === GARRISON_COMMIT, files: Object.keys(entries).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await prepareReference(process.argv[2]), null, 2));
}
