// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { extractUniProtAccessions, uniprotXrefStep } from './uniprot-xref';
import '../__tests__/sidecar-mocks';

describe('extractUniProtAccessions', () => {
  it('returns empty for missing / empty xrefs', () => {
    expect(extractUniProtAccessions(undefined)).toEqual([]);
    expect(extractUniProtAccessions([])).toEqual([]);
  });

  it('matches all four UniProt prefix flavors', () => {
    expect(
      extractUniProtAccessions([
        'UniProtKB/Swiss-Prot:P0AD86',
        'UniProtKB/TrEMBL:Q9XYZ1',
        'UniProtKB:P00000',
        'UniProt:P11111',
      ])
    ).toEqual(['P0AD86', 'Q9XYZ1', 'P00000', 'P11111']);
  });

  it('uppercases accessions', () => {
    expect(extractUniProtAccessions(['UniProtKB/Swiss-Prot:p0ad86'])).toEqual(['P0AD86']);
  });

  it('skips non-UniProt xrefs', () => {
    expect(extractUniProtAccessions(['PDB:1TUP', 'GeneID:944742'])).toEqual([]);
  });

  it('does not double-count when multiple prefixes match the same xref', () => {
    expect(extractUniProtAccessions(['UniProtKB/Swiss-Prot:P0AD86'])).toEqual(['P0AD86']);
  });
});

describe('uniprotXrefStep', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when no UniProt xref is present', async () => {
    const result = await uniprotXrefStep.resolve(
      'M',
      { dbXrefs: ['PDB:1TUP'] },
      new AbortController().signal
    );
    expect(result).toBeNull();
  });

  it('returns a UniProt StructureRef when AFDB validates', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ accession: 'P0AD86', mean_plddt: 78.4, exists: true }))
    );

    const result = await uniprotXrefStep.resolve(
      'M',
      { dbXrefs: ['UniProtKB/Swiss-Prot:P0AD86'] },
      new AbortController().signal
    );

    expect(result?.source).toBe('uniprot_xref');
    expect(result?.structure).toEqual({
      kind: 'uniprot',
      accession: 'P0AD86',
      providerIdentityKey: 'AF:P0AD86:F1:LATEST',
      fragment: 'F1',
      version: 'LATEST',
      modelId: undefined,
    });
    expect(result?.recommendedCandidateId).toBe('alphafold:AF:P0AD86:F1:LATEST:all');
    expect(result?.candidates?.[0]).toMatchObject({
      provider: 'alphafold',
      provenance: {
        resolverSource: 'uniprot_xref',
        structureIdentity: { providerIdentityKey: 'AF:P0AD86:F1:LATEST' },
      },
    });
    expect(result?.identity).toBe(1);
    expect(result?.confidenceNote).toContain('78.4');
  });

  it('falls through to the next candidate when the first is missing in AFDB', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accession: null, mean_plddt: null, exists: false }))
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accession: 'P00002', mean_plddt: 92.1, exists: true }))
      );

    const result = await uniprotXrefStep.resolve(
      'M',
      { dbXrefs: ['UniProtKB:P00001', 'UniProtKB:P00002'] },
      new AbortController().signal
    );
    expect(result?.structure).toMatchObject({ kind: 'uniprot', accession: 'P00002' });
  });

  it('returns null when every candidate misses AFDB', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ accession: null, mean_plddt: null, exists: false }))
    );
    const result = await uniprotXrefStep.resolve(
      'M',
      { dbXrefs: ['UniProtKB:P00001', 'UniProtKB:P00002'] },
      new AbortController().signal
    );
    expect(result).toBeNull();
  });

  it('propagates AFDB provider outages instead of falling through as a miss', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { error: 'provider_error' } }), { status: 502 })
    );

    await expect(
      uniprotXrefStep.resolve('M', { dbXrefs: ['UniProtKB:P03817'] }, new AbortController().signal)
    ).rejects.toMatchObject({ name: 'SidecarProviderError' });
  });

  it('honors the AbortSignal mid-validation', async () => {
    const controller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          const rejectAbort = (): void => {
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          };
          if (signal?.aborted) {
            rejectAbort();
          } else {
            signal?.addEventListener('abort', rejectAbort, { once: true });
          }
        })
    );
    const promise = uniprotXrefStep.resolve(
      'M',
      { dbXrefs: ['UniProtKB:P00001'] },
      controller.signal
    );
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchSpy).toHaveBeenCalled();
  });
});
