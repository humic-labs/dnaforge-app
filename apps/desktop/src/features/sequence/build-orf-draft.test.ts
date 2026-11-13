// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { buildOrfDraft } from './build-orf-draft';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';

const seqWith = (sequence: string, annotations: Annotation[] = []): AnnotatedSequence => ({
  id: 'test',
  name: 'test',
  sequence,
  annotations,
  circular: false,
});

describe('buildOrfDraft', () => {
  it('forward ORF: writes /translation with transl_table=1 by default', () => {
    const sequence = seqWith('ATGGCCTAA');
    const draft = buildOrfDraft({ start: 0, end: 8, strand: '+', frame: 1, length: 9 }, sequence);

    expect(draft).not.toBeNull();
    expect(draft!.type).toBe('CDS');
    expect(draft!.start).toBe(1);
    expect(draft!.end).toBe(9);
    expect(draft!.direction).toBe(1);
    expect(draft!.name).toBe('ORF_frame1_1_9');
    expect(draft!.qualifiers?.translation?.[0]).toBe('MA');
    expect(draft!.qualifiers?.transl_table?.[0]).toBe('1');
  });

  it('reverse ORF: direction=-1, translation respects strand', () => {
    const sequence = seqWith('TTAGGCCAT');
    const draft = buildOrfDraft({ start: 0, end: 8, strand: '-', frame: -1, length: 9 }, sequence);

    expect(draft).not.toBeNull();
    expect(draft!.direction).toBe(-1);
    expect(draft!.qualifiers?.translation?.[0]).toBe('MA');
    expect(draft!.qualifiers?.transl_table?.[0]).toBe('1');
  });

  it('non-multiple-of-3 length: skips /translation, keeps coords', () => {
    const sequence = seqWith('ATGGCCTA');
    const draft = buildOrfDraft({ start: 0, end: 7, strand: '+', frame: 1, length: 8 }, sequence);

    expect(draft).not.toBeNull();
    expect(draft!.type).toBe('CDS');
    expect(draft!.qualifiers).toBeUndefined();
  });

  it('non-standard transl_table on existing CDS: translates on THAT code', () => {
    const sequence = seqWith('ATGGCCTAA', [
      {
        name: 'existing-mito-cds',
        type: 'CDS',
        start: 100,
        end: 200,
        direction: 1,
        qualifiers: { transl_table: ['2'] },
      },
    ]);
    const draft = buildOrfDraft({ start: 0, end: 8, strand: '+', frame: 1, length: 9 }, sequence);

    expect(draft).not.toBeNull();
    expect(draft!.qualifiers?.transl_table).toEqual(['2']);
    expect(draft!.qualifiers?.translation).toEqual(['MA']);
  });

  it('a code that reassigns a codon changes the drafted protein', () => {
    const bases = 'ATGTGAGCCTAA';
    const orf = { start: 0, end: 11, strand: '+' as const, frame: 1, length: 12 };

    const standard = buildOrfDraft(orf, seqWith(bases));
    expect(standard!.qualifiers?.translation).toEqual(['M*A']);
    expect(standard!.qualifiers?.transl_table).toEqual(['1']);

    const mitochondrial = buildOrfDraft(
      orf,
      seqWith(bases, [
        {
          name: 'mito-cds',
          type: 'CDS',
          start: 100,
          end: 200,
          direction: 1,
          qualifiers: { transl_table: ['2'] },
        },
      ])
    );
    expect(mitochondrial!.qualifiers?.translation).toEqual(['MWA']);
    expect(mitochondrial!.qualifiers?.transl_table).toEqual(['2']);
  });

  it('existing CDS with table=1 explicitly: still writes /translation', () => {
    const sequence = seqWith('ATGGCCTAA', [
      {
        name: 'existing-std-cds',
        type: 'CDS',
        start: 100,
        end: 200,
        direction: 1,
        qualifiers: { transl_table: ['1'] },
      },
    ]);
    const draft = buildOrfDraft({ start: 0, end: 8, strand: '+', frame: 1, length: 9 }, sequence);

    expect(draft!.qualifiers?.translation?.[0]).toBe('MA');
    expect(draft!.qualifiers?.transl_table?.[0]).toBe('1');
  });

  it('existing CDS without transl_table qualifier: writes /translation (table 1 assumed)', () => {
    const sequence = seqWith('ATGGCCTAA', [
      {
        name: 'existing-untagged-cds',
        type: 'CDS',
        start: 100,
        end: 200,
        direction: 1,
      },
    ]);
    const draft = buildOrfDraft({ start: 0, end: 8, strand: '+', frame: 1, length: 9 }, sequence);

    expect(draft!.qualifiers?.translation?.[0]).toBe('MA');
  });

  it('end < start (malformed input): returns null', () => {
    const sequence = seqWith('ATGGCCTAA');
    const draft = buildOrfDraft({ start: 8, end: 0, strand: '+', frame: 1, length: 0 }, sequence);
    expect(draft).toBeNull();
  });

  it('frame number is preserved in the auto-generated name', () => {
    const sequence = seqWith('ATGGCCTAA');
    const fwdFrame3 = buildOrfDraft(
      { start: 0, end: 8, strand: '+', frame: 3, length: 9 },
      sequence
    );
    const revFrame2 = buildOrfDraft(
      { start: 0, end: 8, strand: '-', frame: -2, length: 9 },
      seqWith('TTAGGCCAT')
    );
    expect(fwdFrame3!.name).toBe('ORF_frame3_1_9');
    expect(revFrame2!.name).toBe('ORF_frame-2_1_9');
  });
});
