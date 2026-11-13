// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { extractRefSeqXref, refSeqStep } from './refseq-xref';
import { callBody, sidecarAfdbHit, sidecarSearchHit } from '../__tests__/sidecar-mocks';

describe('extractRefSeqXref', () => {
  it('returns null for missing / empty xrefs', () => {
    expect(extractRefSeqXref(undefined)).toBeNull();
    expect(extractRefSeqXref([])).toBeNull();
  });

  it('extracts the RefSeq id from a matching xref', () => {
    expect(extractRefSeqXref(['RefSeq:NP_414543.1'])).toBe('NP_414543.1');
  });

  it('skips non-RefSeq xrefs', () => {
    expect(extractRefSeqXref(['UniProtKB:P00000', 'PDB:1TUP'])).toBeNull();
  });
});

describe('refSeqStep', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('queries xref:refseq-{id} when a RefSeq xref is present', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sidecarSearchHit('P0AD86'))
      .mockResolvedValueOnce(sidecarAfdbHit('P0AD86'));

    const result = await refSeqStep.resolve(
      'M',
      { dbXrefs: ['RefSeq:NP_414543.1'] },
      new AbortController().signal
    );

    expect(callBody(fetchSpy, 0).query).toContain('xref:refseq-NP_414543.1');
    expect(result?.source).toBe('refseq_xref');
  });

  it('returns null when no RefSeq xref is present', async () => {
    const result = await refSeqStep.resolve(
      'M',
      { dbXrefs: ['UniProtKB:P00000'] },
      new AbortController().signal
    );
    expect(result).toBeNull();
  });
});
