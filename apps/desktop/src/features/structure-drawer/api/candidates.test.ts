// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  candidateRowsForResolved,
  findStructureCandidateById,
  makeStructureCandidateId,
  rankStructureCandidates,
} from './candidates';
import type { StructureCandidate, StructureProviderKind } from '../types/structure-drawer';

function candidate(
  provider: StructureProviderKind,
  externalId: string,
  overrides: Partial<StructureCandidate> = {}
): StructureCandidate {
  const id = makeStructureCandidateId({
    provider,
    externalId,
    chainId: provider === 'pdb' ? 'A' : undefined,
  });
  return {
    id,
    provider,
    group: provider === 'pdb' ? 'rcsb' : 'alphafold',
    label: externalId,
    rank: 0,
    structure:
      provider === 'pdb'
        ? { kind: 'pdb', pdbId: externalId }
        : { kind: 'uniprot', accession: externalId },
    metadata: {
      pdbId: provider === 'pdb' ? externalId : undefined,
      uniprotAccession: provider === 'alphafold' ? externalId : undefined,
      ...overrides.metadata,
    },
    provenance: {
      resolverSource: 'protein_sequence',
      identity: 1,
      ...overrides.provenance,
    },
    ...overrides,
  };
}

describe('makeStructureCandidateId', () => {
  it('encodes provider, external id, and chain scope', () => {
    expect(
      makeStructureCandidateId({
        provider: 'pdb',
        externalId: '1rbl',
        chainId: 'a',
      })
    ).toBe('rcsb:1RBL:a');
    expect(
      makeStructureCandidateId({
        provider: 'alphafold',
        externalId: 'p00880',
      })
    ).toBe('alphafold:P00880:all');
  });

  it('preserves case-sensitive scoped RCSB chain values', () => {
    expect(
      makeStructureCandidateId({
        provider: 'pdb',
        externalId: 'RCSB:1rbl:ENTRY:AUTH_ASYM:a',
      })
    ).toBe('rcsb:RCSB:1RBL:ENTRY:AUTH_ASYM:a:all');
    expect(
      makeStructureCandidateId({
        provider: 'pdb',
        externalId: 'RCSB:1rbl:ENTRY:AUTH_ASYM:A',
      })
    ).toBe('rcsb:RCSB:1RBL:ENTRY:AUTH_ASYM:A:all');
  });
});

describe('rankStructureCandidates', () => {
  it('recommends the valid PDB candidate with the lowest numeric resolution', () => {
    const ranked = rankStructureCandidates([
      candidate('alphafold', 'P00880', {
        metadata: { meanPlddt: 91 },
      }),
      candidate('pdb', '1RLC', {
        metadata: { resolution: 2.7 },
      }),
      candidate('pdb', '1RBL', {
        metadata: { resolution: 2.2 },
      }),
    ]);

    expect(ranked.recommendedCandidateId).toBe('rcsb:1RBL:A');
    expect(ranked.candidates.map((row) => row.id)).toEqual([
      'rcsb:1RBL:A',
      'rcsb:1RLC:A',
      'alphafold:P00880:all',
    ]);
  });

  it('sorts missing PDB resolution after numeric resolution and uses lexical IDs as the final tie-breaker', () => {
    const ranked = rankStructureCandidates([
      candidate('pdb', '4RUB'),
      candidate('pdb', '1RLC', { metadata: { resolution: 2.2 } }),
      candidate('pdb', '1RBL', { metadata: { resolution: 2.2 } }),
    ]);

    expect(ranked.candidates.map((row) => row.id)).toEqual([
      'rcsb:1RBL:A',
      'rcsb:1RLC:A',
      'rcsb:4RUB:A',
    ]);
  });

  it('recommends AlphaFold only when no PDB candidate exists', () => {
    const ranked = rankStructureCandidates([
      candidate('alphafold', 'P00880', {
        metadata: { meanPlddt: 91 },
      }),
    ]);

    expect(ranked.recommendedCandidateId).toBe('alphafold:P00880:all');
    expect(ranked.candidates).toHaveLength(1);
  });

  it('dedupes candidate IDs and keeps the richer metadata row', () => {
    const ranked = rankStructureCandidates([
      candidate('pdb', '1RBL'),
      candidate('pdb', '1RBL', {
        metadata: {
          title: 'Ribulose bisphosphate carboxylase',
          resolution: 2.2,
        },
        provenance: {
          resolverSource: 'pdb_xref',
          identity: 1,
          externalResourceId: 'resource-1',
        },
      }),
    ]);

    expect(ranked.candidates).toHaveLength(1);
    expect(ranked.candidates[0].metadata.title).toBe('Ribulose bisphosphate carboxylase');
    expect(ranked.candidates[0].provenance.externalResourceId).toBe('resource-1');
  });

  it('uses recommendedCandidateId as a pointer to an existing candidate row', () => {
    const ranked = rankStructureCandidates([
      candidate('pdb', '1RBL', { metadata: { resolution: 2.2 } }),
      candidate('alphafold', 'P00880'),
    ]);

    expect(ranked.candidates.some((row) => row.id === ranked.recommendedCandidateId)).toBe(true);
    expect(ranked.candidates.map((row) => row.group)).not.toContain('recommended');
  });

  it('does not dedupe distinct case-sensitive RCSB scope values', () => {
    const lower = candidate('pdb', 'RCSB:1RBL:ENTRY:AUTH_ASYM:a', {
      id: makeStructureCandidateId({
        provider: 'pdb',
        externalId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:a',
      }),
      metadata: { resolution: 2.2 },
    });
    const upper = candidate('pdb', 'RCSB:1RBL:ENTRY:AUTH_ASYM:A', {
      id: makeStructureCandidateId({
        provider: 'pdb',
        externalId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:A',
      }),
      metadata: { resolution: 2.2 },
    });

    const ranked = rankStructureCandidates([lower, upper]);

    expect(ranked.candidates.map((row) => row.id).sort()).toEqual([
      'rcsb:RCSB:1RBL:ENTRY:AUTH_ASYM:A:all',
      'rcsb:RCSB:1RBL:ENTRY:AUTH_ASYM:a:all',
    ]);
  });
});

describe('fallback candidate rows', () => {
  it('makes direct AlphaFold resolver results selectable through the same candidate API', () => {
    const rows = candidateRowsForResolved({
      source: 'uniprot_xref',
      identity: 1,
      structure: { kind: 'uniprot', accession: 'P0AD86' },
      confidenceNote: 'Mean pLDDT 78.4',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'alphafold:P0AD86:all',
      provider: 'alphafold',
      label: 'P0AD86',
      metadata: {
        sourceUrl: 'https://alphafold.ebi.ac.uk/entry/P0AD86',
      },
    });
    expect(
      findStructureCandidateById(
        {
          source: 'uniprot_xref',
          identity: 1,
          structure: { kind: 'uniprot', accession: 'P0AD86' },
        },
        'alphafold:P0AD86:all'
      )
    ).toMatchObject({ id: 'alphafold:P0AD86:all' });
  });

  it('makes direct PDB resolver results selectable through the same candidate API', () => {
    expect(
      findStructureCandidateById(
        {
          source: 'pdb_xref',
          identity: 1,
          structure: { kind: 'pdb', pdbId: '1TUP' },
        },
        'rcsb:1TUP:all'
      )
    ).toMatchObject({
      id: 'rcsb:1TUP:all',
      provider: 'pdb',
      metadata: {
        sourceUrl: 'https://www.rcsb.org/structure/1TUP',
      },
    });
  });
});
