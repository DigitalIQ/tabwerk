# Maps-Button in der Google-Suche

Stand: 2026-11-16, Feature in Tabwerk 0.12.0.

## Aktivieren

In den Einstellungen unter Funktionen → Seiten den Schalter „Google-Maps-Button in der Suche“ einschalten und die Website-Rechte bestätigen. Unterstützt werden `www.google.com`, `www.google.de`, `www.google.at` und `www.google.ch` über HTTPS. Der Schalter ist anfangs aus.

Der Link erscheint direkt rechts von „Alle“ beziehungsweise „All“ in erkannter Suchnavigation, übernimmt den Suchbegriff aus dem aktuellen URL-Parameter `q` und öffnet Google Maps im selben Tab. Ein bereits sichtbarer Maps-Link in der Navigation verhindert einen zweiten Link. Ein Maps-Link in einem Suchergebnis unterdrückt den Button nicht.

## Umsetzung

- `src/lib/googlemaps-config.js` begrenzt Hosts und Suchpfade.
- `src/lib/googlemaps.js` registriert das Content-Skript nur für erlaubte Hosts und berücksichtigt Installation, Browserstart, Schalter, entzogene Rechte und bereits offene Tabs. Registrierungsänderungen laufen nacheinander.
- `src/content/googlemaps.js` ergänzt einen normalen Link, beobachtet nachgeladene Navigation und entfernt den Link beim Ausschalten. Wiederholte Injektion und kopierte Navigation erzeugen keine doppelten Buttons. Der Pfad vom Tab-Container zum Text wird mit Klassen und Inline-Styles nachgebaut, damit verschachtelte Labels ihre Abstände behalten. KI-Modus (`udm=50`) dient nicht als Vorlage. Google-Handler, IDs, Icons und Tracking-Attribute werden nicht kopiert.
- Die Funktion speichert keine Suchbegriffe und stellt keine API-Anfragen. Der Suchbegriff geht beim Öffnen des Links an Google Maps. Jev ist dafür nicht erforderlich.

URL-Format: [Google Maps URLs](https://developers.google.com/maps/documentation/urls/get-started), geprüft am 2026-11-16. Der Link nutzt `/maps/search/?api=1&query=…` und kodiert den Suchbegriff mit `URLSearchParams`.

## Prüfung

- `npm test`: 96 Unit-Tests bestanden, darunter Host-Grenzen, Schalter, Teilberechtigungen, Rechteentzug und parallele Registrierungsanfragen.
- `npm run test:maps`: Chrome mit geladener Extension und lokal beantworteten Google-URLs. Geprüft sind Sonderzeichen, Tastaturfokus, Suchwechsel, neue und ältere Navigationsstrukturen, nachgeladene und kopierte Navigation, wiederholte Injektion, vorhandene Maps-Links, Ausschalten und erneutes Einschalten, leere Suche, fremde Hosts und tatsächliche Link-Navigation.
- Die Testseiten wurden bei 390 und 1280 Pixeln sowie im Hell- und Dunkelmodus gerendert und visuell geprüft. Die Regression bildet einen KI-Modus vor „Alle“ und Padding auf verschachtelten Labels ab, nachdem ein Nutzer-Screenshot die falsche Platzierung und Texthöhe gezeigt hatte. Die Reihenfolge beginnt mit KI-Modus, Alle, Maps, Bilder. Textunterkante und Linkhöhe von Maps und Bilder unterscheiden sich im Test um weniger als einen Pixel. Die Navigation bleibt horizontal scrollbar. Der Berechtigungsdialog wird im Browsertest durch vorab vergebene Testrechte ersetzt.
- `JEV_OFFLINE=1 npm run e2e`: abschließend 129/129 Checks bestanden. Ein vorheriger Lauf brach beim Emoji-Listenmodus mit Timeout ab. Sowohl der unveränderte Stand `dd1f2e8` als auch der abschließende Lauf mit dem Feature bestanden. Jev-Antworten waren in diesen Läufen lokale Testantworten.
- Das ZIP `dist/tabwerk-0.12.0.zip` enthält 121 Dateien. Die drei Maps-Dateien sind enthalten. Der Commit-Hook baut das Paket vor der Veröffentlichung neu; der Release-Ablauf prüft alle Dateien gegen den Commit.

**Grenze:** Der direkte Google-Aufruf im isolierten Browser führte zur Bot-Prüfung. Die Fixtures belegen das Verhalten der Extension auf den getesteten Strukturen, keine Kompatibilität mit jedem aktuellen Google-Layout. Nicht erkannte Navigation bleibt unverändert. Ein Live-Test nach dem Laden der Extension ist noch offen.

## Review

Geprüfter lokaler Diff-Snapshot: `dfa90bbf373112f54c7ba0c51405ccca0aecd1d85e173584834220a3f17e534a` (SHA-256, ohne diese Dokumentation).

Jev Pre-Reviewer: Umfang Ja, Security unklar, persistente Daten unklar, externe Verträge unklar, Laufzeit Ja, Auslieferung Ja, Evidenz unklar. Die unsicheren Antworten wurden konservativ hochgestuft. Damit vollständige lokale Prüfung aller geänderten Pfade, Aufrufer, Berechtigungen, asynchronen Abläufe und Tests. Keine offenen Code-Befunde; die fehlende Google-Live-Prüfung bleibt die genannte Evidenzgrenze. Kein unabhängiger Subagent-Review.

Letzte Einstufung: Modell `typesafe/jev-1.14-20261014`, HTTP-Dauer 543,25 ms, gemeldete Kosten 0,000530166 USD. Die Funktion selbst verwendet dieses Modell nicht.
