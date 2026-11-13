// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { geneOrganismStep } from './gene-organism';
import { sidecarAfdbHit, sidecarSearchHit } from '../__tests__/sidecar-mocks';

describe('geneOrganismStep', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('requires both geneName AND taxonId', () => {
    expect(geneOrganismStep.hintsRequired).toEqual(['geneName', 'taxonId']);
  });

  it('skips when taxonId is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await geneOrganismStep.resolve(
      '',
      { geneName: 'thrL' },
      new AbortController().signal
    );
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips sequence-attached CDS requests instead of blind gene-name rescue', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await geneOrganismStep.resolve(
      'MAINFSPKVGEILECNFGNYPVSQ',
      { geneName: 'yifN', taxonId: 83333 },
      new AbortController().signal
    );

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('downgrades lookup-only identity to the conservative floor (0.95)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sidecarSearchHit('P0AD86'))
      .mockResolvedValueOnce(sidecarAfdbHit('P0AD86'));

    const result = await geneOrganismStep.resolve(
      '',
      { geneName: 'thrL', taxonId: 83333 },
      new AbortController().signal
    );

    expect(result?.source).toBe('gene_organism');
    expect(result?.identity).toBe(0.95);
    expect(result?.confidenceNote).toContain('≥95%');
  });
});
