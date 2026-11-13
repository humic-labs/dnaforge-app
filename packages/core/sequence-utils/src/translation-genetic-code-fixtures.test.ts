import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseGenBankFull } from './parsers/genbank';
import { serializeGenBank } from './writers/genbank';
import { cdsToProteinSpliced } from './translation';
import { resolveSequenceGeneticCode } from './genetic-codes';
import type { Annotation, AnnotatedSequence } from './types';

const YEAST_CHR_MT = join(
  __dirname,
  '../../../../apps/desktop/resources/sample-workspaces/standard-samples/workspace/sequences/genomes/scerevisiae-s288c/chrMT/chrMT.gb'
);

function loadYeastMito(): AnnotatedSequence {
  if (!existsSync(YEAST_CHR_MT)) {
    throw new Error(`Shipped yeast mitochondrial genome missing at ${YEAST_CHR_MT}`);
  }
  return parseGenBankFull(readFileSync(YEAST_CHR_MT, 'utf-8'));
}

function codingFeaturesWithTranslation(sequence: AnnotatedSequence): Annotation[] {
  return sequence.annotations.filter(
    (annotation) => annotation.type === 'CDS' && annotation.qualifiers?.translation?.[0]
  );
}

function internalStops(protein: string): number {
  return (protein.match(/\*/g) ?? []).length;
}

describe('the shipped yeast mitochondrial genome', () => {
  const sequence = loadYeastMito();

  it('is recognized as reading by the yeast mitochondrial code', () => {
    const resolution = resolveSequenceGeneticCode(sequence);
    expect(resolution).toMatchObject({
      code: 3,
      basis: 'declared',
      declaredCodes: [3],
      mixed: false,
      needsUserChoice: false,
    });
  });

  it('translates every coding feature to the protein the record itself records', () => {
    const features = codingFeaturesWithTranslation(sequence);
    expect(features.length).toBeGreaterThanOrEqual(10);

    const mismatches: string[] = [];
    for (const feature of features) {
      const expected = feature.qualifiers!.translation![0].replace(/\s+/g, '');
      const actual = cdsToProteinSpliced(feature, sequence.sequence, {
        sequenceLength: sequence.circular ? sequence.length : undefined,
        sequenceGeneticCode: 3,
      });
      if (actual !== expected) {
        mismatches.push(
          `${feature.name}: expected ${expected.length} aa, got ${actual?.length ?? 'null'}`
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('shows cytochrome oxidase subunit 1 stop-free on code 3 and broken on code 1', () => {
    const cox1 = codingFeaturesWithTranslation(sequence).find((annotation) =>
      /cytochrome c oxidase subunit 1/i.test(annotation.qualifiers?.product?.[0] ?? '')
    );
    if (!cox1) throw new Error('COX1 not found in the shipped yeast mitochondrial genome');

    const options = {
      sequenceLength: sequence.circular ? sequence.length : undefined,
    } as const;

    const onCode3 = cdsToProteinSpliced(cox1, sequence.sequence, {
      ...options,
      sequenceGeneticCode: 3,
    });
    expect(onCode3).toBe(cox1.qualifiers!.translation![0].replace(/\s+/g, ''));
    expect(internalStops(onCode3 ?? '')).toBe(0);

    const asStandardCode = cdsToProteinSpliced(
      { ...cox1, qualifiers: { ...cox1.qualifiers, transl_table: ['1'] } },
      sequence.sequence,
      options
    );
    expect(internalStops(asStandardCode ?? '')).toBeGreaterThan(0);
  });

  it('honors the declaration without being told the record code', () => {
    const features = codingFeaturesWithTranslation(sequence);
    const first = features[0];
    expect(
      cdsToProteinSpliced(first, sequence.sequence, {
        sequenceLength: sequence.circular ? sequence.length : undefined,
      })
    ).toBe(first.qualifiers!.translation![0].replace(/\s+/g, ''));
  });
});

describe('a record whose features disagree', () => {
  const sequence = loadYeastMito();

  function mixed(): AnnotatedSequence {
    const nuclearStyle: Annotation = {
      name: 'transplanted-nuclear-gene',
      type: 'CDS',
      start: 1,
      end: 9,
      direction: 1,
      qualifiers: { transl_table: ['1'] },
    };
    return { ...sequence, annotations: [...sequence.annotations, nuclearStyle] };
  }

  it('is reported as mixed, listing both codes, without becoming an error', () => {
    const resolution = resolveSequenceGeneticCode(mixed());
    expect(resolution).toMatchObject({
      basis: 'declared-mixed',
      mixed: true,
      declaredCodes: [1, 3],
    });
    expect(resolution.code).toBe(3);
  });

  it('still translates each feature by its own declared code', () => {
    const record = mixed();
    const options = { sequenceLength: record.circular ? record.length : undefined };

    const native = codingFeaturesWithTranslation(record)[0];
    expect(cdsToProteinSpliced(native, record.sequence, options)).toBe(
      native.qualifiers!.translation![0].replace(/\s+/g, '')
    );

    const transplanted = record.annotations.find(
      (annotation) => annotation.name === 'transplanted-nuclear-gene'
    )!;
    const onDeclared = cdsToProteinSpliced(transplanted, record.sequence, options);
    const asRecordCode = cdsToProteinSpliced({ ...transplanted, qualifiers: {} }, record.sequence, {
      ...options,
      sequenceGeneticCode: 3,
    });
    expect(onDeclared).not.toBe(asRecordCode);
  });

  it('a user override wins over both, and survives a save and reopen', () => {
    const chosen: AnnotatedSequence = { ...mixed(), chosenGeneticCode: 2 };
    expect(resolveSequenceGeneticCode(chosen)).toMatchObject({ code: 2, basis: 'chosen' });
    const reopened = parseGenBankFull(serializeGenBank(chosen));
    expect(resolveSequenceGeneticCode(reopened)).toMatchObject({ code: 2, basis: 'chosen' });
    const native = codingFeaturesWithTranslation(reopened)[0];
    expect(
      cdsToProteinSpliced(native, reopened.sequence, {
        sequenceLength: reopened.circular ? reopened.length : undefined,
        sequenceGeneticCode: 2,
      })
    ).toBe(native.qualifiers!.translation![0].replace(/\s+/g, ''));
  });
});
