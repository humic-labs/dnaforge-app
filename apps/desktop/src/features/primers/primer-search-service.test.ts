import { userMessage } from '@waypoint/user-messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HostedSignUpRequiredError } from '../../hosted/capabilities';
import { findBindingCandidates, hitsOverlapRegion, type BindingHit } from './primer-search-service';

const { startOperation, waitForResult } = vi.hoisted(() => ({
  startOperation: vi.fn(),
  waitForResult: vi.fn(),
}));

const mockSelect = vi.fn();
vi.mock('../../platform', () => ({
  platform: () => ({ db: { execute: vi.fn(), select: mockSelect } }),
}));
vi.mock('./auto-numbering', () => ({
  generateCatalogNumber: vi.fn().mockResolvedValue('P001'),
}));
vi.mock('../../shared/primer-thermodynamics/tm-calculator', () => ({
  calculateTmNN: vi.fn().mockReturnValue(58.4),
  calculateGcContent: vi.fn().mockReturnValue(50),
}));
vi.mock('./primer-library-search-operation-client', () => ({
  startPrimerLibrarySearchOperation: startOperation,
  waitForPrimerLibrarySearchResult: waitForResult,
}));

function mockPrimerRow(overrides?: Record<string, unknown>) {
  return {
    id: 'primer-1',
    catalog_number: 'P001',
    name: 'Test F1',
    sequence: 'primer-one',
    length: 10,
    tm: 58.4,
    gc_percent: 50,
    origin: 'manual',
    origin_details: null,
    status: 'designed',
    vendor: null,
    order_date: null,
    application: null,
    scale: null,
    purification: null,
    modifications: null,
    stock_location: null,
    concentration: null,
    notes: null,
    workspace_id: 1,
    created_at: 10,
    updated_at: 20,
    ...overrides,
  };
}

function managedResult(results: Array<{ primerId: string; hits: unknown[] }>) {
  return {
    targetRevision: `primer-search-target-v1:sha256:${'0'.repeat(64)}`,
    libraryRevision: `primer-library-v1:sha256:${'1'.repeat(64)}`,
    results,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  startOperation.mockResolvedValue({ id: 'operation-a' });
  waitForResult.mockResolvedValue(managedResult([]));
});

describe('hitsOverlapRegion', () => {
  const hit = (start: number, end: number): BindingHit =>
    ({ start, end, strand: 1, identity: 1, editDistance: 0 }) as BindingHit;

  it('keeps normal hits that overlap the region', () => {
    const hits = [hit(100, 120), hit(500, 520), hit(115, 135)];
    expect(hitsOverlapRegion(hits, 110, 130).map((value) => value.start)).toEqual([100, 115]);
  });

  it('handles origin-spanning hits', () => {
    const wrapped = hit(4990, 10);
    expect(hitsOverlapRegion([wrapped], 4980, 5000)).toHaveLength(1);
    expect(hitsOverlapRegion([wrapped], 0, 50)).toHaveLength(1);
    expect(hitsOverlapRegion([wrapped], 100, 200)).toHaveLength(0);
  });
});

describe('findBindingCandidates', () => {
  it('submits the exact target and an ordered, revision-bound primer snapshot', async () => {
    mockSelect.mockResolvedValueOnce([
      mockPrimerRow({ id: 'primer-b', sequence: 'primer-two', updated_at: 22 }),
      mockPrimerRow({ id: 'primer-a', sequence: 'primer-one', updated_at: 11 }),
    ]);
    mockSelect.mockResolvedValueOnce([]);
    waitForResult.mockResolvedValueOnce(
      managedResult([
        {
          primerId: 'primer-a',
          hits: [{ start: 100, end: 110, strand: 1, identity: 1, edit_distance: 0 }],
        },
        { primerId: 'primer-b', hits: [] },
      ])
    );

    const admitted = vi.fn();
    const results = await findBindingCandidates({
      sequenceId: 42,
      onOperationAdmitted: admitted,
      targetDocumentId: 'document-a',
      targetFilePath: '/hosted/workspace-a/sequences/a/a.gb',
      referenceSequence: 'target-sequence',
      circular: true,
    });

    expect(startOperation).toHaveBeenCalledWith(
      {
        targetDocumentId: 'document-a',
        referenceSequence: 'target-sequence',
        circular: true,
        primers: [
          { id: 'primer-a', sequence: 'primer-one', revision: 'updated-at:11' },
          { id: 'primer-b', sequence: 'primer-two', revision: 'updated-at:22' },
        ],
        maxEditDistance: 3,
        minMatchLength: 0,
        minEffectiveTm: 0,
        maxMismatches: 10,
      },
      [{ key: 'target', path: '/hosted/workspace-a/sequences/a/a.gb' }]
    );
    expect(waitForResult).toHaveBeenCalledWith('operation-a', {});
    expect(admitted).toHaveBeenCalledExactlyOnceWith('operation-a');
    expect(results).toHaveLength(1);
    expect(results[0].primer.id).toBe('primer-a');
  });

  it('passes region constraints while retaining the full target identity', async () => {
    mockSelect.mockResolvedValueOnce([mockPrimerRow({ id: 'primer-a' })]);
    mockSelect.mockResolvedValueOnce([]);
    waitForResult.mockResolvedValueOnce(
      managedResult([
        {
          primerId: 'primer-a',
          hits: [{ start: 95, end: 105, strand: 1, identity: 1, edit_distance: 0 }],
        },
      ])
    );

    const results = await findBindingCandidates({
      sequenceId: 42,
      targetDocumentId: 'document-a',
      referenceSequence: 'full-target-sequence',
      circular: true,
      regionStart: 90,
      regionEnd: 130,
    });

    expect(startOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceSequence: 'full-target-sequence',
        circular: true,
        regionStart: 90,
        regionEnd: 130,
      }),
      []
    );
    expect(results[0].bestHit?.start).toBe(95);
  });

  it('marks already-attached primers', async () => {
    mockSelect.mockResolvedValueOnce([mockPrimerRow({ id: 'primer-a' })]);
    mockSelect.mockResolvedValueOnce([
      {
        ...mockPrimerRow({ id: 'primer-a' }),
        binding_id: 'binding-a',
        binding_start: 100,
        binding_end: 110,
        strand: 1,
        source: 'manual',
        binding_created_at: 1,
        binding_updated_at: 1,
      },
    ]);
    waitForResult.mockResolvedValueOnce(
      managedResult([
        {
          primerId: 'primer-a',
          hits: [{ start: 100, end: 110, strand: 1, identity: 1, edit_distance: 0 }],
        },
      ])
    );

    const results = await findBindingCandidates({
      sequenceId: 42,
      referenceSequence: 'target-sequence',
      circular: false,
    });

    expect(results[0].isAttached).toBe(true);
    expect(results[0].existingBindingId).toBe('binding-a');
  });

  it('sorts retained matches by effective Tm', async () => {
    mockSelect.mockResolvedValueOnce([
      mockPrimerRow({ id: 'primer-a', name: 'Low match' }),
      mockPrimerRow({ id: 'primer-b', name: 'High match' }),
    ]);
    mockSelect.mockResolvedValueOnce([]);
    waitForResult.mockResolvedValueOnce(
      managedResult([
        {
          primerId: 'primer-a',
          hits: [{ start: 100, end: 110, strand: 1, identity: 0.9, effective_tm: 45 }],
        },
        {
          primerId: 'primer-b',
          hits: [{ start: 200, end: 210, strand: 1, identity: 1, effective_tm: 55 }],
        },
      ])
    );

    const results = await findBindingCandidates({
      sequenceId: 42,
      referenceSequence: 'target-sequence',
      circular: false,
    });

    expect(results.map((result) => result.primer.name)).toEqual(['High match', 'Low match']);
  });

  it('forwards caller detachment without requesting operation cancellation', async () => {
    mockSelect.mockResolvedValueOnce([mockPrimerRow({ id: 'primer-a' })]);
    mockSelect.mockResolvedValueOnce([]);
    const controller = new AbortController();

    await findBindingCandidates({
      sequenceId: 42,
      referenceSequence: 'target-sequence',
      circular: false,
      signal: controller.signal,
    });

    expect(waitForResult).toHaveBeenCalledWith('operation-a', { signal: controller.signal });
  });

  it('surfaces a managed operation failure as a retryable search error', async () => {
    mockSelect.mockResolvedValueOnce([mockPrimerRow({ id: 'primer-a' })]);
    mockSelect.mockResolvedValueOnce([]);
    waitForResult.mockRejectedValueOnce(new Error('operation failed'));

    await expect(
      findBindingCandidates({
        sequenceId: 42,
        referenceSequence: 'target-sequence',
        circular: false,
      })
    ).rejects.toThrow('Could not complete the managed primer search');
  });

  it('keeps the demo sign-up prompt instead of reporting a matcher failure', async () => {
    mockSelect.mockResolvedValueOnce([mockPrimerRow({ id: 'primer-a' })]);
    mockSelect.mockResolvedValueOnce([]);
    startOperation.mockRejectedValueOnce(
      new HostedSignUpRequiredError(userMessage('guidance.sign-up-to-run-this'))
    );

    const search = findBindingCandidates({
      sequenceId: 42,
      referenceSequence: 'target-sequence',
      circular: false,
    });

    await expect(search).rejects.toBeInstanceOf(HostedSignUpRequiredError);
    await expect(search).rejects.toThrow('Sign up to run this');
  });
});
