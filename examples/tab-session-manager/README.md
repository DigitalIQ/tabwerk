# Offline-Beispiel für Tab Session Manager

Dieses unabhängig geschriebene Beispiel packt ein JSON-Exportarray von Tab Session Manager in ein lokales Blockarchiv und stellt daraus wieder das Exportarray her. Es verändert keine Browserdaten, ruft keinen Import im Browser auf und braucht keine Netzwerkverbindung. Die Beispieldaten sind vollständig synthetisch. Ein erfolgreicher Test bedeutet keine externe Adoption oder bestätigtes Interesse am Paket.

## Ausführen

Im Tabwerk-Checkout mit Node.js 24 oder neuer:

```sh
node --test examples/tab-session-manager/adapter.test.mjs
node examples/tab-session-manager/demo.mjs
```

Die Demo prüft den vollständigen Roundtrip von zwei Sessions mit je zwei Fenstern. In der zweiten Session hat sich nur ein Fenster verändert. Es entstehen vier Referenzen auf drei gespeicherte Blöcke. Zusätzlich zeigt `unfavorableCases` einen kleinen Export mit nur einem Fenster und einen zweiten Fall, in dem dieses einzelne Fenster in beiden Sessions unterschiedliche Inhalte hat. Hier gibt es keine wiederverwendeten Fensterblöcke; der Archiv-Overhead kann die Kompression übersteigen.

Jeder Fall wird nach JSON-Serialisierung des Archivs vollständig zurückdekodiert und mit dem ursprünglichen Exportarray verglichen. Die Ausgabe zählt UTF-8-Bytes von kompaktem ursprünglichem JSON und dem kompletten Archiv einschließlich Metadaten, Referenzen und Base64-Blöcken sowie die Zahl der Blöcke. Das sind synthetische Einzelmessungen, keine Benchmarks realer Exporte und keine Nutzerstatistik.

Für einen echten eigenen Offline-Export erst eine separate Kopie aus Tab Session Manager exportieren. Quelldatei und Zielformat bleiben getrennt:

```sh
node examples/tab-session-manager/cli.mjs encode /pfad/export.json /pfad/neues-archiv.json
node examples/tab-session-manager/cli.mjs decode /pfad/neues-archiv.json /pfad/wiederhergestellt.json
```

Die Ausgabe muss neu sein. Die CLI verweigert vorhandene Zieldateien und überschreibt die Eingabe nicht. Neue Dateien erhalten Dateimodus `0600`. Eingaben sind auf 64 MiB begrenzt; zusätzlich gelten die Grenzen des Codecs pro Fenster. Nicht direkt in das Browserprofil schreiben. Die wiederhergestellte Datei ist ein JSON-Exportarray, wird aber nicht automatisch in einen Browser importiert. URLs und sonstige Exportdaten bleiben lokal und können vertraulich sein.

## Tatsächliches Format und verlustfreies Mapping

Geprüfter Fremdstand: `sienori/Tab-Session-Manager`, Commit `113b272d6b5a2159f50181d1771163c20381ad6c`.

- [export.js](https://github.com/sienori/Tab-Session-Manager/blob/113b272d6b5a2159f50181d1771163c20381ad6c/src/background/export.js#L10) exportiert ein Array ganzer Sessions, auch bei einer einzigen Session. Es gibt kein zusätzliches Versions-Envelope.
- [save.js](https://github.com/sienori/Tab-Session-Manager/blob/113b272d6b5a2159f50181d1771163c20381ad6c/src/background/save.js#L24) speichert `windows[windowId][tabId]` mit vollständigen Tabobjekten, dazu `windowsInfo` und optional globale `tabGroups`.
- [sessions.js](https://github.com/sienori/Tab-Session-Manager/blob/113b272d6b5a2159f50181d1771163c20381ad6c/src/background/sessions.js#L58) persistiert ganze Sessions. [autoSave.js](https://github.com/sienori/Tab-Session-Manager/blob/113b272d6b5a2159f50181d1771163c20381ad6c/src/background/autoSave.js#L13) überspringt vollständig unveränderte Autosaves, teilt aber unveränderte Fenster nicht zwischen unterschiedlichen Sessions.

Das Beispiel erhält sämtliche Session-Metadaten einschließlich `windowsInfo`, `tabGroups` und unbekannter Felder im Manifest. Originale Tabfelder liegen in einem eigenen Envelope innerhalb des komprimierten Blocks. Die für den Codec nötigen typisierten Pflichtfelder erhalten bei Bedarf Defaults. Diese Defaults werden beim Rückweg nicht in die originalen Daten eingefügt. Originale Tab-ID-Keys und unbekannte verschachtelte JSON-Felder bleiben erhalten. Arrays und `tab.index` erhalten die Browserreihenfolge; die Schreibreihenfolge von JSON-Objektfeldern wird nicht garantiert. Semantische JSON-Gleichheit ist die Roundtrip-Zusage.

`active` wird als Fensterreferenz vom Blockinhalt getrennt. Seine ursprüngliche Anwesenheit wird gespeichert. Echte Browserdaten verwenden dafür Boolean-Werte. Die globale TSM-Gruppenliste bleibt vollständig im Session-Sidecar; der Codec erhält dafür ein leeres `groups`-Array. Der Adapter implementiert keine TSM-Gruppenlogik.

Das Archivformat `tabwerk-tsm-offline`, Version 1, gehört ausschließlich zu diesem Beispiel. Es ist kein offizielles Tab-Session-Manager-Format. Nur `decode` liefert wieder das ursprüngliche Exportarray.

## Grenzen

- Browser-IDs, Tab-ID-Keys, `lastAccessed` und andere unverändert erhaltene Felder können zwischen ähnlichen Sessions wechseln und dadurch Deduplizierung verhindern. Es werden keine Felder zur Erzeugung besserer Zahlen verworfen.
- Pflichtinformationen stehen teilweise sowohl im Codec-Envelope als auch in den originalen Tabdaten. Dieses bewusste Beispiel-Overhead wird mitgezählt; ein optimierter produktiver Adapter braucht zusätzliche Formatentscheidungen und Abnahme.
- Kleine oder stark veränderte Sessions können als Blockarchiv größer sein. Synthetische wiederholte Fenster ersetzen keine Messung eines realen eigenen Exports.
- Die CLI lädt die Datei und das Archiv vollständig in den Speicher. Sie ist ein Offline-Beispiel mit Dateigrößenlimit, kein gehärteter Service für fremde Dateien oder unbegrenzte Sessionarchive. Metadaten haben keine eigenständige Integritätsauthentifizierung; der Codec prüft die Fensterblöcke.
- Keine Retention, keine IndexedDB-Migration, kein Browserimport und kein Cloud-Sync. Die bestehenden Löschregeln von Tab Session Manager bleiben außerhalb dieses Beispiels.
- [Issue #619](https://github.com/sienori/Tab-Session-Manager/issues/619) wünscht eine sichtbare Suche nach Session-Dubletten. Dieses Speicherbeispiel implementiert jene UI-Funktion nicht. Der aktuelle [PR #1663](https://github.com/sienori/Tab-Session-Manager/pull/1663) behandelt Favicon-Blob-Speicher; gespeicherte gzip-Blöcke beheben dieses Problem nicht.

Fremdprojekt-Lizenz: [MPL-2.0](https://github.com/sienori/Tab-Session-Manager/blob/113b272d6b5a2159f50181d1771163c20381ad6c/LICENSE). Kein fremder Implementierungscode oder reales Exportmaterial wurde übernommen. Adapter, Tests und synthetische Fixtures wurden hier unabhängig nach der beobachteten Struktur geschrieben und gehören zum MIT-lizenzierten Tabwerk-Checkout.
