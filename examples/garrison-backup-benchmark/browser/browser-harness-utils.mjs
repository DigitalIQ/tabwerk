export function check(condition, label = 'Browser assertion failed') {
  if (!condition) throw new Error(label);
}

// Objekt-Key-Reihenfolge ist kein Inhalt. Negative Null bleibt unterscheidbar.
export function canonical(value) {
  if (value === null || typeof value !== 'object') return Object.is(value, -0) ? '-0' : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export const equal = (actual, expected, label) => check(canonical(actual) === canonical(expected), label);
export const clone = value => structuredClone(value);
export const round = value => Math.round(value * 1000) / 1000;
export const sum = values => values.reduce((total, value) => total + value, 0);
export const uniqueName = label => `tabwerk-browser-${label}-${crypto.randomUUID()}`;
export const asBytes = value => value instanceof Uint8Array ? value : new Uint8Array(value);
export const encodeBase64 = bytes => {
  let encoded = '';
  for (let i = 0; i < bytes.length; i += 16384) encoded += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(encoded);
};
export const decodeBase64 = value => Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
export async function digest(bytes) {
  const result = await crypto.subtle.digest('SHA-256', asBytes(bytes));
  return [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { value, ms: round(performance.now() - start) };
}
export async function rejects(fn, label) {
  let rejected = false;
  try { await fn(); } catch { rejected = true; }
  check(rejected, label);
}
export async function deleteDatabase(name) {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve;
    request.onerror = () => reject(new Error('Test database cleanup failed'));
    request.onblocked = () => reject(new Error('Test database cleanup blocked'));
  });
}
export function syntheticPoints(count = 3) {
  return Array.from({ length: count }, (_, i) => [{ id: 'synthetic', date: i, windows: { '1': { '2': { id: 2, url: 'https://example.invalid/', title: `synthetic ${i}`, active: true } } }, unknown: { n: i, negativeZero: -0, unicode: 'ä😀' } }]);
}
