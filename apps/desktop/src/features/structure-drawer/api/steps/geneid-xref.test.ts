// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { extractGeneIdXref, geneIdStep } from './geneid-xref';
import { callBody, sidecarAfdbHit, sidecarSearchHit } from '../__tests__/sidecar-mocks';

describe('extractGeneIdXref', () => {
  it('extracts the GeneID from a matching xref', () => {
    expect(extractGeneIdXref(['GeneID:944742'])).toBe('944742');
  });

  it('returns null when no GeneID xref is present', () => {
    expect(extractGeneIdXref(['UniProtKB:P00000', 'PDB:1TUP'])).toBeNull();
  });
});

describe('geneIdStep', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('queries xref:geneid-{id} on hit', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sidecarSearchHit('P0AD86'))
      .mockResolvedValueOnce(sidecarAfdbHit('P0AD86'));

    const result = await geneIdStep.resolve(
      'M',
      { dbXrefs: ['GeneID:944742'] },
      new AbortController().signal
    );

    expect(callBody(fetchSpy, 0).query).toContain('xref:geneid-944742');
    expect(result?.source).toBe('geneid_xref');
  });
});
