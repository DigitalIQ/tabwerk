// Kleines Hinweisfenster: chrome://-Seiten, der Web Store und der PDF-Betrachter erlauben
// keiner Erweiterung, etwas einzublenden. Dort öffnet sich dieses Fenster statt der Leiste.
import { initI18n, localizeDom } from '../lib/i18n.js';

await initI18n();
localizeDom();

document.querySelector('#close').addEventListener('click', () => window.close());
