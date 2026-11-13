import { expect, it } from 'vitest';
import { buildDefaultMolecularDocument } from './default-molecular-view';
import { getCurrentMolecularSnapshot } from './molecular-document';
import { binaryCoordinateText } from './binary-coordinates';
import {
  coordinateDigest,
  molecularViewSchema,
  validateMolecularViewCoordinates,
} from './molecular-view';

async function snapshot(resource: string) {
  const text = 'HEADER PINNED NATIVE SOURCE\nEND\n';
  return molecularViewSchema.parse({
    kind: 'molecular-view',
    version: 1,
    title: 'Portable source',
    caption: '',
    scene: JSON.stringify({
      kind: 'single',
      root: { kind: 'root', children: [{ kind: 'download', params: { url: resource } }] },
    }),
    coordinates: { format: 'pdb', text, sha256: await coordinateDigest(text) },
    source: {
      artifactEntityId: 'catalog-structure:source',
      artifactRevisionId: 'exact-source-version',
    },
    evidence: [],
    preview: 'data:image/png;base64,AAAA',
    createdAt: 1,
  });
}

it('validates portable version-one scenes against their exact pinned local resource', async () => {
  const value = await snapshot('structure.pdb');
  await expect(validateMolecularViewCoordinates(value)).resolves.toBeUndefined();
  expect(value.source.artifactEntityId).toBe('catalog-structure:source');
  expect(value.source.artifactRevisionId).toBe('exact-source-version');
});

it('validates a binary CIF view against its pinned structure.bcif resource ', async () => {
  const document = await buildDefaultMolecularDocument({
    name: '1FS0',
    format: 'bcif',
    text: binaryCoordinateText(Uint8Array.from([131, 164, 0, 255])),
    createdAt: 1,
    documentId: '11111111-1111-4111-8111-111111111111',
    referenceId: '22222222-2222-4222-8222-222222222222',
  });
  await expect(
    validateMolecularViewCoordinates(getCurrentMolecularSnapshot(document))
  ).resolves.toBeUndefined();
  await expect(
    validateMolecularViewCoordinates({
      ...getCurrentMolecularSnapshot(document),
      coordinates: { ...getCurrentMolecularSnapshot(document).coordinates, text: 'not base64!' },
    })
  ).rejects.toThrow();
});

it('rejects unpinned external resources in a version-one native snapshot', async () => {
  await expect(
    validateMolecularViewCoordinates(await snapshot('https://example.com/changed.pdb'))
  ).rejects.toThrow(/not pinned/i);
});
