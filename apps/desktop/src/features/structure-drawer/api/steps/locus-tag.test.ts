// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { locusTagStep } from './locus-tag';
import { callBody, sidecarAfdbHit, sidecarSearchHit } from '../__tests__/sidecar-mocks';

describe('locusTagStep', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('requires both locusTag AND taxonId', () => {
    expect(locusTagStep.hintsRequired).toEqual(['locusTag', 'taxonId']);
  });

  it('skips when taxonId is missing (would otherwise match all organisms)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await locusTagStep.resolve(
      'M',
      { locusTag: 'b0001' },
      new AbortController().signal
    );
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('builds the gene_oln + organism_id query', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sidecarSearchHit('P0AD86'))
      .mockResolvedValueOnce(sidecarAfdbHit('P0AD86'));

    const result = await locusTagStep.resolve(
      'M',
      { locusTag: 'b0001', taxonId: 83333 },
      new AbortController().signal
    );

    expect(callBody(fetchSpy, 0).query).toContain('gene_oln:b0001 AND organism_id:83333');
    expect(result?.source).toBe('locus_tag');
    expect(result?.identity).toBe(1);
  });
});
