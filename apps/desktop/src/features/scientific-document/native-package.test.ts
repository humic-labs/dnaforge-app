import { beforeEach, describe, expect, it } from 'vitest';

import {
  getCatalogEntityForFilePath,
  getCatalogEventsForEntity,
  getCatalogFileForPath,
} from '../../db/workspace-catalog';
import { initializeTestSchema } from '../../test/initializeTestSchema';
import { clearMockData, MockFsModule } from '../../test/platform-mocks';
import {
  appendProtocolRunTextAmendment,
  parseScientificDocument,
  renameScientificDocument,
  updateProtocolOverview,
} from './model';
import {
  createNativePaperProtocolPackage,
  createNativeProtocolPackage,
  createNativeProtocolRunPackage,
  saveNativeScientificPackage,
} from './native-package';

describe('native protocol packages', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
  });

  it('creates, catalogs, and reopens a provider-neutral protocol', async () => {
    const created = await createNativeProtocolPackage({
      workspaceRoot: '/lab',
      packagePath: 'Protocols/PCR',
      rawId: 'protocol-pcr',
      title: 'PCR',
      createdAt: '2026-08-16T00:00:00.000Z',
    });

    expect(created.metaPath).toBe('/lab/Protocols/PCR/.forge/protocol.json');
    expect(created.document).toMatchObject({ kind: 'protocol', title: 'PCR', mutable: true });
    await expect(getCatalogEntityForFilePath(created.metaPath)).resolves.toMatchObject({
      id: created.entityId,
      type: 'protocol',
      name: 'PCR',
    });
    await expect(getCatalogEventsForEntity(created.entityId)).resolves.toEqual([
      expect.objectContaining({ event_type: 'created', entity_id: created.entityId }),
    ]);
    await expect(MockFsModule.readTextFile(created.metaPath)).resolves.toContain(
      '"provider": "dnaforge"'
    );

    const originalText = await MockFsModule.readTextFile(created.metaPath);
    const renamed = renameScientificDocument(created.document, 'PCR v2');
    if (renamed.kind !== 'protocol') throw new Error('Expected a protocol.');
    const edited = updateProtocolOverview(renamed, 'Updated native overview');
    await saveNativeScientificPackage({
      workspaceRoot: '/lab',
      metaPath: created.metaPath,
      document: edited,
      expectedText: originalText,
    });

    await expect(getCatalogEntityForFilePath(created.metaPath)).resolves.toMatchObject({
      id: created.entityId,
      name: 'PCR v2',
    });
    await expect(getCatalogFileForPath(created.metaPath)).resolves.toMatchObject({
      content_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      file_kind: 'waypoint-protocol',
    });
    await expect(getCatalogEventsForEntity(created.entityId)).resolves.toEqual([
      expect.objectContaining({ event_type: 'created' }),
      expect.objectContaining({ event_type: 'edited' }),
    ]);
    await expect(MockFsModule.readTextFile(created.metaPath)).resolves.toContain(
      'Updated native overview'
    );
  });

  it('creates and catalogs an editable provider-neutral protocol run', async () => {
    const created = await createNativeProtocolRunPackage({
      workspaceRoot: '/lab',
      packagePath: 'Protocol Runs/PCR run 1',
      rawId: 'protocol-run-1',
      title: 'PCR run 1',
      createdAt: '2026-08-16T01:00:00.000Z',
      protocol: {
        rawId: 'protocol-pcr',
        name: 'PCR',
        pinnedVersionId: 'local-v1',
        pinnedVersionHash: `sha256:${'a'.repeat(64)}`,
      },
    });

    expect(created.metaPath).toBe('/lab/Protocol Runs/PCR run 1/.forge/protocol-run.json');
    expect(created.document).toMatchObject({
      kind: 'protocol_run',
      title: 'PCR run 1',
      mutable: true,
      status: 'in_progress',
    });
    await expect(getCatalogEntityForFilePath(created.metaPath)).resolves.toMatchObject({
      id: created.entityId,
      type: 'protocol_run',
    });

    const originalText = await MockFsModule.readTextFile(created.metaPath);
    if (created.document.kind !== 'protocol_run') throw new Error('Expected a protocol run.');
    const amended = await appendProtocolRunTextAmendment(created.document, {
      path: '/measurements/temperature',
      reason: 'Correct the recorded temperature',
      value: '37 C',
      at: '2026-08-16T01:30:00.000Z',
    });
    await saveNativeScientificPackage({
      workspaceRoot: '/lab',
      metaPath: created.metaPath,
      document: amended,
      expectedText: originalText,
    });

    await expect(MockFsModule.readTextFile(created.metaPath)).resolves.toContain(
      'Correct the recorded temperature'
    );
    await expect(getCatalogFileForPath(created.metaPath)).resolves.toMatchObject({
      content_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      file_kind: 'waypoint-protocol-run',
    });
    await expect(getCatalogEventsForEntity(created.entityId)).resolves.toEqual([
      expect.objectContaining({ event_type: 'created' }),
      expect.objectContaining({ event_type: 'edited' }),
    ]);
  });

  it('persists an already validated paper draft through the native package lifecycle', async () => {
    const document = parseScientificDocument(
      '/lab/Protocols/Paper/.forge/protocol.json',
      JSON.stringify(paperProtocolDocument())
    );
    if (document.kind !== 'protocol') throw new Error('Expected a protocol.');

    const created = await createNativePaperProtocolPackage({
      workspaceRoot: '/lab',
      packagePath: 'Protocols/Paper',
      document,
    });

    expect(created).toMatchObject({
      rawId: 'paper-protocol-source-a',
      metaPath: '/lab/Protocols/Paper/.forge/protocol.json',
      document: {
        kind: 'protocol',
        title: 'Paper protocol',
        paperProtocol: { draft: { revision: 1, state: 'draft' } },
      },
    });
    await expect(getCatalogEntityForFilePath(created.metaPath)).resolves.toMatchObject({
      id: created.entityId,
      type: 'protocol',
      name: 'Paper protocol',
    });
    await expect(MockFsModule.readTextFile(created.metaPath)).resolves.toContain(
      'dnaforge.paper-protocol.v1'
    );

    const retryRaw = paperProtocolDocument();
    (retryRaw.version as Record<string, unknown>).importedAt = '2026-08-19T00:05:00.000Z';
    (retryRaw.provenance as Record<string, unknown>).capturedAt = '2026-08-19T00:05:00.000Z';
    const retryWorkflow = retryRaw.paperProtocol as Record<string, unknown>;
    (
      (retryWorkflow.sources as Record<string, unknown>[])[0] as Record<string, unknown>
    ).capturedAt = '2026-08-19T00:05:00.000Z';
    const retryDocument = parseScientificDocument(created.metaPath, JSON.stringify(retryRaw));
    if (retryDocument.kind !== 'protocol') throw new Error('Expected a protocol.');
    const replay = await createNativePaperProtocolPackage({
      workspaceRoot: '/lab',
      packagePath: 'Protocols/Paper',
      document: retryDocument,
    });
    expect(replay).toMatchObject({ entityId: created.entityId, metaPath: created.metaPath });
    await expect(getCatalogEventsForEntity(created.entityId)).resolves.toHaveLength(1);

    const conflictRaw = paperProtocolDocument();
    conflictRaw.title = 'Different candidate intent';
    const conflictDocument = parseScientificDocument(created.metaPath, JSON.stringify(conflictRaw));
    if (conflictDocument.kind !== 'protocol') throw new Error('Expected a protocol.');
    await expect(
      createNativePaperProtocolPackage({
        workspaceRoot: '/lab',
        packagePath: 'Protocols/Paper',
        document: conflictDocument,
      })
    ).rejects.toThrow(/different candidate intent/i);
  });

  it('does not write an unregistered native package before reporting the catalog error', async () => {
    const created = await createNativeProtocolPackage({
      workspaceRoot: '/lab',
      packagePath: 'Protocols/PCR',
      rawId: 'protocol-pcr',
      title: 'PCR',
      createdAt: '2026-08-16T00:00:00.000Z',
    });
    const unregisteredPath = '/lab/Protocols/Unregistered/.forge/protocol.json';
    const originalText = 'unchanged native package';
    await MockFsModule.writeTextFile(unregisteredPath, originalText);

    await expect(
      saveNativeScientificPackage({
        workspaceRoot: '/lab',
        metaPath: unregisteredPath,
        document: renameScientificDocument(created.document, 'Changed title'),
        expectedText: originalText,
      })
    ).rejects.toThrow('Native scientific package is not registered in the project catalog.');

    await expect(MockFsModule.readTextFile(unregisteredPath)).resolves.toBe(originalText);
  });
});

function paperProtocolDocument(): Record<string, unknown> {
  const hash = `sha256:${'a'.repeat(64)}`;
  return {
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: 'paper-protocol-source-a',
    title: 'Paper protocol',
    editable: true,
    overview: { type: 'doc', content: [] },
    steps: [
      {
        id: 'paper-step-1',
        sourceStepId: 'paper-step-1',
        ordinal: 1,
        title: 'Lyse cells',
        content: { type: 'doc', content: [] },
      },
    ],
    inputs: [],
    outputs: [],
    links: [],
    version: {
      sourceVersionId: hash,
      pinnedVersionHash: hash,
      immutable: true,
      importedAt: '2026-08-19T00:00:00.000Z',
    },
    provenance: { provider: 'local-pdf', capturedAt: '2026-08-19T00:00:00.000Z' },
    paperProtocol: {
      schema: 'dnaforge.paper-protocol.v1',
      candidate: {
        candidateSetId: 'paper-set-source-a',
        candidateId: 'paper-candidate-source-a-1',
        ordinal: 1,
        label: 'Paper protocol',
        status: 'selected',
      },
      draft: { revision: 1, state: 'draft', reopenedFromAcceptedVersionId: null },
      sources: [
        {
          sourceId: 'source-a',
          kind: 'pdf',
          title: 'Paper PDF',
          mediaType: 'application/pdf',
          sha256: hash,
          capturedAt: '2026-08-19T00:00:00.000Z',
          workspacePath: 'papers/source.pdf',
          pageCount: 1,
        },
      ],
      evidence: [
        {
          evidenceId: 'evidence-1',
          stepId: 'paper-step-1',
          sourceId: 'source-a',
          sourceSha256: hash,
          evidenceClass: 'direct',
          quote: 'Lyse cells.',
          locator: {
            kind: 'pdf_rects',
            page: 1,
            rects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.05 }],
          },
        },
      ],
      gaps: [],
      acceptedVersions: [],
    },
  };
}
