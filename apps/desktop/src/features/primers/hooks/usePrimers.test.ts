import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePrimers } from './usePrimers';
import { buildPrimerArtifact, serializePrimerArtifact } from '../primer-artifact';
import type { BoundPrimer, Primer } from '../types';
import type { DBCatalogEntityFile } from '../../../db/workspace-catalog';
import type { SavedPrimerArtifact } from '../primer-artifact-service';

vi.mock('../primer-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../primer-service')>();
  return {
    ...actual,
    listBoundPrimers: vi.fn(),
    updatePrimer: vi.fn(),
    deletePrimer: vi.fn(),
    deleteBinding: vi.fn(),
  };
});
vi.mock('../primer-artifact-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../primer-artifact-service')>();
  return {
    ...actual,
    isFileAuthoritativePrimerInput: vi.fn(
      (input: { requireRegistry?: boolean; artifactPath?: string; workspaceRoot?: string }) =>
        input.requireRegistry === true &&
        typeof input.artifactPath === 'string' &&
        typeof input.workspaceRoot === 'string'
    ),
    primerArtifactRelativePath: vi.fn((primer: { originDetails?: Record<string, unknown> }) =>
      primer.originDetails?.authority === 'primer_artifact'
        ? (primer.originDetails.artifactPath as string)
        : null
    ),
    detachPrimerArtifact: vi.fn(),
    updatePrimerArtifactContent: vi.fn(),
    deletePrimerArtifact: vi.fn(),
    readPrimerArtifactForPrimer: vi.fn(),
  };
});
vi.mock('../record-primers', () => ({
  recordPrimers: vi.fn(),
}));

import { initPlatform, platform } from '../../../platform';
import { primerServices } from '../primer-services';
import { listBoundPrimers } from '../primer-service';
import { detachPrimerArtifact } from '../primer-artifact-service';
import { recordPrimers } from '../record-primers';
import { notifyPrimerBindingsChanged } from '../primer-binding-events';

const mockListBoundPrimers = vi.mocked(listBoundPrimers);
const mockRecordPrimers = vi.mocked(recordPrimers);
const mockDetachPrimerArtifact = vi.mocked(detachPrimerArtifact);

function primerFixture(overrides: Partial<Primer> = {}): Primer {
  const sequence = overrides.sequence ?? 'ATCG';
  return {
    id: '1',
    catalogNumber: 'P001',
    name: 'Test',
    sequence,
    length: sequence.length,
    tm: null,
    gcPercent: 50,
    origin: 'manual',
    originDetails: null,
    status: 'designed',
    vendor: null,
    orderDate: null,
    application: null,
    scale: null,
    purification: null,
    modifications: null,
    stockLocation: null,
    concentration: null,
    notes: null,
    workspaceId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function boundPrimerFixture(overrides: Partial<BoundPrimer> = {}): BoundPrimer {
  return {
    ...primerFixture(),
    binding: {
      id: 'b1',
      primerId: overrides.id ?? '1',
      sequenceId: 42,
      bindingStart: 100,
      bindingEnd: 120,
      strand: 1,
      source: 'manual',
      createdAt: 0,
      updatedAt: 0,
    },
    ...overrides,
  };
}

function catalogFileFixture(workspaceId: number): DBCatalogEntityFile {
  return {
    id: 'primer-file',
    entity_id: '1',
    workspace_id: workspaceId,
    path: '/workspace/primers/Fixture.primer.json',
    relative_path: 'primers/Fixture.primer.json',
    file_kind: 'primer-artifact',
    content_hash: null,
    sequence_fingerprint: null,
    object_uuid: null,
    size_bytes: null,
    modified_at: null,
    status: 'current',
    last_seen_at: null,
    missing_since: null,
    created_at: 0,
    updated_at: 0,
  };
}

async function savedPrimerFixture(): Promise<SavedPrimerArtifact> {
  const artifactPath = '/workspace/primers/Fixture.primer.json';
  const artifact = await buildPrimerArtifact({
    id: '550e8400-e29b-41d4-a716-446655440076',
    catalogNumber: 'P001',
    name: 'Fixture',
    sequence: 'ATCGATCGATCGATCGATCG',
    workspaceRoot: '/workspace',
    artifactPath,
  });
  return {
    artifactPath,
    artifact,
    limsEntity: {
      id: artifact.registry.entityId,
      kind: 'oligo',
      schemaId: null,
      schemaRevisionId: 'oligo-v1',
      name: artifact.name,
      registryId: null,
      fields: {},
      registrationStatus: 'registered',
      domainStatus: null,
      workspaceId: null,
      actor: null,
      eventSeq: null,
      tombstone: false,
      createdAt: 0,
      updatedAt: 0,
      archivedAt: null,
    },
    primer: primerFixture({
      id: artifact.id,
      name: artifact.name,
      sequence: artifact.sequence.bases,
    }),
    gitCommitted: true,
    created: true,
  };
}

describe('usePrimers', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await initPlatform();
    vi.clearAllMocks();
    mockListBoundPrimers.mockResolvedValue([]);
  });

  it('publishes a canonical update through its durable owning project and current artifact revision', async () => {
    const fixture = await savedPrimerFixture();
    const primer = primerFixture({
      id: fixture.artifact.id,
      name: fixture.artifact.name,
      sequence: fixture.artifact.sequence.bases,
      originDetails: {
        authority: 'primer_artifact',
        artifactPath: fixture.artifact.file.workspaceRelativePath,
      },
    });
    const ownerId = await platform().db.ensureWorkspaceOwner('/owner-update');
    vi.spyOn(primerServices.persistence, 'getPrimer').mockResolvedValue(primer);
    vi.spyOn(primerServices.persistence, 'getCatalogFile').mockResolvedValue(
      catalogFileFixture(ownerId)
    );
    vi.spyOn(primerServices.persistence, 'readArtifact').mockResolvedValue({
      path: '/owner-update/Fixture.primer.json',
      artifact: fixture.artifact,
      content: serializePrimerArtifact(fixture.artifact),
      resolvedBindings: [],
    });
    vi.spyOn(primerServices.persistence, 'updateArtifactContent').mockResolvedValue({
      ...fixture,
      primer: { ...primer, name: 'Updated' },
    });
    const legacy = vi.spyOn(primerServices.persistence, 'updateLegacyPrimer');
    const { result } = renderHook(() => usePrimers(null, '/different-target-project'));
    await act(async () => {
      await result.current.update({ id: primer.id, name: 'Updated' });
    });
    expect(primerServices.persistence.updateArtifactContent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: '/owner-update',
        expectedArtifactRevision: fixture.artifact.artifactRevision,
        name: 'Updated',
      })
    );
    expect(legacy).not.toHaveBeenCalled();
  });

  it('retires a canonical primer through its file lifecycle instead of deleting its compatibility row', async () => {
    const fixture = await savedPrimerFixture();
    const primer = primerFixture({
      id: fixture.artifact.id,
      originDetails: {
        authority: 'primer_artifact',
        artifactPath: fixture.artifact.file.workspaceRelativePath,
      },
    });
    const ownerId = await platform().db.ensureWorkspaceOwner('/owner-delete');
    vi.spyOn(primerServices.persistence, 'getPrimer').mockResolvedValue(primer);
    vi.spyOn(primerServices.persistence, 'getCatalogFile').mockResolvedValue(
      catalogFileFixture(ownerId)
    );
    vi.spyOn(primerServices.persistence, 'readArtifact').mockResolvedValue({
      path: '/owner-delete/Fixture.primer.json',
      artifact: fixture.artifact,
      content: serializePrimerArtifact(fixture.artifact),
      resolvedBindings: [],
    });
    vi.spyOn(primerServices.persistence, 'deleteArtifact').mockResolvedValue({
      deleted: true,
      gitCommitted: true,
    });
    const legacy = vi.spyOn(primerServices.persistence, 'deleteLegacyPrimer');
    const { result } = renderHook(() => usePrimers(null, '/different-target-project'));
    await act(async () => {
      await result.current.delete(primer.id);
    });
    expect(primerServices.persistence.deleteArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        primer,
        workspaceRoot: '/owner-delete',
        expectedArtifactRevision: fixture.artifact.artifactRevision,
      })
    );
    expect(legacy).not.toHaveBeenCalled();
  });

  it('loads primers on mount when sequenceId is provided', async () => {
    mockListBoundPrimers.mockResolvedValueOnce([boundPrimerFixture()]);
    const { result } = renderHook(() => usePrimers(42));
    await waitFor(() => {
      expect(result.current.primers).toHaveLength(1);
    });
    expect(mockListBoundPrimers).toHaveBeenCalledWith(42);
  });

  it('reloads only the affected visible sequence after an agent binding mutation', async () => {
    mockListBoundPrimers.mockResolvedValue([]);
    renderHook(() => usePrimers(42));
    renderHook(() => usePrimers(99));
    await waitFor(() => expect(mockListBoundPrimers).toHaveBeenCalledTimes(2));
    mockListBoundPrimers.mockClear();

    act(() => notifyPrimerBindingsChanged(42));

    await waitFor(() => expect(mockListBoundPrimers).toHaveBeenCalledTimes(1));
    expect(mockListBoundPrimers).toHaveBeenCalledWith(42);
  });

  it('exposes error when load fails', async () => {
    mockListBoundPrimers.mockRejectedValueOnce(new Error('DB error'));
    const { result } = renderHook(() => usePrimers(42));
    await waitFor(() => {
      expect(result.current.error).toBeTruthy();
    });
    expect(result.current.error?.message).toBe('DB error');
  });

  it('clears primers and error when sequenceId is null', async () => {
    const { result } = renderHook(() => usePrimers(null));
    expect(result.current.primers).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('clears error on successful reload', async () => {
    mockListBoundPrimers.mockRejectedValueOnce(new Error('DB error'));
    const { result } = renderHook(({ seqId }) => usePrimers(seqId), {
      initialProps: { seqId: 42 as number | null },
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());

    mockListBoundPrimers.mockResolvedValueOnce([]);
    await act(async () => {
      await result.current.reload();
    });
    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
  });

  it('detach removes binding from state', async () => {
    const { deleteBinding } = await import('../primer-service');
    const mockDeleteBinding = vi.mocked(deleteBinding);
    mockDeleteBinding.mockResolvedValueOnce(undefined);

    const primer = boundPrimerFixture();
    mockListBoundPrimers.mockResolvedValueOnce([primer]);

    const { result } = renderHook(() => usePrimers(42));
    await waitFor(() => expect(result.current.primers).toHaveLength(1));

    await act(async () => {
      await result.current.detach('b1');
    });
    await waitFor(() => expect(result.current.primers).toHaveLength(0));
    expect(mockDeleteBinding).toHaveBeenCalledWith('b1');
  });

  it('records a standalone file-backed primer through the seam without inventing a partial binding', async () => {
    mockRecordPrimers.mockResolvedValue({
      recorded: [await savedPrimerFixture()],
      skipped: [],
      failed: [],
    });
    const { result } = renderHook(() => usePrimers(null));
    const input = {
      name: 'Library_F1',
      sequence: 'ATCGATCGATCGATCGATCG',
      artifactPath: '/workspace/primers/Library_F1.primer.json',
      workspaceRoot: '/workspace',
      requireRegistry: true as const,
    };

    await act(async () => {
      await result.current.create(input);
    });

    expect(mockRecordPrimers).toHaveBeenCalledWith(
      expect.objectContaining({
        primers: [
          expect.objectContaining({
            name: 'Library_F1',
            sequence: 'ATCGATCGATCGATCGATCG',
            artifactPath: '/workspace/primers/Library_F1.primer.json',
          }),
        ],
        workspaceRoot: '/workspace',
        origin: 'manual',
        deferCommit: false,
      })
    );

    expect(mockRecordPrimers.mock.calls[0][0].primers[0].binding).toBeUndefined();
    expect(mockListBoundPrimers).not.toHaveBeenCalled();
  });

  it('routes a drag-selection primer through the seam WITH its sequence binding', async () => {
    mockRecordPrimers.mockResolvedValue({
      recorded: [await savedPrimerFixture()],
      skipped: [],
      failed: [],
    });
    const { result } = renderHook(() => usePrimers(42));
    await waitFor(() => expect(mockListBoundPrimers).toHaveBeenCalledWith(42));

    await act(async () => {
      await result.current.create({
        name: 'Bound_R1',
        sequence: 'ATCGATCGATCGATCGATCG',
        artifactPath: '/workspace/primers/Bound_R1.primer.json',
        workspaceRoot: '/workspace',
        requireRegistry: true as const,
        targetDocumentId: 'sequence-puc19',
        targetFilePath: '/workspace/pUC19.gb',
        targetLength: 2686,
        targetTopology: 'circular' as const,
        bindingSequenceId: 42,
        bindingStart: 100,
        bindingEnd: 120,
        bindingStrand: -1 as const,
      });
    });

    expect(mockRecordPrimers.mock.calls[0][0].primers[0].binding).toEqual({
      targetDocumentId: 'sequence-puc19',
      targetFilePath: '/workspace/pUC19.gb',
      targetLength: 2686,
      targetTopology: 'circular',
      bindingSequenceId: 42,
      bindingStart: 100,
      bindingEnd: 120,
      bindingStrand: -1,
    });
  });

  it('rejects a PARTIAL binding instead of silently dropping it (defense-in-depth guard preserved)', async () => {
    mockRecordPrimers.mockResolvedValue({
      recorded: [await savedPrimerFixture()],
      skipped: [],
      failed: [],
    });
    const { result } = renderHook(() => usePrimers(42));
    await waitFor(() => expect(mockListBoundPrimers).toHaveBeenCalledWith(42));

    await expect(
      result.current.create({
        name: 'Partial_1',
        sequence: 'ATCGATCGATCGATCGATCG',
        artifactPath: '/workspace/primers/Partial_1.primer.json',
        workspaceRoot: '/workspace',
        requireRegistry: true as const,
        targetFilePath: '/workspace/pUC19.gb',
      })
    ).rejects.toThrow(/binding metadata is incomplete/i);
    expect(mockRecordPrimers).not.toHaveBeenCalled();
  });

  it('re-throws a recording failure so the drawer form can surface it', async () => {
    mockRecordPrimers.mockResolvedValue({
      recorded: [],
      skipped: [],
      failed: [
        {
          input: { name: 'Dup', sequence: 'ATCG' },
          reason: 'path-collision',
          message: 'A different primer artifact already exists there. Choose a new file name.',
        },
      ],
    });
    const { result } = renderHook(() => usePrimers(42));
    await waitFor(() => expect(mockListBoundPrimers).toHaveBeenCalledWith(42));

    await expect(
      result.current.create({
        name: 'Dup',
        sequence: 'ATCGATCGATCGATCGATCG',
        artifactPath: '/workspace/primers/Dup.primer.json',
        workspaceRoot: '/workspace',
        requireRegistry: true as const,
      })
    ).rejects.toThrow('A different primer artifact already exists there.');
  });

  it('detaches an artifact-backed relationship by revising the file authority', async () => {
    const primer = boundPrimerFixture({
      id: 'artifact-primer',
      name: 'Artifact primer',
      originDetails: {
        authority: 'primer_artifact',
        artifactPath: 'primers/Artifact.primer.json',
      },
      binding: {
        ...boundPrimerFixture().binding,
        id: 'artifact-binding',
        primerId: 'artifact-primer',
        bindingStart: 1,
        bindingEnd: 21,
      },
    });
    mockListBoundPrimers.mockResolvedValueOnce([primer]);
    mockDetachPrimerArtifact.mockResolvedValueOnce(await savedPrimerFixture());
    const { deleteBinding } = await import('../primer-service');
    const { result } = renderHook(() => usePrimers(42, '/workspace'));
    await waitFor(() => expect(result.current.primers).toHaveLength(1));

    await act(async () => result.current.detach('artifact-binding'));

    expect(mockDetachPrimerArtifact).toHaveBeenCalledWith({
      primer,
      workspaceRoot: '/workspace',
      bindingId: 'artifact-binding',
    });
    expect(deleteBinding).not.toHaveBeenCalled();
  });
});
