// Stop consuming output as soon as the decoded byte budget is exceeded. The
// decompressor can allocate its current chunk internally; this is not a CPU or
// process-memory sandbox.
export async function readBounded(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError('Expected byte stream');
      size += value.byteLength;
      if (size > maxBytes) throw new RangeError('Stream byte limit exceeded');
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(error); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function fromBase64(text, maxBytes) {
  if (typeof text !== 'string') throw new TypeError('Compressed data must be base64 text');
  if (text.length > 4 * Math.ceil(maxBytes / 3)) throw new RangeError('Compressed byte limit exceeded');
  if (!text.length || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new TypeError('Invalid base64 data');
  const binary = atob(text);
  if (binary.length > maxBytes) throw new RangeError('Compressed byte limit exceeded');
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (toBase64(bytes) !== text) throw new TypeError('Non-canonical base64 data');
  return bytes;
}

export async function compress(bytes, maxBytes) {
  return toBase64(await readBounded(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')), maxBytes));
}

export async function decompress(text, limits) {
  const bytes = fromBase64(text, limits.maxCompressedBytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return readBounded(stream, limits.maxDecompressedBytes);
}
