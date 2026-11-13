import { describe, expect, it } from 'vitest';

import { HOSTED_REFERENCE_CATALOG_V1 } from './hosted-reference-catalog';
import {
  matureHostedPreparedReferenceSemanticsV1,
  maturePreparedReferenceSemanticsV1,
} from './reference-semantic-maturation';
import {
  REFERENCE_PREPARATION_MANIFEST_V2,
  type LoadedReferencePreparationManifestV2,
} from './reference-preparation-manifest-v2';

const ASSEMBLY_IDENTITY = 'a'.repeat(64);

function hosted(id: string) {
  const definition = HOSTED_REFERENCE_CATALOG_V1.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Missing hosted test definition ${id}.`);
  return definition;
}

describe('hosted reference semantic maturation', () => {
  it('binds reviewed holocentric semantics to the exact prepared assembly identity', () => {
    const semantics = matureHostedPreparedReferenceSemanticsV1(
      hosted('ce11'),
      ASSEMBLY_IDENTITY,
      []
    );

    expect(semantics.assemblyIdentitySha256).toBe(ASSEMBLY_IDENTITY);
    expect(semantics.members.find(({ chrom }) => chrom === 'chrI')?.morphology).toEqual({
      kind: 'holocentric',
    });
    expect(semantics.members.find(({ chrom }) => chrom === 'chrM')?.morphology).toEqual({
      kind: 'generic-contig',
      reason: 'ineligible-member',
    });
  });

  it('reconciles duplicate producer GFF3 rows with the locked source catalog', () => {
    const semantics = matureHostedPreparedReferenceSemanticsV1(
      hosted('sacCer3'),
      ASSEMBLY_IDENTITY,
      [
        { sourceSeqId: 'NC_001133.9', type: 'centromere', start: 151_465, end: 151_582 },
        { sourceSeqId: 'NC_001133.9', type: 'SO:0000577', start: 151_465, end: 151_582 },
      ]
    );

    expect(semantics.members.find(({ chrom }) => chrom === 'chrI')?.morphology).toEqual({
      kind: 'localized',
      interval: { startBp: 151_464, endBp: 151_582 },
      topology: 'internal',
    });
  });

  it('fails closed when producer rows conflict with locked evidence', () => {
    const semantics = matureHostedPreparedReferenceSemanticsV1(
      hosted('sacCer3'),
      ASSEMBLY_IDENTITY,
      [{ sourceSeqId: 'NC_001133.9', type: 'centromere', start: 151_400, end: 151_500 }]
    );

    expect(semantics.members.find(({ chrom }) => chrom === 'chrI')?.morphology).toEqual({
      kind: 'generic-contig',
      reason: 'conflicting-evidence',
    });
  });

  it('rejects candidates that are not bound to an exact hosted member', () => {
    expect(() =>
      matureHostedPreparedReferenceSemanticsV1(hosted('ce11'), ASSEMBLY_IDENTITY, [
        { sourceSeqId: 'not-in-assembly', type: 'centromere', start: 1, end: 2 },
      ])
    ).toThrow(/unknown source sequence/i);
  });

  it('keeps unsupported hosted assemblies explicitly generic', () => {
    const semantics = matureHostedPreparedReferenceSemanticsV1(
      hosted('xenTro10'),
      ASSEMBLY_IDENTITY,
      []
    );

    expect(semantics.members.every(({ morphology }) => morphology.kind === 'generic-contig')).toBe(
      true
    );
  });
});

describe('prepared reference semantic maturation', () => {
  function preparation(sourceUrl?: string): LoadedReferencePreparationManifestV2 {
    return {
      contract: REFERENCE_PREPARATION_MANIFEST_V2,
      manifestPath: '/private/reference.v2.json',
      assemblyIdentity: {
        contract: 'dnaforge-reference-assembly-identity.v2',
        sha256: ASSEMBLY_IDENTITY,
      },
      identityContigs: [
        {
          sourceSeqId: 'NC_test.1',
          lengthBp: 1_000,
          circular: false,
          normalizedSequenceSha256: 'b'.repeat(64),
        },
      ],
      source: {
        fastaPath: '/private/reference.fna.gz',
        fastaSha256: 'c'.repeat(64),
        gffPath: '/private/reference.gff3.gz',
        gffSha256: 'd'.repeat(64),
      },
      provenance: {
        provider: 'Test provider',
        datasetId: 'GCF_test.1',
        datasetVersion: '1',
        sourceUrl,
      },
      entry: {
        id: `local-${ASSEMBLY_IDENTITY.slice(0, 24)}`,
        name: 'Test assembly',
        organism: 'Test organism',
        description: 'Test assembly',
        assetCacheKey: `local-${ASSEMBLY_IDENTITY.slice(0, 24)}`,
        members: [
          {
            chrom: 'chr1',
            displayName: '1',
            lengthBp: 1_000,
            role: 'assembled-molecule',
            circular: false,
            importSource: {
              fastaPath: '/private/reference.fna.gz',
              fastaSha256: 'c'.repeat(64),
              gffPath: '/private/reference.gff3.gz',
              gffSha256: 'd'.repeat(64),
              sourceSeqId: 'NC_test.1',
            },
            manifest: {
              fastaPath: 'prepared/chr1/chr1.fa.gz',
              faiPath: 'prepared/chr1/chr1.fa.gz.fai',
              gffPath: 'prepared/chr1/chr1.gff3.gz',
              tbiPath: 'prepared/chr1/chr1.gff3.gz.tbi',
            },
          },
        ],
      },
    };
  }

  it('admits locked producer candidates when their evidence has durable provenance', () => {
    const semantics = maturePreparedReferenceSemanticsV1(
      preparation('https://example.org/GCF_test.1/'),
      [{ sourceSeqId: 'NC_test.1', type: 'centromere', start: 401, end: 500 }]
    );

    expect(semantics.assemblyIdentitySha256).toBe(ASSEMBLY_IDENTITY);
    expect(semantics.evidence).toHaveLength(1);
    expect(semantics.members[0].morphology).toEqual({
      kind: 'localized',
      interval: { startBp: 400, endBp: 500 },
      topology: 'internal',
    });
  });

  it('fails closed to generic when candidate provenance is not durably citable', () => {
    const semantics = maturePreparedReferenceSemanticsV1(preparation(), [
      { sourceSeqId: 'NC_test.1', type: 'centromere', start: 401, end: 500 },
    ]);

    expect(semantics.evidence).toEqual([]);
    expect(semantics.members[0].morphology).toEqual({
      kind: 'generic-contig',
      reason: 'missing-semantics',
    });
  });
});
