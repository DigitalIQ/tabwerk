import { encodeWindow, decodeWindow, DEFAULT_LIMITS, type SessionWindow, type JsonValue } from '../src/index.js';
import { splitWindow, joinWindow, gzip, planRetention } from '../src/legacy.js';

const window: SessionWindow = {
  id: 1, focused: true, incognito: false, state: 'normal',
  tabs: [{ id: 2, url: 'https://example.test', title: 'Test', active: true, pinned: false, groupId: -1, extra: { nested: [null, 42] } }],
  groups: [],
};
const encoded = await encodeWindow(window, { maxDepth: DEFAULT_LIMITS.maxDepth });
const restored: SessionWindow = await decodeWindow(encoded.ref, encoded.block);
const retained: JsonValue = restored.tabs[0].extra;
const old = await splitWindow(window);
await joinWindow(old.ref, await gzip(old.body));
const result = planRetention([{ t: 1, custom: 'kept' }]);
const custom: string = result.keep[0].custom;
void retained; void custom;
// @ts-expect-error Codec limits are numbers.
encodeWindow(window, { maxTabs: 'many' });
// @ts-expect-error Every core window field is required.
encodeWindow({ tabs: [], groups: [] });
// @ts-expect-error Unknown options are not accepted.
encodeWindow(window, { unlimited: true });
// @ts-expect-error Block version is a literal discriminant.
decodeWindow(encoded.ref, { ...encoded.block, version: 2 });
