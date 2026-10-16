import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createDeltaArchive, createDeltaHistoryValidator, restoreDeltaPoint, inspectDeltaFrame } from './delta-archive.mjs';
import { scenarios } from './fixtures.mjs';

const large = id => [{ id, metadata: { preserved: true, zero: -0 }, tabs: Array.from({ length: 150 }, (_, index) => ({ id: index, text: createHash('sha256').update(String(index)).digest('hex'), values: [null, false, index] })) }];
const read = frame => JSON.parse(gunzipSync(frame.subarray(40)));
// Nur für Manipulationstests: ein Angreifer kann ungeschützte Hashes neu bilden.
function rewrite(frame, mutate) {
  const envelope = read(frame); mutate(envelope);
  const compressed = gzipSync(JSON.stringify(envelope));
  const header = Buffer.alloc(40); header.write('TJD1'); header.writeUInt32BE(compressed.length, 4);
  createHash('sha256').update(compressed).digest().copy(header, 8);
  return Buffer.concat([header, compressed]);
}

test('all fixture points and unknown fields roundtrip with individual immutable frames', () => {
  for (const { history } of scenarios({ points: 12, windows: 3, tabsPerWindow: 8 })) {
    const writer = createDeltaArchive(), frames = history.map(point => writer.append(point));
    for (let i = 0; i < history.length; i++) assert.deepEqual(restoreDeltaPoint(frames, i), history[i]);
    assert.equal(writer.nextIndex, history.length);
    assert.equal(frames.reduce((n, frame) => n + frame.byteLength, 0), frames.reduce((n, frame) => n + inspectDeltaFrame(frame).byteLength, 0));
  }
});

test('changed session IDs use elementwise delta and checkpoints bound replay to five', () => {
  const writer = createDeltaArchive(), frames = [];
  for (let i = 0; i < 13; i++) frames.push(writer.append(large(i)));
  assert.deepEqual(frames.map(frame => inspectDeltaFrame(frame).kind), Array.from({ length: 13 }, (_, i) => i % 5 === 0 ? 'checkpoint' : 'delta'));
  assert.equal(read(frames[1]).payload[0], 'a');
  assert.equal(read(frames[1]).payload[2][0][1][0], 'o');
  assert.equal(inspectDeltaFrame(frames[1]).base, 0);
  assert.ok(frames[1].length < frames[0].length);
  const selected = frames.slice();
  for (let i = 0; i < 5; i++) Object.defineProperty(selected, i, { get() { throw new Error('Older frame accessed'); } });
  assert.deepEqual(restoreDeltaPoint(selected, 9), large(9));
});

test('arrays preserve changes, ordering, exact shrink/growth and nested types', () => {
  const history = [large(0)];
  for (let i = 0; i < 9; i++) {
    const point = structuredClone(history.at(-1));
    point[0].id++;
    point[0].tabs.reverse();
    if (i % 2) point[0].tabs.push({ unknown: [false, null, 'added', -0] });
    else point[0].tabs.splice(1, 3);
    point[0].metadata = i % 3 ? { added: ['x', { nested: i }] } : null;
    history.push(point);
  }
  history.push([], [{ value: [1, 2, 3] }], [{ value: [] }]);
  const writer = createDeltaArchive({ checkpointInterval: 100 });
  const frames = history.map(point => writer.append(point));
  for (let i = 0; i < history.length; i++) assert.deepEqual(restoreDeltaPoint(frames, i), history[i]);
});

test('object deletion and prototype-related keys remain own safe JSON fields', () => {
  const first = large(0);
  first[0].special = JSON.parse('{"__proto__":{"safe":1},"constructor":{"prototype":"data"},"toString":null,"hasOwnProperty":false,"gone":true}');
  const next = structuredClone(first);
  delete next[0].special.gone;
  delete next[0].special.constructor;
  next[0].special.__proto__.safe = 2;
  Object.defineProperty(next[0].special, 'new', { value: { kept: true }, enumerable: true });
  const writer = createDeltaArchive(), frames = [writer.append(first), writer.append(next)];
  assert.equal(inspectDeltaFrame(frames[1]).kind, 'delta');
  const output = restoreDeltaPoint(frames, 1);
  assert.deepEqual(output, next);
  assert.ok(Object.hasOwn(output[0].special, '__proto__'));
  assert.equal(Object.getPrototypeOf(output[0].special), Object.prototype);
  assert.equal({}.safe, undefined);
});

test('writer snapshots input and failed append is atomic', () => {
  const writer = createDeltaArchive(), point = large(0), original = structuredClone(point);
  const frames = [writer.append(point)], firstBytes = Buffer.from(frames[0]);
  point[0].tabs[0].text = 'mutated';
  assert.throws(() => writer.append([{ bad: undefined }]), /JSON/);
  assert.equal(writer.nextIndex, 1);
  frames.push(writer.append(point));
  assert.deepEqual(frames[0], firstBytes);
  assert.deepEqual(restoreDeltaPoint(frames, 0), original);
  const restored = restoreDeltaPoint(frames, 1); restored[0].id = 'outside';
  assert.deepEqual(restoreDeltaPoint(frames, 1), point);
});

test('tiny and unrelated points choose full checkpoints when delta costs more', () => {
  const writer = createDeltaArchive({ checkpointInterval: 50 });
  const frames = [writer.append([]), writer.append([]), writer.append([true])];
  assert.ok(frames.every(frame => inspectDeltaFrame(frame).kind === 'checkpoint'));
  assert.deepEqual(restoreDeltaPoint(frames, 2), [true]);
});

test('checkpoint-aligned retained suffix restores with original indices', () => {
  const writer = createDeltaArchive({ checkpointInterval: 3, startIndex: 10 });
  const frames = Array.from({ length: 8 }, (_, i) => writer.append(large(i)));
  for (let i = 3; i < 8; i++) assert.deepEqual(restoreDeltaPoint(frames.slice(3), i + 10, { startIndex: 13 }), large(i));
  assert.throws(() => restoreDeltaPoint(frames.slice(4), 14, { startIndex: 14 }), /Missing dependency/);
  assert.throws(() => restoreDeltaPoint(frames.slice(3), 12, { startIndex: 13 }), /outside/);
});

test('corruption, truncation, trailing bytes, changed state and dependency hashes fail', () => {
  const writer = createDeltaArchive(), frames = [writer.append(large(0)), writer.append(large(1)), writer.append(large(2))];
  for (const corrupt of [frames[0].subarray(0, -1), Buffer.concat([frames[0], Buffer.from([0])]), Buffer.from(frames[0])]) {
    if (corrupt.length === frames[0].length) corrupt[corrupt.length - 9] ^= 1;
    assert.throws(() => restoreDeltaPoint([corrupt], 0), /header|integrity/);
  }
  assert.throws(() => restoreDeltaPoint([frames[0], frames[2], frames[1]], 2), /reordered/);
  assert.throws(() => restoreDeltaPoint([undefined, frames[1]], 1), /bytes/);
  assert.throws(() => restoreDeltaPoint([frames[0], rewrite(frames[1], e => { e.baseHash = '0'.repeat(64); })], 1), /Dependency integrity/);
  assert.throws(() => restoreDeltaPoint([rewrite(frames[0], e => { e.payload[0].id = 100; })], 0), /state integrity/);
  assert.throws(() => restoreDeltaPoint([frames[0], rewrite(frames[1], e => { e.base = 55; })], 1), /dependency/);
  assert.throws(() => restoreDeltaPoint([frames[0], rewrite(frames[1], e => { e.checkpointInterval = 1; })], 1), /bound/);
});

test('explicit decode limits reject oversized frames and decompressed envelopes', () => {
  const frame = createDeltaArchive().append(large(0));
  assert.throws(() => restoreDeltaPoint([frame], 0, { maxFrameBytes: 40 }), /limit/);
  assert.throws(() => restoreDeltaPoint([frame], 0, { maxPayloadBytes: 100 }), /larger|length|size/i);
  assert.throws(() => inspectDeltaFrame(frame, { maxPayloadBytes: 0 }), /limits/);
});

test('unsupported values are rejected without invoking getters or toJSON', () => {
  const writer = createDeltaArchive();
  let invoked = false;
  const getter = {}; Object.defineProperty(getter, 'value', { enumerable: true, get() { invoked = true; return 1; } });
  for (const point of [[getter], [{ toJSON() { invoked = true; return {}; } }], [NaN], [Infinity], [1n], [new Date()], new Array(2), [Symbol('x')]]) assert.throws(() => writer.append(point));
  const cycle = []; cycle.push(cycle); assert.throws(() => writer.append(cycle), /Cyclic/);
  assert.equal(invoked, false); assert.equal(writer.nextIndex, 0);
  for (const checkpointInterval of [0, -1, 1.5, Infinity]) assert.throws(() => createDeltaArchive({ checkpointInterval }));
});

test('single-pass validation matches individual restores and exposes immutable independent snapshots', () => {
  const writer = createDeltaArchive({ checkpointInterval: 3, startIndex: 10 });
  const frames = Array.from({ length: 9 }, (_, i) => writer.append(large(i)));
  const validator = createDeltaHistoryValidator({ checkpointInterval: 3, startIndex: 10 });
  const results = frames.map(frame => validator.append(frame, { expectedFrameHash: createHash('sha256').update(frame).digest('hex') }));
  for (const [index, result] of results.entries()) {
    assert.deepEqual(result.point, restoreDeltaPoint(frames, index + 10, { startIndex: 10 }));
    assert.deepEqual(result.metadata, inspectDeltaFrame(frames[index]));
  }
  assert.throws(() => { results[0].point[0].tabs[0].values[2] = 'outside'; }, TypeError);
  assert.throws(() => { results[1].point.push('outside'); }, TypeError);
  assert.deepEqual(results[0].point, large(0));
  assert.deepEqual(results.at(-1).point, large(8));
});

test('single-pass validator rejects invalid structure, dependencies, bounds and state even with new frame hashes', () => {
  const writer = createDeltaArchive({ checkpointInterval: 3 });
  const frames = Array.from({ length: 4 }, (_, i) => writer.append(large(i)));
  const changes = [
    e => { e.payload = ['a', 1, [[0, ['invalid']]]]; },
    e => { e.payload = ['a', 1, [[0, ['v', {}]], [0, ['v', {}]]]]; },
    e => { e.baseHash = '0'.repeat(64); },
    e => { e.stateHash = '0'.repeat(64); },
    e => { e.base = 44; },
    e => { e.index = 44; },
    e => { e.checkpointInterval = 1; },
  ];
  for (const change of changes) {
    const validator = createDeltaHistoryValidator({ checkpointInterval: 3 });
    validator.append(frames[0]);
    const changed = rewrite(frames[1], change);
    assert.throws(() => validator.append(changed, { expectedFrameHash: createHash('sha256').update(changed).digest('hex') }));
    // Eine fehlgeschlagene Prüfung verändert den bisherigen Validator-State nicht.
    assert.deepEqual(validator.append(frames[1]).point, large(1));
  }
  assert.throws(() => createDeltaHistoryValidator().append(frames[1]), /reordered/);
  assert.throws(() => createDeltaHistoryValidator({ startIndex: 1 }).append(frames[1]), /Missing dependency/);
  assert.throws(() => createDeltaHistoryValidator().append(frames[0], { expectedFrameHash: '0'.repeat(64) }), /frame hash mismatch/);
  assert.throws(() => createDeltaHistoryValidator({ maxFrameBytes: 40 }).append(frames[0]), /limit/);
  assert.throws(() => createDeltaHistoryValidator({ maxPayloadBytes: 100 }).append(frames[0]), /larger|length|size/i);
  const checkpoint = rewrite(frames[3], e => { e.checkpointInterval = 2; });
  const validator = createDeltaHistoryValidator();
  frames.slice(0, 3).forEach(frame => validator.append(frame));
  assert.throws(() => validator.append(checkpoint), /bound/);
});
