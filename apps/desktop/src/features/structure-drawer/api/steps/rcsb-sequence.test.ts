// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { rcsbSequenceStep } from './rcsb-sequence';
import { callBody } from '../__tests__/sidecar-mocks';
import '../__tests__/sidecar-mocks';
import type { StructureDrawerRequest } from '../../types/structure-drawer';

const realFetch = globalThis.fetch;
const ABORT = new AbortController().signal;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function rnaRequest(sequence: string): StructureDrawerRequest {
  return {
    translation: sequence,
    moleculeType: 'rna',
    cdsLabel: '16S rRNA',
    hints: {},
  };
}

function dnaRequest(sequence: string): StructureDrawerRequest {
  return {
    translation: sequence,
    moleculeType: 'dna',
    cdsLabel: 'operator DNA',
    hints: {},
  };
}

function rcsbMetadata(pdbId: string) {
  return {
    external_resource_id: `resource-${pdbId}`,
    cache_hit: false,
    license: 'CC0',
    attribution: `RCSB Protein Data Bank; PDB ID ${pdbId}`,
    metadata: {
      pdb_id: pdbId,
      title: 'RNA riboswitch structure',
      experimental_method: 'X-RAY DIFFRACTION',
      resolution: 2.4,
      chain_count: 2,
      chain_ids: ['A', 'B'],
      chains: [{ polymer_type: 'RNA', description: 'RNA riboswitch aptamer' }],
      provider_url: `https://www.rcsb.org/structure/${pdbId}`,
    },
  };
}

describe('rcsbSequenceStep', () => {
  it('resolves RNA sequence search hits into scoped RCSB candidates', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            hits: [
              {
                identifier: '4GXY_1',
                pdb_id: '4GXY',
                entity_id: '1',
                score: 92,
                sequence_identity: 0.97,
                evalue: 1e-20,
                bit_score: 88,
              },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(rcsbMetadata('4GXY')), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await rcsbSequenceStep.resolve(
      'A'.repeat(30),
      {},
      ABORT,
      rnaRequest('A'.repeat(30))
    );

    expect(callBody(fetchMock, 0)).toMatchObject({
      sequence: 'A'.repeat(30),
      sequence_type: 'rna',
      granted_capabilities: ['external-fetch:homology-search'],
    });
    expect(callBody(fetchMock, 1)).toMatchObject({
      provider: 'rcsb',
      external_id: 'RCSB:4GXY:ENTRY:ENTITY:1',
    });
    expect(result).toMatchObject({
      source: 'rcsb_sequence',
      identity: 0.97,
      structure: {
        kind: 'pdb',
        pdbId: '4GXY',
        providerIdentityKey: 'RCSB:4GXY:ENTRY:ENTITY:1',
        pdbEntityId: '1',
      },
      recommendedCandidateId: 'rcsb:RCSB:4GXY:ENTRY:ENTITY:1:all',
    });
    expect(result?.candidates?.[0]).toMatchObject({
      metadata: {
        polymerTypes: ['RNA'],
        sourceUrl: 'https://www.rcsb.org/structure/4GXY',
      },
      provenance: {
        resolverSource: 'rcsb_sequence',
        sequenceIdentity: 0.97,
      },
    });
  });

  it('does not run for protein requests', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await rcsbSequenceStep.resolve('MTEST', {}, ABORT, {
      translation: 'MTEST',
      moleculeType: 'protein',
      hints: {},
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for RNA no-hit responses without fetching metadata or AlphaFold fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await rcsbSequenceStep.resolve(
      'AUGCUAGCUAGCUAGCUAGCUAGCUAGCUA',
      {},
      ABORT,
      rnaRequest('AUGCUAGCUAGCUAGCUAGCUAGCUAGCUA')
    );

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/external/rcsb/sequence-search');
    expect(callBody(fetchMock, 0)).toMatchObject({
      sequence_type: 'rna',
      granted_capabilities: ['external-fetch:homology-search'],
    });
  });

  it('uses the same polymer-entity path for DNA requests without protein resolver fallback', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            hits: [
              {
                identifier: '1BNA_1',
                pdb_id: '1BNA',
                entity_id: '1',
                sequence_identity: 1,
              },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            external_resource_id: 'resource-1BNA',
            cache_hit: false,
            license: 'CC0',
            attribution: 'RCSB Protein Data Bank; PDB ID 1BNA',
            metadata: {
              pdb_id: '1BNA',
              title: 'B-DNA dodecamer',
              chain_count: 2,
              chain_ids: ['A', 'B'],
              chains: [{ polymer_type: 'DNA', description: 'DNA duplex' }],
              provider_url: 'https://www.rcsb.org/structure/1BNA',
            },
          }),
          { status: 200 }
        )
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await rcsbSequenceStep.resolve(
      'CGCGAATTCGCG'.repeat(3),
      {},
      ABORT,
      dnaRequest('CGCGAATTCGCG'.repeat(3))
    );

    expect(callBody(fetchMock, 0)).toMatchObject({
      sequence_type: 'dna',
      granted_capabilities: ['external-fetch:homology-search'],
    });
    expect(String(fetchMock.mock.calls[1][0])).toContain('/external/fetch');
    expect(result).toMatchObject({
      source: 'rcsb_sequence',
      structure: {
        kind: 'pdb',
        pdbId: '1BNA',
        providerIdentityKey: 'RCSB:1BNA:ENTRY:ENTITY:1',
        pdbEntityId: '1',
      },
      confidenceNote: 'DNA sequence match in RCSB',
    });
    expect(result?.candidates?.[0].metadata.polymerTypes).toEqual(['DNA']);
  });
});
