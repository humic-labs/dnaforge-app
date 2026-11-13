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
import RESULT_LISTING_CATALOG_RAW from '../../../../../../test-fixtures/structure-complexes/mg1655-structure-result-listings.json?raw';
import { buildStructureDrawerRequestFromCds } from './build-structure-request';

interface FixtureLocation {
  start: number;
  end: number;
  strand: 1 | -1;
}

type ResultClass = 'co_complex' | 'non_cocomplex';
type Provider = 'rcsb' | 'alphafold';
type ExpectedComplexUi = 'complex_member_browser' | 'standard_structure_viewer';
type ListingShape =
  | 'many_cocomplex_pdb_results'
  | 'many_non_cocomplex_pdb_results'
  | 'few_non_cocomplex_pdb_results'
  | 'no_pdb_alphafold_only';
type CoComplexEvidence =
  | 'heteromeric_protein'
  | 'protein_nucleic_acid_complex'
  | 'homomeric_or_single_entity';

interface RepresentativeStructure {
  pdbId: string;
  title: string;
  method: string;
  resolutionAngstrom: number | null;
  polymerComposition: string;
  polymerEntityCount: number;
  proteinEntityCount: number;
  dnaEntityCount: number;
  rnaEntityCount: number;
  coComplexEvidence: CoComplexEvidence;
}

interface ResultListing {
  hasPdbResults: boolean;
  uniprotPdbXrefCount: number;
  hasAlphaFoldPrediction: boolean;
  expectedPrimaryProvider: Provider;
  expectedComplexUi: ExpectedComplexUi;
  listingShape: ListingShape;
  representativeStructures: RepresentativeStructure[];
  sourceUrls: string[];
}

interface ResultListingCase {
  caseId: string;
  resultClass: ResultClass;
  gene: string;
  uniprotAccession: string;
  uniprotId: string;
  proteinName: string;
  featureLabel: string;
  locusTag: string;
  product: string;
  location: FixtureLocation;
  expectedProtein: {
    length: number;
    prefix: string;
    md5: string;
    sha256: string;
  };
  resultListing: ResultListing;
}

interface ResultListingCatalog {
  schemaVersion: 1;
  fixtureId: string;
  verifiedAt: string;
  sourceSequence: {
    path: string;
    organism: string;
    taxonId: number;
    accession: string;
    sha256: string;
  };
  cases: ResultListingCase[];
}

const catalog = JSON.parse(RESULT_LISTING_CATALOG_RAW) as ResultListingCatalog;
const REPO_ROOT = join(__dirname, '../../../../../..');
const MG1655_COMPLETE = join(REPO_ROOT, catalog.sourceSequence.path);

function digest(algorithm: 'md5' | 'sha256', sequence: string): string {
  const hash = createHash(algorithm).update(sequence).digest('hex');
  return algorithm === 'md5' ? hash.toUpperCase() : hash;
}

function fixture(): AnnotatedSequence {
  return parseGenBankFull(readFileSync(MG1655_COMPLETE, 'utf8'));
}

function cdsByGene(parsed: AnnotatedSequence, gene: string): Annotation {
  const cds = parsed.annotations.find(
    (annotation) => annotation.type === 'CDS' && annotation.qualifiers?.gene?.[0] === gene
  );
  if (!cds) throw new Error(`Missing MG1655 CDS fixture for /gene="${gene}"`);
  return cds;
}

function withoutQualifierTranslation(cds: Annotation): Annotation {
  const { translation: _translation, ...rest } = cds.qualifiers ?? {};
  return { ...cds, qualifiers: rest };
}

describe('MG1655 structure result-listing fixtures', () => {
  it('covers exactly five co-complexes and five non-co-complexes', () => {
    const coComplexCases = catalog.cases.filter((item) => item.resultClass === 'co_complex');
    const nonCoComplexCases = catalog.cases.filter((item) => item.resultClass === 'non_cocomplex');
    const genes = new Set(catalog.cases.map((item) => item.gene));
    const accessions = new Set(catalog.cases.map((item) => item.uniprotAccession));

    expect(catalog.fixtureId).toBe('mg1655-structure-result-listings');
    expect(catalog.sourceSequence.path).toBe(
      'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb'
    );
    expect(catalog.cases).toHaveLength(10);
    expect(coComplexCases).toHaveLength(5);
    expect(nonCoComplexCases).toHaveLength(5);
    expect(genes.size).toBe(catalog.cases.length);
    expect(accessions.size).toBe(catalog.cases.length);

    expect(catalog.sourceSequence.accession).toBe('NC_000913.3');
    expect(createHash('sha256').update(readFileSync(MG1655_COMPLETE)).digest('hex')).toBe(
      catalog.sourceSequence.sha256
    );
    expect(JSON.stringify(catalog).toLowerCase()).not.toContain('cds (');
  });

  it('derives every query from a real MG1655 CDS and canonical protein bytes', () => {
    const parsed = fixture();

    for (const item of catalog.cases) {
      const cds = cdsByGene(parsed, item.gene);
      const request = buildStructureDrawerRequestFromCds({
        cds,
        sequence: parsed,
        entityId: '/fixtures/mg1655.gb',
      });

      expect(cds.qualifiers?.gene?.[0]).toBe(item.gene);
      expect(cds.qualifiers?.locus_tag?.[0]).toBe(item.locusTag);
      expect(cds.qualifiers?.product?.[0]).toBe(item.product);
      expect(cds.name).toBe(item.featureLabel);
      expect(item.featureLabel).toBe(item.gene);
      expect(cds.start).toBe(item.location.start);
      expect(cds.end).toBe(item.location.end);
      expect(cds.direction).toBe(item.location.strand);

      const qualifierTranslation = cds.qualifiers?.translation?.[0];
      expect(qualifierTranslation).toBeDefined();
      expect(qualifierTranslation).toMatch(/^[A-Z]+$/);
      expect(qualifierTranslation).not.toContain('*');
      const fromCoordinates = buildStructureDrawerRequestFromCds({
        cds: withoutQualifierTranslation(cds),
        sequence: parsed,
        entityId: '/fixtures/mg1655.gb',
      });
      expect(fromCoordinates?.translation).toBe(qualifierTranslation);

      expect(request?.hints.geneName).toBe(item.gene);
      expect(request?.hints.locusTag).toBe(item.locusTag);
      expect(request?.cdsLabel).toBe(item.featureLabel);
      expect(request?.translation).toBe(qualifierTranslation);
      expect(request?.translation).toHaveLength(item.expectedProtein.length);
      expect(request?.translation.startsWith(item.expectedProtein.prefix)).toBe(true);
      expect(digest('md5', request!.translation)).toBe(item.expectedProtein.md5);
      expect(digest('sha256', request!.translation)).toBe(item.expectedProtein.sha256);
    }
  });

  it('captures varied resolver listing shapes instead of assuming every protein has PDB hits', () => {
    const listingShapes = new Set(catalog.cases.map((item) => item.resultListing.listingShape));
    const xrefCounts = catalog.cases.map((item) => item.resultListing.uniprotPdbXrefCount);

    expect(listingShapes).toEqual(
      new Set([
        'many_cocomplex_pdb_results',
        'many_non_cocomplex_pdb_results',
        'few_non_cocomplex_pdb_results',
        'no_pdb_alphafold_only',
      ])
    );
    expect(xrefCounts).toContain(0);
    expect(xrefCounts).toContain(2);
    expect(xrefCounts.some((count) => count >= 50)).toBe(true);
    expect(xrefCounts.some((count) => count >= 300)).toBe(true);
  });

  it('routes co-complex listings to the complex browser and monomer/no-PDB listings to standard viewer paths', () => {
    for (const item of catalog.cases) {
      if (item.resultClass === 'co_complex') {
        expect(item.resultListing.hasPdbResults).toBe(true);
        expect(item.resultListing.expectedPrimaryProvider).toBe('rcsb');
        expect(item.resultListing.expectedComplexUi).toBe('complex_member_browser');
        expect(item.resultListing.representativeStructures.length).toBeGreaterThanOrEqual(1);
      } else {
        expect(item.resultListing.expectedComplexUi).toBe('standard_structure_viewer');
        expect(item.resultListing.hasAlphaFoldPrediction).toBe(true);
      }
    }
  });

  it('does not conflate no PDB hits with no structure available', () => {
    const alphaFoldOnlyCases = catalog.cases.filter(
      (item) => item.resultListing.listingShape === 'no_pdb_alphafold_only'
    );

    expect(alphaFoldOnlyCases).toHaveLength(2);
    for (const item of alphaFoldOnlyCases) {
      expect(item.resultListing.hasPdbResults).toBe(false);
      expect(item.resultListing.uniprotPdbXrefCount).toBe(0);
      expect(item.resultListing.hasAlphaFoldPrediction).toBe(true);
      expect(item.resultListing.expectedPrimaryProvider).toBe('alphafold');
      expect(item.resultListing.expectedComplexUi).toBe('standard_structure_viewer');
      expect(item.resultListing.representativeStructures).toEqual([]);
      expect(item.resultListing.sourceUrls).toEqual(
        expect.arrayContaining([`https://alphafold.ebi.ac.uk/entry/${item.uniprotAccession}`])
      );
    }
  });

  it('separates heteromeric or protein-NA complexes from homomeric/single-entity PDB hits', () => {
    for (const item of catalog.cases) {
      for (const structure of item.resultListing.representativeStructures) {
        if (item.resultClass === 'co_complex') {
          expect(structure.coComplexEvidence).not.toBe('homomeric_or_single_entity');
          expect(
            structure.polymerEntityCount > 1 ||
              structure.proteinEntityCount > 1 ||
              structure.dnaEntityCount > 0 ||
              structure.rnaEntityCount > 0
          ).toBe(true);
        } else {
          expect(structure.coComplexEvidence).toBe('homomeric_or_single_entity');
          expect(structure.polymerEntityCount).toBe(1);
          expect(structure.proteinEntityCount).toBe(1);
          expect(structure.dnaEntityCount).toBe(0);
          expect(structure.rnaEntityCount).toBe(0);
        }
      }
    }
  });
});
