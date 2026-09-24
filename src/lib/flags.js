// Jede Funktion lässt sich in den Einstellungen ein- und ausschalten.
// parent: die Funktion wirkt nur, wenn die übergeordnete an ist.
// jev: braucht einen Schlüssel für Jev. perm: braucht eine optionale Chrome-Erlaubnis.

export const FEATURES = [
  { id: 'palette', area: 'Suchen', label: 'Schnellsuche', hint: 'Suche per Tastenkürzel über jeder Seite.', def: true },
  { id: 'paletteFulltext', parent: 'palette', area: 'Suchen', label: 'Volltext in offenen Tabs', hint: 'Sucht auch im sichtbaren Text der Seiten. Braucht Leserecht für alle Websites.', def: false, perm: { origins: ['https://*/*', 'http://*/*'] } },
  { id: 'paletteHistoryJev', parent: 'palette', area: 'Suchen', label: 'Verlauf in Alltagssprache', hint: 'Mit /h und Umschalt+Enter: „der Artikel über Solarstrom von letzter Woche“.', def: false, jev: true, perm: { permissions: ['history'] } },
  { id: 'find', area: 'Suchen', label: 'Finden mit Jev', hint: 'Tab per Beschreibung finden, im Popup.', def: true, jev: true },

  { id: 'groups', area: 'Ordnen', label: 'Gruppen-Vorschläge', hint: 'Jev schlägt für jeden Tab eine Gruppe vor.', def: true, jev: true },
  { id: 'groupNames', parent: 'groups', area: 'Ordnen', label: 'Gruppennamen vorschlagen', hint: 'Für Gruppen ohne Titel wählt Jev einen kurzen Namen aus Wörtern der Tab-Titel.', def: true, jev: true },
  { id: 'autoGroup', area: 'Ordnen', label: 'Neue Tabs automatisch einsortieren', hint: 'Nach deinen Regeln wie „github.com = Entwicklung“.', def: false },
  { id: 'autoGroupJev', parent: 'autoGroup', area: 'Ordnen', label: 'Ohne passende Regel Jev fragen', hint: 'Nur bei hoher Sicherheit, sonst bleibt der Tab ohne Gruppe.', def: false, jev: true },
  { id: 'sort', area: 'Ordnen', label: 'Sortieren', hint: 'Nach Website, Nutzung, Titel und mit Jev nach Priorität.', def: true },
  { id: 'focus', area: 'Ordnen', label: 'Fokus-Modus', hint: 'Klappt andere Gruppen ein und sperrt ablenkende Seiten auf Zeit.', def: true },
  { id: 'notes', area: 'Ordnen', label: 'Notizen an Tabs', hint: 'Per Rechtsklick, Tastenkürzel oder Schnellsuche.', def: true },
  { id: 'copyLinks', area: 'Ordnen', label: 'Tabs als Linkliste kopieren', hint: 'Als Markdown oder Text, für Notizen und Mails.', def: true },

  { id: 'cleanup', area: 'Aufräumen', label: 'Doppelte finden', hint: 'Gleiche Adressen finden und einzeln schließen.', def: true },
  { id: 'similar', parent: 'cleanup', area: 'Aufräumen', label: 'Gleichen Inhalt finden', hint: 'Jev vergleicht Tabs derselben Website.', def: true, jev: true },
  { id: 'cleanupSuggest', parent: 'cleanup', area: 'Aufräumen', label: 'Aufräum-Vorschlag', hint: 'Markiert alte und unwichtige Tabs zum Schließen. Mit Jev genauer.', def: true },
  { id: 'dupeGuard', area: 'Aufräumen', label: 'Doppelte beim Öffnen abfangen', hint: 'Springt zum schon offenen Tab. Zweimal öffnen hintereinander behält beide.', def: false },
  { id: 'discard', area: 'Aufräumen', label: 'Inaktive Tabs entladen', hint: 'Spart Speicher. Der Tab bleibt sichtbar und lädt beim Anklicken neu.', def: false },
  { id: 'snooze', area: 'Aufräumen', label: 'Tabs schlummern lassen', hint: 'Tab schließen und zur gewählten Zeit wieder öffnen.', def: true },

  { id: 'history', area: 'Sichern', label: 'Verlauf', hint: 'Sichert Fenster, Tabs und Gruppen nach jeder Änderung.', def: true },
  { id: 'undo', parent: 'history', area: 'Sichern', label: 'Rückgängig', hint: 'Springt zum Stand vor der letzten Tabwerk-Aktion.', def: true },
  { id: 'sessions', area: 'Sichern', label: 'Benannte Sitzungen', hint: 'Fenster unter einem Namen speichern und später öffnen.', def: true },
  { id: 'transfer', area: 'Sichern', label: 'Export und Import', hint: 'Alles als Datei sichern, Sitzungen auch als Lesezeichen-Datei.', def: true },
  { id: 'stats', area: 'Sichern', label: 'Statistik', hint: 'Tabs pro Fenster und Website, älteste Tabs, Verlauf der Anzahl.', def: true },

  { id: 'watches', area: 'Beobachten', label: 'Wächter', hint: 'Seiten beobachten und bei passender Änderung melden.', def: true },
  { id: 'watchDiff', parent: 'watches', area: 'Beobachten', label: 'Änderungen anzeigen', hint: 'Zeigt neue und entfernte Zeilen jeder Prüfung.', def: true },
  { id: 'watchNumbers', parent: 'watches', area: 'Beobachten', label: 'Zahlen und Preise vergleichen', hint: 'Code vergleicht exakt, Jev wählt die richtige Zahl auf der Seite.', def: true, jev: true },

  { id: 'copyUnlock', area: 'Lesezeichen und Formulare', label: 'Kopieren erlauben', hint: 'Hebt Sperren für Kopieren, Einfügen, Markieren und Rechtsklick auf. Für einen Tab oder immer für eine Website.', def: true },
  { id: 'bookmarkFolder', area: 'Lesezeichen und Formulare', label: 'Lesezeichen-Ordner vorschlagen', hint: 'Jev wählt beim Speichern den passenden Ordner.', def: false, jev: true, perm: { permissions: ['bookmarks'] } },
  { id: 'forms', area: 'Lesezeichen und Formulare', label: 'Formulare speichern und ausfüllen', hint: 'Passwort-, Karten- und Kontofelder speichert Tabwerk nie.', def: true },
  { id: 'formsTestData', parent: 'forms', area: 'Lesezeichen und Formulare', label: 'Mit Testdaten füllen', hint: 'Erfundene Namen, Adressen und Zahlen, für Entwickler.', def: true },
  { id: 'formsSensitive', parent: 'forms', area: 'Lesezeichen und Formulare', label: 'Auch geschützte Felder speichern', hint: 'Speichert auch Passwort-, Karten-, Konto-, IBAN- und TAN-Felder. Tabwerk legt sie unverschlüsselt in Chrome ab und nimmt sie in den Export auf. Jev sieht nie Werte.', def: false, warn: true },
  { id: 'formsJev', parent: 'forms', area: 'Lesezeichen und Formulare', label: 'Unbekannte Felder mit Jev zuordnen', hint: 'Jev sieht nur Feldnamen und Beschriftungen, keine Werte.', def: false, jev: true },
];

export const FEATURE_DEFAULTS = Object.fromEntries(FEATURES.map((f) => [f.id, f.def]));
const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));

export const feature = (id) => BY_ID.get(id);

// An, wenn die Funktion selbst und alle übergeordneten an sind.
export function isOn(settings, id) {
  const flags = { ...FEATURE_DEFAULTS, ...(settings.features || {}) };
  for (let f = BY_ID.get(id); f; f = f.parent ? BY_ID.get(f.parent) : null) {
    if (!flags[f.id]) return false;
  }
  return true;
}
