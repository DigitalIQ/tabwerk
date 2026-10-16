import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { loadPrepared } from '../real-input.mjs';
import { restoreDeltaPoint } from '../delta-archive.mjs';
import { createNodeCrossRuntimeFixture } from './nodefixture-generator.mjs';

const code = dirname(fileURLToPath(import.meta.url));
const repo = resolve(code, '../../..');
const { values } = parseArgs({ options: { original: { type: 'string' }, prepared: { type: 'string' } } });
if (!values.original || !values.prepared) throw new Error('Use --original /path/export.json --prepared /path/prepared.json');
const originalPath = resolve(values.original);
const preparedPath = resolve(values.prepared);
const originalBytes = await readFile(originalPath);
const preparedBytes = await readFile(preparedPath);
const prepared = await loadPrepared(preparedPath);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
if (sha(originalBytes) !== prepared.summary.originalExportSha256) throw new Error('Original input hash does not match prepared provenance');
const input = Buffer.from(JSON.stringify({ original: JSON.parse(originalBytes), prepared: JSON.parse(preparedBytes), crossRuntime: await createNodeCrossRuntimeFixture() }));
const scratch = resolve(repo, '.tmp/garrison-browser-runs');
await mkdir(scratch, { recursive: true, mode: 0o700 });
const output = await mkdtemp(`${scratch}/run-`);
const token = randomBytes(24).toString('hex');
const prefix = `/${token}/`;
const reference = resolve(repo, '.tmp/garrison-browser-reference/runtime');
let serial = 0;
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
};
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob:; worker-src 'self'; img-src 'none'; object-src 'none'; frame-src 'none'");
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith(prefix)) return json(response, { error: 'Not found' }, 404);
    const route = decodeURIComponent(url.pathname.slice(prefix.length));
    if (request.method === 'GET' && route === 'input.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(input);
    }
    if (request.method === 'GET' && (route.startsWith('code/') || route.startsWith('reference/'))) {
      const isCode = route.startsWith('code/');
      const base = isCode ? code : reference;
      const path = resolve(base, route.slice(isCode ? 5 : 10));
      if (!path.startsWith(`${base}${sep}`) || !(await stat(path)).isFile()) return json(response, { error: 'Not found' }, 404);
      const bytes = await readFile(path);
      response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json' })[extname(path)] || 'application/octet-stream' });
      return response.end(bytes);
    }
    if (request.method !== 'POST' || !['result', 'progress', 'verify-node'].includes(route)) return json(response, { error: 'Not found' }, 404);
    if (request.headers.origin !== `http://127.0.0.1:${server.address().port}`) return json(response, { error: 'Wrong origin' }, 403);
    const chunks = []; let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 32 * 1024 * 1024) throw new Error('Request too large');
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks));
    if (route === 'verify-node') {
      const frames = payload.frames.map(value => Buffer.from(value, 'base64'));
      if (frames.length !== payload.points.length) throw new Error('Cross-runtime count mismatch');
      for (let index = 0; index < frames.length; index++) {
        if (!isDeepStrictEqual(restoreDeltaPoint(frames, index), payload.points[index])) throw new Error('Cross-runtime mismatch');
      }
      return json(response, { ok: true, verifiedPoints: frames.length });
    }
    const stamp = `${String(++serial).padStart(4, '0')}-${route}-${payload.kind || 'unknown'}`;
    await writeFile(resolve(output, `${stamp}.json`), JSON.stringify(payload, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ saved: stamp, ok: payload.ok, event: route === 'progress' ? payload.event : undefined }));
    return json(response, { ok: true, saved: stamp });
  } catch (error) {
    json(response, { error: 'Local operation failed' }, 500);
    console.error(JSON.stringify({ error: error.name, message: error.message }));
  }
});
server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}${prefix}code/benchmark.html`;
  const info = { url, output, originalSha256: sha(originalBytes), preparedSha256: sha(preparedBytes), startedAt: new Date().toISOString() };
  await writeFile(resolve(output, 'run-info.json'), JSON.stringify(info, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(info));
});
