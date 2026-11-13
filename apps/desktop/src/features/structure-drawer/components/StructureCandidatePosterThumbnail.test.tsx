import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StructureCandidate } from '../types/structure-drawer';

const posterMocks = vi.hoisted(() => ({
  load: vi.fn(),
  release: vi.fn(),
  resolveBaseUrl: vi.fn(async () => 'http://runtime-sidecar.test.invalid'),
}));

vi.mock('./structure-candidate-poster', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./structure-candidate-poster')>();
  return {
    ...actual,
    loadStructureCandidatePosterObjectUrl: posterMocks.load,
    resolveStructureCandidatePosterBaseUrl: posterMocks.resolveBaseUrl,
  };
});

import { StructureCandidatePosterThumbnail } from './StructureCandidatePosterThumbnail';

const CANDIDATE: StructureCandidate = {
  id: 'alphafold:P00880:all',
  provider: 'alphafold',
  structure: { kind: 'uniprot', accession: 'P00880' },
  label: 'P00880',
  group: 'alphafold',
  rank: 1,
  metadata: { uniprotAccession: 'P00880' },
  provenance: { resolverSource: 'protein_sequence', identity: 1 },
};

afterEach(() => {
  cleanup();
  posterMocks.load.mockReset();
  posterMocks.release.mockReset();
  posterMocks.resolveBaseUrl.mockClear();
});

describe('StructureCandidatePosterThumbnail', () => {
  it('retries a mounted poster after transient capacity overload', async () => {
    const capacityError = new Error('Structure poster request capacity queue is full.');
    capacityError.name = 'StructureCandidatePosterCapacityError';
    posterMocks.load
      .mockRejectedValueOnce(capacityError)
      .mockResolvedValueOnce({ objectUrl: 'blob:retried-poster', release: posterMocks.release });

    const { unmount } = render(<StructureCandidatePosterThumbnail candidate={CANDIDATE} />);

    await waitFor(() => expect(posterMocks.load).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    await waitFor(
      () =>
        expect(screen.getByTestId('structure-candidate-poster-image')).toHaveAttribute(
          'src',
          'blob:retried-poster'
        ),
      { timeout: 1_000 }
    );
    expect(screen.getByTestId('structure-candidate-poster-thumb')).toHaveAttribute(
      'data-poster-status',
      'loaded'
    );

    unmount();
    expect(posterMocks.release).toHaveBeenCalledTimes(1);
  });
});
