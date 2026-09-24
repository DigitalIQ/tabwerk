# Datenschutz bei Tabwerk

Stand: 24. September 2026

Tabwerk ist eine Chrome-Erweiterung ohne eigenen Server. Der Anbieter von Tabwerk erhält keine Daten von dir. Es gibt keine Nutzungsstatistik, kein Tracking und keine Werbung.

## Was auf deinem Rechner bleibt

Alles, was Tabwerk speichert, liegt in `chrome.storage.local` in deinem Chrome-Profil:

- Einstellungen und, falls eingetragen, dein Schlüssel für OpenRouter oder TypeSafe
- der Verlauf deiner Fenster, Tabs und Gruppen
- benannte Sitzungen, Notizen, geschlummerte Tabs
- Wächter und der zuletzt gelesene Text der beobachteten Seiten
- gespeicherte Formulare. Passwort-, Karten-, Konto-, IBAN- und TAN-Felder speichert Tabwerk nur, wenn du den Schalter „Auch geschützte Felder speichern“ einschaltest. Dann liegen sie unverschlüsselt in deinem Chrome-Profil und kommen mit in den Export.
- die Liste der Websites, auf denen Tabwerk Kopieren immer erlaubt
- beim Lernen: bis zu 1000 deiner Entscheidungen zu Jev-Vorschlägen, mit Titel und Website des Tabs, Jevs Vorschlag, deiner Wahl und Jevs Sicherheit. Websites auf der Ausschlussliste fehlen. Du löschst das in den Einstellungen unter „Lernen“.

Diese Daten werden nicht synchronisiert. Du löschst sie, indem du Tabwerk entfernst oder in den Einstellungen den Verlauf leerst.

## Was Tabwerk verschickt

Nur wenn du einen Schlüssel einträgst und eine Funktion nutzt, die Jev braucht, schickt Tabwerk eine Anfrage an den Dienst, den du gewählt hast: OpenRouter (openrouter.ai) oder TypeSafe (typesafe.ai). Jev ist ein Entscheidungsmodell von TypeSafe. Die Anfrage enthält nur, was diese eine Entscheidung braucht:

| Funktion | Inhalt der Anfrage |
|---|---|
| Finden, Gruppen, Sortieren, Aufräumen, Gruppennamen | Titel, Website und Pfad der Tabs. Keine Parameter nach „?“ und keine Anker nach „#“ |
| Seitensuche nach Bedeutung | deine Suche und der sichtbare Text der aktuellen Seite: Absätze, Listenpunkte, Überschriften, Zitate und Tabellenzellen, höchstens 160 Stellen und 60.000 Zeichen. Werte aus Formularfeldern gehen nie mit |
| Gleichen Inhalt finden | Titel, Website und Pfad der verglichenen Tabs |
| Wächter | deine Bedingung, Titel und Website der Seite, die geänderten Zeilen oder Textstellen um Zahlen |
| Verlauf in Alltagssprache | deine Suche und Titel, Website und Pfad von bis zu 200 besuchten Seiten aus dem gewählten Zeitraum |
| Lesezeichen-Ordner | Titel, Website und Pfad der Seite und die Namen deiner Lesezeichen-Ordner |
| Formularfelder zuordnen | Beschriftungen und Namen der Felder. Keine Werte |
| Gruppen, wenn „Frühere Zuordnungen als Beispiele“ an ist | zusätzlich bis zu 8 frühere Zuordnungen: Titel, Website und Gruppenname |

Websites auf deiner Ausschlussliste gehen nie an Jev. Für die Verarbeitung bei OpenRouter und TypeSafe gelten deren Datenschutzbestimmungen.

## Rechte in Chrome

Tabwerk fragt Rechte erst an, wenn eine Funktion sie braucht:

- Leserecht für eine Website erst beim Anlegen eines Wächters für genau diese Website
- Lesezeichen und Verlauf erst, wenn du die Suche darin einschaltest
- Leserecht für alle Websites nur für die Volltext-Suche. Der gelesene Text bleibt im Browser.
- Leserecht für eine Website, wenn du dort Kopieren immer erlauben willst

## Kontakt

Fragen und Hinweise bitte als Issue im Repository: https://github.com/DigitalIQ/tabwerk/issues
