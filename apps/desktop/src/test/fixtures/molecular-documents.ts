import { MOLECULAR_DOCUMENT_SCHEMA, type MolecularDocument } from '../../shared/molecular-document';
import { coordinateDigest, type MolecularView } from '../../shared/molecular-view';

export async function molecularViewFixture(): Promise<MolecularView> {
  return (await molecularDocumentFixture()).history[0].snapshot;
}

export async function molecularDocumentFixture(): Promise<MolecularDocument> {
  const documentId = '11111111-1111-4111-8111-111111111111';
  const firstId = '22222222-2222-4222-8222-222222222222';
  const secondId = '33333333-3333-4333-8333-333333333333';
  const text = 'HEADER    preserved coordinate bytes\nATOM      1  CA  ALA A   1\nEND\n';
  const snapshot: MolecularView = {
    kind: 'molecular-view',
    version: 1,
    title: 'Binding pocket',
    caption: 'Exact original explanation',
    scene: JSON.stringify({
      kind: 'single',
      root: {
        kind: 'root',
        children: [{ kind: 'download', params: { url: 'structure.pdb' }, children: [] }],
      },
    }),
    coordinates: { format: 'pdb', text, sha256: await coordinateDigest(text) },
    source: { source: 'pdb', sourceId: '1ABC' },
    evidence: [{ title: 'Source evidence', url: 'https://example.org/evidence' }],
    preview: 'data:image/png;base64,AAAA',
    cameraSnapshot: '{"position":[1,2,3]}',
    createdAt: 100,
    presentation: { id: documentId },
  };
  return {
    schema: MOLECULAR_DOCUMENT_SCHEMA,
    id: documentId,
    name: 'Pocket explanation',
    currentReferenceId: secondId,
    history: [
      { referenceId: firstId, snapshot },
      {
        referenceId: secondId,
        snapshot: {
          ...snapshot,
          source: { ...snapshot.source },
          coordinates: { ...snapshot.coordinates },
          title: 'Edited pocket',
          caption: 'A later explanation',
          createdAt: 200,
          presentation: { id: documentId, parentReferenceId: firstId },
        },
      },
    ],
  };
}
