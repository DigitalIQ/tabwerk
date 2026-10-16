import { createDeltaArchive } from '../delta-archive.mjs';

// Ausschließlich synthetische Daten. Die HTTP-JSON-Übertragung normalisiert -0;
// diesen Fall prüft der Browser separat ohne JSON-Transport.
export async function createNodeCrossRuntimeFixture() {
  const nodePoints = [
    [{ id: 'synthetic', windows: { '1': { '2': { title: 'ä😀', url: 'https://example.invalid/a', active: true } } }, extra: { empty: [], n: 1 } }],
    [{ id: 'synthetic', windows: { '1': { '2': { title: 'ü😀', url: 'https://example.invalid/b', active: false } } }, extra: { empty: [], n: 2 } }],
    [{ id: 'synthetic', windows: {}, extra: { nil: null, nested: [{ yes: true }] } }],
  ];
  const writer = createDeltaArchive({ checkpointInterval: 2 });
  return { nodeFrames: nodePoints.map(point => writer.append(point).toString('base64')), nodePoints, checkpointInterval: 2 };
}
