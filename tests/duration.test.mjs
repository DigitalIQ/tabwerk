import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, formatDuration, describeInterval } from '../src/lib/duration.js';

test('parseDuration liest hh:mm:ss, mm:ss und ss', () => {
  assert.equal(parseDuration('01:30:00'), 5400);
  assert.equal(parseDuration('10:00'), 600);
  assert.equal(parseDuration('45'), 45);
  assert.equal(parseDuration('00:00:30'), 30);
});

test('parseDuration lehnt Unsinn ab', () => {
  assert.equal(parseDuration('1:75:00'), null);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration(''), null);
});

test('formatDuration und describeInterval', () => {
  assert.equal(formatDuration(3725), '01:02:05');
  assert.equal(describeInterval(5), '5 Minuten');
  assert.equal(describeInterval(2), '2 Minuten');
  assert.equal(describeInterval(1.5), '00:01:30');
});
