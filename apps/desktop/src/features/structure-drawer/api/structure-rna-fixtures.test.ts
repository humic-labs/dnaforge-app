// @vitest-environment node

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  parseGenBankFull,
  type AnnotatedSequence,
  type Annotation,
} from '@waypoint/sequence-utils';
import { buildStructureDrawerRequestFromAnnotation } from './build-structure-request';

const REPO_ROOT = join(__dirname, '../../../../../..');
const MG1655_COMPLETE = join(
  REPO_ROOT,
  'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb'
);
const RNA_STRUCTURE_SEARCHES = join(
  REPO_ROOT,
  'test-fixtures/structure-complexes/mg1655-rna-structure-searches.json'
);
const RESULT_LISTINGS = join(
  REPO_ROOT,
  'test-fixtures/structure-complexes/mg1655-structure-result-listings.json'
);

const MG1655_SHA256 = '7cf1ed07c731a1aba11d2b12a7071f395b1a25b4e9a06809549742f83c2d1a2f';

type RnaFixtureCategory =
  | 'rna_only_query'
  | 'trna_query'
  | 'rrna_query'
  | 'protein_rna_cocomplex_query'
  | 'rna_no_pdb_no_alphafold'
  | 'rna_homologous_or_partial_provider_match';

interface RnaSearchFixtureCase {
  caseId: string;
  category: RnaFixtureCategory;
  queryKind: 'rna' | 'protein';
  annotationType: string;
  gene: string;
  locusTag: string;
  product: string;
  location: { start: number; end: number; strand: 1 | -1 };
  expectedQuerySequence?: { length: number; prefix: string; suffix: string };
  expectedRcsbSequenceSearch?: {
    sequenceType: 'rna';
    expectedHitCountClass: 'many' | 'some' | 'none';
    topHits: Array<{
      identifier: string;
      pdbId: string;
      entityId: string;
      sequenceIdentity: number;
    }>;
  };
  expectedAlphaFoldFallback?: boolean;
  expectedDrawerNoMatchCopyKind?: 'rna-no-alphafold';
  backedByProteinResultListingCaseId?: string;
}

interface RnaSearchFixtureCatalog {
  schemaVersion: number;
  fixtureId: string;
  sourceSequence: { path: string; accession: string; sha256: string };
  cases: RnaSearchFixtureCase[];
}

interface ResultListingCatalog {
  cases: Array<{
    caseId: string;
    resultListing: {
      representativeStructures: Array<{
        rnaEntityCount: number;
        coComplexEvidence: string;
      }>;
    };
  }>;
}

function loadCatalog(): RnaSearchFixtureCatalog {
  return JSON.parse(readFileSync(RNA_STRUCTURE_SEARCHES, 'utf8')) as RnaSearchFixtureCatalog;
}

function mg1655(): AnnotatedSequence {
  return parseGenBankFull(readFileSync(MG1655_COMPLETE, 'utf8'));
}

function findAnnotation(catalogCase: RnaSearchFixtureCase, parsed: AnnotatedSequence): Annotation {
  const matches = parsed.annotations.filter(
    (candidate) =>
      candidate.type === catalogCase.annotationType &&
      candidate.qualifiers?.gene?.[0] === catalogCase.gene
  );
  expect(
    matches,
    `${catalogCase.caseId}: ${catalogCase.annotationType} /gene="${catalogCase.gene}" must be unique`
  ).toHaveLength(1);
  const annotation = matches[0]!;
  expectCanonicalFeatureIdentity(annotation, catalogCase);
  return annotation;
}

function expectCanonicalFeatureIdentity(
  annotation: Annotation,
  catalogCase: RnaSearchFixtureCase
): void {
  expect(annotation.qualifiers?.gene?.[0], catalogCase.caseId).toBe(catalogCase.gene);
  expect(annotation.qualifiers?.locus_tag?.[0], catalogCase.caseId).toBe(catalogCase.locusTag);
  expect(annotation.qualifiers?.product?.[0], catalogCase.caseId).toBe(catalogCase.product);
  expect(annotation.name, catalogCase.caseId).toBe(catalogCase.gene);
  expect(annotation.start, catalogCase.caseId).toBe(catalogCase.location.start);
  expect(annotation.end, catalogCase.caseId).toBe(catalogCase.location.end);
  expect(annotation.direction, catalogCase.caseId).toBe(catalogCase.location.strand);
}

describe('MG1655 RNA structure search fixtures', () => {
  it('covers the required RNA/nucleic-acid search categories with real MG1655 annotations', () => {
    const catalog = loadCatalog();
    const categories = new Set(catalog.cases.map((fixtureCase) => fixtureCase.category));

    expect(catalog.fixtureId).toBe('mg1655-rna-structure-searches');
    expect(catalog.sourceSequence).toMatchObject({
      path: 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb',
      accession: 'NC_000913.3',
      sha256: MG1655_SHA256,
    });
    expect(createHash('sha256').update(readFileSync(MG1655_COMPLETE)).digest('hex')).toBe(
      MG1655_SHA256
    );
    const serialized = JSON.stringify(catalog).toLowerCase();
    expect(serialized).not.toContain('featurelabel');
    expect(serialized).not.toContain('rna (');
    expect(serialized).not.toContain('cds (');
    expect(categories).toEqual(
      new Set<RnaFixtureCategory>([
        'rna_only_query',
        'trna_query',
        'rrna_query',
        'protein_rna_cocomplex_query',
        'rna_no_pdb_no_alphafold',
        'rna_homologous_or_partial_provider_match',
      ])
    );
    expect(catalog.cases.length).toBeGreaterThanOrEqual(7);
  });

  it('derives every RNA query from the real MG1655 genome and never assigns AlphaFold fallback', () => {
    const catalog = loadCatalog();
    const parsed = mg1655();
    const rnaCases = catalog.cases.filter((fixtureCase) => fixtureCase.queryKind === 'rna');

    expect(rnaCases.length).toBeGreaterThanOrEqual(5);
    for (const fixtureCase of rnaCases) {
      const request = buildStructureDrawerRequestFromAnnotation({
        annotation: findAnnotation(fixtureCase, parsed),
        sequence: parsed,
        entityId: '/fixtures/mg1655.gb',
      });

      expect(request, fixtureCase.caseId).not.toBeNull();
      expect(request?.moleculeType, fixtureCase.caseId).toBe('rna');
      expect(request?.proteinIdentity, fixtureCase.caseId).toBeUndefined();
      expect(fixtureCase.expectedAlphaFoldFallback, fixtureCase.caseId).toBe(false);
      expect(request?.cdsLabel, fixtureCase.caseId).toBe(fixtureCase.gene);
      expect(request?.hints.geneName, fixtureCase.caseId).toBe(fixtureCase.gene);
      expect(request?.hints.locusTag, fixtureCase.caseId).toBe(fixtureCase.locusTag);
      expect(request?.translation, fixtureCase.caseId).toMatch(/^[ACGU]+$/);
      expect(request?.translation.length, fixtureCase.caseId).toBe(
        fixtureCase.expectedQuerySequence?.length
      );
      expect(request?.translation.length, fixtureCase.caseId).toBe(
        fixtureCase.location.end - fixtureCase.location.start + 1
      );
      expect(
        request?.translation.startsWith(fixtureCase.expectedQuerySequence?.prefix ?? ''),
        fixtureCase.caseId
      ).toBe(true);
      expect(
        request?.translation.endsWith(fixtureCase.expectedQuerySequence?.suffix ?? ''),
        fixtureCase.caseId
      ).toBe(true);
    }
  });

  it('requires no-hit RNA fixtures to have no RCSB hit and RNA-specific no-match copy', () => {
    const catalog = loadCatalog();
    const noHitCases = catalog.cases.filter(
      (fixtureCase) => fixtureCase.category === 'rna_no_pdb_no_alphafold'
    );

    expect(noHitCases.length).toBeGreaterThanOrEqual(2);
    for (const fixtureCase of noHitCases) {
      expect(fixtureCase.expectedRcsbSequenceSearch?.expectedHitCountClass).toBe('none');
      expect(fixtureCase.expectedRcsbSequenceSearch?.topHits).toEqual([]);
      expect(fixtureCase.expectedAlphaFoldFallback).toBe(false);
      expect(fixtureCase.expectedDrawerNoMatchCopyKind).toBe('rna-no-alphafold');
    }
  });

  it('anchors protein-RNA co-complex cases to existing protein result listings with RNA entities', () => {
    const catalog = loadCatalog();
    const parsed = mg1655();
    const resultListings = JSON.parse(
      readFileSync(RESULT_LISTINGS, 'utf8')
    ) as ResultListingCatalog;
    const resultListingById = new Map(resultListings.cases.map((item) => [item.caseId, item]));
    const proteinRnaCases = catalog.cases.filter(
      (fixtureCase) => fixtureCase.category === 'protein_rna_cocomplex_query'
    );

    expect(proteinRnaCases.length).toBeGreaterThanOrEqual(2);
    for (const fixtureCase of proteinRnaCases) {
      const listing = resultListingById.get(fixtureCase.backedByProteinResultListingCaseId ?? '');
      expect(listing, fixtureCase.caseId).toBeDefined();
      expect(
        listing?.resultListing.representativeStructures.some(
          (structure) =>
            structure.rnaEntityCount > 0 &&
            structure.coComplexEvidence === 'protein_nucleic_acid_complex'
        ),
        fixtureCase.caseId
      ).toBe(true);
      expect(fixtureCase.queryKind, fixtureCase.caseId).toBe('protein');
      const cds = findAnnotation(fixtureCase, parsed);
      const request = buildStructureDrawerRequestFromAnnotation({
        annotation: cds,
        sequence: parsed,
        entityId: '/fixtures/mg1655.gb',
      });
      expect(request?.moleculeType, fixtureCase.caseId).toBeUndefined();
      expect(request?.translation, fixtureCase.caseId).toBe(cds.qualifiers?.translation?.[0]);
      expect(request?.translation, fixtureCase.caseId).not.toContain('*');
    }
  });
});
