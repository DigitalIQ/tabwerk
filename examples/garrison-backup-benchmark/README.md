# Garrison: lokaler Backup-Vergleich

Diese lokalen Prototypen vergleichen Session-Archive, einen experimentellen Delta-Store und Garrisons Backup-Code mit synthetischen Daten sowie einem privaten TSM-Export. Der Browseradapter läuft in einem eigens isolierten Browserprofil. Die installierten Extensions und persönlichen Browserprofile werden nicht verändert. Es ist keine Garrison-Integration und kein Nachweis externer Nutzung.

Die geprüften Ergebnisse des Browservergleichs vom 16.10.2026 stehen in [PUBLIC-RESULTS.md](PUBLIC-RESULTS.md). Veröffentlicht sind Quellcode, synthetische Fixtures und aggregierte Messwerte. Der private TSM-Export und die lokale Versuchschronik sind nicht enthalten. Security-Meldungen betreut [Manuel Bissinger (DigitalIQ)](../../SECURITY.md).

Ein weiterer lokaler Versuch ergänzt echte TSM-Daten, stärkere Brotli-Baselines und einen experimentellen strukturellen Delta-Codec mit Checkpoints. `delta-archive.mjs` verändert weder das npm-Paket noch das bisherige Format. Für einen eigenen, bereits vorbereiteten privaten Export:

```sh
node compare-delta.mjs --prepared /absoluter/pfad/prepared.json \
  > /absoluter/privater/pfad/delta-comparison.log 2>&1
```

Der Lauf schreibt in einen neuen privaten Ordner unter `tabwerk/.tmp/garrison-real-data/`. Rohdaten, Archive und Logs dürfen nicht veröffentlicht werden. Er prüft den vollständigen Verlauf, seine beiden Hälften und synthetische Gegenfälle mit denselben Verfahren. Die Default-Checkpoint-Distanz ist fünf. Der reine Frame-Writer erzeugt einzelne Frames. Der inzwischen ergänzte Dateispeicher übernimmt Transaktionen, Resume und Retention wie im folgenden Abschnitt beschrieben.

## Browseradapter und Garrisons originale Backup-Pfade

`browser/browser-delta-codec.mjs` implementiert TJD1 mit WebCrypto und nativen gzip Streams. Node- und Browserframes sind gegenseitig lesbar, ihre komprimierten Bytes müssen nicht identisch sein. `browser/browser-delta-store.mjs` verwendet IndexedDB mit verpflichtendem `durability: 'strict'`, Web Locks und atomaren Commits. Ein frischer atomarer Read-Snapshot wird vollständig geprüft; die Schreibtransaktion vergleicht die geprüften Records vor der Mutation erneut. Hash-Indexsegmente, begrenzte Metadaten, Retention, GC und portable Records bleiben erhalten. Es gibt keinen Cache zwischen Operationen.

```js
import { createBrowserDeltaStore, importBrowserDeltaRecords } from './browser/browser-delta-store.mjs';
const store = await createBrowserDeltaStore({ name: 'local-history', checkpointInterval: 5 });
const id = await store.append(completeSessionDatabase);
const restored = await store.restore(id);
const records = await store.exportRecords();
const independent = await importBrowserDeltaRecords(records, { name: 'independent-import' });
await independent.restore(id);
independent.close();
store.close();
```

Dieser Adapter benötigt Web Locks, WebCrypto, Compression Streams und eine Browserimplementierung, die strikte IndexedDB-Transaktionen bestätigt. Fehlende Unterstützung führt zum Abbruch. IndexedDB-Haltbarkeit ist keine POSIX-fsync-Zusage; Worker-Abbruchtests belegen keinen Hardware-Stromausfall. Logische Recordbytes sind keine physische Datenbankbelegung. Der atomare Snapshot hält die komprimierten Live-Records im Speicher. Ein nativer Entpackchunk kann vor Abbruch kurzzeitig über dem Entpacklimit liegen.

`browser/prepare-garrison-reference.mjs` lädt den gepinnten Garrison-Commit `850099b1b0b8a03bef1743c2e21f42f951e08e2e` und die lockfilegeprüften Dependencies. Statische ESM-Factories ersetzen Import-/Exportbindungen; originale Funktionskörper bleiben erhalten. Der Referenzadapter verwendet Garrisons echte IndexedDB-Implementierung, Backup-/Exportfunktionen und fflate-ZIP-Code. Extension-Storage wird durch IndexedDB ersetzt, der Download-Sink materialisiert die originalen Blob-URLs lokal. Die Ausführung ist ein Browsernachweis des adaptierten Quellpfads, kein vollständiger Firefox-Extension- oder OS-Downloadtest.

Voraussetzungen: Node.js 22 oder neuer, Python 3 für die POSIX-Persistenztests, `tar` für die Referenzvorbereitung und ein aktueller Browser mit den oben genannten APIs. Die Referenzvorbereitung benötigt Netzwerkzugriff auf GitHub und die npm-Tarballs. Garrisons Quellen stehen unter [GPL-3.0](https://github.com/superuser-miguel/Tab-Session-Garrison/blob/850099b1b0b8a03bef1743c2e21f42f951e08e2e/LICENSE). Heruntergeladene Quellen, deren lokal erzeugte Factories und Dependencies liegen ausschließlich unter `.tmp/`; sie werden nicht als Teil der MIT-Distribution von Tabwerk mitgeliefert. Dies ist ein unabhängiger Vergleich ohne Beteiligung oder Empfehlung des Garrison-Projekts.

Reproduktion aus dem Tabwerk-Root mit einem eigenen TSM-Export. `real-input.mjs` gibt den neu erzeugten Pfad zu `prepared.json` aus; diesen im nächsten Befehl einsetzen. Nutzdaten und resultierende Logs lokal behalten:

```sh
npm ci --prefix examples/garrison-backup-benchmark
node examples/garrison-backup-benchmark/real-input.mjs --input /absoluter/pfad/export.json --source tsm
node examples/garrison-backup-benchmark/browser/prepare-garrison-reference.mjs "$PWD"
node --test examples/garrison-backup-benchmark/browser/garrison-browser-reference.test.mjs
node --test examples/garrison-backup-benchmark/browser/browser-delta-adapter.test.mjs
node --test examples/garrison-backup-benchmark/browser/browser-incremental-export.test.mjs
node --test examples/garrison-backup-benchmark/browser/browser-incremental-persistence.test.mjs
node examples/garrison-backup-benchmark/browser/local-server.mjs \
  --original /absoluter/pfad/export.json --prepared /absoluter/pfad/prepared.json
```

Der Server bindet ausschließlich Loopback, erzeugt eine zufällige URL und einen privaten Ergebnisordner unter `.tmp/garrison-browser-runs/`. Vor dem Start prüft er den Originalhash gegen die Provenienz der vorbereiteten Datei. Seine URL in einem isolierten Browser öffnen, erst die Browserprüfungen, danach den Vergleich starten. `fake-indexeddb` ist als feste Testabhängigkeit im Beispielpaket hinterlegt; der Browseradapter selbst nutzt es nicht. Node-Simulationen ersetzen die nativen Browserprüfungen nicht. Eigene Eingaben reproduzieren das Verfahren, nicht die privaten Messdaten oder deren konkrete Laufzeiten.

Der Hauptfall lässt die Datenbank aus zehn unveränderten echten Autosaves von einer auf zehn Sessions wachsen. Fünf Pfade laufen in rotierender Reihenfolge, ein Warmup und fünf Messrunden: eingefrorener inkrementeller Export mit portabler State-Persistenz, optimierter inkrementeller Export mit eigener Cursorpersistenz, isoliertes CompleteZIP, inkrementelles IndividualJSON als aktivierter Standardpfad sowie CompleteZIP plus IndividualJSON. Jeder Pfad steht dadurch einmal an jeder Position. Initialisierung wird zusätzlich zum laufenden Zyklus ausgewiesen und in die Gesamtbackupzeit einbezogen. Ein abschließender Reopen ist eine getrennte Recovery-Prüfung und nicht Teil der laufenden Backupzeit. Die Uhr wird für den historischen Replay kontrolliert; Sessionfelder bleiben unverändert. Legacy-AllJSON und der vollständige 32-Session-Export bleiben Zusatzproben ohne belastbare Zeitstatistik.

Beide Delta-Pfade liefern nur neue oder geänderte Records sowie Löschangaben und verkettete Paketmetadaten. `baseline-incremental-export.mjs` ist die unveränderte Kopie des vorigen Exporters, SHA-256 `bb9b9c3ffd19c4203e98661fd5734b4043a23554b903b98b65109622edc4208c`. Store, Codec und Garrison-Referenz bleiben gemeinsame unveränderte Grundlagen. Endbestand, kumulierte Deliverybytes und zusätzliche lokale Senderzustands-Writes werden getrennt ausgewiesen. Historische IndividualJSON-Restores verwenden eine ausdrücklich zusätzliche Liste der Ausgabegrenzen; Löschungen und Updates bestehender Sessions sind in diesem wachsenden Verlauf nicht geprüft. CompleteZIP-Restore beginnt beim jüngsten benötigten ZIP. Alle Varianten müssen dieselben vollständigen Datenbankstände wiederherstellen. Die Referenz hat keine native ZIP-Importfunktion; gemessen wird das unabhängige Dekodieren der Archivdaten.

### Inkrementeller Export

`browser/browser-incremental-export.mjs` trennt den geprüften Store vom Transport. `createBrowserIncrementalExporter()` erstellt den Sender, `createBrowserIncrementalReceiver()` den unabhängigen Empfänger. Beide akzeptieren einen zuvor gespeicherten `stateBytes`-Zustand. Der Aufrufer verantwortet dessen atomare Speicherung. Die Funktionen sind asynchron.

Der Ablauf ist verbindlich: `prepare(store)` prüft den Store vollständig frisch und liefert `packet`, `receipt`, `stateBytes` und Byte-Statistiken. Zuerst `stateBytes` atomar speichern, dann `packet` unveränderlich ausliefern. Erst nach bestätigter Speicherung des Pakets `acknowledge(receipt)` aufrufen und den zurückgegebenen Zustand wiederum atomar speichern. Ohne Änderung ist `packet` null. Geht eine Bestätigung verloren, enthält der gespeicherte Senderzustand dasselbe Pending-Paket für die Wiederholung. Ein Prozessneustart lädt diesen Zustand erneut. Die API kann keine Bestätigung eines tatsächlich nicht gespeicherten Pakets erkennen; das ist eine Verpflichtung des Transportadapters.

Der Empfänger nimmt ausschließlich gelieferte Pakete entgegen. `apply(packet)` prüft Kette, Basis, Record-Hashes und den vollständigen daraus entstehenden Store, bevor er seinen Zustand ändert. `restore(id)` rekonstruiert einen Punkt daraus. Für einen persistenten Empfänger muss der Aufrufer den mit `exportState()` gelieferten Zustand atomar speichern; die API selbst ist keine zusätzliche dauerhafte Datenbank. Im Backupvergleich werden unveränderliche Paketdateien bestätigt und später unabhängig abgespielt, keine laufende Online-Replika. Hashes erkennen Integritätsfehler, sind aber keine Signaturen oder Authentifizierung.

Der Sender hält ein Inventar mit O(n) Records und bis zur Bestätigung zusätzlich das Pending-Paket. Die serialisierten Bytes und deren lokale IndexedDB-Persistenz sind Teil der Messung. Das beseitigt wiederholte Frame-Auslieferung, nicht die vollständige Validierung oder sämtliche wachsenden Metadaten. Eine verloren gegangene Paketdatei wird nicht durch den Cursor ersetzt. Ohne vollständige Paketkette ist eine neue Bootstrap-Lieferung an einen frischen Empfänger erforderlich.

Pro Exportstream darf nur ein koordinierter Writer arbeiten. Die Queue serialisiert Aufrufe innerhalb einer Senderinstanz. Mehrere Tabs oder getrennt geladene Cursor benötigen beim Einbau zusätzlich einen Web Lock oder einen Vergleich vor dem atomaren Ersetzen des Streamzustands. Der Empfänger erkennt widersprüchliche Pakete gleicher Sequenz und lehnt sie ab, führt aber keine konkurrierenden Exportzweige zusammen. Der Benchmark verwendet einen Sender pro Stream.

### ACK mit eigener Cursorpersistenz

`createBrowserDurableIncrementalExporter({ name, ...options })` verwendet `browser-incremental-persistence.mjs`. `name` bezeichnet eine eigene IndexedDB für den Exportstream, zusätzlich zur Quelldatenbank. `prepare(store)` speichert das unveränderte Wire-Paket binär und das vorbereitete Inventar, bevor es die Paketbytes zurückgibt. Erst nach deren bestätigter Speicherung ruft der Transport `acknowledge(receipt)` auf. Dieses ACK prüft die referenzierten Records frisch und schreibt in einer strikten Transaktion nur einen kleinen aktiven Verweis; altes Inventar und Pending-Paket werden in derselben Transaktion entfernt. Zusätzliche externe State-Saves sind bei dieser API nicht nötig. `inspectPersistence()` zeigt logische Read-/Write-/Deletebytes und Zustand, `close()` schließt den Handle.

Web Locks koordinieren Handles derselben Persistenzdatenbank. Vor jeder Mutation werden alle geprüften Records innerhalb der Schreibtransaktion bytegenau mit dem gelesenen Stand verglichen. Ein fehlender aktiver Verweis bei vorhandenen Records ist ein Fehler; nur eine atomar als leer geprüfte Datenbank wird neu initialisiert. Nach einem unbekannten Commit-Ausgang wird der gespeicherte Zustand erneut gelesen. Ein bestätigtes ACK bleibt nach Reopen bestätigt, ein noch offenes Paket bleibt unverändert wiederholbar.

Die Source-Historie wird weiterhin pro Prepare vollständig frisch validiert. Für eigene unveränderte Cursor-Verweise darf der Adapter bereits geprüfte semantische Beziehungen wiederverwenden: alle referenzierten Bytes werden trotzdem frisch gelesen und gegen ihre Hashes geprüft. Bei Reopen oder verändertem Verweis werden Paket, Basis und daraus abgeleitetes Inventar erneut vollständig geprüft. Das ist kein Cache der Source-Historie. Der vorbereitete O(n)-Inventarstand wird einmal pro neuem Paket gespeichert; das ACK schreibt ihn nicht erneut. Das Wire-Format und der unabhängige Receiver bleiben kompatibel mit der eingefrorenen Baseline.

Quellen und Grenzen: gepinnte Garrison-Dateien sowie Hashbelege unter `.tmp/garrison-browser-reference/`; [IndexedDB](https://www.w3.org/TR/IndexedDB/) und [Web Locks](https://www.w3.org/TR/web-locks/). Private TSM-Daten, Browserartefakte und Messberichte werden nicht veröffentlicht. Das npm-Paket bleibt unverändert.

## Skalierung gegen vollständige Checkpoints

`scaling-benchmark.mjs` vergleicht Checkpoint-Intervall fünf und eins mit demselben eingefrorenen optimierten Store. Sämtliche Integritätsprüfungen bleiben aktiv. Der Standardlauf umfasst die zehn echten TSM-Punkte sowie 10, 100, 300 und 1.000 Punkte aus drei getrennt bezeichneten Testfällen: zyklische Wiederholung der echten Eingabe, unabhängig synthetische sparsame Änderungen und synthetische volatile Felder mit Neustarts alle 23 Schritte.

```sh
node scaling-benchmark.mjs --prepared /absoluter/pfad/prepared.json \
  > /absoluter/privater/pfad/scaling-benchmark.log 2>&1
```

Fünf alternierende Messpaare nach Warmup prüfen Reads und fünf fortlaufende Appends. Retention auf die letzten zehn Punkte und anschließende GC werden bei den Randgrößen gesondert gemessen. Große Ausgangsbestände werden direkt im v2-Dateiformat einschließlich aller alten Manifeste und Indexsegmente vorbereitet; ihre Vorbereitung zählt nicht als gemessener API-Aufbau. Bis 100 Punkte wird zusätzlich der vollständige Aufbau über öffentliche Appends gemessen und gegen Frame-Hashes, Dateigrößen und Schreibzähler der Vorbereitung geprüft. Ein eigener 65-Punkte-Test prüft die Äquivalenz über zwei Segmentgrenzen samt Retention und GC. Jede erzeugte Historie wird feldgenau rekonstruiert. Die fünf Append-Proben nach den echten zehn Punkten sind kontrollierte Wiederholungen, keine zusätzlich beobachteten Autosaves.

Die Messung trennt aktive referenzierte Bytes, gesamten Dateibestand vor Bereinigung und logische Schreibbytes. Letztere sind keine Messung der SSD-Schreiblast. P95 aus fünf Samples ist nur das Maximum. Prozessweite Speicherwerte sind kein isolierter Vergleich des RAM-Bedarfs der Varianten. Ein langer synthetischer Verlauf ist kein echter Nutzungsverlauf. Die aktuelle Garrison-Implementierung wird dabei nicht ausgeführt; die Übertragbarkeit wird im Ergebnisbericht gesondert eingeordnet.

Ein kurzer Funktionstest nutzt `--smoke --kinds synthetic-sparse`; seine Werte sind kein Performance-Nachweis. Private Ausgangsbestände und Berichte bleiben unter `.tmp/garrison-real-data/`. Neue Tests: `node --test scaling-fixtures.test.mjs scaling-benchmark.test.mjs`.

`metadata-benchmark.mjs` prüft getrennt das kumulierte Schreibvolumen über 1.000 tatsächliche API-Appends kleiner synthetischer Punkte. Es vergleicht den eingefrorenen v1-Stand mit v2, zählt Indexdateien mit und weist die Werte an Segmentgrenzen sowie bei 10, 100, 300 und 1.000 Punkten aus. V1 wird bis 100 Punkte über die API gebaut; längere v1-Werte stammen aus dem daran geprüften vollständigen Dateimodell. Dieser Lauf liefert keine vergleichenden Zeitwerte.

```sh
node metadata-benchmark.mjs --before-module /absoluter/privater/v1-snapshot/module \
  > /absoluter/privater/pfad/metadata-benchmark.log 2>&1
```

## Transaktionaler lokaler Dateispeicher

`delta-store.mjs` ergänzt einen lokalen POSIX-Store. Benötigt werden Node.js und `python3` mit `fcntl.flock`; die Python-Standardbibliothek übernimmt OS-Lock und sämtliche Dateimutationen. Das ist kein Browser-Storage-Adapter und kein neues npm-Release.

```js
import { openDeltaStore } from './delta-store.mjs';
const store = await openDeltaStore('/absoluter/privater/store', { checkpointInterval: 5 });
const id = await store.append(point);
const restored = await store.restore(id);
const ids = await store.list();
await store.retain(ids.filter(id => id % 2 === 1));
await store.collectGarbage();
const metadata = await store.inspect();
await store.close();
```

IDs bleiben über Retention hinweg stabil und werden nach einem leeren Verlauf nicht wiederverwendet. `retain(ids)` erhält eine beliebige Teilmenge in ursprünglicher zeitlicher Reihenfolge und rebasiert nötige Frames. `collectGarbage()` läuft separat und entfernt nur anhand der Commit-Historie belegte alte Dateien. Unbekannte Dateien und nicht bestätigte Orphans ohne Herkunftsnachweis bleiben erhalten. Alle Reads und Writes verwenden dasselbe OS-Lock; parallele Writer lesen vor jeder Änderung den aktuellen Commit. Eingabeobjekte bis zum Abschluss von `append()` nicht verändern.

Neue Frames, Indexsegmente und Manifeste werden zuerst geschrieben und synchronisiert. Atomarer Austausch von `CURRENT` ist der Commit-Punkt; der abschließende Verzeichnis-fsync bestätigt die Synchronisierung. Ein Fehler kann `committed=true` bei noch `durable=false` enthalten. Bei unerwartetem Helper-Tod ohne Rückmeldung gilt `committed=null` und `commitUnknown=true`: zuerst den Zustand erneut lesen, nicht blind erneut anhängen. Retries sind nicht automatisch idempotent. Reopen rekonstruiert die letzte Checkpoint-Kette und setzt sie mit identischen Frame-Hashes fort.

Das Metadatenformat v2 speichert höchstens 32 Einträge pro unveränderlichem Indexsegment. Jedes Segment verweist per Dateiname und SHA256 auf seinen Vorgänger. Das kleine Manifest enthält nur die Wurzelreferenz, Anzahl, Generation, nächste ID und den Verweis auf das vorherige Manifest. Append schreibt höchstens ein Segment, ein Manifest und den Pointer neu. Alle historischen Dateien zählen weiterhin zum belegten Speicher und zu den Schreibzählern. Aktuelles Manifest und referenzierte Indexsegmente teilen sich ein Budget von 64 MiB, ein einzelnes Segment ist auf 64 KiB begrenzt.

Bestehende v1-Stores bleiben lesbar. Vor Append oder Retention ist die Migration ausdrücklich aufzurufen:

```js
const store = await openDeltaStore('/absoluter/privater/bestehender-store');
await store.migrateMetadata();
```

Die Migration schreibt neue Metadaten, erhält alle Frame-Dateien und committet atomar. Alte v1-Manifeste bleiben bis zur separat aufgerufenen GC erhalten. Ein weiterer Migrationsaufruf auf v2 ändert nichts. `inspect().version` bezeichnet das tatsächliche Manifestformat. Der `FORMAT`-Marker eines migrierten v1-Containers bleibt erhalten; neu angelegte Container verwenden v2. Für alte Reader ist das v2-Manifest nicht lesbar. Retention baut die Indexkette der behaltenen Punkte neu auf. GC entfernt bestätigte obsolete Frames, danach Indexabhängigkeiten vor deren Eltern und zuletzt alte Manifeste. Die aktuelle Indexkette bleibt erhalten.

Reale Dateispeicher-Prüfung einschließlich Retention, Garbage Collection und Neustart nach jedem Append:

```sh
node delta-store-real.mjs --prepared /absoluter/pfad/prepared.json \
  > /absoluter/privater/pfad/store-real.log 2>&1
```

Prozessabbruchtests mit denselben echten Eingaben laufen mit `TSM_PREPARED_PATH=/absoluter/pfad/prepared.json node --test delta-store-crash.test.mjs`, Ausgabe ebenfalls privat umleiten. Ohne diese Variable verwendet die Suite synthetische Daten. Die Tests erzeugen ausschließlich neue Testverzeichnisse unter `.tmp/`.

Die aktuelle Implementierung liest bei jeder Operation alle referenzierten Frames frisch und validiert sie in einem sequenziellen Durchlauf. `createDeltaHistoryValidator()` prüft Header, Envelope, Dependency, Replay-Grenze und State-Hash einmal pro Frame. Restore nutzt den dabei geprüften Zustand als unabhängige Kopie. Ein Cache über mehrere Operationen wird nicht verwendet. Append rekonstruiert den Writer aus der letzten geprüften Checkpoint-Kette und vergleicht die regenerierten Frame-Hashes weiterhin. Retention erzeugt neue Frames aus den im selben Durchlauf geprüften Zuständen.

Vollständige Validierung bleibt O(n); alle Operationen sind exklusiv serialisiert. Das Metadaten-Schreibvolumen eines Append ist durch die Segmentgröße begrenzt, statt die gesamte Historie erneut zu schreiben. Kumuliert bleibt es bei fortlaufenden Appends linear bis auf die wachsenden Ziffernlängen der Zähler. Retention und einmalige Migration schreiben die benötigte Indexkette vollständig neu. SIGKILL-/EIO-Tests belegen die geprüften Prozessabbrüche und Fehlergrenzen, keine Hardware-Stromausfallgarantie. Aktuelle Browserergebnisse und Grenzen stehen in [PUBLIC-RESULTS.md](PUBLIC-RESULTS.md).

Der historische Validierungsvergleich mit `validation-benchmark.mjs` gehört zu den beiden v1-Modulständen vor der Metadatenänderung. Er setzt identische Store-Bytes voraus und darf nicht als v1/v2-Vergleich mit der aktuellen Runtime ausgeführt werden. Der damalige Aufruf lautete:

```sh
node validation-benchmark.mjs --prepared /absoluter/pfad/prepared.json \
  --baseline /absoluter/privater/pfad/validation-before-3_p7j_ko --rounds 5 \
  > /absoluter/privater/pfad/validation-benchmark.log 2>&1
```

Die Baseline-Dateien liegen nur im lokalen Experiment. Ohne sie lassen sich dieser historische Vergleich und die entsprechenden differentiellen Tests nicht reproduzieren; die übrigen Integritätstests bleiben ausführbar. Der Benchmark prüft sämtliche wiederhergestellten Felder und Dateigrößen, schreibt nur private Artefakte unter `.tmp/garrison-real-data/` und gibt keine Sessionwerte aus. „Cold open“ bedeutet neuer Store-Handle, kein geleerter Betriebssystemcache.

Für den ursprünglichen synthetischen Node-Vergleich stehen der gepinnte Garrison-Stand und die Datenstruktur in [source-contract.md](source-contract.md). Dort ist `history[t]` ein Garrison-kompatibles Exportarray mit einem gespeicherten Autosave und **keine Folge vollständiger Garrison-Datenbankabzüge**. Der weiter oben beschriebene Browservergleich bildet dagegen wachsende vollständige Datenbanken ab und misst den adaptierten Garrison-Backup-Pfad. Beide Experimente sind getrennt zu beurteilen.

## Ausführen

Node.js 26.10.0 wurde verwendet. Der Benchmark nutzt `fflate@0.8.3`, passend zur geprüften Garrison-Version; die Node-Browsersimulationen nutzen `fake-indexeddb@6.2.5`. Beide Testabhängigkeiten sind fest gepinnt. `private: true` verhindert eine versehentliche npm-Veröffentlichung dieses Beispielpakets; sein Quellcode ist öffentlich. Der Codec wird aus dem lokalen Release-Quellstand geladen, nicht wiederholt aus npm installiert.

```sh
cd examples/garrison-backup-benchmark
npm ci --ignore-scripts --no-audit --no-fund
npm test
node benchmark.mjs
```

Standard: fünf Verläufe mit je 60 Zeitpunkten, normalerweise sechs Fenstern mit je 16 Tabs, drei Messrunden nach Warmup. Der kleine Grenzfall benutzt ein Fenster mit einem Tab. Kürzerer Funktionstest:

```sh
node benchmark.mjs --points 6 --windows 3 --tabs 4 --rounds 1
```

Ergebnisse landen in einem neuen Ordner unter `tabwerk/.tmp/garrison-benchmark-*`. `--output-root /absoluter/pfad` kann den Elternordner ändern. Vorhandene Ergebnisordner werden nicht überschrieben. `results.json` enthält Definitionen, Eingabe-/Artefakthashes, alle Messrunden und verdichtete Werte. `summary.md` zeigt die Größenübersicht. Die tatsächlichen Archivdateien und synthetischen Eingaben bleiben für die Nachprüfung erhalten.

## Acht Vergleichsverfahren

| Verfahren | Gespeicherte Form | Verhalten bei neuem Zeitpunkt |
| --- | --- | --- |
| `zip-points-pretty` | Eine ZIP je Exportarray, eingerücktes JSON wie im geprüften Garrison-Code | Nur neue Datei |
| `zip-points` | Eine ZIP je Exportarray, kompaktes JSON | Nur neue Datei |
| `gzip-points` | Eine gzip-Datei je Exportarray | Nur neue Datei |
| `zip-rollup` | Eine ZIP mit einem getrennten JSON-Eintrag je Zeitpunkt | Ganze ZIP neu gebaut |
| `zip-combined` | Ein zusammengefasster JSON-Verlauf in genau einem ZIP-Eintrag | Ganzes Archiv neu gebaut |
| `gzip-combined` | Ein zusammengefasster JSON-Verlauf in gzip | Ganzes Archiv neu gebaut |
| `codec-json` | Eigenständiger JSON-Container, Manifeste und einmalig gespeicherte komprimierte Fensterblöcke | Alle Fenster erneut kodiert, nur neue Blöcke hinzugefügt; gesamter JSON-Container erneut serialisiert |
| `codec-gzip` | Derselbe Codec-Container zusätzlich vollständig gzip-komprimiert | Gesamter Container erneut serialisiert und komprimiert |

ZIP verwendet `fflate` Level 6. gzip verwendet Node zlib Level 6. ZIP-Zeitfelder sind fest, damit Artefakte reproduzierbar sind. Unbekannte Metadaten, IDs, Zeitfelder, Gruppen und Split-View-Angaben bleiben in allen Verfahren erhalten. Es wird nichts zugunsten besserer Sharing-Zahlen entfernt.

Die äußere gzip-Schicht bei `codec-gzip` ist eine Kontrolle für unkomprimierte Manifest-Metadaten. Sie muss zum Lesen eines Zeitpunkts vollständig entpackt werden. Sie verwandelt den Container nicht in einen direkt adressierbaren Dateispeicher.

## Was gemessen wird

- **Aufbewahrte Bytes:** alle benötigten Dateien zusammen, einschließlich Formatheader, Manifeste, Hashes und Base64. Logische Dateigrößen, keine belegten Dateisystemblöcke.
- **Kumulierte Schreibnutzlast:** Summe aller erzeugten Dateiinhalte bei fortlaufendem Hinzufügen. Das ist ein berechnetes Schreibmodell, keine Messung tatsächlicher Datenträger-I/O. Bei einem Gesamtcontainer zählt jede vollständige Neufassung. Bei getrennten Dateien zählt nur die jeweils neue Datei.
- **Erstellen:** Serialisierung und Kompression pro Hinzufügen, bei Gesamtarchiven einschließlich Wiederaufbau. P50/P95 über die Zeitpunkte und Runden; Median der Gesamtdauer pro Verlauf.
- **Restore eines Zeitpunkts:** aus bereits im RAM vorhandenen komprimierten Bytes, einschließlich Formatparsing und Dekompression. Der Codec parst, kopiert und prüft den gesamten JSON-Container; ZIP-Rollup dekomprimiert nur den ausgewählten Eintrag, muss aber ZIP-Metadaten durchsuchen. Das ist keine Messung direkter Dateizugriffe.
- **Speicher:** nur Peak-RSS des gesamten Benchmarkprozesses wird dokumentiert. Er enthält Fixtures, Verifikation und mehrere Verfahren; er taugt nicht zum RAM-Vergleich der Verfahren.

Die Reihenfolge der Verfahren rotiert zwischen den Runden. Assertions und I/O sind aus den CPU-Zeitwerten ausgeschlossen. Absolute Laufzeiten stammen aus einem lokalen Node-Prozess, nicht aus Firefox. Codec-Zeiten enthalten den unabhängigen Adapter und die konservative Containerprüfung; sie sind kein isolierter Microbenchmark der Codec-Bibliothek.

## Prüfumfang

Jeder Zeitpunkt wird in jeder Runde aus den tatsächlichen serialisierten Bytes vollständig rekonstruiert. Nach dem Speichern werden alle Artefakte erneut gelesen und wiederhergestellt. Zusätzlich wird ein Teil der Zeitpunkte entfernt; gemeinsam benötigte Blöcke müssen erhalten bleiben. Die Eingabe wird nach allen Messungen auf unveränderten Inhalt geprüft.

Tests prüfen außerdem fehlende und beschädigte Blöcke, ungültige Referenzen, unbekannte Metadaten, Parallelzugriff, fehlgeschlagenes Append und Unterbrechung vor dem Dateiaustausch. `persistence.mjs` schreibt eine Staging-Datei und ersetzt das fertige Archiv per Rename. Die simulierte Unterbrechung vor Rename erhält den letzten fertigen Stand. Das ist keine Zusage für Stromausfallfestigkeit, keine produktive Browsertransaktion und kein fertiger append-only Blockstore.

Das Archivformat ist ein lokales Experiment. Kein Import fremder beliebig großer Archive und keine produktive Migration sind vorgesehen. Paketgrenzen pro Fenster ersetzen keine Gesamtgrößengrenze des Prototyps.

## Auswertung

Die günstige Hypothese lautet: Bei vielen stabilen Fenstern und wenigen Änderungen werden Blöcke zwischen Zeitpunkten wiederverwendet. Die Gegenfälle ändern Zeitfelder, IDs oder alle Fenster. Alle Folgepunkte enthalten echte URLänderungen, weil Aktivtab-Wechsel allein keinen Garrison-Autosave auslösen.

Ein kleineres Ergebnis gegenüber unkomprimiertem JSON genügt nicht. Entscheidend sind die komprimierten Baselines bei identischem Restore-Umfang, zusammen mit Schreibaufwand, Wiederherstellung und zusätzlicher Architektur. Synthetische Grenzfälle sind keine repräsentative Verteilung realer Garrison-Nutzer. Ein positiver Fall rechtfertigt höchstens einen passenden Pilot, keine allgemeine Speicher- oder Performancezusage.

Es gab keine Kontaktaufnahme. Alle Ergebnisse werden Manuel zuerst vorgelegt.
