// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSavedResidueSelectionDocument,
  appendSavedResidueSelectionRevision,
  type SavedResidueSelectionDocument,
} from '@waypoint/workspace-editor';
import {
  clearMockData,
  getMockFileContent,
  MockFsModule,
  setMockFileContent,
} from '../test/platform-mocks';
import { initializeTestSchema } from '../test/initializeTestSchema';
import {
  getCatalogEntity,
  getCatalogEventsForEntity,
  getCatalogFilesForEntity,
} from './workspace-catalog';
import { readProjectMemory } from './project-memory';
import {
  createSavedResidueSelectionArtifact,
  resolveSavedResidueSelectionArtifact,
  writeSavedResidueSelectionArtifactRevision,
} from './saved-residue-selection-artifact';

function selectionDocument(): SavedResidueSelectionDocument {
  return createSavedResidueSelectionDocument({
    id: 'selection-asset-1',
    name: 'Catalytic residues',
    color: '#ef4444',
    revisionId: 'selection-revision-1',
    createdAt: '2026-07-14T12:00:00.000Z',
    actor: { kind: 'user' },
    members: [
      {
        id: 'member-1',
        selection: {
          target: {
            moleculeId: 'protein:sha256:abc123',
            moleculeKind: 'protein',
            coordinateSystem: 'residue',
            intervals: [
              { start: 85, end: 108 },
              { start: 194, end: 204 },
            ],
          },
        },
        scope: { kind: 'polymer' },
        polymerRevision: {
          moleculeId: 'protein:sha256:abc123',
          moleculeKind: 'protein',
          sequenceDigestSha256: 'abc123',
        },
      },
    ],
  });
}

describe('saved residue selection artifacts', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
  });

  it('creates a visible portable artifact and indexes stable selection identity', async () => {
    const document = selectionDocument();
    const result = await createSavedResidueSelectionArtifact({
      workspaceRoot: '/lab',
      document,
    });

    expect(result).toEqual({
      path: '/lab/Selections/Catalytic residues.selection-asset-1.wpselection.json',
      name: 'Catalytic residues.selection-asset-1.wpselection.json',
      fileKind: 'waypoint-residue-selection',
      selection: document,
    });
    expect(JSON.parse(getMockFileContent(result.path) ?? '{}')).toEqual(document);
    expect(await getCatalogEntity(document.id)).toMatchObject({
      id: 'selection-asset-1',
      type: 'selection',
      locator: 'entity://selection/selection-asset-1',
      storage_type: 'file',
    });
    expect(await getCatalogFilesForEntity(document.id)).toEqual([
      expect.objectContaining({
        path: result.path,
        relative_path: 'Selections/Catalytic residues.selection-asset-1.wpselection.json',
        file_kind: 'waypoint-residue-selection',
        status: 'current',
      }),
    ]);
    expect(await readProjectMemory('/lab')).toMatchObject({
      entities: [expect.objectContaining({ id: document.id, kind: 'selection' })],
      files: [
        expect.objectContaining({
          entityId: document.id,
          fileKind: 'selection',
          path: 'Selections/Catalytic residues.selection-asset-1.wpselection.json',
        }),
      ],
    });
  });

  it('keeps a committed canonical artifact successful when a repairable projection fails', async () => {
    const document = selectionDocument();
    const originalWrite = MockFsModule.writeTextFile;
    const writeSpy = vi
      .spyOn(MockFsModule, 'writeTextFile')
      .mockImplementation(async (path, text) => {
        if (path.includes('/.waypoint/project-memory/')) {
          throw new Error('project memory projection unavailable');
        }
        await originalWrite(path, text);
      });

    try {
      const result = await createSavedResidueSelectionArtifact({
        workspaceRoot: '/lab',
        document,
      });

      expect(JSON.parse(getMockFileContent(result.path) ?? '{}')).toEqual(document);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          stage: 'project-memory',
          error: 'project memory projection unavailable',
        }),
      ]);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('writes an appended revision to the same artifact without changing old revision bytes', async () => {
    const original = selectionDocument();
    const created = await createSavedResidueSelectionArtifact({
      workspaceRoot: '/lab',
      document: original,
    });
    const next = appendSavedResidueSelectionRevision(original, {
      revisionId: 'selection-revision-2',
      createdAt: '2026-07-14T13:00:00.000Z',
      actor: { kind: 'user' },
      reason: 'Rename and add a residue',
      name: 'Catalytic plus gate',
      members: [
        {
          ...original.revisions[0].members[0],
          selection: {
            ...original.revisions[0].members[0].selection,
            target: {
              ...original.revisions[0].members[0].selection.target,
              intervals: [
                ...original.revisions[0].members[0].selection.target.intervals,
                { start: 250, end: 250 },
              ],
            },
          },
        },
      ],
    });

    await writeSavedResidueSelectionArtifactRevision({
      workspaceRoot: '/lab',
      path: created.path,
      document: next,
    });

    const persisted = JSON.parse(getMockFileContent(created.path) ?? '{}');
    expect(persisted.currentRevisionId).toBe('selection-revision-2');
    expect(persisted.revisions).toHaveLength(2);
    expect(persisted.revisions[0]).toEqual(original.revisions[0]);
    expect(await getCatalogEventsForEntity(original.id)).toEqual([
      expect.objectContaining({ event_type: 'artifact_created' }),
      expect.objectContaining({
        event_type: 'artifact_updated',
        payload: expect.stringContaining('selection-revision-2'),
      }),
    ]);
  });

  it('serializes concurrent appends and rejects the stale candidate instead of overwriting', async () => {
    const original = selectionDocument();
    const created = await createSavedResidueSelectionArtifact({
      workspaceRoot: '/lab',
      document: original,
    });
    const firstCandidate = appendSavedResidueSelectionRevision(original, {
      revisionId: 'selection-revision-2-first',
      createdAt: '2026-07-14T13:00:00.000Z',
      actor: { kind: 'user' },
      members: original.revisions[0].members,
    });
    const staleCandidate = appendSavedResidueSelectionRevision(original, {
      revisionId: 'selection-revision-2-stale',
      createdAt: '2026-07-14T13:00:01.000Z',
      actor: { kind: 'agent', id: 'codex' },
      members: original.revisions[0].members,
    });

    const results = await Promise.allSettled([
      writeSavedResidueSelectionArtifactRevision({
        workspaceRoot: '/lab',
        path: created.path,
        document: firstCandidate,
      }),
      writeSavedResidueSelectionArtifactRevision({
        workspaceRoot: '/lab',
        path: created.path,
        document: staleCandidate,
      }),
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toEqual({
      status: 'rejected',
      reason: expect.objectContaining({
        message: expect.stringContaining('stale'),
      }),
    });
    expect(JSON.parse(getMockFileContent(created.path) ?? '{}')).toEqual(firstCandidate);
  });

  it('repairs a deleted catalog from the embedded stable selection id', async () => {
    const document = selectionDocument();
    const path = '/lab/Selections/Recovered.wpselection.json';
    setMockFileContent(path, `${JSON.stringify(document, null, 2)}\n`);

    const resolved = await resolveSavedResidueSelectionArtifact({
      workspaceRoot: '/lab',
      path,
    });

    expect(resolved.selection).toEqual(document);
    expect(resolved.entity).toMatchObject({ id: document.id, type: 'selection' });
    expect(await getCatalogFilesForEntity(document.id)).toEqual([
      expect.objectContaining({
        path,
        file_kind: 'waypoint-residue-selection',
        status: 'current',
      }),
    ]);
  });
});
