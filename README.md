# Tabwerk

Chrome-Extension für viele offene Tabs. Tabwerk findet, gruppiert, sortiert und entdoppelt Tabs, beobachtet Webseiten und sichert jeden Stand von Fenstern, Tabs und Gruppen.

Alles, was sich exakt berechnen lässt, erledigt Code. Für semantische Fragen nutzt Tabwerk optional [Jev](https://docs.typesafe.ai), ein Entscheidungsmodell von TypeSafe. Jev ist erreichbar über [OpenRouter](https://openrouter.ai) oder direkt über [TypeSafe](https://typesafe.ai). Ohne Schlüssel laufen alle Funktionen, die nur Code brauchen.

## Funktionen

| Bereich | Was passiert | Wer entscheidet |
|---|---|---|
| Schnellsuche | Per Tastenkürzel über jeder Seite: Tabs, Aktionen, Lesezeichen, Verlauf | Code (unscharfe Suche), Jev nur auf Wunsch mit `⇧↵` |
| Finden | Du beschreibst einen Tab in eigenen Worten, Tabwerk springt hin | Jev (`choice`) |
| Gruppen | Vorschlag für bestehende Gruppen oder neue aus deinen Kategorien, mit Sicherheit pro Tab | Jev (`choice`) |
| Sortieren | Tabs oder ganze Gruppen nach Priorität, dazu nach Website, zuletzt benutzt, Öffnungszeit oder Titel | Priorität: Jev (`score`), sonst Code |
| Doppelte | gleiche Adressen finden, pro Eintrag wählen, was zugeht; gleichen Inhalt unter anderer Adresse finden | Adressen: Code, Inhalt: Jev (`noul`) |
| Wächter | Seite beobachten und melden, wenn eine Bedingung in Alltagssprache eintritt | Vergleich: Code, Bewertung: Jev (`noul`) |
| Verlauf | sichert nach jeder Änderung, stellt jeden Stand wieder her | Code |
| Aufräum-Vorschlag | markiert alte und unwichtige Tabs zum Schließen | Alter: Code, Wichtigkeit: Jev (`score`) |
| Einsortieren | neue Tabs landen automatisch in der passenden Gruppe | Regeln: Code, sonst optional Jev |
| Doppel-Schutz | eine schon offene Seite öffnet sich nicht noch einmal, außer du willst es | Code |
| Entladen | inaktive Tabs geben Speicher frei | Code |
| Notizen | Notiz an einen Tab heften, per Rechtsklick, `Alt+Umschalt+N` oder Schnellsuche | Code |
| Gruppennamen | Gruppen ohne Titel bekommen einen kurzen Namen | Kandidaten: Code, Auswahl: Jev |
| Sitzungen | Fenster unter einem Namen speichern und wieder öffnen | Code |
| Fokus | andere Gruppen einklappen, ablenkende Seiten auf Zeit sperren | Code |
| Schlummern | Tab schließen und zur gewählten Zeit wieder öffnen | Code |
| Linkliste | Tabs als Markdown oder Text kopieren | Code |
| Statistik | Tabs pro Fenster und Website, älteste Tabs, Verlauf der Anzahl | Code |
| Formulare | speichern, ausfüllen, mit Testdaten füllen | Code, unbekannte Felder optional Jev |
| Export und Import | alles als Datei, Sitzungen auch als Lesezeichen-Datei | Code |

Jede Funktion lässt sich in den Einstellungen einzeln ausschalten. Abhängige Funktionen hängen an der übergeordneten.

Jede Aktion sichert vorher den Stand. „Rückgängig“ im Popup oder `Alt+Umschalt+Z` springt genau dorthin zurück.

Was Jev gut kann und wo es schwach ist, steht in [docs/jev-im-browser.md](docs/jev-im-browser.md).

## Installieren

1. Repository klonen oder als ZIP laden und entpacken.
2. In Chrome `chrome://extensions` öffnen.
3. Oben rechts „Entwicklermodus“ einschalten.
4. „Entpackte Erweiterung laden“ und den Ordner wählen.
5. Die Einstellungen öffnen sich. Wähle OpenRouter oder TypeSafe und verbinde Tabwerk. Das ist optional.

Tastenkürzel:

| Kürzel | Aktion |
|---|---|
| `⌘⇧Leertaste` (Mac), `Strg+Umschalt+Leertaste` | Schnellsuche |
| `Alt+Umschalt+T` | Popup |
| `Alt+Umschalt+N` | Notiz zum aktuellen Tab |
| `Alt+Umschalt+Z` | Letzte Tabwerk-Aktion rückgängig |
| frei wählbar | Formular ausfüllen |

Ändern unter `chrome://extensions/shortcuts`.

## Pro Fenster

Gruppen, Sortieren, Doppelte, Rückgängig und der Verlauf arbeiten im Fenster, in dem du das Popup öffnest. Andere Fenster bleiben unberührt. Doppelte und Verlauf haben ein Häkchen „Alle Fenster“. Finden und Schnellsuche durchsuchen alle Fenster und zeigen Tabs aus dem aktuellen Fenster zuerst.

## Schnellsuche

- Tippen sucht per Code, unscharf: „gh tabw“ findet „GitHub … tabwerk“. Umlaute und ß sind egal.
- Filter: `/t` Tabs, `/a` Aktionen, `/b` Lesezeichen, `/h` Verlauf, `/n` Notizen, `/s` Sitzungen, `/z` geschlummerte Tabs, `/f` Formulare.
- Farbmodus: automatisch nach Website, wie das System, immer hell oder immer dunkel.
- Volltext: auf Wunsch sucht die Schnellsuche auch im sichtbaren Text offener Tabs.
- Mit `/h` und `⇧↵` findet Jev Seiten aus dem Verlauf per Beschreibung, etwa „der Artikel über Solarstrom von letzter Woche“.
- `↵` öffnet, `⌘⌫` schließt den gewählten Tab, `Esc` schließt die Suche.
- Aktionen: Tab schließen, anpinnen, stumm, duplizieren, in neues Fenster, Doppelte schließen, sortieren, Gruppen ein- und ausklappen, Rückgängig, Jetzt sichern und mehr. Aktionen mit Jev sind markiert.
- Lesezeichen und Verlauf schaltest du in den Einstellungen ein. Chrome fragt dann einmal nach der Erlaubnis.
- Jev fragt die Schnellsuche nie beim Tippen, nur mit `⇧↵` und nur, wenn du das in den Einstellungen einschaltest.

Auf normalen Webseiten liegt die Suche über der Seite, der Hintergrund bleibt als Milchglas sichtbar. Auf `chrome://`-Seiten und im Web Store darf keine Erweiterung etwas einblenden. Dort öffnet sich ein kleines Fenster.

## Wächter

Ein Wächter prüft eine Seite in festem Abstand: 5 Minuten, 15 Minuten, 1 Stunde, 6 Stunden, 24 Stunden oder individuell im Format `hh:mm:ss`. Chrome weckt Erweiterungen höchstens alle 30 Sekunden.

Anlegen geht im Popup oder per Rechtsklick auf einer Seite:

- „Diese Seite beobachten“
- „Auf markierten Text achten“ übernimmt die Markierung in die Bedingung
- „Verlinkte Seite beobachten“ auf einem Link

Tabwerk vergleicht den Text der Seite im Code. Nur wenn sich etwas geändert hat, fragt es Jev, ob die Änderung zur Bedingung passt. Ist die Seite in einem Tab offen, liest Tabwerk den gerenderten Text aus dem Tab. Sonst lädt es die Seite im Hintergrund.

## Verlauf

Tabwerk hört auf jede Änderung an Tabs, Gruppen und Fenstern. Nach 1,5 Sekunden Ruhe legt es eine Sicherung an. Ist der Stand gleich wie zuletzt, entsteht keine neue. Zusätzlich sichert ein Wecker alle 10 Minuten.

Aufbewahrung: die letzten 24 Stunden vollständig (höchstens 400), bis 7 Tage eine pro Stunde, bis 90 Tage eine pro Tag.

Beim Wiederherstellen nutzt Tabwerk offene Tabs weiter. Fehlende Tabs öffnet es neu. Tabs, die im alten Stand nicht vorkamen, bleiben offen und rücken ans Ende. Vor jedem Wiederherstellen sichert Tabwerk den aktuellen Stand.

Der Verlauf liegt nur lokal in `chrome.storage.local`. Er ersetzt kein Backup über eine Neuinstallation hinweg.

## Datenschutz und Sicherheit

- Tabwerk hat keinen eigenen Server und sammelt keine Nutzungsdaten.
- An Jev gehen nur die Daten der jeweiligen Frage: Tab-Titel, Website und Pfad. Query-Parameter und Anker bleiben lokal. Wächter schicken nur die geänderten Zeilen der beobachteten Seite.
- Websites auf der Ausschlussliste in den Einstellungen gehen nie an Jev.
- Der Schlüssel liegt unverschlüsselt in `chrome.storage.local` und wird nicht synchronisiert. Jede Erweiterung mit Zugriff auf dein Chrome-Profil könnte ihn lesen. Nutze einen eigenen Schlüssel mit Ausgabenlimit.
- Leserechte für Websites fragt Tabwerk einzeln an, erst beim Anlegen eines Wächters.
- Lesezeichen und Verlauf sind optionale Rechte. Tabwerk fragt erst, wenn du die Suche darin einschaltest.
- Das Repository enthält keine Schlüssel. Tests laufen ohne Schlüssel mit festen Testantworten.

Die ausführliche Datenschutzerklärung steht in [PRIVACY.md](PRIVACY.md).

## Entwickeln

```bash
npm install
npm test          # Unit-Tests ohne Browser
npm run e2e       # lädt die Extension in Chrome for Testing und klickt alles durch
npm run icons     # rendert die Icons neu
npm run pack      # baut dist/tabwerk-<version>.zip für den Chrome Web Store
npm run store     # erzeugt Store-Bilder aus den Test-Screenshots
```

Texte und Angaben für den Chrome Web Store stehen in [store/listing.md](store/listing.md) und [store/review.md](store/review.md).

`npm run e2e` braucht ein Chrome for Testing aus dem Playwright-Cache oder `CHROME_PATH`. Jev-Anfragen gehen im Test an einen lokalen Proxy:

| Umgebung | Proxy antwortet mit |
|---|---|
| nichts gesetzt oder `JEV_OFFLINE=1` | festen Testantworten, ohne Netz |
| `OPENROUTER_API_KEY` | echten Antworten von Jev über OpenRouter |
| `JEV_HELPER=/pfad/zum/skript` | Ausgabe eines eigenen Skripts, das eine Anfrage-Datei an Jev schickt |

Prüfungen, die echte Jev-Antworten brauchen, überspringt der Test offline. Alle Testdaten sind erfunden.

Aufbau:

```
manifest.json
src/background.js      Service Worker, Nachrichten, Ereignisse, Wecker, Kontextmenü
src/lib/jev.js         Jev über OpenRouter oder TypeSafe
src/lib/prompts.js     Fragen an Jev (reine Funktionen)
src/lib/features.js    Finden, Gruppen, Sortieren, Doppelte
src/lib/history.js     Verlauf und Wiederherstellen
src/lib/fuzzy.js       unscharfe Suche
src/lib/actions.js     Aktionen der Schnellsuche
src/lib/watch.js       Wächter
src/lib/duration.js    Intervalle
src/lib/flags.js       Schalter für jede Funktion
src/lib/extras.js      Aufräumen, Einsortieren, Doppel-Schutz, Notizen, Sitzungen, Fokus, Schlummern, Statistik
src/lib/formsbg.js     Formulare speichern und ausfüllen
src/lib/transfer.js    Export und Import
src/content/forms.js   Funktionen, die in der Seite laufen
src/palette/           Schnellsuche
src/popup/             Popup
src/options/           Einstellungen
src/watch/             Fenster für neue Wächter aus dem Kontextmenü
src/note/              Notiz-Fenster
src/focus/             Seite für gesperrte Websites im Fokus
src/stats/             Statistik
src/offscreen/         HTML zu Text für Wächter
tests/                 node --test
scripts/e2e.mjs        Ende-zu-Ende-Test
```

## Lizenz

Tabwerk steht unter der MIT-Lizenz, siehe [LICENSE](LICENSE).

Schrift Geist und Geist Mono: SIL Open Font License, siehe `assets/fonts/LICENSE-Geist.txt`. Icons Phosphor: MIT, siehe `assets/icons/LICENSE-Phosphor.txt`.
