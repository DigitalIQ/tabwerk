# Bewertungen mit Jev

Hier stehen Abwägungen, bei denen Jev die Optionen bewertet hat. Die Messwerte rechnet Code, Jev bewertet nur. Skala: 0 ablehnen, 1 schwach, 2 nützlich, 3 stark, 4 unbedingt. Der Wert ist der wahrscheinlichkeitsgewichtete Mittelwert. „unsicher“ heißt: Jev war sich unter 80 % sicher, die Einordnung ist dann eigene Prüfung.

## Speicher des Verlaufs (September 2026)

Messung auf einem simulierten Tag: 8 Fenster, 320 Tabs, 600 Änderungen, 70 % davon reine Navigation. Heute: 34 MB.

| Option | Messung | Jev | Sicherheit |
| --- | --- | --- | --- |
| gzip je Sicherung | 4,9-mal kleiner | 3,1 | 82 % |
| Fenster als Blöcke plus gzip | 15-mal kleiner | 3,0 | 85 % |
| Wörterbuch für Adressen und Titel | 14-mal kleiner | 2,8 | unsicher |
| Fenster als Blöcke | 4-mal kleiner | 2,6 | unsicher |
| Kürzere Aufbewahrung, einstellbar | etwa proportional | 2,4 | unsicher |
| Wörterbuch plus Blöcke | 41-mal kleiner | 2,0 | unsicher |
| Titel weglassen | 40 % kleiner | 2,0 | unsicher |
| Reine Navigation höchstens alle 5 Minuten sichern | 2,4-mal kleiner | 1,6 | unsicher |
| IndexedDB statt chrome.storage | nicht kleiner | 1,0 | unsicher |
| Nur Unterschiede speichern (Kette) | etwa 50-mal kleiner | 0,1 | 95 % |

Gebaut: Fenster als Blöcke plus gzip. Das ist fast so klein wie die Spitze, hält das Wiederherstellen einfach und braucht keine Kette, in der ein kaputter Schritt alles Spätere mitreißt.

## Nutzungsdaten zum Verbessern (September 2026)

Frage: Soll Tabwerk Browsing- und Nutzungsdaten speichern und auswerten, damit Funktionen und Jevs Entscheidungen besser werden?

| Option | Daten verlassen den Rechner | Jev | Sicherheit |
| --- | --- | --- | --- |
| Regeln aus wiederholten Korrekturen vorschlagen („github.com = Entwicklung“) | nein | 3,4 | unsicher |
| Schwelle für automatisches Übernehmen je Funktion anpassen, nach angenommenen Vorschlägen | nein | 3,1 | 85 % |
| Aus Korrekturen lernen: die letzten passenden Korrekturen als Beispiele an Jev geben | nur wie heute an Jev | 3,0 | 89 % |
| Daumen hoch oder runter je Entscheidung, lokal gespeichert | nein | 3,0 | 82 % |
| Entwicklermodus: Entscheidungen und Korrekturen als JSONL exportieren | nein | 2,9 | unsicher |
| Anonyme Zähler an einen eigenen Server, freiwillig | ja | 0,6 | unsicher |
| Interessenprofil aus dem Verlauf bei jeder Anfrage mitschicken | ja, mehr als heute | 0,1 | 90 % |
| Entscheidungsbeispiele freiwillig an den Entwickler spenden | ja | 0,1 | 95 % |
| Korrekturen an den Modellanbieter zum Training | ja | 0,0 | 100 % |

Ergebnis: Lernen ja, aber nur auf dem Rechner. Alles, was einen eigenen Server braucht oder mehr persönliche Daten verschickt, fällt durch. Noch nicht gebaut.
