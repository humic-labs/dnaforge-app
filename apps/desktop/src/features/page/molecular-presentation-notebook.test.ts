import { expect, it } from 'vitest';
import { appendMolecularPresentation } from './molecular-presentation-notebook';
import { molecularDocumentRevisionDigest } from '../../shared/molecular-document-reference';
import { molecularViewSchema } from './embeds/structure3d/utils/molecularView';

it('records a portable document-bound snapshot and is idempotent for that exact revision', async () => {
  const referenceId = crypto.randomUUID();
  const view = molecularViewSchema.parse({
    kind: 'molecular-view',
    version: 1,
    title: 'Pocket and overview',
    caption: 'Observed binding geometry',
    scene: JSON.stringify({
      kind: 'multiple',
      snapshots: [
        { root: {}, metadata: { title: 'Overview' } },
        { root: {}, metadata: { title: 'Pocket' } },
      ],
    }),
    initialSnapshotIndex: 1,
    coordinates: { format: 'pdb', text: 'pinned coordinates', sha256: 'a'.repeat(64) },
    source: {},
    evidence: [{ title: 'Structure evidence', url: 'https://example.org/structure' }],
    presentation: {
      id: crypto.randomUUID(),
      parentReferenceId: crypto.randomUUID(),
      changeSummary: 'Show the binding pocket',
    },
    preview: 'data:image/png;base64,AAAA',
    createdAt: 1,
  });
  const original = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Existing notebook notes' }] }],
  };
  const digest = await molecularDocumentRevisionDigest(view);
  const documentId = crypto.randomUUID();
  const capture = (content: Parameters<typeof appendMolecularPresentation>[0], id: string) =>
    appendMolecularPresentation(content, id, view, {
      documentReference: {
        kind: 'molecular-document',
        version: 1,
        projectId: 'scope',
        documentId,
        revisionId: id,
        revisionSha256: digest,
      },
      path: '/project/view.dnaforge-molecular.json',
      fileRevision: 'b'.repeat(64),
      currentRevisionId: id,
    });
  const content = await capture(original, referenceId);
  expect(content.content?.[0]).toEqual(original.content[0]);
  const embed = content.content?.find((node) => node.type === 'embed');
  expect(embed?.attrs?.data).toMatchObject({
    id: expect.any(String),
    source: 'file',
    sourceId: view.coordinates.text,
    coordinateSha256: view.coordinates.sha256,
    molViewSpec: view.scene,
    molViewSpecSnapshotIndex: 1,
    molViewSpecSavedReferenceId: referenceId,
    molecularViewSnapshot: view,
    molecularDocumentId: documentId,
    molecularDocumentSavedReferenceId: referenceId,
    molecularDocumentProjectId: 'scope',
  });
  const restored = JSON.parse(JSON.stringify(content));
  const retained = restored.content.find((node: { type: string }) => node.type === 'embed');
  expect(molecularViewSchema.parse(retained.attrs.data.molecularViewSnapshot)).toEqual(view);
  expect(await capture(content, referenceId)).toBe(content);
  expect(
    (await capture(content, crypto.randomUUID())).content?.filter((node) => node.type === 'embed')
  ).toHaveLength(2);
  const second = await capture(content, crypto.randomUUID());
  const identities = second.content
    ?.filter((node) => node.type === 'embed')
    .map((node) => node.attrs?.data.id);
  expect(new Set(identities).size).toBe(2);
});
