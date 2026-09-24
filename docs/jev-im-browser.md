# Was Jev im Browser gut kann

Stand: 2026-09-24. Quellen: TypeSafe-Doku (docs.typesafe.ai, Seiten „Models“, „API reference“, „Jev 1.13 jaggedness“, „Jev with coding agents“), OpenRouter-Doku zur Decisions API und eigene Probeläufe mit erfundenen Daten.

## Was Jev ist

Jev ist ein Entscheidungsmodell von TypeSafe. Es schreibt keinen Text. Es bekommt einen Zustand (`state`) und typisierte Fragen und antwortet mit:

- `choice`: eine Option aus höchstens 255, mit Wahrscheinlichkeit pro Option und einer Sicherheit
- `score`: eine Stufe auf einer Skala mit 2 bis 10 beschriebenen Stufen
- `noul`: die Wahrscheinlichkeit, dass eine Aussage stimmt

Aktuelles Modell ist `jev-1.13`. `jev-latest` und `jev-preview` zeigen laut Doku beide darauf. Bei OpenRouter heißt der Alias `~typesafe/jev-latest`, mit Tilde. Ohne Tilde antwortet OpenRouter mit Fehler 400. Ein Vorabmodell gibt es derzeit nicht. Abgerechnet werden nur gelesene Tokens, 0,042 $ pro Million. Die Antwort kostet nichts. Pro Anfrage passen 64k Tokens.

## Wo Jev im Browser stark ist

| Aufgabe | Frage an Jev | Probelauf 2026-09-24 |
|---|---|---|
| Tab finden per Beschreibung | `choice` über alle offenen Tabs | „Seite mit dem Kopfhörerpreis“ traf den Preisvergleich mit 100 % |
| Tabs in Gruppen sortieren | `choice` pro Tab über Gruppen und Kategorien | 9 von 9 Tabs richtig, Sicherheit 99 bis 100 % |
| Tabs nach Wichtigkeit ordnen | `score` pro Tab mit eigenen Stufen | Bericht und Fachartikel vorn, Video und Shop hinten |
| Gleicher Inhalt unter anderer Adresse | `noul` pro Tab-Paar | gleicher Artikel 0,96, verschiedene Seiten 0,01 |
| Seitenänderung passt zur Bedingung | `noul` über entfernte und neue Zeilen | „wieder lieferbar“: echte Änderung 0,94, nur Uhrzeit geändert 0,04 |
| Beleg für die Meldung | `choice` über die geänderten Zeilen | wählt „Auf Lager, Lieferung morgen“ |
| Nächste Klickaktion wählen | `choice` über sichtbare Elemente | nutzt Jev Ultrafast, nicht Teil von Tabwerk |

Eine Anfrage dauerte 360 bis 640 ms und kostete zwischen 0,00002 und 0,00017 $.

## Wo Jev schwach ist

Laut der Liste „Jev 1.13 jaggedness“ und passend zu den Probeläufen:

- Rechnen, Zählen, Preise vergleichen. „Unter 200 €“ prüft Jev nicht verlässlich. Tabwerk zeigt dafür einen Hinweis.
- Datumsvergleiche. „Nach Datum sortieren“ macht Tabwerk deshalb im Code.
- Text erzeugen. Zusammenfassungen oder Gruppennamen erfindet Jev nicht. Die Namen kommen aus den Kategorien.
- Viel Kontext ohne Bezug. Tabwerk schickt pro Tab nur Titel, Website und Pfad.
- Manipulierte Inhalte. Seitentext kann die Antwort beeinflussen. Tabwerk zeigt deshalb die Sicherheit an und wählt unsichere Vorschläge ab.
- Deutsch. Englisch ist die Hauptsprache. Die Fragen in Tabwerk sind englisch, Titel und Kategorien dürfen deutsch sein. In den Probeläufen klappte das.

## Folgerung für Tabwerk

Code entscheidet alles, was sich exakt berechnen lässt: doppelte Adressen, Reihenfolge nach Datum oder Domain, Textvergleich bei Wächtern. Jev bekommt nur die semantischen Fragen. Jede Antwort zeigt die Sicherheit. Unter der Schwelle wählt Tabwerk den Vorschlag ab und markiert ihn mit „prüfen“.
