// Macht aus HTML lesbaren Text. Der Service Worker hat keinen DOMParser, deshalb läuft das hier.

const DROP = 'script, style, noscript, template, svg, iframe, head, nav[aria-hidden="true"]';
const BLOCK = new Set(['P', 'DIV', 'LI', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE',
  'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'UL', 'OL', 'TABLE', 'BLOCKQUOTE', 'PRE', 'DT', 'DD', 'FIGCAPTION', 'LABEL', 'OPTION', 'BUTTON']);

export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = doc.title || '';
  doc.querySelectorAll(DROP).forEach((el) => el.remove());
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out.push(child.textContent);
      else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'BR') out.push('\n');
        const block = BLOCK.has(child.tagName);
        if (block) out.push('\n');
        walk(child);
        if (block) out.push('\n');
      }
    }
  };
  if (doc.body) walk(doc.body);
  return { title, text: out.join('').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim() };
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.target !== 'offscreen' || message.type !== 'parse-html') return false;
  reply(htmlToText(message.html));
  return false;
});
