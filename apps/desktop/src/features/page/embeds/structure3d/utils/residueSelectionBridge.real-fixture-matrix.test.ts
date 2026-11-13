// @vitest-environment node

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseGenBankFull, type Annotation } from '@waypoint/sequence-utils';
import {
  buildResidueSelectionForCdsCodon,
  translatedCdsMoleculeIdFromParts,
} from '@waypoint/workspace-editor';
import {
  residueSelectionsToStructureResidues,
  residueSelectionMapsToStructureLink,
} from './residueSelectionBridge';

const FIXTURES_DIR = join(__dirname, '../../../../../../../../test-fixtures');

type FixtureLookup = { match: string; gene?: never } | { gene: string; match?: never };

type FixtureCase = FixtureLookup & {
  name: string;
  organism: string;
  path: string;
  residueIndex: number;
  structureFeatureId?: string;
  structureId?: string;
  structureTargets?: Array<{
    chain: string;
    baseChain?: string;
    labelAsymId?: string;
    authAsymId?: string;
    entityId?: string;
    operator?: string;
    position?: number;
  }>;
};

const REAL_FIXTURE_CASES: FixtureCase[] = [
  {
    name: 'E. coli MG1655 atpG ATP synthase gamma',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/linear/mg1655-atpG-reference.gb',
    match: 'ATP synthase F1 complex subunit gamma',
    residueIndex: 30,
    structureFeatureId: 'b3733',
    structureId: 'structure:rcsb:RCSB:1FS0:ENTRY:AUTH_ASYM:G',
    structureTargets: [
      {
        chain: 'B',
        baseChain: 'B',
        labelAsymId: 'B',
        authAsymId: 'G',
        entityId: '2',
        operator: 'ASM_1',
      },
    ],
  },
  {
    name: 'E. coli MG1655 atpE ATP synthase c',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/linear/mg1655-atpE-reference.gb',
    match: 'ATP synthase Fo complex subunit c',
    residueIndex: 30,
    structureFeatureId: 'b3737',
    structureId: 'structure:rcsb:RCSB:6OQR:ENTRY:AUTH_ASYM:I,J,L,M,N,O,P,Q,R,S',
    structureTargets: ['I', 'J', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S'].map((authAsymId) => ({
      chain: authAsymId,
      baseChain: authAsymId,
      labelAsymId: authAsymId,
      authAsymId,
      entityId: '7',
    })),
  },
  {
    name: 'E. coli region yagG label-only CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/linear/ecoli-mg1655-region.gb',
    match: 'yagG CDS',
    residueIndex: 8,
    structureFeatureId: 'yagG',
  },
  {
    name: 'E. coli complete chromosome mioC origin-near reverse CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/circular/ecoli-mg1655-complete.gb',
    gene: 'mioC',
    residueIndex: 6,
    structureFeatureId: 'mioC',
  },
  {
    name: 'E. coli mioC Ape label-only structure fixture',
    organism: 'Escherichia coli',
    path: 'sequences/linear/structure-mg1655-mioc-ape-label.gb',
    match: 'mioC CDS',
    residueIndex: 5,
    structureFeatureId: 'mioC',
  },
  {
    name: 'S. cerevisiae SEO1 Ape label-only reverse CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'sequences/linear/structure-s288c-seo1-ape-label.gb',
    match: 'SEO1 CDS',
    residueIndex: 7,
    structureFeatureId: 'SEO1',
  },
  {
    name: 'S. cerevisiae VPS8 label/gene alias structure fixture',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'sequences/linear/structure-s288c-vps8-ape-label.gb',
    match: 'VPS8 CDS',
    residueIndex: 25,
    structureFeatureId: 'VPS8',
    structureId: 'structure:alphafold:AF:P39702:F1:V6:MODEL:AF-P39702-F1-model_v6:all',
    structureTargets: [
      {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        entityId: '1',
        operator: '1_555',
      },
    ],
  },
  {
    name: 'Synechococcus TrEMBL AlphaFold fixture',
    organism: 'Synechococcus sp.',
    path: 'sequences/linear/structure-synechococcus-a0a0h3jza8-trembl.gb',
    match: 'A0A0H3JZA8',
    residueIndex: 9,
    structureFeatureId: 'syc0127_d',
  },
  {
    name: 'pUC19 lacZ-alpha real plasmid CDS',
    organism: 'pUC19 plasmid',
    path: 'sequences/circular/pUC19.gb',
    match: 'lacZ-alpha',
    residueIndex: 2,
  },
  {
    name: 'pUC19 beta-lactamase real plasmid CDS',
    organism: 'pUC19 plasmid',
    path: 'sequences/circular/pUC19.gb',
    match: 'beta-lactamase',
    residueIndex: 11,
    structureFeatureId: 'bla',
  },
  {
    name: 'S. cerevisiae chromosome IV COS7 GBFF fixture',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'Cos7p',
    residueIndex: 10,
    structureFeatureId: 'YDL248W',
  },
  {
    name: 'E. coli region yagH forward CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/linear/ecoli-mg1655-region.gb',
    match: 'yagH CDS',
    residueIndex: 12,
    structureFeatureId: 'yagH',
  },
  {
    name: 'E. coli region xynR reverse CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/linear/ecoli-mg1655-region.gb',
    match: 'xynR CDS',
    residueIndex: 15,
    structureFeatureId: 'xynR',
  },
  {
    name: 'E. coli region argF reverse CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/linear/ecoli-mg1655-region.gb',
    match: 'argF CDS',
    residueIndex: 20,
    structureFeatureId: 'argF',
  },
  {
    name: 'E. coli region insB-3 insertion reverse CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/linear/ecoli-mg1655-region.gb',
    match: 'insB-3 CDS',
    residueIndex: 10,
    structureFeatureId: 'insB-3',
  },
  {
    name: 'E. coli region yagJ forward CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/linear/ecoli-mg1655-region.gb',
    match: 'yagJ CDS',
    residueIndex: 8,
    structureFeatureId: 'yagJ',
  },
  {
    name: 'E. coli region paoD reverse CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/linear/ecoli-mg1655-region.gb',
    match: 'paoD CDS',
    residueIndex: 18,
    structureFeatureId: 'paoD',
  },
  {
    name: 'E. coli region paoC long reverse CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/linear/ecoli-mg1655-region.gb',
    match: 'paoC CDS',
    residueIndex: 25,
    structureFeatureId: 'paoC',
  },
  {
    name: 'E. coli region ecpC fimbrial usher reverse CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/linear/ecoli-mg1655-region.gb',
    match: 'ecpC CDS',
    residueIndex: 17,
    structureFeatureId: 'ecpC',
  },
  {
    name: 'E. coli region ecpA short reverse CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/linear/ecoli-mg1655-region.gb',
    match: 'ecpA CDS',
    residueIndex: 7,
    structureFeatureId: 'ecpA',
  },
  {
    name: 'E. coli region prpE forward CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/linear/ecoli-mg1655-region.gb',
    match: 'prpE CDS',
    residueIndex: 30,
    structureFeatureId: 'prpE',
  },
  {
    name: 'E. coli region codA forward CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/linear/ecoli-mg1655-region.gb',
    match: 'codA CDS',
    residueIndex: 16,
    structureFeatureId: 'codA',
  },
  {
    name: 'E. coli complete asnC origin-near reverse CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/circular/ecoli-mg1655-complete.gb',
    gene: 'asnC',
    residueIndex: 8,
    structureFeatureId: 'asnC',
  },
  {
    name: 'E. coli complete asnA forward CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/circular/ecoli-mg1655-complete.gb',
    gene: 'asnA',
    residueIndex: 18,
    structureFeatureId: 'asnA',
  },
  {
    name: 'E. coli complete ravA reverse CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/circular/ecoli-mg1655-complete.gb',
    gene: 'ravA',
    residueIndex: 25,
    structureFeatureId: 'ravA',
  },
  {
    name: 'E. coli complete rbsA long forward CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/circular/ecoli-mg1655-complete.gb',
    gene: 'rbsA',
    residueIndex: 30,
    structureFeatureId: 'rbsA',
  },
  {
    name: 'E. coli complete ilvL leader peptide',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/circular/ecoli-mg1655-complete.gb',
    gene: 'ilvL',
    residueIndex: 2,
    structureFeatureId: 'ilvL',
  },
  {
    name: 'E. coli complete trxA thioredoxin forward CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/circular/ecoli-mg1655-complete.gb',
    gene: 'trxA',
    residueIndex: 10,
    structureFeatureId: 'trxA',
  },
  {
    name: 'E. coli complete rho transcription terminator',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/circular/ecoli-mg1655-complete.gb',
    gene: 'rho',
    residueIndex: 14,
    structureFeatureId: 'rho',
  },
  {
    name: 'E. coli complete metE long forward CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/circular/ecoli-mg1655-complete.gb',
    gene: 'metE',
    residueIndex: 20,
    structureFeatureId: 'metE',
  },
  {
    name: 'E. coli complete glnA reverse CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/circular/ecoli-mg1655-complete.gb',
    gene: 'glnA',
    residueIndex: 12,
    structureFeatureId: 'glnA',
  },
  {
    name: 'E. coli complete polA long forward CDS',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/circular/ecoli-mg1655-complete.gb',
    gene: 'polA',
    residueIndex: 40,
    structureFeatureId: 'polA',
  },
  {
    name: 'E. coli complete prfB spliced reverse CDS (real join)',
    organism: 'Escherichia coli K-12 MG1655',
    path: 'sequences/circular/ecoli-mg1655-complete.gb',
    gene: 'prfB',
    residueIndex: 6,
    structureFeatureId: 'prfB',
  },
  {
    name: 'S. cerevisiae chromosome IV HIM1 forward CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'HIM1',
    residueIndex: 12,
    structureFeatureId: 'HIM1',
  },
  {
    name: 'S. cerevisiae chromosome IV SWA2 reverse CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'SWA2',
    residueIndex: 15,
    structureFeatureId: 'SWA2',
  },
  {
    name: 'S. cerevisiae chromosome IV VPS3 reverse CORVET CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'VPS3',
    residueIndex: 20,
    structureFeatureId: 'VPS3',
  },
  {
    name: 'S. cerevisiae chromosome IV YRA1 spliced forward CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'YRA1',
    residueIndex: 3,
    structureFeatureId: 'YRA1',
  },
  {
    name: 'S. cerevisiae chromosome IV RPL27B spliced forward CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'RPL27B',
    residueIndex: 3,
    structureFeatureId: 'RPL27B',
  },
  {
    name: 'S. cerevisiae chromosome IV PEP7 reverse CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'PEP7',
    residueIndex: 14,
    structureFeatureId: 'PEP7',
  },
  {
    name: 'S. cerevisiae chromosome IV UTP4 reverse long CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'UTP4',
    residueIndex: 22,
    structureFeatureId: 'UTP4',
  },
  {
    name: 'S. cerevisiae chromosome IV SKP1 reverse CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'SKP1',
    residueIndex: 11,
    structureFeatureId: 'SKP1',
  },
  {
    name: 'S. cerevisiae chromosome IV PEX3 reverse CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'PEX3',
    residueIndex: 13,
    structureFeatureId: 'PEX3',
  },
  {
    name: 'S. cerevisiae chromosome IV UBX5 forward CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'UBX5',
    residueIndex: 12,
    structureFeatureId: 'UBX5',
  },
  {
    name: 'S. cerevisiae chromosome IV GPI8 forward CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'GPI8',
    residueIndex: 18,
    structureFeatureId: 'GPI8',
  },
  {
    name: 'S. cerevisiae chromosome IV TRP4 forward CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'TRP4',
    residueIndex: 25,
    structureFeatureId: 'TRP4',
  },
  {
    name: 'S. cerevisiae chromosome IV ATP22 reverse CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'ATP22',
    residueIndex: 17,
    structureFeatureId: 'ATP22',
  },
  {
    name: 'S. cerevisiae chromosome IV SBE2 forward CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'SBE2',
    residueIndex: 30,
    structureFeatureId: 'SBE2',
  },
  {
    name: 'S. cerevisiae chromosome IV VPS52 forward CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'VPS52',
    residueIndex: 16,
    structureFeatureId: 'VPS52',
  },
  {
    name: 'S. cerevisiae chromosome IV VPS72 reverse CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'VPS72',
    residueIndex: 12,
    structureFeatureId: 'VPS72',
  },
  {
    name: 'S. cerevisiae chromosome IV SNF1 forward CDS',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'genomes/yeast-chrIV/chrIV.gbff',
    match: 'SNF1',
    residueIndex: 24,
    structureFeatureId: 'SNF1',
  },
  {
    name: 'S. cerevisiae VPS8 RCSB 8QX8 query chain fixture',
    organism: 'Saccharomyces cerevisiae S288C',
    path: 'sequences/linear/structure-s288c-vps8-ape-label.gb',
    match: 'VPS8 CDS',
    residueIndex: 66,
    structureFeatureId: 'VPS8',
    structureId: 'structure:rcsb:RCSB:8QX8:ENTRY:AUTH_ASYM:F:all',
    structureTargets: [
      {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'F',
        entityId: '1',
        operator: 'ASM_1',
        position: 67,
      },
    ],
  },
];

function textForAnnotation(annotation: Annotation): string {
  return [
    annotation.name,
    annotation.label,
    ...Object.values(annotation.qualifiers ?? {}).flatMap((values) => values),
  ]
    .filter(Boolean)
    .join(' ');
}

const parsedFixtureCache = new Map<string, ReturnType<typeof parseGenBankFull>>();

function loadParsedFixture(relativePath: string): ReturnType<typeof parseGenBankFull> {
  const cached = parsedFixtureCache.get(relativePath);
  if (cached) return cached;
  const fullPath = join(FIXTURES_DIR, relativePath);
  const parsed = parseGenBankFull(readFileSync(fullPath, 'utf8'));
  parsedFixtureCache.set(relativePath, parsed);
  return parsed;
}

function fixtureIdentity(fixture: FixtureCase): string {
  return fixture.gene ?? fixture.match;
}

function matchesFixture(annotation: Annotation, fixture: FixtureCase): boolean {
  if (annotation.type !== 'CDS') return false;
  if (fixture.gene !== undefined) return annotation.qualifiers?.gene?.[0] === fixture.gene;
  return textForAnnotation(annotation).includes(fixture.match);
}

function loadCase(fixture: FixtureCase): { sequence: string; cds: Annotation } {
  const sequence = loadParsedFixture(fixture.path);
  const cds = sequence.annotations.find((annotation) => matchesFixture(annotation, fixture));
  if (!cds) throw new Error(`CDS ${fixtureIdentity(fixture)} not found in ${fixture.path}`);
  return { sequence: sequence.sequence, cds };
}

function codonForResidue(
  cds: Annotation,
  residueIndex: number
): {
  start: number;
  end: number;
  strand: 1 | -1;
  residueIndex: number;
} {
  const strand = cds.direction === -1 ? -1 : 1;
  if (strand === -1) {
    const end = cds.end - 1 - residueIndex * 3;
    return { start: end - 2, end, strand, residueIndex: residueIndex + 1 };
  }

  const start = cds.start - 1 + residueIndex * 3;
  return { start, end: start + 2, strand, residueIndex: residueIndex + 1 };
}

describe('residueSelectionBridge real-fixture matrix', () => {
  it('keeps the bridge fixture matrix broad enough to avoid atpG-only false confidence', () => {
    expect(REAL_FIXTURE_CASES.length).toBeGreaterThanOrEqual(30);
    expect(
      new Set(REAL_FIXTURE_CASES.map((fixture) => `${fixture.path}\0${fixtureIdentity(fixture)}`))
        .size
    ).toBeGreaterThanOrEqual(30);
    expect(
      new Set(REAL_FIXTURE_CASES.map((fixture) => fixture.organism)).size
    ).toBeGreaterThanOrEqual(4);
    expect(new Set(REAL_FIXTURE_CASES.map((fixture) => fixture.path)).size).toBeGreaterThanOrEqual(
      7
    );
    expect(
      REAL_FIXTURE_CASES.filter((fixture) => !fixture.organism.includes('Escherichia coli')).length
    ).toBeGreaterThanOrEqual(20);
    const casesPerOrganism = new Map<string, number>();
    for (const fixture of REAL_FIXTURE_CASES) {
      casesPerOrganism.set(fixture.organism, (casesPerOrganism.get(fixture.organism) ?? 0) + 1);
    }
    expect(Math.max(...casesPerOrganism.values())).toBeLessThanOrEqual(
      Math.ceil(REAL_FIXTURE_CASES.length * 0.65)
    );
    const loadedCases = REAL_FIXTURE_CASES.map((fixture) => loadCase(fixture));
    expect(loadedCases.filter(({ cds }) => cds.direction === -1).length).toBeGreaterThanOrEqual(10);
    expect(
      loadedCases.filter(({ cds }) => (cds.segments?.length ?? 0) > 1).length
    ).toBeGreaterThanOrEqual(2);
    expect(
      loadedCases.filter(({ cds }) => (cds.segments?.length ?? 0) > 1 && cds.direction === -1)
        .length
    ).toBeGreaterThanOrEqual(1);
    expect(
      REAL_FIXTURE_CASES.some((fixture) => fixture.path.includes('structure-s288c-vps8'))
    ).toBe(true);
    expect(
      REAL_FIXTURE_CASES.some(
        (fixture) => fixture.structureTargets && fixture.structureTargets.length > 1
      )
    ).toBe(true);
    expect(REAL_FIXTURE_CASES.some((fixture) => fixture.structureId?.includes('alphafold'))).toBe(
      true
    );
    expect(REAL_FIXTURE_CASES.some((fixture) => fixture.structureId?.includes('rcsb'))).toBe(true);
  });

  it.each(REAL_FIXTURE_CASES)(
    'maps real sequence-origin residue selections through structure links: $name',
    (fixture) => {
      const { sequence, cds } = loadCase(fixture);
      const referenceId = `/fixtures/${fixture.path}`;
      const selection = buildResidueSelectionForCdsCodon({
        referenceId,
        cds,
        codon: codonForResidue(cds, fixture.residueIndex),
        fullSequence: sequence,
      });
      if (!selection) throw new Error(`Selection was not buildable for ${fixture.name}`);

      const selectionFeatureId = selection.target.label ?? fixtureIdentity(fixture);
      const structureFeatureId = fixture.structureFeatureId ?? selectionFeatureId;
      const structureTargets = fixture.structureTargets ?? [{ chain: 'A' }];
      const link = {
        sequenceDocumentId: referenceId,
        cdsStart: cds.start - 1,
        cdsEnd: cds.end - 1,
        strand: (cds.direction === -1 ? -1 : 1) as 1 | -1,
        cdsLabel: selectionFeatureId,
        residueTarget: {
          ...structureTargets[0],
          residues: [
            {
              residueIndex: fixture.residueIndex,
              position: structureTargets[0].position ?? fixture.residueIndex + 1,
            },
          ],
        },
        residueTargets: structureTargets.map((target) => ({
          ...target,
          residues: [
            {
              residueIndex: fixture.residueIndex,
              position: target.position ?? fixture.residueIndex + 1,
            },
          ],
        })),
        residueMolecule: {
          moleculeId: translatedCdsMoleculeIdFromParts({
            referenceId,
            featureKey: structureFeatureId,
            start0: cds.start - 1,
            end0: cds.end - 1,
            strand: cds.direction === -1 ? -1 : 1,
          }),
          moleculeKind: 'translated-cds',
          label: selectionFeatureId,
        },
      };

      expect(residueSelectionMapsToStructureLink(selection, link)).toBe(true);
      expect(
        residueSelectionsToStructureResidues({
          structureId: fixture.structureId ?? `structure:fixture:${fixture.name}`,
          link,
          selections: [selection],
        })
      ).toEqual(
        structureTargets.map((target) => ({
          chain: target.chain,
          position: target.position ?? fixture.residueIndex + 1,
          ...(target.baseChain ? { baseChain: target.baseChain } : {}),
          ...(target.labelAsymId ? { labelAsymId: target.labelAsymId } : {}),
          ...(target.authAsymId ? { authAsymId: target.authAsymId } : {}),
          ...(target.entityId ? { entityId: target.entityId } : {}),
          ...(target.operator ? { operator: target.operator } : {}),
        }))
      );
    }
  );
});
