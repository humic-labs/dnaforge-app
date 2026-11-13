// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { proteinSequenceStep } from './protein-sequence';
import { buildStructureDrawerRequestFromCds } from '../build-structure-request';
import { sidecarAfdbHit, sidecarAfdbMiss, vi as _vi } from '../__tests__/sidecar-mocks';
import '../__tests__/sidecar-mocks';
import type { StructureDrawerRequest } from '../../types/structure-drawer';

void _vi;

const ABORT = new AbortController().signal;
const MIOC_PROTEIN =
  'MADITLISGSTLGGAEYVAEHLAEKLEEAGFTTETLHGPLLEDLPASGIWLVISSTHGAGDI' +
  'PDNLSPFYEALQEQKPDLSAVRFGAIGIGSREYDTFCGAIDKLEAELKNSGAKQTGETLKIN' +
  'ILDHDIPEDPAEEWLGSWVNLLK';
const MIOC_SHA256 = '0688d2c546ef5e3b818ce9b3f45d3eb942740e09849eef2047b2864ea734050d';

type QueryIdentityOverrides = {
  canonicalSequence?: string;
  normalizedLength?: number;
  checksumSha256?: string;
  ineligible?: boolean;
  ineligibleReason?: string;
  evidence?: Array<{
    kind: 'internal_stop' | 'non_standard_residue' | 'protein_invalid_residue';
    residue?: string;
  }>;
};

async function sha256Hex(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bySequenceHit(
  accession: string,
  reviewed = true,
  pdbIds: string[] = [],
  md5 = 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF',
  pdbXrefs: Array<{
    pdb_id: string;
    method?: string;
    resolution?: number | null;
    chains?: string[];
    raw_properties?: Record<string, string>;
  }> = [],
  queryOverrides: QueryIdentityOverrides = {}
) {
  const canonicalSequence = queryOverrides.canonicalSequence ?? MIOC_PROTEIN;
  const normalizedLength = queryOverrides.normalizedLength ?? canonicalSequence.length;
  return new Response(
    JSON.stringify({
      md5,
      query_identity: {
        kind: 'protein_sequence',
        normalized_length: normalizedLength,
        checksum_md5: md5,
        checksum_sha256: queryOverrides.checksumSha256 ?? MIOC_SHA256,
        canonical_form: 'waypoint-protein-v2',
        canonical_lookup_sequence: canonicalSequence,
        canonical_form_applied: true,
        ineligible: queryOverrides.ineligible ?? false,
        ineligible_reason: queryOverrides.ineligibleReason,
        evidence: queryOverrides.evidence ?? [],
      },
      hits: [
        {
          accession,
          reviewed,
          pdb_ids: pdbIds,
          pdb_xrefs: pdbXrefs,
          match_evidence: {
            kind: 'exact_sequence_checksum',
            checksum_md5: md5,
            sequence_identity: 1,
            rank: 0,
            rank_reasons: ['checksum_match', reviewed ? 'reviewed' : 'unreviewed'],
          },
        },
      ],
    }),
    { status: 200 }
  );
}

function bySequenceMiss(
  md5 = 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF',
  queryOverrides: QueryIdentityOverrides = {}
) {
  const canonicalSequence = queryOverrides.canonicalSequence ?? MIOC_PROTEIN;
  const normalizedLength = queryOverrides.normalizedLength ?? canonicalSequence.length;
  return new Response(
    JSON.stringify({
      md5,
      query_identity: {
        kind: 'protein_sequence',
        normalized_length: normalizedLength,
        checksum_md5: md5,
        checksum_sha256: queryOverrides.checksumSha256 ?? MIOC_SHA256,
        canonical_form: 'waypoint-protein-v2',
        canonical_lookup_sequence: canonicalSequence,
        canonical_form_applied: true,
        ineligible: queryOverrides.ineligible ?? false,
        ineligible_reason: queryOverrides.ineligibleReason,
        evidence: queryOverrides.evidence ?? [],
      },
      hits: [],
    }),
    { status: 200 }
  );
}

function requestFromQualifierTranslation(translation: string): StructureDrawerRequest {
  const request = buildStructureDrawerRequestFromCds({
    cds: {
      type: 'CDS',
      name: 'synthetic CDS',
      start: 1,
      end: 9,
      direction: 1,
      qualifiers: { translation: [translation] },
    } as any,
    sequence: {
      sequence: 'ATGGCTGAT',
      circular: false,
      annotations: [],
    } as any,
    entityId: 'fixture://synthetic.gb',
  });
  if (!request) throw new Error('Expected synthetic CDS request');
  return request;
}

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
        resolution: 1.9,
        chain_ids: ['A', 'B'],
        organism: 'Synechococcus elongatus',
        provider_url: `https://www.rcsb.org/structure/${pdbId}`,
        ...overrides,
      },
    }),
    { status: 200 }
  );
}

function identityRequest(overrides: Partial<StructureDrawerRequest> = {}): StructureDrawerRequest {
  const request: StructureDrawerRequest = {
    translation: MIOC_PROTEIN,
    hints: {},
    identityRequestKey: `req:feature:v2:test:protein-sequence:v2:${MIOC_SHA256}`,
    proteinIdentity: {
      schemaVersion: 2,
      feature: {
        kind: 'sequence_feature',
        featureKey: 'feature:v2:test',
        label: 'mioc CDS',
        location: {
          segments: [{ start0: 0, end0: MIOC_PROTEIN.length * 3, strand: 1 }],
          circular: false,
        },
        hintSummary: {
          dbXrefCount: 0,
          hasProteinId: false,
          hasLocusTag: false,
          hasGeneName: false,
        },
        evidenceIds: [],
      },
      sequence: {
        kind: 'protein_sequence',
        schemaVersion: 2,
        identityKey: `protein-sequence:v2:${MIOC_SHA256}`,
        canonicalizationStatus: 'renderer_preflight',
        lookupSequence: MIOC_PROTEIN,
        canonicalLookupSequence: MIOC_PROTEIN,
        length: MIOC_PROTEIN.length,
        source: 'qualifier_translation',
        startCodon: null,
        initiatorNormalized: false,
        digests: { sha256: MIOC_SHA256 },
        evidenceIds: [],
      },
      externalProteins: [],
      resolutionSets: [],
      structures: [],
      evidence: [],
    },
  };
  return { ...request, ...overrides };
}

describe('proteinSequenceStep — exact protein-sequence MD5 match', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('declares no hint requirements (always runs given a translation)', () => {
    expect(proteinSequenceStep.hintsRequired).toEqual([]);
  });

  it('priority runs exact sequence before heuristic resolver steps', () => {
    expect(proteinSequenceStep.priority).toBeLessThan(10);
  });

  it('returns null when translation is empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await proteinSequenceStep.resolve('', {}, ABORT);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not spend an exact-sequence network call when a curated PDB structure xref is already present', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await proteinSequenceStep.resolve(
      MIOC_PROTEIN,
      { dbXrefs: ['PDB:1RBL'] },
      ABORT
    );

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not treat malformed PDB-looking notes as curated structure xrefs', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P03817'))
      .mockResolvedValueOnce(sidecarAfdbHit('P03817', 92.4));

    const result = await proteinSequenceStep.resolve(
      MIOC_PROTEIN,
      { dbXrefs: ['PDB: see notes'] },
      ABORT
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result?.source).toBe('protein_sequence');
    expect(result?.structure).toMatchObject({
      kind: 'uniprot',
      accession: 'P03817',
    });
  });

  it('does expand UniProt xrefs through exact-sequence identity so RCSB candidates are not suppressed', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        bySequenceHit('P03817', true, ['1XYZ'], 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF', [
          {
            pdb_id: '1XYZ',
            method: 'X-ray',
            resolution: 1.8,
            chains: ['A'],
          },
        ])
      )
      .mockResolvedValueOnce(sidecarAfdbHit('P03817', 92.4))
      .mockResolvedValueOnce(rcsbFetchHit('1XYZ', { resolution: 1.8, chain_ids: ['A'] }));

    const result = await proteinSequenceStep.resolve(
      MIOC_PROTEIN,
      { dbXrefs: ['UniProtKB:P03817'] },
      ABORT
    );

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result?.source).toBe('protein_sequence');
    expect(result?.candidates?.map((candidate) => candidate.provider)).toEqual([
      'pdb',
      'alphafold',
    ]);
    expect(result?.candidates?.[0]).toMatchObject({
      id: 'rcsb:RCSB:1XYZ:ENTRY:AUTH_ASYM:A:all',
      provenance: {
        externalResourceId: 'resource-1XYZ',
      },
    });
  });

  it('keeps full RCSB complex chain metadata when UniProt scopes the query chain', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        bySequenceHit('P0ABA6', true, ['1FS0'], 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF', [
          {
            pdb_id: '1FS0',
            method: 'X-ray',
            resolution: 2.1,
            chains: ['G'],
            raw_properties: { Resolution: '2.10 A', Chains: 'G=1-286' },
          },
        ])
      )
      .mockResolvedValueOnce(sidecarAfdbHit('P0ABA6', 88.6))
      .mockResolvedValueOnce(
        rcsbFetchHit('1FS0', {
          title: 'COMPLEX OF GAMMA/EPSILON ATP SYNTHASE FROM E.COLI',
          resolution: 2.1,
          chain_count: 2,
          chain_ids: ['E', 'G'],
          chains: [
            { description: 'ATP synthase epsilon chain', polymer_type: 'Protein' },
            { description: 'ATP synthase gamma chain', polymer_type: 'Protein' },
          ],
        })
      );

    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);
    const pdbCandidate = result?.candidates?.find((candidate) => candidate.provider === 'pdb');

    expect(result?.structure).toEqual({
      kind: 'pdb',
      pdbId: '1FS0',
      providerIdentityKey: 'RCSB:1FS0:ENTRY:AUTH_ASYM:G',
      labelAsymIds: undefined,
      authAsymIds: ['G'],
      uniprotFallback: { accession: 'P0ABA6' },
    });
    expect(pdbCandidate?.metadata).toMatchObject({
      pdbId: '1FS0',
      chainCount: 2,
      chainIds: ['E', 'G'],
      entityDescriptions: ['ATP synthase epsilon chain', 'ATP synthase gamma chain'],
    });
  });

  it('returns null when UniProt has no exact-sequence match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(bySequenceMiss());
    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);
    expect(result).toBeNull();
  });

  it('returns null instead of fabricating exact evidence when match evidence is malformed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          md5: 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF',
          query_identity: {
            kind: 'protein_sequence',
            normalized_length: MIOC_PROTEIN.length,
            checksum_md5: 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF',
            checksum_sha256: MIOC_SHA256,
            canonical_form: 'waypoint-protein-v2',
            canonical_lookup_sequence: MIOC_PROTEIN,
            canonical_form_applied: true,
            ineligible: false,
            evidence: [],
          },
          hits: [{ accession: 'P03817', reviewed: true, match_evidence: { rank: '0' } }],
        }),
        { status: 200 }
      )
    );

    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null when UniProt hits but AFDB has no prediction', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P03817'))
      .mockResolvedValueOnce(sidecarAfdbMiss());
    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);
    expect(result).toBeNull();
  });

  it('returns identity 1.0 + uniprot structure on hit + AFDB exists', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P03817'))
      .mockResolvedValueOnce(sidecarAfdbHit('P03817', 92.4));
    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);
    expect(result).not.toBeNull();
    expect(result?.source).toBe('protein_sequence');
    expect(result?.identity).toBe(1.0);
    expect(result?.structure).toMatchObject({
      kind: 'uniprot',
      accession: 'P03817',
      providerIdentityKey: 'AF:P03817:F1:LATEST',
    });
    expect(result?.confidenceNote).toMatch(/exact protein-sequence match/);
    expect(result?.confidenceNote).toMatch(/92\.4/);
  });

  it('carries AFDB latest version into the provider identity and byte-fetch model id', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('A0A0H3JZA8'))
      .mockResolvedValueOnce(
        sidecarAfdbHit('A0A0H3JZA8', 31.47, {
          latestVersion: 6,
          cifUrl: 'https://alphafold.ebi.ac.uk/files/AF-A0A0H3JZA8-F1-model_v6.cif',
        })
      );

    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);

    expect(result?.structure).toMatchObject({
      kind: 'uniprot',
      accession: 'A0A0H3JZA8',
      providerIdentityKey: 'AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6',
      fragment: 'F1',
      version: 'V6',
      modelId: 'AF-A0A0H3JZA8-F1-model_v6',
    });
    expect(result?.candidates?.[0].provenance.structureIdentity).toMatchObject({
      kind: 'alphafold',
      providerIdentityKey: 'AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6',
      version: 'V6',
      modelId: 'AF-A0A0H3JZA8-F1-model_v6',
    });
  });

  it('carries provider query and match evidence into candidate provenance', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P03817', true, [], '4BFC2ED15C60BB6BF4D68FC54F668B53'))
      .mockResolvedValueOnce(sidecarAfdbHit('P03817', 92.4));

    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);

    expect(result?.candidates?.[0].provenance).toMatchObject({
      sequenceIdentity: 1,
      externalProtein: {
        kind: 'uniprot',
        accession: 'P03817',
        reviewed: true,
        match: 'exact_sequence',
        checksumMd5: '4BFC2ED15C60BB6BF4D68FC54F668B53',
        rank: 0,
        rankReasons: ['checksum_match', 'reviewed'],
      },
      queryIdentity: {
        kind: 'protein_sequence',
        canonicalForm: 'waypoint-protein-v2',
        checksumMd5: '4BFC2ED15C60BB6BF4D68FC54F668B53',
        checksumSha256: MIOC_SHA256,
        ineligible: false,
        evidenceKinds: [],
      },
    });
  });

  it('rejects a renderer/sidecar canonicalization mismatch before using provider hits', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(bySequenceHit('P03817'));
    const request = identityRequest();
    request.proteinIdentity!.sequence.canonicalLookupSequence = `${MIOC_PROTEIN}A`;

    await expect(
      proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT, request)
    ).rejects.toMatchObject({
      name: 'CanonicalizationMismatchError',
    });
  });

  it('accepts a renderer-built request with Unicode whitespace when sidecar canonicalization matches', async () => {
    const request = requestFromQualifierTranslation('M\u00a0AD\u2003IT*');
    const canonical = 'MADIT';
    const checksumSha256 = await sha256Hex(canonical);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        bySequenceHit('P03817', true, [], 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', [], {
          canonicalSequence: canonical,
          checksumSha256,
        })
      )
      .mockResolvedValueOnce(sidecarAfdbHit('P03817', 92.4));

    const result = await proteinSequenceStep.resolve(request.translation, {}, ABORT, request);

    expect(request.translation).toBe(canonical);
    expect(result?.structure).toMatchObject({
      kind: 'uniprot',
      accession: 'P03817',
      providerIdentityKey: 'AF:P03817:F1:LATEST',
    });
    expect(result?.proteinIdentity?.sequence.canonicalizationStatus).toBe('sidecar_confirmed');
    expect(result?.proteinIdentity?.sequence.canonicalLookupSequence).toBe(canonical);
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body ?? '{}')).sequence).toBe(canonical);
  });

  it('keeps internal-stop renderer requests aligned with the sidecar and returns no exact hit', async () => {
    const request = requestFromQualifierTranslation('MA*D*');
    const canonical = 'MA*D';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      bySequenceMiss('', {
        canonicalSequence: '',
        normalizedLength: canonical.length,
        checksumSha256: '',
        ineligible: true,
        ineligibleReason: 'internal_stop',
        evidence: [{ kind: 'internal_stop', residue: '*' }],
      })
    );

    const result = await proteinSequenceStep.resolve(request.translation, {}, ABORT, request);

    expect(request.translation).toBe(canonical);
    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body ?? '{}'))).toMatchObject({
      sequence: canonical,
      canonical_form_hint: 'waypoint-protein-v2',
    });
  });

  it('still rejects sidecar ineligible responses that do not match the renderer internal-stop request', async () => {
    const request = requestFromQualifierTranslation('MA*D*');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      bySequenceMiss('', {
        canonicalSequence: '',
        normalizedLength: 3,
        checksumSha256: '',
        ineligible: true,
        ineligibleReason: 'internal_stop',
        evidence: [{ kind: 'internal_stop', residue: '*' }],
      })
    );

    await expect(
      proteinSequenceStep.resolve(request.translation, {}, ABORT, request)
    ).rejects.toMatchObject({
      name: 'CanonicalizationMismatchError',
    });
  });

  it('preserves non-standard residues in the renderer-built identity contract', async () => {
    const request = requestFromQualifierTranslation('MAUX*');
    const canonical = 'MAUX';
    const checksumSha256 = await sha256Hex(canonical);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        bySequenceHit('P0TEST', true, [], 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', [], {
          canonicalSequence: canonical,
          checksumSha256,
          evidence: [
            { kind: 'non_standard_residue', residue: 'U' },
            { kind: 'non_standard_residue', residue: 'X' },
          ],
        })
      )
      .mockResolvedValueOnce(sidecarAfdbHit('P0TEST', 65.2));

    const result = await proteinSequenceStep.resolve(request.translation, {}, ABORT, request);

    expect(request.translation).toBe(canonical);
    expect(result?.proteinIdentity?.sequence.canonicalLookupSequence).toBe(canonical);
    expect(result?.candidates?.[0].provenance.queryIdentity?.evidenceKinds).toEqual([
      'non_standard_residue',
      'non_standard_residue',
    ]);
  });

  it('confidence note omits pLDDT when AFDB does not report it', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P03817'))
      .mockResolvedValueOnce(sidecarAfdbHit('P03817'));
    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);
    expect(result?.confidenceNote).toBe('Exact protein-sequence match (predicted)');
  });

  it('prefers PDB (experimental) over AFDB (predicted) when UniProt entry has solved structures', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P03817', true, ['1XYZ', '2ABC']))
      .mockResolvedValueOnce(sidecarAfdbHit('P03817', 92.4))
      .mockResolvedValueOnce(rcsbFetchHit('1XYZ'))
      .mockResolvedValueOnce(rcsbFetchHit('2ABC'));
    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);
    expect(result).not.toBeNull();
    expect(result?.source).toBe('protein_sequence');
    expect(result?.identity).toBe(1.0);
    expect(result?.structure).toEqual({
      kind: 'pdb',
      pdbId: '1XYZ',
      providerIdentityKey: 'RCSB:1XYZ:ENTRY',
      labelAsymIds: undefined,
      uniprotFallback: { accession: 'P03817' },
    });
    expect(result?.confidenceNote).toMatch(/Experimental structure 1XYZ/);
    expect(result?.confidenceNote).toMatch(/1 more available/);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('returns a ranked candidate set for every PDB xref plus the AFDB alternate', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        bySequenceHit('P00880', true, ['1RLC', '1RBL'], 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF', [
          {
            pdb_id: '1RLC',
            method: 'X-ray',
            resolution: 2.7,
            chains: ['A'],
            raw_properties: { Resolution: '2.70 A', Chains: 'A=1-150' },
          },
          {
            pdb_id: '1RBL',
            method: 'X-ray',
            resolution: 2.2,
            chains: ['A', 'B'],
            raw_properties: { Resolution: '2.20 A', Chains: 'A=1-150, B=1-150' },
          },
        ])
      )
      .mockResolvedValueOnce(sidecarAfdbHit('P00880', 91.4))
      .mockResolvedValueOnce(rcsbFetchHit('1RLC', { resolution: 2.7, chain_ids: ['A'] }))
      .mockResolvedValueOnce(rcsbFetchHit('1RBL', { resolution: 2.2, chain_ids: ['A', 'B'] }));

    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);

    expect(result?.recommendedCandidateId).toBe('rcsb:RCSB:1RBL:ENTRY:AUTH_ASYM:A,B:all');
    expect(result?.structure).toEqual({
      kind: 'pdb',
      pdbId: '1RBL',
      providerIdentityKey: 'RCSB:1RBL:ENTRY:AUTH_ASYM:A,B',
      labelAsymIds: undefined,
      authAsymIds: ['A', 'B'],
      uniprotFallback: { accession: 'P00880' },
    });
    expect(result?.candidates?.map((row) => row.id)).toEqual([
      'rcsb:RCSB:1RBL:ENTRY:AUTH_ASYM:A,B:all',
      'rcsb:RCSB:1RLC:ENTRY:AUTH_ASYM:A:all',
      'alphafold:AF:P00880:F1:LATEST:all',
    ]);
    expect(result?.candidates?.[0].metadata).toMatchObject({
      pdbId: '1RBL',
      method: 'X-ray',
      resolution: 2.2,
      chainIds: ['A', 'B'],
    });
    expect(result?.candidates?.[2]).toMatchObject({
      provider: 'alphafold',
      metadata: {
        uniprotAccession: 'P00880',
        meanPlddt: 91.4,
      },
    });
  });

  it('preserves case-sensitive UniProt PDB xref author chains as distinct RCSB scopes', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        bySequenceHit('P00880', true, ['1ABC'], 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF', [
          {
            pdb_id: '1ABC',
            method: 'X-ray',
            resolution: 1.9,
            chains: ['a'],
            raw_properties: { Resolution: '1.90 A', Chains: 'a=1-150' },
          },
          {
            pdb_id: '1ABC',
            method: 'X-ray',
            resolution: 1.9,
            chains: ['A'],
            raw_properties: { Resolution: '1.90 A', Chains: 'A=1-150' },
          },
        ])
      )
      .mockResolvedValueOnce(sidecarAfdbHit('P00880', 91.4))
      .mockResolvedValueOnce(rcsbFetchHit('1ABC', { resolution: 1.9, chain_ids: ['a'] }))
      .mockResolvedValueOnce(rcsbFetchHit('1ABC', { resolution: 1.9, chain_ids: ['A'] }));

    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);

    const pdbCandidates = result?.candidates?.filter((candidate) => candidate.provider === 'pdb');
    expect(pdbCandidates?.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining([
        'rcsb:RCSB:1ABC:ENTRY:AUTH_ASYM:a:all',
        'rcsb:RCSB:1ABC:ENTRY:AUTH_ASYM:A:all',
      ])
    );
    expect(pdbCandidates).toHaveLength(2);
    expect(pdbCandidates?.map((candidate) => candidate.structure)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerIdentityKey: 'RCSB:1ABC:ENTRY:AUTH_ASYM:a',
          authAsymIds: ['a'],
        }),
        expect.objectContaining({
          providerIdentityKey: 'RCSB:1ABC:ENTRY:AUTH_ASYM:A',
          authAsymIds: ['A'],
        }),
      ])
    );

    const externalFetchBodies = fetchSpy.mock.calls
      .map((call) => JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}')))
      .filter((body) => body.provider === 'rcsb');
    expect(externalFetchBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ external_id: 'RCSB:1ABC:ENTRY:AUTH_ASYM:a' }),
        expect.objectContaining({ external_id: 'RCSB:1ABC:ENTRY:AUTH_ASYM:A' }),
      ])
    );
  });

  it('returns a sidecar-confirmed protein identity ledger with external protein and structure identities', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        bySequenceHit('P00880', true, ['1RBL'], 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF', [
          {
            pdb_id: '1RBL',
            method: 'X-ray',
            resolution: 2.2,
            chains: ['A', 'B'],
          },
        ])
      )
      .mockResolvedValueOnce(sidecarAfdbHit('P00880', 91.4))
      .mockResolvedValueOnce(rcsbFetchHit('1RBL'));

    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT, identityRequest());

    expect(result?.proteinIdentity?.sequence).toMatchObject({
      canonicalizationStatus: 'sidecar_confirmed',
      canonicalLookupSequence: MIOC_PROTEIN,
      digests: {
        md5: 'DEADBEEFDEADBEEFDEADBEEFDEADBEEF',
        sha256: MIOC_SHA256,
      },
    });
    expect(result?.proteinIdentity?.externalProteins).toEqual([
      expect.objectContaining({
        kind: 'uniprot',
        id: 'uniprot:P00880',
        accession: 'P00880',
        providerIdentityKey: 'P00880',
        match: 'exact_sequence',
        sequenceIdentity: 1,
      }),
    ]);
    expect(result?.proteinIdentity?.resolutionSets).toEqual([
      expect.objectContaining({
        selectedExternalProteinId: 'uniprot:P00880',
        matches: [expect.objectContaining({ id: 'uniprot:P00880', selected: true })],
      }),
    ]);
    expect(result?.proteinIdentity?.structures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'rcsb',
          id: 'RCSB:1RBL:ENTRY:AUTH_ASYM:A,B',
          pdbId: '1RBL',
          providerIdentityKey: 'RCSB:1RBL:ENTRY:AUTH_ASYM:A,B',
          labelAsymIds: undefined,
          authAsymIds: ['A', 'B'],
        }),
        expect.objectContaining({
          kind: 'alphafold',
          id: 'AF:P00880:F1:LATEST',
          accession: 'P00880',
          providerIdentityKey: 'AF:P00880:F1:LATEST',
          fragment: 'F1',
          version: 'LATEST',
        }),
      ])
    );
    expect(result?.candidates?.map((candidate) => candidate.provenance.structureIdentity)).toEqual([
      expect.objectContaining({
        kind: 'rcsb',
        providerIdentityKey: 'RCSB:1RBL:ENTRY:AUTH_ASYM:A,B',
      }),
      expect.objectContaining({ kind: 'alphafold', providerIdentityKey: 'AF:P00880:F1:LATEST' }),
    ]);
  });

  it('enriches PDB candidates from the RCSB metadata provider', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P00880', true, ['1RBL']))
      .mockResolvedValueOnce(sidecarAfdbHit('P00880', 91.4))
      .mockResolvedValueOnce(
        rcsbFetchHit('1RBL', {
          title: 'Ribulose bisphosphate carboxylase',
          resolution: 2.2,
        })
      );

    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);

    expect(result?.candidates?.[0]).toMatchObject({
      id: 'rcsb:RCSB:1RBL:ENTRY:all',
      metadata: {
        title: 'Ribulose bisphosphate carboxylase',
        method: 'X-ray',
        resolution: 2.2,
        chainIds: ['A', 'B'],
        sourceUrl: 'https://www.rcsb.org/structure/1RBL',
        license: 'CC0-1.0',
        attribution: 'RCSB Protein Data Bank; PDB ID 1RBL',
      },
      provenance: {
        externalResourceId: 'resource-1RBL',
        cacheHit: false,
      },
    });
  });

  it('still returns a valid PDB candidate when optional RCSB metadata enrichment fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P00880', true, ['1RBL']))
      .mockResolvedValueOnce(sidecarAfdbMiss())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: { error: 'provider_error' } }), { status: 502 })
      );

    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);

    expect(result?.structure).toEqual({
      kind: 'pdb',
      pdbId: '1RBL',
      providerIdentityKey: 'RCSB:1RBL:ENTRY',
      labelAsymIds: undefined,
      authAsymIds: undefined,
    });
    expect(result?.candidates?.[0].provenance.externalResourceId).toBeUndefined();
  });

  it('prefer-PDB still returns when AFDB has no prediction for the same accession', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P03817', true, ['1XYZ']))
      .mockResolvedValueOnce(sidecarAfdbMiss())
      .mockResolvedValueOnce(rcsbFetchHit('1XYZ'));
    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);
    expect(result?.structure).toEqual({
      kind: 'pdb',
      pdbId: '1XYZ',
      providerIdentityKey: 'RCSB:1XYZ:ENTRY',
      labelAsymIds: undefined,
    });
    expect((result?.structure as { uniprotFallback?: unknown }).uniprotFallback).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('prefer-PDB still falls through when AFDB validation is transiently unavailable', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P03817', true, ['1XYZ']))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: { error: 'circuit_open' } }), { status: 503 })
      )
      .mockResolvedValueOnce(rcsbFetchHit('1XYZ'));

    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);

    expect(result?.structure).toEqual({
      kind: 'pdb',
      pdbId: '1XYZ',
      providerIdentityKey: 'RCSB:1XYZ:ENTRY',
      labelAsymIds: undefined,
    });
  });

  it('prefer-PDB confidence note has no "more available" suffix when only one PDB entry', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P03817', true, ['1XYZ']))
      .mockResolvedValueOnce(sidecarAfdbHit('P03817'))
      .mockResolvedValueOnce(rcsbFetchHit('1XYZ'));
    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);
    expect(result?.confidenceNote).toBe(
      'Experimental structure 1XYZ · exact protein-sequence match'
    );
  });

  it('falls back to AFDB when UniProt entry exists but pdb_ids is empty', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P03817', true, []))
      .mockResolvedValueOnce(sidecarAfdbHit('P03817', 91.2));
    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);
    expect(result?.structure).toMatchObject({
      kind: 'uniprot',
      accession: 'P03817',
      providerIdentityKey: 'AF:P03817:F1:LATEST',
    });
    expect(result?.confidenceNote).toMatch(/predicted/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('propagates AFDB provider outages for exact sequence hits without PDB candidates', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P03817', true, []))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: { error: 'provider_error' } }), { status: 502 })
      );

    await expect(proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT)).rejects.toMatchObject({
      name: 'SidecarProviderError',
    });
  });

  it('hints object is ignored — step works for an empty hints record', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P03817'))
      .mockResolvedValueOnce(sidecarAfdbHit('P03817', 88.0));
    const result = await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);
    expect(result?.structure).toMatchObject({
      kind: 'uniprot',
      accession: 'P03817',
      providerIdentityKey: 'AF:P03817:F1:LATEST',
    });
  });

  it('sends POST to /external/uniprot/by-sequence with the translation in the body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(bySequenceHit('P03817'))
      .mockResolvedValueOnce(sidecarAfdbHit('P03817'));
    await proteinSequenceStep.resolve(MIOC_PROTEIN, {}, ABORT);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/external/uniprot/by-sequence');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body ?? '{}'));
    expect(body.sequence).toBe(MIOC_PROTEIN);
  });
});
