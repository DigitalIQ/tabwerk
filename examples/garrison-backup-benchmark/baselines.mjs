import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { gzipSync, gunzipSync } from 'node:zlib';

export const json = value => Buffer.from(JSON.stringify(value));
const zipOptions = { level: 6, mtime: new Date('2000-01-01T00:00:00Z') };
export const pointName = index => `point-${String(index).padStart(6, '0')}.json`;
export const zipOne = (name, bytes) => Buffer.from(zipSync({ [name]: bytes }, zipOptions));
export const unzipOne = (bytes, name) => {
  const entries = unzipSync(bytes, { filter: entry => entry.name === name });
  if (!entries[name]) throw new Error(`Missing ZIP entry: ${name}`);
  return JSON.parse(strFromU8(entries[name]));
};

// Jeder Verlaufspunkt ist ein Exportarray. Die Baselines erhalten denselben Verlauf.
export const methods = {
  'zip-points-pretty': {
    description: 'One ZIP per point, pretty JSON like Garrison; summed retained files',
    layout: 'separate-files',
    append: point => zipOne('point.json', strToU8(JSON.stringify(point, null, '  '))),
    restore: (files, index) => unzipOne(files[index], 'point.json'),
  },
  'zip-points': {
    description: 'One ZIP per point, compact JSON; summed retained files',
    layout: 'separate-files',
    append: point => zipOne('point.json', json(point)),
    restore: (files, index) => unzipOne(files[index], 'point.json'),
  },
  'gzip-points': {
    description: 'One gzip per point, compact JSON; summed retained files',
    layout: 'separate-files',
    append: point => gzipSync(json(point), { level: 6 }),
    restore: (files, index) => JSON.parse(gunzipSync(files[index])),
  },
  'zip-rollup': {
    description: 'One ZIP with a separate compact JSON entry per point',
    layout: 'single-file',
    build: history => Buffer.from(zipSync(Object.fromEntries(history.map((point, i) => [pointName(i), json(point)])), zipOptions)),
    restore: (bytes, index) => unzipOne(bytes, pointName(index)),
  },
  'zip-combined': {
    description: 'One compact JSON history in one ZIP entry; whole-history rebuild',
    layout: 'single-file',
    build: history => zipOne('history.json', json(history)),
    restore: (bytes, index) => unzipOne(bytes, 'history.json')[index],
  },
  'gzip-combined': {
    description: 'One compact JSON history in gzip; whole-history rebuild',
    layout: 'single-file',
    build: history => gzipSync(json(history), { level: 6 }),
    restore: (bytes, index) => JSON.parse(gunzipSync(bytes))[index],
  },
};

export function fileBytes(value) {
  return Array.isArray(value) ? value.reduce((sum, bytes) => sum + bytes.length, 0) : value.length;
}
