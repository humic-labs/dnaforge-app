import { describe, it, expect } from 'vitest';
import { serializeGenBank } from './genbank';
import { parseGenBankFull } from '../parsers/genbank';
import type { AnnotatedSequence, Annotation } from '../types';

function doc(annotation: Annotation, sequence = 'ACGT'.repeat(50)): AnnotatedSequence {
  return {
    name: 'test',
    sequence,
    circular: false,
    annotations: [annotation],
  } as AnnotatedSequence;
}

const SPLICED: Annotation = {
  name: 'spliced',
  type: 'CDS',
  start: 1,
  end: 100,
  direction: 1,
  segments: [
    { start: 1, end: 30 },
    { start: 61, end: 100 },
  ],
};

describe('serializeGenBank — join() is emitted from segments, not only from _locationString', () => {
  it('emits join() for a segments-bearing annotation with NO _locationString', () => {
    const out = serializeGenBank(doc(SPLICED));
    expect(out).toContain('join(1..30,61..100)');
    expect(out).not.toMatch(/^ {5}CDS {13}1\.\.100$/m);
  });

  it('wraps join() in complement() for a reverse-strand spliced CDS', () => {
    const out = serializeGenBank(doc({ ...SPLICED, direction: -1 }));
    expect(out).toContain('complement(join(1..30,61..100))');
  });

  it('round-trips segments through export and re-parse without _locationString', () => {
    const out = serializeGenBank(doc(SPLICED));
    const reparsed = parseGenBankFull(out);

    const cds = reparsed.annotations.find((a) => a.type === 'CDS');
    expect(cds?.segments).toEqual([
      { start: 1, end: 30 },
      { start: 61, end: 100 },
    ]);
  });

  it('still prefers a stored _locationString when present (round-trip fidelity)', () => {
    const out = serializeGenBank(
      doc({
        ...SPLICED,
        qualifiers: { _locationString: ['join(<1..30,61..>100)'] },
      })
    );
    expect(out).toContain('join(<1..30,61..>100)');
  });

  it('leaves a single-segment annotation as a plain range', () => {
    const out = serializeGenBank(doc({ ...SPLICED, segments: [{ start: 1, end: 100 }] }));
    expect(out).toMatch(/1\.\.100/);
    expect(out).not.toContain('join(');
  });

  it('leaves an annotation with no segments as a plain range', () => {
    const out = serializeGenBank(doc({ ...SPLICED, segments: undefined }));
    expect(out).toMatch(/1\.\.100/);
    expect(out).not.toContain('join(');
  });
});
