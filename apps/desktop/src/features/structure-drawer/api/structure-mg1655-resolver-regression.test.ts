// @vitest-environment node

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseGenBankFull, type Annotation } from '@waypoint/sequence-utils';
import { buildStructureDrawerRequestFromCds } from './build-structure-request';
import { proteinSequenceStep } from './steps/protein-sequence';
import { resolveStructureRequest } from './structure-resolver';
import { sidecarAfdbHit } from './__tests__/sidecar-mocks';
import './__tests__/sidecar-mocks';

const ABORT = new AbortController().signal;
const REPO_ROOT = join(__dirname, '../../../../../..');
const MG1655_COMPLETE = join(
  REPO_ROOT,
  'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb'
);

function digest(algorithm: 'md5' | 'sha256', sequence: string): string {
  const hash = createHash(algorithm).update(sequence).digest('hex');
  return algorithm === 'md5' ? hash.toUpperCase() : hash;
}

function bySequenceHit(accession: string, sequence: string) {
  const checksumMd5 = digest('md5', sequence);
  const checksumSha256 = digest('sha256', sequence);
  return new Response(
    JSON.stringify({
      md5: checksumMd5,
      query_identity: {
        kind: 'protein_sequence',
        normalized_length: sequence.length,
        checksum_md5: checksumMd5,
        checksum_sha256: checksumSha256,
        canonical_form: 'waypoint-protein-v2',
        canonical_lookup_sequence: sequence,
        canonical_form_applied: true,
        ineligible: false,
        ineligible_reason: null,
        evidence: [],
      },
      hits: [
        {
          accession,
          reviewed: true,
          pdb_ids: [],
          pdb_xrefs: [],
          match_evidence: {
            kind: 'exact_sequence_checksum',
            checksum_md5: checksumMd5,
            sequence_identity: 1,
            rank: 0,
            rank_reasons: ['checksum_match', 'reviewed'],
          },
        },
      ],
    }),
    { status: 200 }
  );
}

function bySequenceHitWithPdb(
  accession: string,
  sequence: string,
  pdbXrefs: Array<{ pdb_id: string; method: string; resolution: number; chains: string[] }>
) {
  const checksumMd5 = digest('md5', sequence);
  const checksumSha256 = digest('sha256', sequence);
  return new Response(
    JSON.stringify({
      md5: checksumMd5,
      query_identity: {
        kind: 'protein_sequence',
        normalized_length: sequence.length,
        checksum_md5: checksumMd5,
        checksum_sha256: checksumSha256,
        canonical_form: 'waypoint-protein-v2',
        canonical_lookup_sequence: sequence,
        canonical_form_applied: true,
        ineligible: false,
        ineligible_reason: null,
        evidence: [],
      },
      hits: [
        {
          accession,
          reviewed: true,
          pdb_ids: pdbXrefs.map((xref) => xref.pdb_id),
          pdb_xrefs: pdbXrefs,
          match_evidence: {
            kind: 'exact_sequence_checksum',
            checksum_md5: checksumMd5,
            sequence_identity: 1,
            rank: 0,
            rank_reasons: ['checksum_match', 'reviewed'],
          },
        },
      ],
    }),
    { status: 200 }
  );
}

function rcsbFetchHit(pdbId: string, resolution: number) {
  return new Response(
    JSON.stringify({
      external_resource_id: `resource-${pdbId}`,
      cache_hit: false,
      license: 'CC0-1.0',
      attribution: `RCSB Protein Data Bank; PDB ID ${pdbId}`,
      metadata: {
        pdb_id: pdbId,
        title: `${pdbId} YoeB structure`,
        experimental_method: 'X-ray',
        resolution,
        chain_ids: ['A'],
        provider_url: `https://www.rcsb.org/structure/${pdbId}`,
      },
    }),
    { status: 200 }
  );
}

function bySequenceMiss(sequence: string) {
  const checksumMd5 = digest('md5', sequence);
  const checksumSha256 = digest('sha256', sequence);
  return new Response(
    JSON.stringify({
      md5: checksumMd5,
      query_identity: {
        kind: 'protein_sequence',
        normalized_length: sequence.length,
        checksum_md5: checksumMd5,
        checksum_sha256: checksumSha256,
        canonical_form: 'waypoint-protein-v2',
        canonical_lookup_sequence: sequence,
        canonical_form_applied: true,
        ineligible: false,
        ineligible_reason: null,
        evidence: [],
      },
      hits: [],
    }),
    { status: 200 }
  );
}

function searchHit({
  accession,
  sequence,
  taxonId = 83333,
  organism = 'Escherichia coli (strain K12)',
}: {
  accession: string;
  sequence: string;
  taxonId?: number;
  organism?: string;
}) {
  return new Response(
    JSON.stringify({
      hits: [
        {
          accession,
          reviewed: true,
          sequence,
          taxon_id: taxonId,
          organism,
        },
      ],
    }),
    { status: 200 }
  );
}

function emptySearch() {
  return new Response(JSON.stringify({ hits: [] }), { status: 200 });
}

let parsedFixture: ReturnType<typeof parseGenBankFull> | null = null;
function fixture() {
  parsedFixture ??= parseGenBankFull(readFileSync(MG1655_COMPLETE, 'utf8'));
  return parsedFixture;
}

function cdsByGene(gene: string): Annotation {
  const cds = fixture().annotations.find(
    (annotation) => annotation.type === 'CDS' && annotation.qualifiers?.gene?.[0] === gene
  );
  if (!cds) throw new Error(`Missing MG1655 CDS fixture for /gene="${gene}"`);
  return cds;
}

function cdsByGeneAndStart(gene: string, start: number): Annotation {
  const cds = fixture().annotations.find(
    (annotation) =>
      annotation.type === 'CDS' &&
      annotation.qualifiers?.gene?.[0] === gene &&
      annotation.start === start
  );
  if (!cds) throw new Error(`Missing MG1655 CDS fixture for /gene="${gene}" at ${start}`);
  return cds;
}

function withoutQualifierTranslation(cds: Annotation): Annotation {
  const { translation: _translation, ...rest } = cds.qualifiers ?? {};
  return { ...cds, qualifiers: rest };
}

function withoutProviderCrossReferences(cds: Annotation): Annotation {
  const { db_xref: _dbXref, protein_id: _proteinId, ...rest } = cds.qualifiers ?? {};
  return { ...cds, qualifiers: rest };
}

function requestFor(cds: Annotation) {
  return buildStructureDrawerRequestFromCds({
    cds,
    sequence: fixture(),
    entityId: '/fixtures/mg1655.gb',
  });
}

describe('MG1655 structure resolver regressions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves ARSC through the full drawer resolver to the provider-confirmed AlphaFold accession', async () => {
    const request = requestFor(cdsByGene('arsC'));
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P0AB96', request!.translation))
      .mockResolvedValueOnce(sidecarAfdbHit('P0AB96', 96.69));

    const result = await resolveStructureRequest(request!, ABORT);

    expect(result?.source).toBe('protein_sequence');
    expect(result?.structure).toMatchObject({ kind: 'uniprot', accession: 'P0AB96' });
    expect(result?.candidates?.map((candidate) => candidate.label)).toEqual(['P0AB96']);
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).sequence.slice(0, 12)).toBe(
      'MSNITIYHNPAC'
    );
  });

  it('normalizes coordinate-derived MG1655 GTG starts before the full drawer resolver lookup', async () => {
    const request = requestFor(withoutQualifierTranslation(cdsByGene('hdfR')));
    expect(request?.proteinIdentity?.sequence.rawSequence?.slice(0, 3)).toBe('VDT');
    expect(request?.proteinIdentity?.sequence.initiatorNormalized).toBe(true);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P0A8R9', request!.translation))
      .mockResolvedValueOnce(sidecarAfdbHit('P0A8R9', 89.25));

    const result = await resolveStructureRequest(request!, ABORT);
    const bySequenceBody = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));

    expect(bySequenceBody.sequence.slice(0, 12)).toBe('MDTELLKTFLEV');
    expect(bySequenceBody.sequence.slice(0, 12)).not.toBe('VDTELLKTFLEV');
    expect(result?.source).toBe('protein_sequence');
    expect(result?.structure).toMatchObject({ kind: 'uniprot', accession: 'P0A8R9' });
  });

  it('keeps YOEB exact-sequence PDB candidates after reverse-strand GTG initiator normalization', async () => {
    const request = requestFor(withoutQualifierTranslation(cdsByGene('yoeB')));
    expect(request?.translation.slice(0, 12)).toBe('MKLIWSEESWDD');
    expect(request?.proteinIdentity?.sequence.rawSequence?.slice(0, 3)).toBe('VKL');
    expect(request?.proteinIdentity?.sequence.initiatorNormalized).toBe(true);
    expect(digest('md5', request!.translation)).toBe('411587148D95097537C316C67E7E3072');
    expect(request!.translation).toBe(requestFor(cdsByGene('yoeB'))!.translation);

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        bySequenceHitWithPdb('P69348', request!.translation, [
          { pdb_id: '2A6S', method: 'X-ray', resolution: 1.77, chains: ['A', 'B', 'C', 'D'] },
          { pdb_id: '4V8X', method: 'X-ray', resolution: 3.35, chains: ['AY', 'AZ'] },
        ])
      )
      .mockResolvedValueOnce(sidecarAfdbHit('P69348', 86.7))
      .mockResolvedValueOnce(rcsbFetchHit('2A6S', 1.77))
      .mockResolvedValueOnce(rcsbFetchHit('4V8X', 3.35));

    const result = await proteinSequenceStep.resolve(request!.translation, request!.hints, ABORT);

    expect(result?.source).toBe('protein_sequence');
    expect(result?.candidates?.map((candidate) => candidate.provider)).toEqual([
      'pdb',
      'pdb',
      'alphafold',
    ]);
    expect(result?.candidates?.map((candidate) => candidate.label)).toEqual([
      '2A6S',
      '4V8X',
      'P69348',
    ]);
  });

  it('resolves the short-start MrcB CDS through strict gene + sequence-overlap evidence', async () => {
    const canonicalMrcB = requestFor(cdsByGeneAndStart('mrcB', 164730))!.translation;
    const request = requestFor(withoutProviderCrossReferences(cdsByGeneAndStart('mrcB', 164865)));
    expect(canonicalMrcB).toHaveLength(844);
    expect(request?.translation).toHaveLength(799);
    expect(canonicalMrcB.indexOf(request!.translation)).toBe(45);
    expect(request?.translation.slice(0, 12)).toBe('MPRKGKGKGKGR');

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceMiss(request!.translation))
      .mockResolvedValueOnce(searchHit({ accession: 'P02919', sequence: canonicalMrcB }))
      .mockResolvedValueOnce(emptySearch())
      .mockResolvedValueOnce(sidecarAfdbHit('P02919', 87.44));

    const result = await resolveStructureRequest(request!, ABORT);

    expect(result?.source).toBe('gene_sequence_overlap');
    expect(result?.structure).toMatchObject({ kind: 'uniprot', accession: 'P02919' });
    expect(result?.confidenceNote).toContain('strict sequence overlap');
    const searchBody = JSON.parse(String(fetchSpy.mock.calls[1][1]?.body));
    expect(searchBody).toMatchObject({
      query: 'gene:mrcB AND reviewed:true',
      size: 10,
      include_sequence: true,
    });
  });

  it('resolves the stop-delimited PhnE1 pseudogene fragment to the canonical fragment accession', async () => {
    const request = requestFor(withoutProviderCrossReferences(cdsByGene('phnE1')));
    expect(request?.translation).toContain('*');
    const canonicalFragment = request!.translation.split('*')[0];
    expect(canonicalFragment).toHaveLength(206);

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceMiss(request!.translation))
      .mockResolvedValueOnce(searchHit({ accession: 'P0DP69', sequence: canonicalFragment }))
      .mockResolvedValueOnce(emptySearch())
      .mockResolvedValueOnce(sidecarAfdbHit('P0DP69', 72.0));

    const result = await resolveStructureRequest(request!, ABORT);

    expect(result?.source).toBe('gene_sequence_overlap');
    expect(result?.structure).toMatchObject({ kind: 'uniprot', accession: 'P0DP69' });
    expect(result?.confidenceNote).toContain('strict sequence overlap');
  });

  it('does not rescue a disrupted YaiX CDS by gene name when sequence overlap fails', async () => {
    const request = requestFor(withoutProviderCrossReferences(cdsByGene('yaiX')));
    const canonicalYaiX =
      'MDLLPFLLDANLSATNPPAIPHWWKRQPLIPNLLSQELKNYLKLNVKEKNIQIADQVIIDETAGEVVIGANTRICHG' +
      'AVIQGPVVIGANCLIGNYAFIRPGTIISNGVKIGFATEIKNAVIEAEATIGPQCFIADSVVANQAYLGAQVRTSNHR' +
      'LDEQPVSVRTPEGIIATGCDKLGCYIGQRSRLGVQVIILPGRIISPNTQLGPRVIVERNLPTGTYSLRQELIRTGD';
    expect(canonicalYaiX).toHaveLength(230);
    expect(request?.translation).toHaveLength(232);
    expect(request!.translation.includes(canonicalYaiX)).toBe(false);
    expect(canonicalYaiX.includes(request!.translation)).toBe(false);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceMiss(request!.translation))
      .mockResolvedValueOnce(searchHit({ accession: 'P75697', sequence: canonicalYaiX }))
      .mockResolvedValueOnce(emptySearch());

    const result = await resolveStructureRequest(request!, ABORT);

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does not rescue the joined RenD CDS when the contained UniProt protein is below the coverage floor', async () => {
    const request = requestFor(withoutProviderCrossReferences(cdsByGene('renD')));
    const canonicalRenD = 'MARAGILVVDGKVWRTVYYRFATREEWEGKVSTNLIFKECRQSAAMKRVLRVYKRTSMGTQ';
    expect(request?.translation).toHaveLength(101);
    expect(canonicalRenD).toHaveLength(61);
    expect(request!.translation.endsWith(canonicalRenD)).toBe(true);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceMiss(request!.translation))
      .mockResolvedValueOnce(searchHit({ accession: 'P75718', sequence: canonicalRenD }))
      .mockResolvedValueOnce(emptySearch());

    const result = await resolveStructureRequest(request!, ABORT);

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
