# tabwerk-session-codec

An ESM codec for compressed browser-window snapshots. Store an unchanged window
once and refer to it from several saved sessions, even when its active tab changes.
It has no runtime dependencies, browser permissions, storage adapter or network
access.

```sh
npm install tabwerk-session-codec
```

Maintained by [Manuel Bissinger (DigitalIQ)](https://github.com/DigitalIQ).
See [SECURITY.md](SECURITY.md) for security responsibility and private reporting.

## Scope

The codec handles a browser-window schema, not arbitrary application backups.
Your application captures and restores tabs, stores references and blocks, and
chooses when to delete them. Keep additional window and session metadata in your
own manifest. Unknown JSON fields on tabs and groups are preserved. IDs, timestamps
and any other changing tab fields remain in the block and can reduce deduplication.

Tabwerk uses the separate legacy entry point for its existing archive format.
The repository's `examples/tab-session-manager` directory demonstrates a local
adapter for a third-party export format. It is an offline example, not an upstream
integration, endorsement or evidence of adoption.

## Example

The bare import below works after installation from npm or a local tarball.
In this repository, import
`packages/session-codec/src/index.js` by its relative path instead.

```js
import { encodeWindow, decodeWindow } from 'tabwerk-session-codec';

const window = {
  id: 1, focused: true, incognito: false, state: 'normal',
  tabs: [{
    id: 10, url: 'https://example.com/', title: 'Example',
    pinned: false, active: true, groupId: -1,
    lastAccessed: 1800000000000,
  }],
  groups: [],
};

const { ref, block } = await encodeWindow(window);
const blocks = new Map();
if (!blocks.has(block.hash)) blocks.set(block.hash, block);
const manifest = { windows: [ref] };

const storedRef = manifest.windows[0];
const restored = await decodeWindow(storedRef, blocks.get(storedRef.block));
```

For persistent storage, write a block and its manifest atomically where possible.
Do not remove a block until no retained manifest references it. A Map in this
example illustrates the relationship; it is not a concurrent database protocol.

## v1 API and format

- `encodeWindow(window, options?)` returns a Promise of `{ ref, block }`.
- `decodeWindow(ref, block, options?)` returns a Promise of a restored window.
- `DEFAULT_LIMITS` is a frozen object containing the defaults below.

```js
ref = {
  version: 1,
  id: 1, focused: true, incognito: false, state: 'normal',
  active: 0, // Tab array index; -1 means no active tab.
  block: '...', // 64 lowercase hexadecimal SHA-256 characters.
};
block = {
  version: 1,
  encoding: 'gzip-base64',
  hash: '...', // Same hash as ref.block.
  data: '...', // Canonical padded base64 of gzip-compressed UTF-8 JSON.
};
```

The uncompressed body is `{ version: 1, tabs: [...], groups: [...] }`. Each stored
tab omits `active`. Window metadata and the active index are in the reference.
Object keys within tabs and groups are sorted before serialization; array order
is preserved. The body hash covers the exact uncompressed bytes. It does not
cover the reference, authenticate the sender, encrypt data or guarantee identical
gzip bytes across runtimes. Decode checks the format, hash, input schema and limits.

Windows require exactly `id` (safe integer), `focused` and `incognito` (booleans),
`state` (string), `tabs` and `groups` (arrays). Each tab requires safe integer `id`
and `groupId`, string `url` and `title`, boolean `pinned` and `active`. Zero or one
tab may be active. Groups require safe integer `id`, string `title` and `color`,
and boolean `collapsed`. The codec does not validate URLs, assign browser IDs or
resolve group references. Consumers must enforce their own navigation policy.

Additional tab/group fields may contain JSON primitives, dense arrays and plain
objects, including null-prototype input objects. Decode returns ordinary objects.
Finite numbers are accepted; JSON serialization normalizes negative zero to zero.
Undefined, functions, symbols, BigInt, class instances, sparse arrays, cycles,
accessor properties and non-enumerable properties are rejected. `__proto__`,
`constructor` and `prototype` keys are rejected at every depth. This is data
validation, not isolation from malicious JavaScript Proxies or a compromised
JavaScript runtime. Use parsed JSON data from external sources.

## Bounds

Options are positive safe integers. Unknown options are errors.

| Option | Default | Maximum configurable value |
| --- | ---: | ---: |
| `maxCompressedBytes` | 2 MiB | 256 MiB |
| `maxDecompressedBytes` | 8 MiB | 256 MiB |
| `maxTabs` | 10,000 | 1,000,000 |
| `maxGroups` | 1,000 | 1,000,000 |
| `maxDepth` | 64 | 128 |
| `maxNodes` | 200,000 | 1,000,000 |

These are per-window/per-call bounds. The JSON byte budget also applies while
copying the input window and reference; leave room for metadata. The compressed
envelope has a separate base64-sized budget. Encode limits compressed output too.
Decode checks base64 size before allocating its decoded bytes, then counts bytes
as it reads the decompression stream. At the first over-budget chunk it cancels
the reader without collecting that chunk or requesting another one.

The decompressor may allocate an internal chunk before the check. JSON parsing,
cloning, UTF-8 conversion and final concatenation also use memory. These bounds do
not cap process memory or CPU time. Cap the number of snapshots, total archive
size and concurrent calls in your application. Read untrusted large archives in
a worker if responsiveness or stronger isolation is needed.

Invalid structure produces `TypeError`; exceeded bounds produce `RangeError`.
Malformed JSON, UTF-8 or gzip can also expose the corresponding platform error.
Error messages are diagnostic and are not a stable machine-readable API.

## Legacy compatibility

`tabwerk-session-codec/legacy` exports `BLOCK_PREFIX`, `gzip`, `gunzip`,
`contentKey`, `splitWindow`, `joinWindow`, `orphanBlocks` and `planRetention`.
The implementation retains the original Tabwerk v0 serialization order, 24-hex
content keys, gzip/base64 representation and retention behavior. Old blocks need
no migration. v1 does not silently interpret v0 blocks.

The legacy entry point has no v1 input limits, schema validation or hash checks.
Use it only for trusted local Tabwerk data. Its fixed retention policy keeps at
most 400 snapshots from the latest 24 hours, one per hour through day seven, one
per day through day 90, and drops older entries. Supply newest entries first.
This is Tabwerk's policy, not a suggested policy for another application's saves.

## Runtime and tests

Node 22 or newer is a package requirement, not a claim that every such release
has been tested. This change was tested under Node **26.10.0**. Browsers need ESM,
Web Crypto, CompressionStream/DecompressionStream, Blob, Response, TextEncoder,
TextDecoder, atob and btoa. In browsers Web Crypto requires a secure context.
Tabwerk targets Chrome 116 or newer; that setting alone does not verify this
package in every supported browser. No polyfills are included.

From this package directory:

```sh
npm test
```

No install is needed for the Node tests. They cover original v0 fixtures, v1
roundtrips and deduplication, invalid schemas and hashes, bounded decompression,
reader cancellation and malformed input. Type declarations are included.
`type-tests/consumer.mts` is a separate TypeScript consumer fixture.

MIT, Copyright 2026 DigitalIQ. Preserve the included license when redistributing.
The repository's Unclutter-derived decluttering code, fonts and icons are not
part of this package. See `SECURITY.md` for the disclosure policy.
