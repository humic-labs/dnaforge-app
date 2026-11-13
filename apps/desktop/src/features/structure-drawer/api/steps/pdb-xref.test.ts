// @vitest-environment node

import { afterEach, describe, it, expect, vi } from 'vitest';
import { extractPdbId, extractPdbIds, pdbXrefStep } from './pdb-xref';
import { sidecarAfdbHit } from '../__tests__/sidecar-mocks';
import '../__tests__/sidecar-mocks';

afterEach(() => {
  vi.restoreAllMocks();
});

function rcsbFetchHit(pdbId: string, overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      external_resource_id: `resource-${pdbId}`,
      cache_hit: false,
      license: 'CC0-1.0',
      attribution: `RCSB Protein Data Bank; PDB ID ${pdbId}`,
      metadata: {
        pdb_id: pdbId,
        title: `${pdbId} title`,
        experimental_method: 'X-ray',
        resolution: 2.2,
        chain_count: 2,
        chain_ids: ['A', 'B'],
        provider_url: `https://www.rcsb.org/structure/${pdbId}`,
        ...overrides,
      },
    }),
    { status: 200 }
  );
}

describe('extractPdbId', () => {
  it('returns null for missing or empty xrefs', () => {
    expect(extractPdbId(undefined)).toBeNull();
    expect(extractPdbId([])).toBeNull();
  });

  it('matches PDB: prefix and uppercases the id', () => {
    expect(extractPdbId(['PDB:1tup'])).toBe('1TUP');
  });

  it('matches PDBe: prefix', () => {
    expect(extractPdbId(['PDBe:4xyz'])).toBe('4XYZ');
  });

  it('returns the first PDB xref when multiple are present', () => {
    expect(extractPdbId(['UniProtKB/Swiss-Prot:P00000', 'PDB:1abc', 'PDB:2def'])).toBe('1ABC');
  });

  it('extracts every unique PDB xref for candidate rows', () => {
    expect(
      extractPdbIds(['PDB:2def', 'UniProtKB/Swiss-Prot:P00000', 'PDB:1abc', 'PDBe:2def'])
    ).toEqual(['2DEF', '1ABC']);
  });

  it('ignores malformed PDB xref payloads before they reach the sidecar', () => {
    expect(extractPdbIds(['PDB: see notes', 'PDB:1abcde', 'PDB:1RBL'])).toEqual(['1RBL']);
  });

  it('skips non-PDB xrefs', () => {
    expect(extractPdbId(['UniProtKB:P0AD86', 'GeneID:944742', 'taxon:83333'])).toBeNull();
  });
});

describe('pdbXrefStep', () => {
  it('returns a pdb StructureRef on hit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rcsbFetchHit('1TUP'));

    const result = await pdbXrefStep.resolve(
      'M',
      { dbXrefs: ['PDB:1TUP'] },
      new AbortController().signal
    );
    expect(result?.source).toBe('pdb_xref');
    expect(result?.identity).toBe(1);
    expect(result?.structure).toEqual({
      kind: 'pdb',
      pdbId: '1TUP',
      providerIdentityKey: 'RCSB:1TUP:ENTRY',
    });
    expect(result?.recommendedCandidateId).toBe('rcsb:RCSB:1TUP:ENTRY:all');
    expect(result?.candidates).toMatchObject([
      {
        id: 'rcsb:RCSB:1TUP:ENTRY:all',
        provider: 'pdb',
        group: 'rcsb',
        label: '1TUP',
        structure: { kind: 'pdb', pdbId: '1TUP', providerIdentityKey: 'RCSB:1TUP:ENTRY' },
        metadata: {
          pdbId: '1TUP',
          title: '1TUP title',
          sourceUrl: 'https://www.rcsb.org/structure/1TUP',
        },
        provenance: {
          resolverSource: 'pdb_xref',
          identity: 1,
          externalResourceId: 'resource-1TUP',
          cacheHit: false,
        },
      },
    ]);
  });

  it('returns a ranked candidate set for multiple direct PDB xrefs', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rcsbFetchHit('2DEF', { resolution: 2.8 }))
      .mockResolvedValueOnce(rcsbFetchHit('1ABC', { resolution: 1.9 }));

    const result = await pdbXrefStep.resolve(
      'M',
      { dbXrefs: ['PDB:2DEF', 'PDB:1ABC'] },
      new AbortController().signal
    );

    expect(result?.recommendedCandidateId).toBe('rcsb:RCSB:1ABC:ENTRY:all');
    expect(result?.structure).toEqual({
      kind: 'pdb',
      pdbId: '1ABC',
      providerIdentityKey: 'RCSB:1ABC:ENTRY',
    });
    expect(result?.candidates?.map((row) => row.id)).toEqual([
      'rcsb:RCSB:1ABC:ENTRY:all',
      'rcsb:RCSB:2DEF:ENTRY:all',
    ]);
  });

  it('still returns direct PDB candidates when optional RCSB metadata is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { error: 'provider_error' } }), { status: 502 })
    );

    const result = await pdbXrefStep.resolve(
      'M',
      { dbXrefs: ['PDB:1ABC'] },
      new AbortController().signal
    );

    expect(result?.structure).toEqual({
      kind: 'pdb',
      pdbId: '1ABC',
      providerIdentityKey: 'RCSB:1ABC:ENTRY',
    });
    expect(result?.candidates?.[0].provenance.externalResourceId).toBeUndefined();
  });

  it('keeps AlphaFold alternates when direct PDB and UniProt xrefs are both present', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        sidecarAfdbHit('P00880', 91.4, {
          latestVersion: 6,
          cifUrl: 'https://alphafold.ebi.ac.uk/files/AF-P00880-F1-model_v6.cif',
        })
      )
      .mockResolvedValueOnce(rcsbFetchHit('1RBL'));

    const result = await pdbXrefStep.resolve(
      'M',
      { dbXrefs: ['PDB:1RBL', 'UniProtKB/Swiss-Prot:P00880'] },
      new AbortController().signal
    );

    expect(result?.recommendedCandidateId).toBe('rcsb:RCSB:1RBL:ENTRY:all');
    expect(result?.structure).toEqual({
      kind: 'pdb',
      pdbId: '1RBL',
      providerIdentityKey: 'RCSB:1RBL:ENTRY',
      uniprotFallback: { accession: 'P00880' },
    });
    expect(result?.candidates?.map((candidate) => candidate.id)).toEqual([
      'rcsb:RCSB:1RBL:ENTRY:all',
      'alphafold:AF:P00880:F1:V6:MODEL:AF-P00880-F1-model_v6:all',
    ]);
  });

  it('keeps direct PDB candidates when optional AFDB validation is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: { error: 'provider_error' } }), { status: 502 })
      )
      .mockResolvedValueOnce(rcsbFetchHit('1RBL'));

    const result = await pdbXrefStep.resolve(
      'M',
      { dbXrefs: ['PDB:1RBL', 'UniProtKB/Swiss-Prot:P00880'] },
      new AbortController().signal
    );

    expect(result?.structure).toEqual({
      kind: 'pdb',
      pdbId: '1RBL',
      providerIdentityKey: 'RCSB:1RBL:ENTRY',
    });
    expect(result?.candidates?.map((candidate) => candidate.provider)).toEqual(['pdb']);
  });

  it('returns null when no PDB xref is present', async () => {
    const result = await pdbXrefStep.resolve(
      'M',
      { dbXrefs: ['UniProtKB:P00000'] },
      new AbortController().signal
    );
    expect(result).toBeNull();
  });

  it('declares dbXrefs as a required hint', () => {
    expect(pdbXrefStep.hintsRequired).toEqual(['dbXrefs']);
  });

  it('runs first in the priority order', () => {
    expect(pdbXrefStep.priority).toBe(10);
  });
});
