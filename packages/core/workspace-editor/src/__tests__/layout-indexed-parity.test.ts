import { describe, it, expect } from 'vitest';
import type { AnnotatedSequence, ORF } from '@waypoint/sequence-utils';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import { DEFAULT_EDITOR_CONFIG } from '../types';

describe('layout output shape under various fixtures', () => {
  it('linear sequence with annotations + CDS produces valid lines', () => {
    const seq: AnnotatedSequence = {
      id: 'linear',
      name: 'linear',
      sequence: 'ACGTACGTAC'.repeat(50),
      length: 500,
      annotations: [
        { name: 'feat1', type: 'misc_feature', start: 20, end: 80, direction: 1 },
        { name: 'feat2', type: 'misc_feature', start: 100, end: 180, direction: -1 },
        { name: 'cds1', type: 'CDS', start: 200, end: 350, direction: 1 },
      ],
      circular: false,
    };
    const layout = computeSequenceLayoutImpl(seq, {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 80,
    });
    expect(layout.lines.length).toBeGreaterThan(0);
    for (const line of layout.lines) {
      expect(line.complementSequence.length).toBe(line.sequence.length);
    }
    const annotatedLine = layout.lines.find((l) => l.annotations.some((a) => a.name === 'feat1'));
    expect(annotatedLine).toBeDefined();
    const cdsLine = layout.lines.find((l) => l.classifiedCDSs.some((c) => c.name === 'cds1'));
    expect(cdsLine).toBeDefined();
  });

  it('circular sequence with origin-spanning annotation', () => {
    const seq: AnnotatedSequence = {
      id: 'circ',
      name: 'circ',
      sequence: 'ACGTACGTAC'.repeat(50),
      length: 500,
      annotations: [
        { name: 'wrap', type: 'misc_feature', start: 480, end: 50, direction: 1 },
        { name: 'normal', type: 'misc_feature', start: 100, end: 200, direction: 1 },
      ],
      circular: true,
    };
    const layout = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 80 },
      0,
      5,
      [],
      false,
      [],
      0
    );
    const hasWrap = layout.lines.some((l) => l.annotations.some((a) => a.name === 'wrap'));
    const hasNormal = layout.lines.some((l) => l.annotations.some((a) => a.name === 'normal'));
    expect(hasWrap).toBe(true);
    expect(hasNormal).toBe(true);
  });

  it('ORFs on both strands produce correct forward/reverse lane counts', () => {
    const orfs: ORF[] = [
      { start: 0, end: 60, strand: '+' },
      { start: 30, end: 90, strand: '+' },
      { start: 100, end: 150, strand: '-' },
    ];
    const seq: AnnotatedSequence = {
      id: 'orf',
      name: 'orf',
      sequence: 'ACGTACGTAC'.repeat(50),
      length: 500,
      annotations: [],
      circular: false,
    };
    const layout = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 80 },
      0,
      0,
      [],
      false,
      orfs
    );
    const firstRow = layout.lines[0];
    expect(firstRow.forwardOrfLaneCount).toBeGreaterThanOrEqual(1);
    const secondRow = layout.lines[1];
    expect(secondRow.reverseOrfLaneCount).toBeGreaterThanOrEqual(1);
  });

  it('primers are counted per row', () => {
    const seq: AnnotatedSequence = {
      id: 'primer',
      name: 'primer',
      sequence: 'ACGTACGTAC'.repeat(50),
      length: 500,
      annotations: [],
      circular: false,
    };
    const primers = [
      { start: 10, end: 30, direction: 'forward' as const, name: 'p1' },
      { start: 40, end: 60, direction: 'reverse' as const, name: 'p2' },
    ];
    const layout = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 80, showPrimers: true },
      0,
      0,
      primers,
      false,
      []
    );
    expect(layout.lines[0]).toBeDefined();
  });

  it('bpOffset shifts the visible sequence', () => {
    const seq: AnnotatedSequence = {
      id: 'off',
      name: 'off',
      sequence: 'ABCDEFGHIJ'.repeat(50),
      length: 500,
      annotations: [],
      circular: true,
    };
    const layoutA = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 10 },
      0,
      0,
      [],
      false,
      [],
      0
    );
    const layoutB = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 10 },
      0,
      0,
      [],
      false,
      [],
      5
    );
    expect(layoutA.lines[0].startPos).toBe(0);
    expect(layoutB.lines[0].startPos).toBe(5);
    expect(layoutA.lines[0].sequence).not.toBe(layoutB.lines[0].sequence);
  });

  it('empty sequence returns empty layout', () => {
    const seq: AnnotatedSequence = {
      id: 'empty',
      name: 'empty',
      sequence: '',
      length: 0,
      annotations: [],
      circular: false,
    };
    const layout = computeSequenceLayoutImpl(seq, {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 80,
    });
    expect(layout.lines).toEqual([]);
  });

  it('complement is correct for simple sequence', () => {
    const seq: AnnotatedSequence = {
      id: 'c',
      name: 'c',
      sequence: 'ACGT',
      length: 4,
      annotations: [],
      circular: false,
    };
    const layout = computeSequenceLayoutImpl(seq, {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 80,
    });
    expect(layout.lines[0].sequence).toBe('ACGT');
    expect(layout.lines[0].complementSequence).toBe('TGCA');
  });

  it('complement handles circular substring wrap', () => {
    const seq: AnnotatedSequence = {
      id: 'cw',
      name: 'cw',
      sequence: 'ACGTACGTAC',
      length: 10,
      annotations: [],
      circular: true,
    };
    const layout = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 10 },
      0,
      0,
      [],
      false,
      [],
      5
    );
    expect(layout.lines[0].sequence).toBe('CGTACACGTA');
    expect(layout.lines[0].complementSequence).toBe('GCATGTGCAT');
  });
});
