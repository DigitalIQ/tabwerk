# Garrison-Quellvertrag und synthetische Verläufe

Geprüft am 15.10.2026. Fremdstand: `superuser-miguel/Tab-Session-Garrison`, Commit `850099b1b0b8a03bef1743c2e21f42f951e08e2e`. Die Fixtures wurden unabhängig geschrieben. Keine fremden Sessiondaten, URLs, Favicons oder Implementierungen übernommen. Reservierte `.example.test`-Hosts und selbst erzeugte SVG-Symbole werden nicht im Netzwerk abgerufen.

## Bedeutung von history

`scenarios({ points = 60, windows = 6, tabsPerWindow = 16 } = {})` liefert fünf Objekte `{id, description, history}`. `history[t]` ist ein Exportarray mit genau einer damals gespeicherten regulären Autosave-Session: `[session]`. Dieses Array ist **kein vollständiges Abbild der Garrison-Datenbank** zum Zeitpunkt t. Die Testreihe behandelt bereits gespeicherte Session-Versionen als Historie und wendet keine fremde Löschpolitik an.

Der Quellcode von [save.js, L24–78](https://github.com/superuser-miguel/Tab-Session-Garrison/blob/850099b1b0b8a03bef1743c2e21f42f951e08e2e/src/background/save.js#L24) erzeugt neue Session-IDs und Zeitfelder, `windows[windowId][tabId]` mit vollständigen Browser-Tabobjekten und zusätzliche `windowsInfo`. [save.js, L80–97](https://github.com/superuser-miguel/Tab-Session-Garrison/blob/850099b1b0b8a03bef1743c2e21f42f951e08e2e/src/background/save.js#L80) speichert optional globale `tabGroups`. Unbekannte Session-, Fenster-, Gruppen- und Tabfelder in unseren Fixtures prüfen die verlustfreie Erhaltung, ohne zu behaupten, dass Garrison diese konkreten synthetischen Felder selbst erzeugt.

[autoSave.js, L13–28](https://github.com/superuser-miguel/Tab-Session-Garrison/blob/850099b1b0b8a03bef1743c2e21f42f951e08e2e/src/background/autoSave.js#L13) sammelt alle Fenster und speichert erst nach Änderung. [autoSave.js, L245–264](https://github.com/superuser-miguel/Tab-Session-Garrison/blob/850099b1b0b8a03bef1743c2e21f42f951e08e2e/src/background/autoSave.js#L245) vergleicht Fenster-Keys sowie Tab-IDs und URLs. Nur ein anderer aktiver Tab, Titel oder `lastAccessed` reicht bei sonst gleicher Struktur nicht aus. Deshalb enthält jeder weitere Fixture-Zeitpunkt mindestens eine echte URLänderung. Im Restart-Fall ändern sich zusätzlich IDs/Keys.

[export.js, L12–26](https://github.com/superuser-miguel/Tab-Session-Garrison/blob/850099b1b0b8a03bef1743c2e21f42f951e08e2e/src/background/export.js#L12) exportiert auch einzelne Sessions als JSON-Array. Genau dieses Dateischema verwenden die historischen Einzel-Autosaves.

## CompleteZIP ist ein anderer Gegenstand

Die vorhandene opt-in-Funktion [backupComplete, backup.js L27–72](https://github.com/superuser-miguel/Tab-Session-Garrison/blob/850099b1b0b8a03bef1743c2e21f42f951e08e2e/src/background/backup.js#L27) bildet einen Fingerprint aus den IDs und Änderungszeiten aller gespeicherten Sessions. Bei geändertem Fingerprint lädt sie **alle Sessions aus der aktuellen Datenbank**, schreibt deren vollständiges pretty-printed JSON in eine timestamped ZIP und hält solche Backups laut Quellkommentar unbefristet. Das ZIP entsteht über [backupZip.js, L14–20](https://github.com/superuser-miguel/Tab-Session-Garrison/blob/850099b1b0b8a03bef1743c2e21f42f951e08e2e/src/background/backupZip.js#L14) mit fflate `zipSync`, Level 6. Der zusätzliche [BackupManifest-Eintrag](https://github.com/superuser-miguel/Tab-Session-Garrison/blob/850099b1b0b8a03bef1743c2e21f42f951e08e2e/src/background/backupManifest.js#L12) ist eine Verwaltungsstruktur und noch kein gemeinsamer Fensterblockbestand.

Ein Vergleich von getrennt komprimierten `history[t]`-Einzelsessions mit einem gemeinsamen Fensterblockarchiv misst daher **Kompression einer Autosave-Historie**, nicht die direkte Ersetzung des aktuellen CompleteZIP. Für eine Aussage über CompleteZIP müssten zusätzlich die gesamte jeweilige DB, bestehende Retention, manuelle Sessions und exakte ZIP-Eingaben modelliert werden. Die Fixtures behaupten dies ausdrücklich nicht. ZIP-Overhead, JSON-Prettyprinting und Kompressionslevel dürfen nicht als erfundene Codec-Ersparnis verschwinden.

## Gezielte Grenzfälle

| ID | Erzeugung | Einordnung |
| --- | --- | --- |
| `sparse-one-window` | Pro weiterem Autosave eine echte URL-/Titeländerung in genau einem zyklisch gewählten Fenster. Alle anderen Fensterfelder bleiben stabil. | Absichtlich günstig für Wiederverwendung, keine Behauptung über typische `lastAccessed`-Stabilität. |
| `volatile-last-accessed` | Alle Tab-Zeitfelder ändern sich in jedem Fenster, zusätzlich eine echte URLänderung. | Absichtlich ungünstige Sensitivität auf volatile, verlustfrei erhaltene Felder. |
| `browser-restart` | Periodische neue Fenster-/Tab-/Gruppen-/Split-IDs und Keys; URLänderung auch zwischen den Neustarts. | Sensitivität gegenüber Browserneustarts, kein gemessener Neustartanteil. |
| `all-windows-edit` | Mindestens eine echte URLänderung in jedem Fenster pro weiterem Zeitpunkt. | Absichtlich ungünstiger Fall ohne unverändertes ganzes Fenster. |
| `tiny-one-window` | Ein einziges Fenster mit einem Tab und echter URLänderung je weiterem Zeitpunkt. | Archiv-Overhead-Grenzfall; Konfigurationswerte für Fenster/Tabzahl werden hier absichtlich auf 1 gesetzt. |

Der feste Generator erzeugt verschiedene Hosts, Pfade, Querywerte, Titel, Gruppen, Iconfarben und unbekannte Datenfelder. Ähnliche Domain-Favicons wiederholen sich wie bei mehreren Seiten derselben Website. Trotzdem sind es synthetische Daten. Die fünf Fälle sind keine gewichtete oder repräsentative Nutzerverteilung und dürfen nicht zu einer allgemeinen Nutzerersparnis gemittelt werden.

`splitViewId` wird als Tabfeld erhalten. Das README des gepinnten Projekts beschreibt das Mitspeichern dieses Firefox-Felds, aber noch keine Restore-API für Split Views. Vorhandensein in unserem Archiv belegt deshalb keine funktionierende Wiederherstellung einer Split-Ansicht im Browser.

## Tests

`node --test examples/garrison-backup-benchmark/fixtures.test.mjs` prüft Determinismus, Schemakonsistenz, tatsächliche Autosave-relevante Änderungen, unabhängige historische Objekte, den Einfenster-/Alle-Fenster-Kontrast, volatile Daten, Restart-Verknüpfungen und Inhaltsvariation. Der Vergleich von gzip/ZIP/Blockarchiv sowie deren Roundtrips liegt außerhalb dieser Fixtures und gehört zum Benchmark.
