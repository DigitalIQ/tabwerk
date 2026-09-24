// Regeln für das automatische Einsortieren: eine Regel pro Zeile, „domain = Gruppe“.
// Subdomains zählen mit: „github.com“ trifft auch „gist.github.com“.

export function parseRules(lines) {
  return (Array.isArray(lines) ? lines : String(lines || '').split('\n'))
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [left, ...rest] = line.split('=');
      return { host: left.trim().toLowerCase().replace(/^www\./, ''), group: rest.join('=').trim() };
    })
    .filter((r) => r.host && r.group);
}

export function matchRule(host, rules) {
  const h = (host || '').toLowerCase().replace(/^www\./, '');
  // Die spezifischste Regel gewinnt.
  return rules
    .filter((r) => h === r.host || h.endsWith(`.${r.host}`))
    .sort((a, b) => b.host.length - a.host.length)[0] || null;
}
