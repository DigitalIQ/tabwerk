# Session-Codec lokal prüfen

`packages/session-codec` enthält das eigenständige npm-Paket `tabwerk-session-codec`. Das Extension-Root bleibt mit `private: true` gegen eine versehentliche npm-Veröffentlichung geschützt. Die Tests veröffentlichen nichts und behaupten keine externe Adoption.

## Integration

Tabwerks `src/lib/histstore.js` und `retention.js` exportieren die Implementierung aus dem Legacy-Einstieg des Pakets. Es gibt eine gemeinsame Implementierung. Die Browser-Extension lädt diese Dateien direkt per relativem ESM-Import und benötigt kein `node_modules` zur Laufzeit.

Das ist eine lokale Quellcodeintegration. Sie verwendet keine Registry-Abhängigkeit und erzeugt keinen Nachweis fremder Nutzung. Der bestehende `hwin:`-Speicher und die Aufbewahrungsfristen bleiben unverändert. Neue Consumer verwenden die separate v1-API; ihre Daten werden nicht automatisch in Tabwerks Verlauf migriert.

Der ZIP-Packager nimmt die Paketquellen und deren Lizenz mit auf. Tests, Typdeklarationen, npm-Metadaten, Beispiele und Entwicklungsabhängigkeiten gehören nicht zur Browser-Laufzeit. Typdeklarationen können in `src/` liegen, werden beim Packen aber ausgeschlossen.

## Prüfungen

```sh
npm test
npm run test:codec
npm run test:adapter
npm run test:distribution
```

`test:distribution` erzeugt ein neues Arbeitsverzeichnis unter `.tmp/codec-distribution-*`. Dort liegen das npm-Tarball, ein getrennt offline installierter Consumer, das Extension-ZIP, dessen ausgepackter Inhalt und `result.json`. Vorhandene Store-ZIPs werden dabei nicht geändert. Der Consumer importiert v1 und Legacy über den tatsächlichen Paketnamen.

Den ausgegebenen Pfad anschließend für Chrome verwenden:

```sh
npm run test:codec-browser -- .tmp/codec-distribution-VERZEICHNIS/result.json
```

Der Test benötigt die vorhandene Playwright-Installation und Chrome for Testing. Er startet ein eigenes Profil unter demselben Prüfverzeichnis, lädt die ausgepackte Extension und verwendet synthetische Daten. Persönliche Chrome-Profile bleiben unberührt. Geprüft werden v1, Legacy, alte Inline-Snapshots und deren Migration zu Inhaltsblöcken. Der Bericht heißt `browser-result.json`; das Profil wird nach dem Lauf geschlossen. Dies ist ein gezielter Integrationstest, keine vollständige UI-Abnahme aller Tabwerk-Funktionen.

```sh
node examples/tab-session-manager/demo.mjs
```

Die Demo arbeitet mit synthetischen Daten im tatsächlich beobachteten Exportformat. Sie prüft die verlustfreie Rückwandlung und zählt Original-/Archivbytes einschließlich Metadaten. Für Ergebnisse eines echten Exports ist eine eigene Messung nötig. Die Quellen und Grenzen stehen beim Beispiel.

## Geprüfter Stand vom 15. Oktober 2026

- 120 Tests unter Node 26.10.0 bestanden, einschließlich 18 Paket- und acht Adaptertests.
- TypeScript-Consumer mit TypeScript 5.8.3 offline unter `--strict --noEmit --module NodeNext --target ES2022` geprüft.
- Gepacktes npm-Archiv in einem getrennten Consumer mit leerem Cache offline installiert; Haupt- und Legacy-Einstieg funktionieren.
- Tatsächlich gepacktes Extension-ZIP entpackt und native ESM-Pfade geprüft.
- Gezielter Lauf in Chrome for Testing 151: v1-Roundtrip, Legacy-Roundtrip, alte Blöcke, alte Inline-Snapshots und deren Migration bestanden; keine unbehandelten Popup-Fehler.
- Unabhängiger Review ohne offene Befunde. Die unveränderte Legacy-Implementierung wurde zusätzlich gegen den Ausgangscommit geprüft. Kein vollständiger Security-Scan oder kompletter UI-Test behauptet.

Die synthetische Adapterdemo zeigt vier Fensterreferenzen auf drei Blöcke: 34.424 Bytes kompaktes JSON gegenüber 6.465 Bytes vollständigem Archiv. Die ungünstigen Fälle ergeben 461 gegenüber 1.004 Bytes sowie 937 gegenüber 1.948 Bytes. Damit ist der Nutzen von wiederholten unveränderten Fensterinhalten abhängig; es gibt keine allgemeine Kompressionszusage.

## Vor einem Release

Vor einem Release Version und npm-Zugang prüfen sowie den tatsächlich gepackten Inhalt kontrollieren. Die Maintainer-Zuordnung und der private Meldeweg stehen in `SECURITY.md`. Keine Veröffentlichung ist Teil der lokalen Tests. Der Code enthält weder einen automatischen Publish-Schritt noch einen Registry-Downloadzähler.
