// @vitest-environment node

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildCustomGeneticCode,
  parseGenBankFull,
  type Annotation,
} from '@waypoint/sequence-utils';
import { buildResidueSelectionForCdsCodon } from '@waypoint/workspace-editor';
import {
  buildStructureDrawerRequestFromAnnotation,
  buildStructureDrawerRequestFromCds,
  buildStructureDrawerRequestFromIndexedCds,
  buildStructureDrawerRequestFromProteinEntity,
} from './build-structure-request';

const REPO_ROOT = join(__dirname, '../../../../../..');
const MG1655_COMPLETE = join(
  REPO_ROOT,
  'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb'
);

function md5(protein: string): string {
  return createHash('md5').update(protein).digest('hex').toUpperCase();
}

let parsedFixture: ReturnType<typeof parseGenBankFull> | null = null;
function fixture() {
  parsedFixture ??= parseGenBankFull(readFileSync(MG1655_COMPLETE, 'utf8'));
  return parsedFixture;
}

function featureByGene(type: string, gene: string): Annotation {
  const parsed = fixture();
  const annotation = parsed.annotations.find(
    (candidate) => candidate.type === type && candidate.qualifiers?.gene?.[0] === gene
  );
  if (!annotation) throw new Error(`Missing MG1655 ${type} fixture for /gene="${gene}"`);
  return annotation;
}

function cdsByGene(gene: string): Annotation {
  return featureByGene('CDS', gene);
}

function ncRnaByGene(gene: string): Annotation {
  return featureByGene('ncRNA', gene);
}

function withoutQualifierTranslation(cds: Annotation): Annotation {
  const { translation: _translation, ...rest } = cds.qualifiers ?? {};
  return { ...cds, qualifiers: rest };
}

describe('buildStructureDrawerRequestFromCds', () => {
  it.each([
    {
      name: 'locus tag precedence',
      annotationName: 'visible CDS label',
      qualifiers: {
        locus_tag: ['LOCUS_001'],
        gene: ['dnaG'],
        product: ['DNA primase'],
        translation: ['MA'],
      },
      featureKey: 'LOCUS_001',
      direction: 1 as const,
    },
    {
      name: 'gene precedence without locus tag',
      annotationName: 'visible CDS label',
      qualifiers: { gene: ['dnaG'], product: ['DNA primase'], translation: ['MA'] },
      featureKey: 'dnaG',
      direction: 1 as const,
    },
    {
      name: 'product precedence over visible label',
      annotationName: 'M744_RS09680',
      qualifiers: { product: ['DNA primase'], translation: ['MA'] },
      featureKey: 'DNA primase',
      direction: 1 as const,
    },
    {
      name: 'visible label fallback',
      annotationName: 'reverse-visible-name',
      qualifiers: { translation: ['MA'] },
      featureKey: 'reverse-visible-name',
      direction: -1 as const,
    },
  ])(
    'carries the same translated-CDS molecule identity as sequence selection: $name',
    ({ annotationName, qualifiers, featureKey, direction }) => {
      const cds: Annotation = {
        type: 'CDS',
        name: annotationName,
        label: annotationName,
        start: 1,
        end: 6,
        direction,
        qualifiers,
      };
      const request = buildStructureDrawerRequestFromCds({
        cds,
        sequence: {
          id: '/fixtures/product-locus-alias.gb',
          name: 'product-locus-alias.gb',
          sequence: 'ATGGCT',
          annotations: [cds],
          circular: false,
        },
        entityId: '/fixtures/product-locus-alias.gb',
      });
      const selection = buildResidueSelectionForCdsCodon({
        referenceId: '/fixtures/product-locus-alias.gb',
        cds,
        codon: direction === 1 ? { start: 0, end: 2, strand: 1 } : { start: 3, end: 5, strand: -1 },
        fullSequence: 'ATGGCT',
      });

      expect(request).toMatchObject({
        cdsLabel: annotationName,
        residueMolecule: {
          moleculeId: `translated-cds:/fixtures/product-locus-alias.gb:${featureKey}:1-6:${direction}`,
          moleculeKind: 'translated-cds',
          label: featureKey,
        },
      });
      expect(selection?.target).toMatchObject(request?.residueMolecule ?? {});
    }
  );

  it('reports consecutive stops instead of issuing inconsistent protein identities', () => {
    const cds: Annotation = {
      type: 'CDS',
      name: 'overrun',
      start: 1,
      end: 12,
      direction: 1,
      qualifiers: { translation: ['MA**'] },
    };
    const request = buildStructureDrawerRequestFromCds({
      cds,
      sequence: { id: 'overrun', name: 'overrun', sequence: 'ATGGCTTAATAA', annotations: [cds] },
    });
    expect(request?.refusal?.code).toBe('internal_stop');
    expect(request?.refusal?.message).toContain('stop');
  });

  it('builds an ARSC request whose translation is the provider-confirmed positive checksum', () => {
    const parsed = fixture();
    const request = buildStructureDrawerRequestFromCds({
      cds: cdsByGene('arsC'),
      sequence: parsed,
      entityId: '/fixtures/mg1655.gb',
    });

    expect(request?.cdsLabel).toBe('arsC');
    expect(request?.translation.slice(0, 12)).toBe('MSNITIYHNPAC');
    expect(md5(request!.translation)).toBe('3B0FB4D862F55919DA7D85A871902311');
    expect(request?.entityId).toBe('/fixtures/mg1655.gb');
    expect(request?.proteinIdentity?.schemaVersion).toBe(2);
    expect(request?.proteinIdentity?.feature?.label).toBe('arsC');
    expect(request?.proteinIdentity?.sequence.lookupSequence).toBe(request?.translation);
    expect(request?.proteinIdentity?.sequence.canonicalizationStatus).toBe('renderer_preflight');
    expect(request?.proteinIdentity?.sequence.identityKey).toMatch(
      /^protein-sequence:v2:[0-9a-f]{64}$/
    );
    expect(request?.identityRequestKey).toBe(
      `req:${request?.proteinIdentity?.feature?.featureKey}:${request?.proteinIdentity?.sequence.identityKey}`
    );
    expect(request?.proteinIdentity?.evidence.map((item) => item.kind)).toContain(
      'qualifier_translation'
    );
  });

  it('derives the same ARSC checksum from coordinates when the CDS carries no /translation', () => {
    const parsed = fixture();
    const request = buildStructureDrawerRequestFromCds({
      cds: withoutQualifierTranslation(cdsByGene('arsC')),
      sequence: parsed,
      entityId: '/fixtures/mg1655.gb',
    });

    expect(request?.translation.slice(0, 12)).toBe('MSNITIYHNPAC');
    expect(md5(request!.translation)).toBe('3B0FB4D862F55919DA7D85A871902311');
    expect(request?.proteinIdentity?.evidence.map((item) => item.kind)).toContain(
      'derived_cds_translation'
    );
  });

  it('normalizes alternative bacterial start codons before the resolver sees the request', () => {
    const parsed = fixture();
    const cds = cdsByGene('hdfR');
    const request = buildStructureDrawerRequestFromCds({
      cds: withoutQualifierTranslation(cds),
      sequence: parsed,
      entityId: '/fixtures/mg1655.gb',
    });

    expect(request?.translation.slice(0, 12)).toBe('MDTELLKTFLEV');
    expect(md5(request!.translation)).toBe('389F3509DC3F8A27217AAA42C7C4CC36');
    expect(request?.proteinIdentity?.sequence.rawSequence?.slice(0, 3)).toBe('VDT');
    expect(request?.proteinIdentity?.sequence.initiatorNormalized).toBe(true);
    expect(request?.proteinIdentity?.evidence.map((item) => item.kind)).toContain(
      'initiator_normalization'
    );

    const fromQualifier = buildStructureDrawerRequestFromCds({
      cds,
      sequence: parsed,
      entityId: '/fixtures/mg1655.gb',
    });
    expect(fromQualifier?.translation).toBe(request?.translation);
  });

  it('builds an RNA structure request from a real MG1655 ncRNA feature without protein identity', () => {
    const parsed = fixture();
    const request = buildStructureDrawerRequestFromAnnotation({
      annotation: ncRnaByGene('ffs'),
      sequence: parsed,
      entityId: '/fixtures/mg1655.gb',
    });

    expect(request).toMatchObject({
      translation: expect.stringMatching(/^GGGGGCUCUGUUGGUUCUCCCGCAACGCUACUCUGUUUAC/),
      moleculeType: 'rna',
      cdsLabel: 'ffs',
      entityId: '/fixtures/mg1655.gb',
      hints: {},
    });
    expect(request?.translation.length).toBe(114);
    expect(request?.translation.endsWith('AGCUGGCAGGGCCCCCACCC')).toBe(true);
    expect(request?.proteinIdentity).toBeUndefined();
    expect(request?.identityRequestKey).toMatch(/^req:feature:v2:[0-9a-f]{64}:rna-sequence:v1$/);
  });

  it('reverse-complements a real MG1655 antisense RNA feature before RCSB lookup', () => {
    const parsed = fixture();
    const request = buildStructureDrawerRequestFromAnnotation({
      annotation: ncRnaByGene('oxyS'),
      sequence: parsed,
      entityId: '/fixtures/mg1655.gb',
    });

    expect(request?.cdsLabel).toBe('oxyS');
    expect(request?.moleculeType).toBe('rna');
    expect(request?.translation.slice(0, 40)).toBe('GAAACGGAGCGGCACCUCUUUUAACCCUUGAAGUCACUGC');
    expect(request?.translation.length).toBe(117);
    expect(request?.translation.endsWith('GCGGAUCUCCAGGAUCCGCUUUUUUUU')).toBe(true);
    expect(request?.proteinIdentity).toBeUndefined();
  });

  it('does not build RNA requests for features too short for RCSB sequence search', () => {
    const request = buildStructureDrawerRequestFromAnnotation({
      annotation: { type: 'tRNA', name: 'short RNA', start: 1, end: 12, direction: 1 },
      sequence: {
        id: 'rna-fixture',
        name: 'rna-fixture',
        sequence: 'ACGTACGTACGT',
        annotations: [],
        circular: false,
      },
    });

    expect(request).toBeNull();
  });
});

describe('buildStructureDrawerRequestFromProteinEntity  slice 1.4)', () => {
  const GFP =
    'MSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKLTLKFICTTGKLPVPWPTLVTTLTYGVQCFSRYPDHMKQHDFFKSAMPEGYVQERTIFFKDDGNYKTRAEVKFEGDTLVNRIELKGIDFKEDGNILGHKLEYNYNSHNVYIMADKQKNGIKVNFKIRHNIEDGSVQLADHYQQNTPIGDGPVLLPDNHYLSTQSALSKDPNEKRDHMVLLEFVTAAGITHGMDELYK';

  it('builds a request with no cdsBounds/no strand, identity keyed by entity id', () => {
    const request = buildStructureDrawerRequestFromProteinEntity({
      entityId: 'aa000001',
      aaSequence: GFP,
      label: 'GFP',
    });

    expect(request).not.toBeNull();
    expect(request?.translation).toBe(GFP);
    expect(request?.entityId).toBe('aa000001');
    expect(request?.cdsBounds).toBeUndefined();
    expect(request?.proteinIdentity?.sequence.source).toBe('standalone_protein_entity');
    expect(request?.residueMolecule?.moleculeKind).toBe('protein');
    expect(request?.residueMolecule?.moleculeId).toContain('aa000001');
  });

  it('gives two different entity ids with the SAME sequence distinct residueMolecule ids', () => {
    const a = buildStructureDrawerRequestFromProteinEntity({
      entityId: 'aa000001',
      aaSequence: GFP,
    });
    const b = buildStructureDrawerRequestFromProteinEntity({
      entityId: 'aa000002',
      aaSequence: GFP,
    });

    expect(a?.residueMolecule?.moleculeId).not.toBe(b?.residueMolecule?.moleculeId);
    expect(a?.proteinIdentity?.sequence.identityKey).toBe(b?.proteinIdentity?.sequence.identityKey);
  });

  it('returns null for an empty/invalid amino-acid sequence', () => {
    expect(
      buildStructureDrawerRequestFromProteinEntity({ entityId: 'aa000001', aaSequence: '' })
    ).toBeNull();
  });
});

describe('a protein that is not standard amino acids', () => {
  const amber = (() => {
    const built = buildCustomGeneticCode({
      id: 'gc-3f2a9c1e',
      revision: 1,
      name: 'Amber suppression (pAzF at TAG)',
      base: 11,
      changes: { TAG: { kind: 'residue', residue: 'pAzF' } },
      residues: [{ abbreviation: 'pAzF', name: 'p-azido-L-phenylalanine', ccd: 'AZF' }],
    });
    if (!built.ok) throw new Error('fixture must build');
    return built.definition;
  })();

  const sequence = 'ATGAAATAGAAATAA';
  const cds: Annotation = { name: 'amberGene', type: 'CDS', start: 1, end: 15, direction: 1 };

  function record(chosenGeneticCode?: typeof amber) {
    return {
      id: 'amber',
      name: 'amber',
      sequence,
      length: sequence.length,
      annotations: [cds],
      circular: false,
      ...(chosenGeneticCode ? { chosenGeneticCode } : {}),
    };
  }

  it('refuses prediction and names the position, rather than predicting on X', () => {
    const request = buildStructureDrawerRequestFromCds({
      cds,
      sequence: record(amber),
      entityId: 'amber',
    });
    expect(request?.refusal).toMatchObject({ code: 'non_standard_residues' });
    expect(request?.refusal?.message).toMatch(/position 3/i);
    expect(request?.refusal?.message).toMatch(/Amber suppression \(pAzF at TAG\)/);
  });

  it('does not refuse the same record read on a published code', () => {
    const request = buildStructureDrawerRequestFromCds({
      cds,
      sequence: record(),
      entityId: 'amber',
    });
    expect(request?.refusal).toBeUndefined();
  });
});

describe('buildStructureDrawerRequestFromIndexedCds', () => {
  const cds: Annotation = {
    id: 'JUN.cds.1',
    name: 'NM_002228.4',
    type: 'CDS',
    start: 58782076,
    end: 58783070,
    direction: -1,
    qualifiers: { gene: ['JUN'], protein_id: ['NP_002219.1'] },
  } as Annotation;
  const location = {
    referenceId: 'grch38',
    chrom: 'chr1',
    start0: 58782075,
    end0: 58783070,
    strand: -1 as const,
  };

  it('builds a request from the spliced translation, dropping one trailing stop', () => {
    const request = buildStructureDrawerRequestFromIndexedCds({
      cds,
      protein: 'MTAKMETTFYDDALNASFLPSESGPYGYSNPKIL*',
      location,
      entityId: 'indexed-genome:tab-1',
    });
    expect(request?.translation).toBe('MTAKMETTFYDDALNASFLPSESGPYGYSNPKIL');
    expect(request?.entityId).toBe('indexed-genome:tab-1');
    expect(request?.hints.geneName).toBe('JUN');
    expect(request?.cdsBounds).toBeUndefined();
    expect(request?.residueMolecule).toBeUndefined();
  });

  it('refuses a protein with an internal stop', () => {
    expect(
      buildStructureDrawerRequestFromIndexedCds({
        cds,
        protein: 'MTAK*METT',
        location,
        entityId: 'indexed-genome:tab-1',
      })
    ).toBeNull();
  });

  it('keys the feature by reference and location, so two loci never share a request', () => {
    const a = buildStructureDrawerRequestFromIndexedCds({
      cds,
      protein: 'MTAKMETT',
      location,
      entityId: 'indexed-genome:tab-1',
    });
    const b = buildStructureDrawerRequestFromIndexedCds({
      cds,
      protein: 'MTAKMETT',
      location: { ...location, chrom: 'chr2' },
      entityId: 'indexed-genome:tab-1',
    });
    expect(a?.identityRequestKey).not.toBe(b?.identityRequestKey);
  });
});
