# Chrome Web Store: Angaben unter „Datenschutz“

## Einziger Zweck (Single purpose)
Tabwerk hilft, viele offene Browser-Tabs zu verwalten: finden, ordnen, aufräumen, sichern und wiederherstellen. Wächter und Formulare ergänzen das für Seiten, die man offen hält, um sie zu beobachten oder wiederholt auszufüllen.

## Begründung der Berechtigungen

| Berechtigung | Begründung |
|---|---|
| tabs | Titel und Adressen der Tabs lesen, um sie zu suchen, zu gruppieren, zu sortieren und Doppelte zu finden. |
| tabGroups | Tab-Gruppen anlegen, benennen, einfärben, sortieren und wiederherstellen. |
| storage, unlimitedStorage | Einstellungen, Verlauf der Tab-Stände, Sitzungen, Notizen, Wächter, Formulare und die gelernten Entscheidungen des Nutzers lokal speichern. Der Verlauf kann bei vielen Tabs mehrere MB groß werden. |
| alarms | Wächter im gewählten Takt prüfen, geschlummerte Tabs wecken, Fokus beenden, inaktive Tabs entladen. |
| notifications | Melden, wenn ein Wächter anschlägt oder ein geschlummerter Tab zurück ist. |
| offscreen | HTML einer beobachteten Seite in Text umwandeln. Der Service Worker hat keinen DOMParser. |
| scripting | Schnellsuche über der Seite einblenden, Text beobachteter Seiten lesen, Formulare speichern und ausfüllen, Kopiersperren einer Seite aufheben. Nur auf Nutzeraktion oder für Websites, die der Nutzer ausdrücklich freigegeben hat. |
| activeTab | Schnellsuche und Formulare im aktiven Tab nach Tastenkürzel oder Rechtsklick. |
| contextMenus | Einträge im Rechtsklick-Menü für Wächter, Notizen, Schlummern, Formulare, Kopieren erlauben und Lesezeichen. |
| identity | Anmeldung bei OpenRouter per OAuth (PKCE), damit der Nutzer keinen Schlüssel kopieren muss. |
| favicon | Website-Symbole in Listen anzeigen, ohne die Seiten erneut zu laden. |
| Host: openrouter.ai, api.typesafe.ai | Anfragen an das Entscheidungsmodell Jev, nur mit dem Schlüssel des Nutzers. |
| optional: http(s)://*/* | Leserecht pro Website für Wächter und, nur auf Wunsch, für die Volltext-Suche in offenen Tabs. |
| optional: bookmarks | Lesezeichen durchsuchen und mit Ordner-Vorschlag anlegen, nur wenn eingeschaltet. |
| optional: history | Verlauf in der Schnellsuche durchsuchen, nur wenn eingeschaltet. |

## Remote Code
Nein. Tabwerk lädt und führt keinen Code von außen aus. Alle Skripte liegen im Paket.

## Datennutzung (ankreuzen)
- Webprotokoll (Web history): ja. Titel, Website und Pfad von Tabs und besuchten Seiten gehen an OpenRouter oder TypeSafe, wenn der Nutzer eine Jev-Funktion nutzt.
- Website-Inhalte (Website content): ja. Geänderte Zeilen beobachteter Seiten gehen an OpenRouter oder TypeSafe, wenn ein Wächter mit Jev prüft.
- Alle anderen Kategorien: nein. Formulardaten, Notizen, Verlauf und gelernte Entscheidungen bleiben lokal.

Bestätigungen:
- Daten werden nicht an Dritte verkauft, außer im genehmigten Einsatzfall (hier: das vom Nutzer gewählte Entscheidungsmodell).
- Daten werden nicht für Zwecke genutzt, die nichts mit dem Einzelzweck zu tun haben.
- Daten werden nicht zur Beurteilung der Kreditwürdigkeit oder für Kredite genutzt.

## Datenschutzerklärung (URL)
https://github.com/DigitalIQ/tabwerk/blob/main/PRIVACY.md
