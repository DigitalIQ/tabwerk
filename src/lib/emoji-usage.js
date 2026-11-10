export const EMOJI_USAGE_KEY = 'emojiUsage';

export async function readEmojiUsage() {
  const stored = await chrome.storage.local.get(EMOJI_USAGE_KEY);
  return stored[EMOJI_USAGE_KEY] ?? {};
}

export async function recordEmojiUse({ emoji }) {
  if (typeof emoji !== 'string' || emoji.length > 32 || !/\p{Emoji}/u.test(emoji)) return;
  // Mehrere offene Schnellsuchen dürfen denselben Zähler gleichzeitig erhöhen.
  await navigator.locks.request('tabwerk-emoji-usage', async () => {
    const usage = await readEmojiUsage();
    usage[emoji] = { count: (usage[emoji]?.count ?? 0) + 1, lastUsed: Date.now() };
    await chrome.storage.local.set({ [EMOJI_USAGE_KEY]: usage });
  });
}

export function rankEmojiUsage(usage, limit = 8) {
  const entries = Object.entries(usage);
  const byRecent = ([, a], [, b]) => b.lastUsed - a.lastUsed;
  const byFrequency = ([, a], [, b]) => b.count - a.count || b.lastUsed - a.lastUsed;
  return {
    total: entries.reduce((sum, [, data]) => sum + data.count, 0),
    unique: entries.length,
    frequent: entries.slice().sort(byFrequency).slice(0, limit),
    recent: entries.sort(byRecent).slice(0, limit),
  };
}
