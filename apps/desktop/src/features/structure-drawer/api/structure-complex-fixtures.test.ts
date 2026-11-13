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
import ATPG_COMPLEX_CATALOG_RAW from '../../../../../../test-fixtures/structure-complexes/mg1655-atpg-complexes.json?raw';
import { buildStructureDrawerRequestFromCds } from './build-structure-request';

interface FixtureLocation {
  start: number;
  end: number;
  strand: 1 | -1;
}

interface WorkspaceMember {
  memberId: string;
  gene: string;
  uniprotAccession: string;
  uniprotId: string;
  proteinName: string;
  locusTag: string;
  product: string;
  proteinId: string;
  location: FixtureLocation;
  expectedWorkspaceStatus: 'mapped_current_sequence';
}

interface ExternalMember {
  memberId: string;
  homologousEcoliGene: string;
  uniprotAccession: string;
  proteinName: string;
  sourceOrganism: string;
  sourceTaxonId: number;
  expectedWorkspaceStatus: 'external_only';
}

interface CaseMember {
  memberId: string;
  role: string;
  entityId: string;
  chains: string[];
}

interface ComplexCase {
  fixtureId: string;
  coverageClass: string;
  underlyingSequencePolicy: 'all_members_in_source' | 'external_only_members_absent_from_source';
  pdbId: string;
  title: string;
  method: string;
  resolutionAngstrom: number;
  emdbIds?: string[];
  sourceOrganism: string;
  sourceTaxonId: number;
  primaryEntityId: string;
  primaryChains: string[];
  sourceUrls: string[];
  members: CaseMember[];
}

interface FixtureCatalog {
  schemaVersion: 1;
  fixtureId: string;
  sourceSequence: {
    path: string;
    organism: string;
    taxonId: number;
    accession: string;
    sha256: string;
  };
  queryAnchor: {
    memberId: string;
    gene: string;
    uniprotAccession: string;
    uniprotId: string;
    proteinName: string;
    locusTag: string;
    product: string;
    proteinId: string;
    location: FixtureLocation;
    expectedProtein: {
      length: number;
      prefix: string;
      md5: string;
      sha256: string;
    };
  };
  workspaceMembers: WorkspaceMember[];
  externalMembers: ExternalMember[];
  cases: ComplexCase[];
}

const catalog = JSON.parse(ATPG_COMPLEX_CATALOG_RAW) as FixtureCatalog;
const REPO_ROOT = join(__dirname, '../../../../../..');
const MG1655_COMPLETE = join(REPO_ROOT, catalog.sourceSequence.path);
const ATP_SYNTHASE_GENES = ['atpA', 'atpB', 'atpC', 'atpD', 'atpE', 'atpF', 'atpG', 'atpH'];

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

function expectCanonicalCdsIdentity(
  cds: Annotation,
  member: Pick<WorkspaceMember, 'gene' | 'locusTag' | 'product' | 'proteinId' | 'location'>
): void {
  expect(cds.qualifiers?.gene?.[0]).toBe(member.gene);
  expect(cds.qualifiers?.locus_tag?.[0]).toBe(member.locusTag);
  expect(cds.qualifiers?.product?.[0]).toBe(member.product);
  expect(cds.qualifiers?.protein_id?.[0]).toBe(member.proteinId);
  expect(cds.name).toBe(member.gene);
  expect(cds.start).toBe(member.location.start);
  expect(cds.end).toBe(member.location.end);
  expect(cds.direction).toBe(member.location.strand);
}

function expectQualifierTranslationMatchesCoordinates(
  cds: Annotation,
  parsed: AnnotatedSequence
): void {
  const qualifierTranslation = cds.qualifiers?.translation?.[0];
  expect(qualifierTranslation).toBeDefined();
  expect(qualifierTranslation).toMatch(/^[A-Z]+$/);

  const fromQualifier = buildStructureDrawerRequestFromCds({
    cds,
    sequence: parsed,
    entityId: '/fixtures/mg1655.gb',
  });
  const fromCoordinates = buildStructureDrawerRequestFromCds({
    cds: withoutQualifierTranslation(cds),
    sequence: parsed,
    entityId: '/fixtures/mg1655.gb',
  });

  expect(fromQualifier?.translation).toBe(qualifierTranslation);
  expect(fromCoordinates?.translation).toBe(qualifierTranslation);
  expect(qualifierTranslation).not.toContain('*');
}

function workspaceMemberById(): Map<string, WorkspaceMember> {
  return new Map(catalog.workspaceMembers.map((member) => [member.memberId, member]));
}

function externalMemberById(): Map<string, ExternalMember> {
  return new Map(catalog.externalMembers.map((member) => [member.memberId, member]));
}

describe('MG1655 atpG structure complex fixtures', () => {
  it('anchors the query on the real MG1655 atpG CDS and canonical protein bytes', () => {
    const parsed = fixture();
    const anchor = catalog.queryAnchor;
    const cds = cdsByGene(parsed, anchor.gene);

    expectCanonicalCdsIdentity(cds, anchor);
    expectQualifierTranslationMatchesCoordinates(cds, parsed);

    const request = buildStructureDrawerRequestFromCds({
      cds,
      sequence: parsed,
      entityId: '/fixtures/mg1655.gb',
    });

    expect(request?.cdsLabel).toBe(anchor.gene);
    expect(request?.hints.geneName).toBe(anchor.gene);
    expect(request?.hints.locusTag).toBe(anchor.locusTag);
    expect(request?.hints.proteinId).toBe(anchor.proteinId);
    expect(request?.translation).toHaveLength(anchor.expectedProtein.length);
    expect(request?.translation.startsWith(anchor.expectedProtein.prefix)).toBe(true);
    expect(digest('md5', request!.translation)).toBe(anchor.expectedProtein.md5);
    expect(digest('sha256', request!.translation)).toBe(anchor.expectedProtein.sha256);
    expect(request?.proteinIdentity?.feature.label).toBe(anchor.gene);
    expect(request?.proteinIdentity?.sequence.lookupSequence).toBe(request?.translation);
  });

  it('uses a hardened real complex catalog instead of synthetic or thrL fixtures', () => {
    const serialized = JSON.stringify(catalog).toLowerCase();
    const pdbIds = catalog.cases.map((item) => item.pdbId);

    expect(catalog.fixtureId).toBe('mg1655-atpg-structure-complexes');
    expect(catalog.sourceSequence.path).toBe(
      'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb'
    );
    expect(catalog.queryAnchor.gene).toBe('atpG');
    expect(catalog.queryAnchor.uniprotAccession).toBe('P0ABA6');
    expect(catalog.cases.length).toBeGreaterThanOrEqual(10);
    expect(serialized).not.toContain('thrl');
    expect(serialized).not.toContain('synthetic');
    expect(catalog.sourceSequence.accession).toBe('NC_000913.3');
    expect(createHash('sha256').update(readFileSync(MG1655_COMPLETE)).digest('hex')).toBe(
      catalog.sourceSequence.sha256
    );
    expect(serialized).not.toContain('cds (');
    expect(pdbIds).toEqual(
      expect.arrayContaining([
        '1FS0',
        '3OAA',
        '5T4O',
        '5T4P',
        '5T4Q',
        '6OQR',
        '6PQV',
        '6WNQ',
        '6WNR',
        '8DBP',
        '8DBT',
        '7JGA',
      ])
    );
  });

  it('maps every exact E. coli complex member back to a CDS in the MG1655 source fixture', () => {
    const parsed = fixture();
    const workspaceMembers = workspaceMemberById();
    const externalMembers = externalMemberById();

    for (const member of catalog.workspaceMembers) {
      const cds = cdsByGene(parsed, member.gene);
      expectCanonicalCdsIdentity(cds, member);
      expectQualifierTranslationMatchesCoordinates(cds, parsed);
    }

    for (const complexCase of catalog.cases) {
      expect(complexCase.sourceUrls.length).toBeGreaterThanOrEqual(2);
      expect(complexCase.primaryChains.length).toBeGreaterThan(0);

      const anchorMembers = complexCase.members.filter((member) => member.role === 'query_anchor');
      if (complexCase.underlyingSequencePolicy === 'all_members_in_source') {
        expect(anchorMembers).toHaveLength(1);
        expect(anchorMembers[0]?.memberId).toBe(catalog.queryAnchor.memberId);
        expect(anchorMembers[0]?.entityId).toBe(complexCase.primaryEntityId);
        expect(anchorMembers[0]?.chains).toEqual(complexCase.primaryChains);

        for (const memberRef of complexCase.members) {
          expect(workspaceMembers.has(memberRef.memberId)).toBe(true);
          expect(externalMembers.has(memberRef.memberId)).toBe(false);
          expect(memberRef.chains.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('covers full ATP synthase assemblies whose subunits are all present in MG1655', () => {
    const workspaceMembers = workspaceMemberById();
    const fullComplexCases = catalog.cases.filter(
      (item) =>
        item.coverageClass === 'full_f1fo_complex' &&
        item.underlyingSequencePolicy === 'all_members_in_source'
    );

    expect(fullComplexCases.length).toBeGreaterThanOrEqual(8);
    for (const complexCase of fullComplexCases) {
      const mappedGenes = complexCase.members.map((memberRef) => {
        const member = workspaceMembers.get(memberRef.memberId);
        if (!member) throw new Error(`Missing workspace member ${memberRef.memberId}`);
        return member.gene;
      });
      expect(new Set(mappedGenes)).toEqual(new Set(ATP_SYNTHASE_GENES));
    }
  });

  it('keeps homologous external-only complexes from masquerading as MG1655 subunits', () => {
    const workspaceMembers = workspaceMemberById();
    const externalMembers = externalMemberById();
    const exactUniprotAccessions = new Set(
      catalog.workspaceMembers.map((member) => member.uniprotAccession)
    );
    const externalCases = catalog.cases.filter(
      (item) => item.underlyingSequencePolicy === 'external_only_members_absent_from_source'
    );

    expect(externalCases.length).toBeGreaterThanOrEqual(1);
    for (const complexCase of externalCases) {
      expect(complexCase.sourceTaxonId).not.toBe(catalog.sourceSequence.taxonId);
      expect(complexCase.sourceOrganism).not.toContain('MG1655');
      expect(complexCase.members.some((member) => member.role === 'external_homolog_query')).toBe(
        true
      );

      for (const memberRef of complexCase.members) {
        const member = externalMembers.get(memberRef.memberId);
        expect(workspaceMembers.has(memberRef.memberId)).toBe(false);
        expect(member).toBeDefined();
        expect(member?.expectedWorkspaceStatus).toBe('external_only');
        expect(member?.sourceTaxonId).not.toBe(catalog.sourceSequence.taxonId);
        expect(exactUniprotAccessions.has(member!.uniprotAccession)).toBe(false);
      }
    }
  });

  it('spans co-complex shapes, experimental methods, and EM map-backed states', () => {
    const coverageClasses = new Set(catalog.cases.map((item) => item.coverageClass));
    const methods = new Set(catalog.cases.map((item) => item.method));
    const emdbIds = catalog.cases.flatMap((item) => item.emdbIds ?? []);

    expect(coverageClasses).toEqual(
      new Set([
        'gamma_epsilon_complex',
        'f1_sector_complex',
        'full_f1fo_complex',
        'homolog_full_f1fo_external',
      ])
    );
    expect(methods).toEqual(new Set(['X-RAY DIFFRACTION', 'ELECTRON MICROSCOPY']));
    expect(emdbIds.length).toBeGreaterThanOrEqual(8);
    expect(Math.min(...catalog.cases.map((item) => item.resolutionAngstrom))).toBeLessThanOrEqual(
      2.1
    );
  });
});
