import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encodeExport, decodeExport } from './adapter.mjs';

const [mode, inputPath, outputPath, ...extra] = process.argv.slice(2);
if (!['encode', 'decode'].includes(mode) || !inputPath || !outputPath || extra.length) {
  console.error('Aufruf: node examples/tab-session-manager/cli.mjs encode|decode INPUT.json NEUE-AUSGABE.json');
  process.exitCode = 1;
} else {
  try {
    if (resolve(inputPath) === resolve(outputPath)) throw new Error('Ein- und Ausgabe müssen verschieden sein');
    const input = await open(inputPath, 'r');
    let text;
    try {
      if ((await input.stat()).size > 64 * 1024 * 1024) throw new Error('Eingabedatei überschreitet das Beispiel-Limit von 64 MiB');
      text = await input.readFile('utf8');
    } finally {
      await input.close();
    }
    const data = JSON.parse(text);
    const result = mode === 'encode' ? await encodeExport(data) : await decodeExport(data);
    await writeFile(outputPath, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
    console.log(`Neue Datei geschrieben: ${outputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
