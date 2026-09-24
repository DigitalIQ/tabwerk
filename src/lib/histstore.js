// Speicherformat des Verlaufs. Jedes Fenster wird als Block gespeichert, gepackt mit gzip.
// Der Schlüssel eines Blocks ist ein Fingerabdruck seines Inhalts. Ein Fenster, das sich nicht
// ändert, liegt deshalb nur einmal im Speicher, egal wie viele Sicherungen darauf zeigen.
// Ohne chrome.*, damit die Tests in Node laufen.

export const BLOCK_PREFIX = 'hwin:';

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

export async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return toBase64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

export async function gunzip(text) {
  const stream = new Blob([fromBase64(text)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// 96 Bit aus SHA-256. Kollisionen sind bei dieser Menge praktisch ausgeschlossen.
export async function contentKey(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Der aktive Tab wechselt oft. Er steht deshalb im Verweis, nicht im Block.
export async function splitWindow(w) {
  const body = JSON.stringify({
    tabs: w.tabs.map(({ active, ...t }) => t),
    groups: w.groups,
  });
  const block = await contentKey(body);
  const ref = { id: w.id, focused: w.focused, incognito: w.incognito, state: w.state, active: w.tabs.findIndex((t) => t.active), block };
  return { ref, block, body };
}

export async function joinWindow(ref, data) {
  const { tabs, groups } = JSON.parse(await gunzip(data));
  const { block, active, ...rest } = ref;
  return { ...rest, tabs: tabs.map((t, i) => ({ ...t, active: i === active })), groups };
}

// Blöcke, die nach dem Aufräumen keine Sicherung mehr braucht.
export function orphanBlocks(keep, drop) {
  const used = new Set(keep.flatMap((e) => e.blocks || []));
  return [...new Set(drop.flatMap((e) => e.blocks || []))].filter((b) => !used.has(b));
}
