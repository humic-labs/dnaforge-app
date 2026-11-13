import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parseGenBankFull, type AnnotatedSequence } from '@waypoint/sequence-utils';

import { buildAnnotationDescriptor, resolveAnnotation } from './annotation';
import type { SequenceDescriptorInput } from './types';

const REPO_ROOT = join(__dirname, '../../../../../..');
const PUC19_PATH = join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb');
const puc19: AnnotatedSequence = parseGenBankFull(readFileSync(PUC19_PATH, 'utf8'));

const LACZ_START = 146;
const LACZ_END = 469;
const LACZ_TRANSLATION =
  'MTMITPSLHACRSTLEDPRVPSSNSLAVVLQRRDWENPGVTQLNRLAAHPPFASWRNSEEARTDRPSQQLRSLNGEWRLMRYFLLTHLCGISHRIWCTLSTICSDAA';

function annotationInput(start: number, end: number): SequenceDescriptorInput {
  return { kind: 'annotation', path: PUC19_PATH, range: { start, end } };
}

describe('annotation — file-text fields land in fileText with trust untrusted-data', () => {
  const d = buildAnnotationDescriptor(annotationInput(LACZ_START, LACZ_END), puc19, 3);

  it('resolves the lacZ CDS (not null)', () => {
    expect(d).not.toBeNull();
    expect(d?.kind).toBe('annotation');
  });

  it('featureName is present and tagged untrusted-data', () => {
    expect(d?.fileText.featureName).toEqual({ value: 'lacZ-alpha', trust: 'untrusted-data' });
  });

  it('product is present and tagged untrusted-data', () => {
    expect(d?.fileText.product?.trust).toBe('untrusted-data');
    expect(d?.fileText.product?.value).toBe('LacZ alpha fragment');
  });

  it('gene is present and tagged untrusted-data', () => {
    expect(d?.fileText.gene).toEqual({ value: 'lacZ', trust: 'untrusted-data' });
  });

  it('every fileText entry carries the untrusted-data trust tag', () => {
    for (const field of Object.values(d!.fileText)) {
      expect(field.trust).toBe('untrusted-data');
    }
  });
});

describe('annotation — measured carries featureType/start/end/strand', () => {
  const d = buildAnnotationDescriptor(annotationInput(LACZ_START, LACZ_END), puc19, 3);

  it('exposes the structural measured fields read from the feature', () => {
    expect(d?.measured.featureType).toBe('CDS');
    expect(d?.measured.start).toBe(LACZ_START);
    expect(d?.measured.end).toBe(LACZ_END);
    expect(d?.measured.strand).toBe('-');
    expect(d?.measured.lengthBp).toBe(LACZ_END - LACZ_START + 1);
  });

  it('computes protein length + translTable for the CDS (via the tested mapper)', () => {
    expect(d?.measured.proteinLengthAa).toBe(108);
    expect(d?.measured.translationAvailable).toBe(false);
    expect(d?.measured.translTable).toBe(11);
  });

  it('reports a supplied translation for the same reverse-strand CDS', () => {
    const annotations = puc19.annotations.map((annotation) =>
      annotation.type === 'CDS' && annotation.start === LACZ_START && annotation.end === LACZ_END
        ? {
            ...annotation,
            qualifiers: { ...annotation.qualifiers, translation: [LACZ_TRANSLATION] },
          }
        : annotation
    );
    const translated = buildAnnotationDescriptor(
      annotationInput(LACZ_START, LACZ_END),
      { ...puc19, annotations },
      3
    );
    expect(translated?.measured.translationAvailable).toBe(true);
    expect(translated?.measured.proteinLengthAa).toBe(108);
    expect(translated?.measured.translTable).toBe(11);
    expect(translated?.measured.strand).toBe('-');
  });

  it('never inlines bases', () => {
    expect(d?.bases).toBe('not_included');
    expect(d?.schemaVersion).toBe(2);
  });
});

describe('annotation — resolver returns null at an annotation gap', () => {
  it('returns null when no non-wrapping feature covers the range', () => {
    const range = { start: 1, end: 50 };
    const annotations = puc19.annotations.filter(({ type }) => type.toLowerCase() !== 'source');
    expect(annotations.length).toBeGreaterThan(0);
    expect(annotations.every(({ start, end }) => end < range.start || start > range.end)).toBe(
      true
    );
    expect(resolveAnnotation(annotations, range, puc19.length)).toBeNull();
    expect(
      buildAnnotationDescriptor(
        annotationInput(range.start, range.end),
        { ...puc19, annotations },
        3
      )
    ).toBeNull();
  });
});
