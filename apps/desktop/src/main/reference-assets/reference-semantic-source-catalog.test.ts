import { describe, expect, it } from 'vitest';

import { HOSTED_REFERENCE_CATALOG_V1 } from './hosted-reference-catalog';
import {
  HOSTED_REFERENCE_PRE_MATURATION_COMPATIBILITY_V1,
  HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1,
  assertHostedReferenceSemanticCoverageV1,
  matureHostedReferenceSemanticsV1,
} from './reference-semantic-source-catalog';
import { requireContractToken, requireSafeId } from './reference-preparation-validation';

describe('hosted reference semantic source catalog', () => {
  it('covers every active hosted reference exactly once with exact assembly identity', () => {
    const reviewedIds = [
      ...HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1.map(({ id }) => id),
      ...Object.keys(HOSTED_REFERENCE_PRE_MATURATION_COMPATIBILITY_V1),
    ].sort();
    const hostedIds = HOSTED_REFERENCE_CATALOG_V1.map(({ id }) => id).sort();
    expect(reviewedIds.every((id) => hostedIds.includes(id))).toBe(true);
    expect(new Set(reviewedIds).size).toBe(reviewedIds.length);

    expect(() =>
      assertHostedReferenceSemanticCoverageV1(
        HOSTED_REFERENCE_CATALOG_V1,
        HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1
      )
    ).not.toThrow();

    const catalogById = new Map(HOSTED_REFERENCE_CATALOG_V1.map((entry) => [entry.id, entry]));
    for (const source of HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1) {
      expect(source.assemblyAccession).toBe(catalogById.get(source.id)?.provenance.datasetId);
      expect(source.evidence.length).toBeGreaterThan(0);
      expect(source.discoveryAudit).toMatchObject({
        contract: 'dnaforge-semantic-discovery-audit.v1',
        assemblyAccession: source.assemblyAccession,
        reviewedAt: '2026-09-17',
      });
      expect(source.discoveryAudit.evidenceIds).toEqual(source.evidence.map(({ id }) => id));
      expect(source.discoveryAudit.checks).toEqual(
        expect.arrayContaining([
          'producer-annotation',
          'ncbi-feature-table',
          'ncbi-assembly-gaps',
          'ncbi-ideogram',
          'ucsc-cytobands',
          'primary-literature',
          'organism-database',
        ])
      );
      for (const evidence of source.evidence) {
        expect(evidence.id.length).toBeGreaterThan(0);
        expect(evidence.sourceUrl).toMatch(/^https:\/\//);
        expect(() => requireSafeId(evidence.id, evidence.id)).not.toThrow();
        expect(() => requireContractToken(evidence.adapterContract, evidence.id)).not.toThrow();
      }
    }
  });

  it('fails closed for references activated before semantic maturation became mandatory', () => {
    for (const [id, assemblyAccession] of Object.entries(
      HOSTED_REFERENCE_PRE_MATURATION_COMPATIBILITY_V1
    )) {
      const definition = HOSTED_REFERENCE_CATALOG_V1.find((entry) => entry.id === id);
      expect(definition?.provenance.datasetId).toBe(assemblyAccession);
      if (!definition) throw new Error(`${id} missing from hosted catalog`);
      expect(
        matureHostedReferenceSemanticsV1(definition).members.every(
          ({ morphology }) => morphology.kind === 'generic-contig'
        )
      ).toBe(true);
    }
  });

  it('materializes one fail-closed semantic result for every published member', () => {
    for (const definition of HOSTED_REFERENCE_CATALOG_V1) {
      const semantics = matureHostedReferenceSemanticsV1(definition);
      expect(semantics.members.map(({ chrom }) => chrom)).toEqual(
        definition.contigs.map(({ chrom }) => chrom)
      );
      expect(semantics.members).toHaveLength(definition.contigs.length);
      expect(
        semantics.members.every(
          ({ morphology }) =>
            morphology.kind === 'localized' ||
            morphology.kind === 'localized-boundary' ||
            morphology.kind === 'schematic' ||
            morphology.kind === 'between-members' ||
            morphology.kind === 'holocentric' ||
            morphology.kind === 'unlocalized-centromere' ||
            morphology.kind === 'generic-contig'
        )
      ).toBe(true);
    }
  });

  it('renders C. elegans nuclear chromosomes as holocentric and its mitochondrion as generic', () => {
    const definition = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'ce11');
    if (!definition) throw new Error('ce11 missing from hosted catalog');
    const semantics = matureHostedReferenceSemanticsV1(definition);

    expect(
      semantics.members.filter(({ chrom }) => chrom !== 'chrM').map(({ morphology }) => morphology)
    ).toEqual(Array.from({ length: 6 }, () => ({ kind: 'holocentric' })));
    expect(semantics.members.find(({ chrom }) => chrom === 'chrM')?.morphology).toEqual({
      kind: 'generic-contig',
      reason: 'ineligible-member',
    });
  });

  it('resolves localized centromeres from every currently admitted exact source', () => {
    const expectedLocalized = new Map([
      ['grch38', 24],
      ['hs1', 24],
      ['sacCer3', 16],
      ['mm39', 21],
      ['rn8', 17],
      ['rheMac10', 21],
      ['grcz12tu', 25],
      ['tair10', 5],
      ['agis1', 12],
      ['t2tMmu8v2', 22],
      ['mPanTro3v21', 25],
      ['mGorGor1v21', 25],
      ['pombeAsm294v3', 3],
      ['xenLae10', 18],
    ]);

    for (const [id, expectedCount] of expectedLocalized) {
      const definition = HOSTED_REFERENCE_CATALOG_V1.find((entry) => entry.id === id);
      if (!definition) throw new Error(`${id} missing from hosted catalog`);
      const semantics = matureHostedReferenceSemanticsV1(definition);
      expect(
        semantics.members.filter(({ morphology }) => morphology.kind === 'localized')
      ).toHaveLength(expectedCount);
    }

    const mm39 = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'mm39');
    if (!mm39) throw new Error('mm39 missing from hosted catalog');
    const mm39Semantics = matureHostedReferenceSemanticsV1(mm39);
    expect(mm39Semantics.members.find(({ chrom }) => chrom === 'chr1')?.morphology).toMatchObject({
      kind: 'localized',
      topology: 'terminal-start',
    });
    expect(mm39Semantics.members.find(({ chrom }) => chrom === 'chrY')?.morphology).toMatchObject({
      kind: 'localized',
      topology: 'internal',
    });

    const rn8 = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'rn8');
    if (!rn8) throw new Error('rn8 missing from hosted catalog');
    const rn8Semantics = matureHostedReferenceSemanticsV1(rn8);
    expect(rn8Semantics.members.find(({ chrom }) => chrom === 'chr2')?.morphology).toEqual({
      kind: 'localized',
      interval: { startBp: 2_500_000, endBp: 3_000_000 },
      topology: 'terminal-start',
    });
    expect(rn8Semantics.members.find(({ chrom }) => chrom === 'chr14')?.morphology).toEqual({
      kind: 'localized',
      interval: { startBp: 48_500_000, endBp: 52_500_000 },
      topology: 'internal',
    });
    const expectedSchematic = new Map([
      ['chr1', 'submetacentric'],
      ['chr3', 'acrocentric'],
      ['chr9', 'telocentric'],
      ['chr12', 'acrocentric'],
      ['chrY', 'telocentric'],
    ]);
    for (const [chrom, centromereClass] of expectedSchematic) {
      expect(rn8Semantics.members.find((member) => member.chrom === chrom)?.morphology).toEqual({
        kind: 'schematic',
        centromereClass,
        shortArmAt: 'start',
      });
    }
    expect(
      rn8Semantics.members
        .filter(({ chrom }) => chrom !== 'chrM' && chrom !== 'chrMT')
        .every(({ morphology }) => morphology.kind !== 'generic-contig')
    ).toBe(true);

    const rn7 = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'rn7');
    if (!rn7) throw new Error('rn7 missing from hosted catalog');
    const rn7Semantics = matureHostedReferenceSemanticsV1(rn7);
    expect(
      rn7Semantics.members.filter(({ morphology }) => morphology.kind === 'localized-boundary')
    ).toHaveLength(22);
    expect(rn7Semantics.members.find(({ chrom }) => chrom === 'chr1')?.morphology).toEqual({
      kind: 'localized-boundary',
      positionBp: 40_566_263,
      topology: 'internal',
    });
    expect(rn7Semantics.members.find(({ chrom }) => chrom === 'chr2')?.morphology).toEqual({
      kind: 'localized-boundary',
      positionBp: 0,
      topology: 'terminal-start',
    });

    const expectedExamples = [
      ['grcz12tu', 'chr1', 29_986_117, 32_748_083],
      ['tair10', 'chr1', 14_080_000, 15_610_000],
      ['agis1', 'chr1', 16_808_000, 17_441_000],
      ['t2tMmu8v2', 'chr1', 86_606_158, 103_987_289],
      ['mPanTro3v21', 'chr1', 101_355_931, 105_078_016],
      ['mPanTro3v21', 'chrY', 13_138_472, 14_429_665],
      ['mGorGor1v21', 'chr1', 108_411_325, 111_910_309],
      ['mGorGor1v21', 'chrY', 20_584_874, 24_867_439],
      ['pombeAsm294v3', 'chrI', 3_753_686, 3_789_421],
      ['xenLae10', 'chr1L', 96_582_536, 97_638_551],
    ] as const;
    for (const [id, chrom, startBp, endBp] of expectedExamples) {
      const definition = HOSTED_REFERENCE_CATALOG_V1.find((entry) => entry.id === id);
      if (!definition) throw new Error(`${id} missing from hosted catalog`);
      expect(
        matureHostedReferenceSemanticsV1(definition).members.find(
          (member) => member.chrom === chrom
        )?.morphology
      ).toEqual({ kind: 'localized', interval: { startBp, endBp }, topology: 'internal' });
    }

    for (const [id, chrom, aliasEvidenceId] of [
      ['mPanTro3v21', 'chr1', 'mPanTro3v21-t2t-alias-accessions'],
      ['mGorGor1v21', 'chr1', 'mGorGor1v21-t2t-alias-accessions'],
      ['xenLae10', 'chr1L', 'xenLae10-cenpa-genome-identity'],
    ] as const) {
      const definition = HOSTED_REFERENCE_CATALOG_V1.find((entry) => entry.id === id);
      if (!definition) throw new Error(`${id} missing from hosted catalog`);
      expect(
        matureHostedReferenceSemanticsV1(definition).members.find(
          (member) => member.chrom === chrom
        )?.properties[0]?.evidenceIds
      ).toContain(aliasEvidenceId);
    }
  });

  it('distinguishes unresolved-after-audit assemblies from resolved semantic coverage', () => {
    const unresolved = HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1.filter(
      ({ discoveryAudit }) => discoveryAudit.outcome === 'unresolved-after-audit'
    ).map(({ id }) => id);

    expect(unresolved.sort()).toEqual(
      [
        'canFam4',
        'danRer11',
        'equCabTbT2t',
        'grcg7b',
        'mOryCun11',
        'oarRambouilletV3',
        'xenTro10',
        'zmB73v5',
      ].sort()
    );
    expect(
      HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1.filter(
        ({ discoveryAudit }) => discoveryAudit.outcome === 'partially-resolved'
      )
        .map(({ id }) => id)
        .sort()
    ).toEqual(['dm6', 'rheMac10']);

    for (const id of [
      'canFam4',
      'danRer11',
      'equCabTbT2t',
      'grcg7b',
      'mOryCun11',
      'oarRambouilletV3',
      'xenTro10',
      'zmB73v5',
    ]) {
      const source = HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1.find(
        (candidate) => candidate.id === id
      );
      if (!source) throw new Error(`${id} missing from semantic catalog`);
      expect(source.memberSourcesByChrom).toEqual({});
      expect(source.evidence.map(({ kind }) => kind)).toEqual([
        'reviewed-assertion',
        'ucsc-cytobands',
        'ncbi-assembly-gaps',
      ]);
    }
  });

  it('models Drosophila split chromosome arms at their real member boundaries', () => {
    const definition = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'dm6');
    if (!definition) throw new Error('dm6 missing from hosted catalog');
    const semantics = matureHostedReferenceSemanticsV1(definition);

    expect(semantics.members.find(({ chrom }) => chrom === 'chr2L')?.morphology).toEqual({
      kind: 'between-members',
      groupId: 'chr2',
      side: 'right',
    });
    expect(semantics.members.find(({ chrom }) => chrom === 'chr2R')?.morphology).toEqual({
      kind: 'between-members',
      groupId: 'chr2',
      side: 'left',
    });
    for (const chrom of ['chr4', 'chrX', 'chrY']) {
      expect(semantics.members.find((member) => member.chrom === chrom)?.morphology).toEqual({
        kind: 'unlocalized-centromere',
      });
    }
    expect(semantics.members.find(({ chrom }) => chrom === 'chrM')?.morphology.kind).toBe(
      'generic-contig'
    );
  });

  it('rejects missing, duplicate, and stale hosted semantic catalog rows', () => {
    const first = HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1[0];
    const firstDefinition = HOSTED_REFERENCE_CATALOG_V1[0];
    expect(() =>
      assertHostedReferenceSemanticCoverageV1(
        HOSTED_REFERENCE_CATALOG_V1.filter((entry) => entry.id !== first.id),
        HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1
      )
    ).toThrow(/stale/i);
    expect(() =>
      assertHostedReferenceSemanticCoverageV1(HOSTED_REFERENCE_CATALOG_V1, [
        ...HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1,
        first,
      ])
    ).toThrow(/duplicate/i);
    expect(() =>
      assertHostedReferenceSemanticCoverageV1(HOSTED_REFERENCE_CATALOG_V1, [
        { ...first, assemblyAccession: `${firstDefinition.provenance.datasetId}.stale` },
        ...HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1.slice(1),
      ])
    ).toThrow(/assembly/i);
    expect(() =>
      assertHostedReferenceSemanticCoverageV1(HOSTED_REFERENCE_CATALOG_V1, [
        {
          ...first,
          discoveryAudit: {
            ...first.discoveryAudit,
            checks: first.discoveryAudit.checks.slice(1),
          },
        },
        ...HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1.slice(1),
      ])
    ).toThrow(/audit/i);
    expect(() =>
      assertHostedReferenceSemanticCoverageV1(HOSTED_REFERENCE_CATALOG_V1, [
        {
          ...first,
          discoveryAudit: {
            ...first.discoveryAudit,
            evidenceIds: first.discoveryAudit.evidenceIds.slice(1),
          },
        },
        ...HOSTED_REFERENCE_SEMANTIC_SOURCE_CATALOG_V1.slice(1),
      ])
    ).toThrow(/evidence/i);
  });
});
