# Experimenteller Delta-Store: Browservergleich

Stand: 16.10.2026. Maintainer: [Manuel Bissinger (DigitalIQ)](../../SECURITY.md).

Der Prototyp bietet transaktionale Speicherung, vollständige Integritätsprüfung, Retention, Crash-Recovery und inkrementellen Export mit dauerhaftem ACK-Cursor. Er ist separat vom veröffentlichten npm-Paket `tabwerk-session-codec@0.1.0`. Es gibt keine Integration in Garrison und keinen Nachweis externer Nutzung durch dieses Experiment.

## Ergebnis

Die optimierte ACK-Verarbeitung senkt gegenüber dem eingefrorenen bisherigen inkrementellen Export die ACK-Zeit um **82,7 %**, die logischen Sender-Schreibbytes um **24,4 %** und die gesamte Backupzeit einschließlich Initialisierung um **5,6 %**. Der neue Pfad war in allen fünf Vergleichsrunden schneller. Die ausgelieferte Paketmenge bleibt gleich. Gegen Garrisons Backup-Pfade bleibt er deutlich langsamer.

| Metrik für zehn Backups | Bisheriger inkrementeller Export | Optimierter Export |
| --- | ---: | ---: |
| ACK-Aufrufe gesamt | 359,2 ms | 62,2 ms |
| Logische Sender-Writes | 1.420.520 Bytes | 1.073.438 Bytes |
| Backup inklusive Initialisierung | 4.973,5 ms | 4.693,0 ms |
| Kumulierte Lieferung | 1.041.363 Bytes | 1.041.363 Bytes |
| Verbleibender Senderbestand | 2.305 Bytes | 2.592 Bytes |

Die neue API speichert das Pending-Wirepaket als Bytefolge, ohne zusätzliche Base64-Verpackung des Senderzustands. Prepare speichert das vorbereitete Inventar atomar; ACK schreibt einen kleinen Head und löscht die abgelösten Records in derselben strikten IndexedDB-Transaktion. Das Inventar wird bei Prepare weiterhin vollständig geschrieben und bleibt O(n). Weniger logische Schreibbytes bedeuten keine gemessene Verringerung physischer SSD-Writes.

Beim optimierten ACK ist Persistenz im Aufruf enthalten. Die bisherige API benötigt externe Pending-/ACK-State-Saves, die in ihrer Gesamtbackupzeit enthalten sind. Die Zeitangaben sind getrennte Mediane und dürfen nicht addiert werden.

| Backup-Pfad | Kumulierte Lieferung | Zehn Backups inklusive Initialisierung |
| --- | ---: | ---: |
| Optimierter inkrementeller Export | 1.041.363 Bytes | 4.693,0 ms |
| Garrison CompleteZIP | 2.915.377 Bytes | 290,9 ms |
| Garrison IndividualJSON, aktivierter Default | 3.429.284 Bytes | 32,8 ms |
| Garrison CompleteZIP plus IndividualJSON | 6.344.661 Bytes | 301,2 ms |

Gegen CompleteZIP spart der optimierte Export **64,3 % Lieferung**, benötigt aber **16,1-mal dessen Backupzeit**. Das ist ein Platz-/Transportvorteil unter diesem Workload, kein allgemeiner Geschwindigkeits- oder Integrationsvorteil. Receiver und Paketformat bleiben unverändert; ein Restore-Gewinn ist nicht belegt.

## Messverfahren

- Zehn unveränderte reguläre Autosaves aus einem privaten Tab-Session-Manager-Export bilden vollständige wachsende Datenbanken mit einer bis zehn Sessions. Es ist ein append-only Replay aus echten TSM-Daten, kein beobachteter Garrison-Lebenszyklus.
- Ein Warmup und fünf balancierte Runden mit fünf Verfahren; jeder Pfad steht einmal an jeder Position. Die Tabellen zeigen Mediane des gesamten Zehn-Backup-Laufs. Initialisierung ist enthalten, abschließender Reopen wird separat geprüft. Keine künstlichen Neustarts pro Backup.
- Garrison-Referenz: [Commit 850099b](https://github.com/superuser-miguel/Tab-Session-Garrison/tree/850099b1b0b8a03bef1743c2e21f42f951e08e2e), originale Backup-Funktionen mit lokalen Extension-/Downloadadaptern. Der Sink materialisiert Blob-Daten, kein OS-Download. Es handelt sich nicht um einen vollständigen Firefox-Extension-Test.
- Eingefrorene inkrementelle Baseline: [baseline-incremental-export.mjs](browser/baseline-incremental-export.mjs), SHA-256 `bb9b9c3ffd19c4203e98661fd5734b4043a23554b903b98b65109622edc4208c`. Source-Store, Codec und Garrison-Referenz sind zwischen den Vergleichspfaden gleich.
- Eine zusätzliche Ausgabegrenzen-Liste ermöglicht historische IndividualJSON-Restores im wachsenden Testfall. Updates und Löschungen bestehender Sessions sind damit nicht abgedeckt. Beim separaten Vollbestand von 32 Sessions lässt IndividualJSON eine Session aus; dieser Pfad ist kein gleichwertiges Vollbackup dieses Bestands.

Der private Datensatz, Sessionfelder, Titel, URLs, Archive und vollständige Laufberichte werden nicht veröffentlicht. [Die Anleitung](README.md) macht das Verfahren mit eigenen Daten ausführbar. Die konkreten privaten Messwerte lassen sich ohne diesen Datensatz nicht unabhängig reproduzieren. Synthetische Fixtures und Tests sind im Repository enthalten; ihre Ergebnisse dürfen nicht als reale Nutzung ausgegeben werden.

## Integrität und Wiederanlauf

Die vollständige Source-Validierung liest und prüft die Records bei jeder Operation frisch. ACK prüft referenzierte Bytes und Hashes erneut und vergleicht die gelesenen Records vor Mutation innerhalb der Schreibtransaktion bytegenau. Nur semantische Beziehungen eines byteidentischen bereits geprüften Heads dürfen wiederverwendet werden. Reopen und geänderte Heads erzwingen die vollständige erneute Prüfung. Web Locks koordinieren Handles derselben Exportdatenbank.

Im geprüften Browserstand bestanden **38 native Browserprüfungen**, **250 feldgenaue Hauptrestores** und **100 zusätzliche Kompatibilitätsrestores** mit dem eingefrorenen Receiver. Abgedeckt sind unter anderem:

- Prepare-/ACK-Transaktionsabbrüche und Worker-Abbrüche vor und nach Commit;
- verlorene Bestätigungen, idempotente Wiederholungen und unbekannter Commit-Ausgang;
- manipulierte Head-, Inventar- und Paketrecords;
- externe Änderungen zwischen Read und Commit sowie zwei gleichzeitig geöffnete Handles.

Zusätzlich bestanden fünf neue Node-Persistenztests und 21 bestehende Adapter-/Protokolltests. Ein separater Review ergänzte 28 lokale Prüfungen, darunter Retention/GC mit verlorenem ACK und Reopen, und hatte nach Korrekturen keine offenen Korrektheitsbefunde. Dieser Review war eine separate Agentenprüfung, keine externe Zertifizierung. Die zusätzlichen Reviewskripte und privaten Rohbelege sind nicht Teil der Veröffentlichung.

Vor und nach der Messung waren 23 Quelldateien, 613 Referenz-/Dependencydateien und beide Eingaben hashgleich. Die Veröffentlichung macht anschließend die lokalen Eingabepfade konfigurierbar und die Node-Testabhängigkeit installierbar; diese Änderungen betreffen den Launcher und Tests, nicht den gemessenen Codec oder ACK-Algorithmus.

Strikte IndexedDB-Transaktionen und Worker-Abbruchtests sind keine Prüfung eines OS-Absturzes oder Stromausfalls. Hashes erkennen Korruption, authentifizieren aber keinen Angreifer, der Daten samt Hashes neu erzeugt. Vollständige Validierung und Senderinventar bleiben O(n); Speicherquoten und Browserunterstützung begrenzen den Einsatz. Ein dauerhaft gespeicherter Cursor ersetzt keine verlorene Paketdatei.

## Quellen und Meldungen

- [Quellvertrag des ursprünglichen synthetischen Node-Vergleichs](source-contract.md)
- [Garrison backup.js am gepinnten Commit](https://github.com/superuser-miguel/Tab-Session-Garrison/blob/850099b1b0b8a03bef1743c2e21f42f951e08e2e/src/background/backup.js)
- [Garrison-Lizenz, GPL-3.0](https://github.com/superuser-miguel/Tab-Session-Garrison/blob/850099b1b0b8a03bef1743c2e21f42f951e08e2e/LICENSE)
- [Private Security-Meldung und Maintainer-Zuordnung](../../SECURITY.md)

Garrison wurde für dieses Experiment nicht kontaktiert. Die Veröffentlichung dokumentiert eigene Maintainer-Arbeit und lokale Tests, keine Adoption oder Empfehlung durch Dritte.
