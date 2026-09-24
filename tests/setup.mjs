// Unit-Tests laufen ohne Chrome. Dieser Ersatz liefert die deutschen Texte aus _locales/de.
import { readFileSync } from 'node:fs';

const messages = JSON.parse(readFileSync(new URL('../_locales/de/messages.json', import.meta.url), 'utf8'));
const lower = Object.fromEntries(Object.entries(messages).map(([k, v]) => [k.toLowerCase(), v]));

globalThis.chrome = globalThis.chrome || {
  i18n: {
    getUILanguage: () => 'de',
    getMessage: (key, subs = []) => {
      const entry = lower[key.toLowerCase()];
      if (!entry) return '';
      let msg = entry.message;
      for (const [name, ph] of Object.entries(entry.placeholders || {})) msg = msg.replace(new RegExp(`\\$${name}\\$`, 'gi'), ph.content);
      return msg.replace(/\$(\d)/g, (_, n) => subs[n - 1] ?? '').replace(/\$\$/g, '$');
    },
  },
};
