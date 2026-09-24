// Formulare: reine Logik für Zuordnung, Schutz sensibler Felder und Testdaten.
// Die Funktionen für die Seite selbst stehen in src/content/forms.js.

// Diese Felder speichert und füllt Tabwerk nie.
export const SENSITIVE = /pass|pwd|kennwort|passwort|card|karte|cc-|cvv|cvc|csc|iban|bic|swift|konto|account.?num|pin\b|\btan\b|otp|one-time|token|secret|geheim|ssn|social.?security|steuer.?id|tax.?id|security.?code/i;

export function isSensitive(field) {
  if (['password', 'hidden', 'file'].includes(field.type)) return true;
  if (/^(cc-|current-password|new-password|one-time-code)/.test(field.autocomplete || '')) return true;
  return SENSITIVE.test([field.name, field.id, field.label, field.autocomplete, field.placeholder].filter(Boolean).join(' '));
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, '');

// Ordnet Zielfelder gespeicherten Feldern zu: erst ID, dann Name, dann Beschriftung.
// Liefert pro Zielfeld den Index des gespeicherten Felds oder -1.
export function matchFields(targets, saved) {
  const used = new Set();
  const pick = (test) => saved.findIndex((s, i) => !used.has(i) && test(s));
  return targets.map((t) => {
    let i = -1;
    if (t.id) i = pick((s) => s.id && s.id === t.id);
    if (i === -1 && t.name) i = pick((s) => s.name && s.name === t.name);
    if (i === -1 && t.label) i = pick((s) => s.label && norm(s.label) === norm(t.label));
    if (i === -1 && t.autocomplete && t.autocomplete !== 'on' && t.autocomplete !== 'off') i = pick((s) => s.autocomplete === t.autocomplete);
    if (i !== -1) used.add(i);
    return i;
  });
}

// Beschreibung eines Felds für Jev. Werte bleiben draußen.
export function describeField(f) {
  return Object.fromEntries(Object.entries({ label: f.label, name: f.name, id: f.id, type: f.type, placeholder: f.placeholder, autocomplete: f.autocomplete })
    .filter(([, v]) => v && v !== 'on' && v !== 'off'));
}

// ---------- Testdaten ----------

const FIRST = ['Anna', 'Ben', 'Clara', 'David', 'Emma', 'Finn', 'Greta', 'Hannes', 'Ida', 'Jonas', 'Lena', 'Mats'];
const LAST = ['Becker', 'Fischer', 'Hartmann', 'Keller', 'Lorenz', 'Meyer', 'Neumann', 'Schulz', 'Vogel', 'Wagner'];
const STREET = ['Lindenweg', 'Hauptstraße', 'Gartenstraße', 'Am Markt', 'Bahnhofstraße', 'Birkenallee'];
const CITY = [['10115', 'Berlin'], ['01067', 'Dresden'], ['50667', 'Köln'], ['60311', 'Frankfurt am Main'], ['80331', 'München'], ['04109', 'Leipzig']];
const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ');

// Kleiner, wiederholbarer Zufall, damit Tests stabil bleiben.
export function rng(seed = Date.now()) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return ((x >>> 0) % 1e6) / 1e6;
  };
}

export function fakePerson(random = Math.random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const first = pick(FIRST);
  const last = pick(LAST);
  const [zip, city] = pick(CITY);
  return {
    first, last,
    email: `${first}.${last}@example.com`.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue'),
    phone: `+49 30 ${Math.floor(1000000 + random() * 8999999)}`,
    street: `${pick(STREET)} ${1 + Math.floor(random() * 120)}`,
    zip, city,
    company: `${last} & Partner GmbH`,
    birth: `19${60 + Math.floor(random() * 40)}-0${1 + Math.floor(random() * 9)}-1${Math.floor(random() * 9)}`,
    text: Array.from({ length: 12 }, () => pick(WORDS)).join(' '),
  };
}

// Wählt pro Feld einen passenden erfundenen Wert anhand von Typ und Beschriftung.
export function fakeValue(field, person, random = Math.random) {
  const hay = [field.label, field.name, field.id, field.placeholder, field.autocomplete].filter(Boolean).join(' ').toLowerCase();
  const has = (re) => re.test(hay);
  if (field.type === 'checkbox') return random() < 0.5;
  if (field.type === 'radio') return true;
  if (field.type === 'select') return field.options?.length > 1 ? field.options[1 + Math.floor(random() * (field.options.length - 1))] : field.options?.[0] ?? '';
  if (field.type === 'email' || has(/e-?mail/)) return person.email;
  if (field.type === 'tel' || has(/tel|phone|mobil|handy/)) return person.phone;
  if (field.type === 'url' || has(/website|webseite|homepage|url/)) return 'https://example.com';
  if (field.type === 'date' || has(/geburt|birth|datum|date/)) return person.birth;
  if (field.type === 'number' || has(/anzahl|menge|alter|age|quantity/)) return String(1 + Math.floor(random() * 40));
  if (has(/vorname|first|given/)) return person.first;
  if (has(/nachname|last|family|surname/)) return person.last;
  if (has(/firma|company|organi[sz]ation|unternehmen/)) return person.company;
  if (has(/stra(ss|ß)e|street|address|adresse/)) return person.street;
  if (has(/plz|zip|postal|postleitzahl/)) return person.zip;
  if (has(/stadt|ort|city|town/)) return person.city;
  if (has(/land|country/)) return 'Deutschland';
  if (has(/name/)) return `${person.first} ${person.last}`;
  if (field.type === 'textarea' || has(/nachricht|message|kommentar|comment|beschreibung/)) return person.text;
  return person.text.split(' ').slice(0, 3).join(' ');
}
