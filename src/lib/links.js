// Tabs als Linkliste für die Zwischenablage.

const escapeMd = (text) => (text || '').replace(/([[\]\\])/g, '\\$1');

export function toLinkList(tabs, format = 'markdown') {
  const web = tabs.filter((t) => /^https?:/.test(t.url || ''));
  if (format === 'text') return web.map((t) => `${t.title || t.url}\n${t.url}`).join('\n\n');
  return web.map((t) => `- [${escapeMd(t.title || t.url)}](${t.url.replace(/\)/g, '%29')})`).join('\n');
}
