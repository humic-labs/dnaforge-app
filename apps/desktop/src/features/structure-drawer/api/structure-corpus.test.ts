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
import {
  MG1655_STRUCTURE_PROBE_CONTROLS,
  classifyStructureCorpusFeature,
  classifyStructureCorpusSidecarProbe,
  collectStructureCorpusFromGenBank,
  collectStructureCorpusFromSequence,
  deriveStructureProteinFromCds,
  evaluateStructureCorpusProbeControls,
} from './structure-corpus';

const REPO_ROOT = join(__dirname, '../../../../../..');
const MG1655_COMPLETE = join(
  REPO_ROOT,
  'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb'
);

function md5(protein: string): string {
  return createHash('md5').update(protein).digest('hex').toUpperCase();
}

let cachedText: string | undefined;
let cachedParse: AnnotatedSequence | undefined;

function mg1655Text(): string {
  cachedText ??= readFileSync(MG1655_COMPLETE, 'utf8');
  return cachedText;
}

function mg1655(): AnnotatedSequence {
  cachedParse ??= parseGenBankFull(mg1655Text());
  return cachedParse;
}

function cdsByGene(gene: string): Annotation {
  const cds = mg1655().annotations.find(
    (annotation) => annotation.type === 'CDS' && annotation.qualifiers?.gene?.[0] === gene
  );
  if (!cds) throw new Error(`Missing MG1655 CDS fixture for /gene="${gene}"`);
  return cds;
}

function withoutQualifierTranslation(cds: Annotation): Annotation {
  const { translation: _translation, ...rest } = cds.qualifiers ?? {};
  return { ...cds, qualifiers: rest };
}

function mg1655WithoutQualifierTranslations(): AnnotatedSequence {
  const parsed = mg1655();
  return {
    ...parsed,
    annotations: parsed.annotations.map((annotation) =>
      annotation.type === 'CDS' ? withoutQualifierTranslation(annotation) : annotation
    ),
  };
}

describe('structure corpus extraction', () => {
  it('captures the real MG1655 qualifier surface the resolver gets to key off', () => {
    const corpus = collectStructureCorpusFromGenBank(mg1655Text(), {
      sourcePath: 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb',
    });

    expect(corpus.summary.cdsCount).toBe(4318);
    expect(corpus.summary.sequenceName).toBe('NC_000913');
    expect(corpus.summary.sequenceLength).toBe(4641652);

    expect(corpus.summary.withGene).toBe(4318);
    expect(corpus.summary.withLocusTag).toBe(4318);
    expect(corpus.summary.withDbXref).toBe(4318);

    expect(corpus.summary.withQualifierTranslation).toBe(4300);
    expect(corpus.summary.withProteinId).toBe(4300);
    expect(corpus.summary.cdsCount - corpus.summary.withQualifierTranslation).toBe(18);

    expect(corpus.summary.derivedProteinCount).toBe(4318);

    expect(corpus.summary.initiatorNormalizedCount).toBe(0);

    expect(corpus.summary.internalStopCount).toBe(2);
  });

  it('normalizes >400 annotated alternative start codons on the coordinate-derived branch', () => {
    const derivedOnly = collectStructureCorpusFromSequence(mg1655WithoutQualifierTranslations(), {
      sourcePath: 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb',
    });

    expect(derivedOnly.summary.withQualifierTranslation).toBe(0);
    expect(derivedOnly.summary.cdsCount).toBe(4318);
    expect(derivedOnly.summary.derivedProteinCount).toBe(4318);
    expect(derivedOnly.summary.initiatorNormalizedCount).toBeGreaterThan(400);
  });

  it('reproduces the canonical NCBI protein from the feature coordinates alone', () => {
    const parsed = mg1655();
    const mismatched: string[] = [];

    for (const annotation of parsed.annotations) {
      if (annotation.type !== 'CDS') continue;
      const stated = annotation.qualifiers?.translation?.[0];
      if (!stated) continue;

      const derived = deriveStructureProteinFromCds(
        withoutQualifierTranslation(annotation),
        parsed.sequence,
        { circular: parsed.circular }
      );
      expect(derived?.source).toBe('derived_cds');
      expect(derived?.protein).toHaveLength(stated.length);
      if (derived?.protein === stated) continue;

      const gene = annotation.qualifiers?.gene?.[0] ?? annotation.name;
      const differingPositions = [...stated].flatMap((residue, index) =>
        residue === derived?.protein[index] ? [] : [index]
      );
      mismatched.push(
        `${gene} ${differingPositions.map((index) => `${index}:${stated[index]}->${derived?.protein[index]}`).join(',')}`
      );
    }

    expect(mismatched.sort()).toEqual(['infC 0:M->I', 'pcnB 0:M->I', 'ymcF 0:M->I', 'ynfQ 0:M->I']);

    for (const gene of ['fdhF', 'fdnG', 'fdoG']) {
      expect(cdsByGene(gene).qualifiers?.transl_except?.[0]).toContain('aa:Sec');
      const cds = cdsByGene(gene);
      const derived = deriveStructureProteinFromCds(
        withoutQualifierTranslation(cds),
        parsed.sequence,
        {
          circular: parsed.circular,
        }
      );
      expect(derived?.protein).toBe(cds.qualifiers?.translation?.[0]);
      expect(derived?.protein).toContain('U');
    }
    for (const gene of ['infC', 'pcnB', 'ymcF', 'ynfQ']) {
      const derived = deriveStructureProteinFromCds(
        withoutQualifierTranslation(cdsByGene(gene)),
        parsed.sequence,
        { circular: parsed.circular }
      );
      expect(derived?.startCodon).toBe('ATT');
      expect(derived?.initiatorNormalized).toBe(false);
    }
  });

  it('keeps a flattened join() sewn back into ONE multi-segment CDS', () => {
    const parsed = mg1655();
    const multiSegment = parsed.annotations.filter(
      (annotation) => annotation.type === 'CDS' && (annotation.segments?.length ?? 1) > 1
    );

    expect(multiSegment).toHaveLength(20);

    const prfB = cdsByGene('prfB');
    expect(prfB.direction).toBe(-1);
    expect(prfB.segments).toEqual([
      { start: 3035184, end: 3036206 },
      { start: 3036208, end: 3036282 },
    ]);

    const derived = deriveStructureProteinFromCds(
      withoutQualifierTranslation(prfB),
      parsed.sequence,
      { circular: parsed.circular }
    );
    expect(derived?.source).toBe('derived_cds');
    expect(derived?.protein).toHaveLength(365);
    expect(derived?.protein).not.toContain('*');
    expect(derived?.protein).toBe(prfB.qualifiers?.translation?.[0]);
  });

  it('derives ARSC as a provider-confirmed positive control without start normalization', () => {
    const parsed = mg1655();
    const arsC = cdsByGene('arsC');

    expect(arsC.qualifiers?.locus_tag?.[0]).toBe('b3503');
    expect(arsC.qualifiers?.product?.[0]).toBe('arsenate reductase');
    expect(arsC.qualifiers?.protein_id?.[0]).toBe('NP_417960.1');

    const derived = deriveStructureProteinFromCds(arsC, parsed.sequence, {
      circular: parsed.circular,
    });

    expect(derived?.source).toBe('qualifier_translation');
    expect(derived?.startCodon).toBe('ATG');
    expect(derived?.protein.slice(0, 12)).toBe('MSNITIYHNPAC');
    expect(derived?.initiatorNormalized).toBe(false);
    expect(md5(derived!.protein)).toBe('3B0FB4D862F55919DA7D85A871902311');

    const fromCoordinates = deriveStructureProteinFromCds(
      withoutQualifierTranslation(arsC),
      parsed.sequence,
      { circular: parsed.circular }
    );
    expect(fromCoordinates?.source).toBe('derived_cds');
    expect(fromCoordinates?.initiatorNormalized).toBe(false);
    expect(fromCoordinates?.protein).toBe(derived?.protein);
  });

  it.each([
    ['hdfR', 'GTG', 'V', 'MDTELLKTFLEV', '389F3509DC3F8A27217AAA42C7C4CC36'],
    ['rbsR', 'TTG', 'L', 'MATMKDVARLAG', 'DC1E91F836209D60E254769B84A92A0F'],
  ])(
    'normalizes the annotated %s alternative start codon for structure lookup',
    (gene, startCodon, rawFirstResidue, expectedStart, expectedMd5) => {
      const parsed = mg1655();
      const cds = cdsByGene(gene);

      const stated = cds.qualifiers?.translation?.[0];
      expect(stated).toBeDefined();

      const derived = deriveStructureProteinFromCds(
        withoutQualifierTranslation(cds),
        parsed.sequence,
        { circular: parsed.circular }
      );

      expect(derived?.source).toBe('derived_cds');
      expect(derived?.startCodon).toBe(startCodon);
      expect(derived?.rawProtein[0]).toBe(rawFirstResidue);
      expect(derived?.rawProtein[0]).not.toBe('M');
      expect(derived?.protein.slice(0, 12)).toBe(expectedStart);
      expect(derived?.initiatorNormalized).toBe(true);
      expect(derived?.protein).toBe(stated);
      expect(md5(derived!.protein)).toBe(expectedMd5);
      expect(classifyStructureCorpusFeature({ derivation: derived! })).toContain(
        'translation_mismatch_start_codon'
      );
    }
  );

  it('classifies sidecar probe outcomes into actionable provider failure classes', () => {
    expect(
      classifyStructureCorpusSidecarProbe({
        sourcePath: 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb',
        featureIndex: 1,
        label: 'arsC',
        bySequenceStatus: 200,
        uniprotHitCount: 1,
        topAccession: 'P0AB96',
        pdbIds: [],
        afdbStatus: 200,
        afdbExists: true,
        afdbMeanPlddt: 96.69,
      })
    ).toEqual(['external_match', 'alphafold_match', 'structure_bytes_not_probed']);

    expect(
      classifyStructureCorpusSidecarProbe({
        sourcePath: 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb',
        featureIndex: 2,
        label: 'problematic CDS',
        bySequenceStatus: 200,
        uniprotHitCount: 0,
        topAccession: null,
        pdbIds: [],
        afdbStatus: null,
        afdbExists: null,
        afdbMeanPlddt: null,
      })
    ).toEqual(['no_external_match']);

    expect(
      classifyStructureCorpusSidecarProbe({
        sourcePath: 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb',
        featureIndex: 5,
        label: 'renD',
        resolutionMode: 'gene_sequence_overlap',
        bySequenceStatus: 200,
        geneSearchStatus: 200,
        uniprotHitCount: 0,
        topAccession: 'P75718',
        pdbIds: [],
        afdbStatus: 200,
        afdbExists: true,
        afdbMeanPlddt: 83.31,
        sequenceOverlap: { overlapLength: 61, queryCoverage: 0.871, hitCoverage: 1 },
        structureBytesStatus: 200,
        structureBytesOk: true,
      })
    ).toEqual(['external_match', 'alphafold_match', 'structure_bytes_loaded']);

    expect(
      classifyStructureCorpusSidecarProbe({
        sourcePath: 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb',
        featureIndex: 3,
        label: 'provider error CDS',
        bySequenceStatus: 502,
        uniprotHitCount: null,
        topAccession: null,
        pdbIds: [],
        afdbStatus: null,
        afdbExists: null,
        afdbMeanPlddt: null,
      })
    ).toEqual(['provider_error']);

    expect(
      classifyStructureCorpusSidecarProbe({
        sourcePath: 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb',
        featureIndex: 4,
        label: 'no AFDB CDS',
        bySequenceStatus: 200,
        uniprotHitCount: 1,
        topAccession: 'P0TEST',
        pdbIds: [],
        afdbStatus: 200,
        afdbExists: false,
        afdbMeanPlddt: null,
      })
    ).toEqual(['external_match', 'no_alphafold_prediction']);
  });

  it('fails MG1655 sidecar controls when known positives are missing or mismatched', () => {
    const passing = evaluateStructureCorpusProbeControls(
      [
        sidecarProbe('arsC', 'P0AB96', true),
        sidecarProbe('hdfR', 'P0A8R9', true),
        sidecarProbe('rbsR', 'P0ACQ0', true),
        sidecarProbe('mioC', 'P03817', true),
      ],
      MG1655_STRUCTURE_PROBE_CONTROLS
    );

    expect(passing.ok).toBe(true);
    expect(passing.failures).toEqual([]);

    const prefixCollision = evaluateStructureCorpusProbeControls(
      [sidecarProbe('arsCX', 'P0AB96', true)],
      MG1655_STRUCTURE_PROBE_CONTROLS.filter((control) => control.control === 'arsC')
    );
    expect(prefixCollision.ok).toBe(false);
    expect(prefixCollision.failures).toEqual([{ control: 'arsC', reason: 'missing_probe' }]);

    const failing = evaluateStructureCorpusProbeControls(
      [
        sidecarProbe('arsC', 'P0AB96', true, false),
        sidecarProbe('hdfR', 'P0WRONG', true),
        sidecarProbe('rbsR', 'P0ACQ0', false),
      ],
      MG1655_STRUCTURE_PROBE_CONTROLS
    );

    expect(failing.ok).toBe(false);
    expect(failing.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          control: 'arsC',
          reason: 'missing_structure_bytes',
          actual: '403',
        }),
        expect.objectContaining({
          control: 'hdfR',
          reason: 'unexpected_top_accession',
          expected: 'P0A8R9',
          actual: 'P0WRONG',
        }),
        expect.objectContaining({
          control: 'rbsR',
          reason: 'missing_alphafold_match',
        }),
        expect.objectContaining({
          control: 'mioC',
          reason: 'missing_probe',
        }),
      ])
    );
  });
});

function sidecarProbe(
  label: string,
  accession: string,
  afdbExists: boolean,
  structureBytesOk = afdbExists
) {
  return {
    sourcePath: 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb',
    featureIndex: 1,
    label,
    bySequenceStatus: 200,
    uniprotHitCount: 1,
    topAccession: accession,
    pdbIds: [],
    afdbStatus: 200,
    afdbExists,
    afdbMeanPlddt: afdbExists ? 90 : null,
    structureBytesStatus: structureBytesOk ? 200 : 403,
    structureBytesOk,
  };
}
