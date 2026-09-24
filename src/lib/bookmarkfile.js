// Sitzungen als Lesezeichen-Datei im Netscape-Format. Jeder Browser kann sie importieren.

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toBookmarkHtml(sessions) {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Tabwerk</TITLE>',
    '<H1>Tabwerk</H1>',
    '<DL><p>',
  ];
  for (const s of sessions) {
    const t = Math.round((s.t || Date.now()) / 1000);
    lines.push(`  <DT><H3 ADD_DATE="${t}">${esc(s.name)}</H3>`, '  <DL><p>');
    for (const w of s.windows) {
      const groups = new Map((w.groups || []).map((g) => [g.id, g]));
      let open = null;
      for (const tab of w.tabs) {
        if (!/^https?:/.test(tab.url || '')) continue;
        const g = tab.groupId !== -1 ? groups.get(tab.groupId) : null;
        if ((g?.id ?? null) !== open) {
          if (open !== null) lines.push('    </DL><p>');
          if (g) lines.push(`    <DT><H3>${esc(g.title || 'Gruppe')}</H3>`, '    <DL><p>');
          open = g?.id ?? null;
        }
        lines.push(`${open !== null ? '      ' : '    '}<DT><A HREF="${esc(tab.url)}" ADD_DATE="${t}">${esc(tab.title || tab.url)}</A>`);
      }
      if (open !== null) lines.push('    </DL><p>');
    }
    lines.push('  </DL><p>');
  }
  lines.push('</DL><p>');
  return lines.join('\n');
}
