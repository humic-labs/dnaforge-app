import { describe, it, expect } from 'vitest';
import type { AnnotatedSequence, Annotation, ORF } from '@waypoint/sequence-utils';
import {
  classifyAndAssignCDSLanes,
  computeSequenceLayoutImpl,
  computeLaneCountsPerRow,
} from '../useSequenceLayout';
import type { PrimerDisplay } from '../types';
import { DEFAULT_EDITOR_CONFIG } from '../types';

function makePrimer(
  id: string,
  start: number,
  end: number,
  direction: 'forward' | 'reverse'
): PrimerDisplay {
  return {
    id,
    name: id,
    start,
    end,
    direction,
    bases: 'ACGTACGT',
    tm: 60,
    gc: 50,
  };
}

function assertRowParity(
  layoutLines: ReturnType<typeof computeSequenceLayoutImpl>['lines'],
  laneCounts: ReturnType<typeof computeLaneCountsPerRow>,
  context: string
): void {
  expect(layoutLines.length).toBe(laneCounts.length);
  for (let i = 0; i < layoutLines.length; i++) {
    const line = layoutLines[i];
    const sweep = laneCounts[i];

    expect(sweep.annotationLaneCount, `${context} row ${i} annotationLaneCount`).toBe(
      line.annotationLaneCount
    );
    expect(sweep.translationLaneCount, `${context} row ${i} translationLaneCount`).toBe(
      line.translationLaneCount ?? 0
    );
    expect(sweep.forwardOrfLaneCount, `${context} row ${i} forwardOrfLaneCount`).toBe(
      line.forwardOrfLaneCount
    );
    expect(sweep.reverseOrfLaneCount, `${context} row ${i} reverseOrfLaneCount`).toBe(
      line.reverseOrfLaneCount
    );

    expect(sweep.forwardPrimerLaneCount, `${context} row ${i} fwdPrimer`).toBeGreaterThanOrEqual(0);
    expect(sweep.reversePrimerLaneCount, `${context} row ${i} revPrimer`).toBeGreaterThanOrEqual(0);
  }
}

describe('computeLaneCountsPerRow — parity with greedy packing', () => {
  it('preserves exact ordinary CDS order, lanes and shared-index ownership across layouts', () => {
    const annotations: Annotation[] = [
      { name: 'adjacent', type: 'CDS', start: 31, end: 50, direction: 1 },
      { name: 'tie-first', type: 'CDS', start: 11, end: 30, direction: -1 },
      {
        name: 'left-long',
        type: 'CDS',
        start: 5,
        end: 75,
        direction: 1,
        qualifiers: { note: ['retain this field'] },
      },
      { name: 'outside-left', type: 'CDS', start: 1, end: 10, direction: 1 },
      { name: 'right', type: 'CDS', start: 51, end: 90, direction: -1 },
      { name: 'tie-second', type: 'CDS', start: 11, end: 30, direction: 1 },
      { name: 'nested', type: 'CDS', start: 21, end: 25, direction: -1 },
      { name: 'outside-right', type: 'CDS', start: 91, end: 100, direction: 1 },
    ];
    const before = structuredClone(annotations);
    for (const annotation of annotations) Object.freeze(annotation);
    Object.freeze(annotations);
    const sequence = 'A'.repeat(100);
    expect(classifyAndAssignCDSLanes(annotations, 10, 90, sequence, sequence.length)).toEqual({
      classifiedCDSs: [
        [2, 0],
        [1, 1],
        [5, 2],
        [6, 3],
        [0, 1],
        [4, 1],
      ].map(([index, translationLane]) => ({
        ...annotations[index],
        cdsType: 'partial',
        translationLane,
      })),
      translationLaneCount: 4,
    });

    const seq: AnnotatedSequence = {
      id: 'shared-cds',
      name: 'shared-cds',
      sequence,
      length: sequence.length,
      annotations,
      circular: false,
    };
    const first = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 25 });
    const firstRows = first.lines.map((line) => line.classifiedCDSs);
    const savedRows = structuredClone(firstRows);

    for (const row of firstRows) for (const cds of row) Object.freeze(cds);
    const second = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 50 });
    expect(firstRows).toEqual(savedRows);
    for (const line of second.lines)
      for (const cds of line.classifiedCDSs)
        expect(firstRows.flat().some((prior) => prior === cds)).toBe(false);
    expect(annotations).toEqual(before);
  });

  it('linear sequence, no overlaps', () => {
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'ACGT'.repeat(200),
      length: 800,
      annotations: [
        { name: 'a1', type: 'misc_feature', start: 20, end: 80, direction: 1 },
        { name: 'a2', type: 'misc_feature', start: 200, end: 300, direction: 1 },
      ],
      circular: false,
    };
    const cpr = 100;
    const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr };
    const layout = computeSequenceLayoutImpl(seq, config);
    const lanes = computeLaneCountsPerRow({
      annotations: seq.annotations,
      primers: [],
      orfs: [],
      cpr,
      seqLen: seq.length,
      isCircular: seq.circular ?? false,
      normalizedBpOffset: 0,
      topBufferCount: 0,
      realRowCount: Math.ceil(seq.length / cpr),
      bottomBufferCount: 0,
      showPrimers: false,
    });
    assertRowParity(layout.lines, lanes, 'linear-no-overlap');
  });

  it('linear sequence with heavy overlap on one row', () => {
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'ACGT'.repeat(50),
      length: 200,
      annotations: [
        { name: 'a1', type: 'misc_feature', start: 10, end: 50, direction: 1 },
        { name: 'a2', type: 'misc_feature', start: 20, end: 60, direction: 1 },
        { name: 'a3', type: 'misc_feature', start: 30, end: 70, direction: 1 },
        { name: 'a4', type: 'misc_feature', start: 15, end: 55, direction: 1 },
        { name: 'a5', type: 'misc_feature', start: 25, end: 65, direction: 1 },
      ],
      circular: false,
    };
    const cpr = 200;
    const layout = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr });
    const lanes = computeLaneCountsPerRow({
      annotations: seq.annotations,
      primers: [],
      orfs: [],
      cpr,
      seqLen: seq.length,
      isCircular: false,
      normalizedBpOffset: 0,
      topBufferCount: 0,
      realRowCount: 1,
      bottomBufferCount: 0,
      showPrimers: false,
    });
    assertRowParity(layout.lines, lanes, 'heavy-overlap');

    expect(lanes[0].annotationLaneCount).toBeGreaterThanOrEqual(3);
  });

  it('linear sequence with CDS', () => {
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'ATGGCCAAGCTT'.repeat(30),
      length: 360,
      annotations: [
        { name: 'gene1', type: 'CDS', start: 10, end: 100, direction: 1 },
        { name: 'gene2', type: 'CDS', start: 200, end: 290, direction: 1 },
        { name: 'feat', type: 'misc_feature', start: 50, end: 150, direction: 1 },
      ],
      circular: false,
    };
    const cpr = 80;
    const layout = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr });
    const lanes = computeLaneCountsPerRow({
      annotations: seq.annotations,
      primers: [],
      orfs: [],
      cpr,
      seqLen: seq.length,
      isCircular: false,
      normalizedBpOffset: 0,
      topBufferCount: 0,
      realRowCount: Math.ceil(seq.length / cpr),
      bottomBufferCount: 0,
      showPrimers: false,
    });
    assertRowParity(layout.lines, lanes, 'linear-cds');
  });

  it('circular sequence with buffer rows', () => {
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'ACGT'.repeat(100),
      length: 400,
      annotations: [
        { name: 'a1', type: 'misc_feature', start: 50, end: 150, direction: 1 },
        { name: 'a2', type: 'misc_feature', start: 200, end: 300, direction: 1 },
      ],
      circular: true,
    };
    const cpr = 100;
    const virtualRowCount = 3;
    const layout = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      virtualRowCount,
      [],
      false,
      [],
      0
    );
    const lanes = computeLaneCountsPerRow({
      annotations: seq.annotations,
      primers: [],
      orfs: [],
      cpr,
      seqLen: seq.length,
      isCircular: true,
      normalizedBpOffset: 0,
      topBufferCount: virtualRowCount,
      realRowCount: Math.ceil(seq.length / cpr),
      bottomBufferCount: virtualRowCount,
      showPrimers: false,
    });
    assertRowParity(layout.lines, lanes, 'circular-buffer');
  });

  it('circular with origin-spanning annotation', () => {
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'ACGT'.repeat(100),
      length: 400,
      annotations: [
        { name: 'wrap', type: 'misc_feature', start: 350, end: 50, direction: 1 },
        { name: 'normal', type: 'misc_feature', start: 100, end: 200, direction: 1 },
      ],
      circular: true,
    };
    const cpr = 100;
    const virtualRowCount = 2;
    const layout = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      virtualRowCount,
      [],
      false,
      [],
      0
    );
    const lanes = computeLaneCountsPerRow({
      annotations: seq.annotations,
      primers: [],
      orfs: [],
      cpr,
      seqLen: seq.length,
      isCircular: true,
      normalizedBpOffset: 0,
      topBufferCount: virtualRowCount,
      realRowCount: Math.ceil(seq.length / cpr),
      bottomBufferCount: virtualRowCount,
      showPrimers: false,
    });
    assertRowParity(layout.lines, lanes, 'origin-spanning-ann');
  });

  it('circular with bpOffset (zoomed panned view)', () => {
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'ACGT'.repeat(100),
      length: 400,
      annotations: [
        { name: 'a1', type: 'misc_feature', start: 50, end: 150, direction: 1 },
        { name: 'a2', type: 'misc_feature', start: 250, end: 350, direction: 1 },
      ],
      circular: true,
    };
    const cpr = 100;
    const virtualRowCount = 2;
    const bpOffset = 75;
    const layout = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      virtualRowCount,
      [],
      false,
      [],
      bpOffset
    );
    const lanes = computeLaneCountsPerRow({
      annotations: seq.annotations,
      primers: [],
      orfs: [],
      cpr,
      seqLen: seq.length,
      isCircular: true,
      normalizedBpOffset: bpOffset,
      topBufferCount: virtualRowCount,
      realRowCount: Math.ceil(seq.length / cpr),
      bottomBufferCount: virtualRowCount,
      showPrimers: false,
    });
    assertRowParity(layout.lines, lanes, 'bpOffset');
  });

  it('ORFs on both strands', () => {
    const orfs: ORF[] = [
      { start: 0, end: 60, strand: '+' },
      { start: 30, end: 90, strand: '+' },
      { start: 20, end: 80, strand: '+' },
      { start: 100, end: 150, strand: '-' },
    ];
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'A'.repeat(300),
      length: 300,
      annotations: [],
      circular: false,
    };
    const cpr = 100;
    const layout = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      0,
      [],
      false,
      orfs
    );
    const lanes = computeLaneCountsPerRow({
      annotations: [],
      primers: [],
      orfs,
      cpr,
      seqLen: seq.length,
      isCircular: false,
      normalizedBpOffset: 0,
      topBufferCount: 0,
      realRowCount: 3,
      bottomBufferCount: 0,
      showPrimers: false,
    });
    assertRowParity(layout.lines, lanes, 'orfs-both-strands');

    expect(lanes[0].forwardOrfLaneCount).toBe(3);

    expect(lanes[1].reverseOrfLaneCount).toBe(1);
  });

  it('identical annotations are grouped (dedup parity)', () => {
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'A'.repeat(200),
      length: 200,
      annotations: [
        { name: 'x1', type: 'misc_feature', start: 20, end: 80, direction: 1 },
        { name: 'x2', type: 'misc_feature', start: 20, end: 80, direction: 1 },
        { name: 'x3', type: 'misc_feature', start: 20, end: 80, direction: 1 },
      ],
      circular: false,
    };
    const cpr = 200;
    const layout = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr });
    const lanes = computeLaneCountsPerRow({
      annotations: seq.annotations,
      primers: [],
      orfs: [],
      cpr,
      seqLen: 200,
      isCircular: false,
      normalizedBpOffset: 0,
      topBufferCount: 0,
      realRowCount: 1,
      bottomBufferCount: 0,
      showPrimers: false,
    });
    assertRowParity(layout.lines, lanes, 'identical-dedup');
    expect(lanes[0].annotationLaneCount).toBe(1);
  });

  it('primers are correctly counted on row', () => {
    const primers = [
      makePrimer('p1', 10, 40, 'forward'),
      makePrimer('p2', 20, 50, 'forward'),
      makePrimer('p3', 60, 90, 'reverse'),
    ];
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'A'.repeat(100),
      length: 100,
      annotations: [],
      circular: false,
    };
    const cpr = 100;
    const lanes = computeLaneCountsPerRow({
      annotations: [],
      primers,
      orfs: [],
      cpr,
      seqLen: seq.length,
      isCircular: false,
      normalizedBpOffset: 0,
      topBufferCount: 0,
      realRowCount: 1,
      bottomBufferCount: 0,
      showPrimers: true,
    });

    expect(lanes[0].forwardPrimerLaneCount).toBe(2);

    expect(lanes[0].reversePrimerLaneCount).toBe(1);
  });

  it('origin-spanning primer on circular sequence', () => {
    const primers = [makePrimer('wrap', 380, 50, 'forward')];
    const cpr = 100;
    const lanes = computeLaneCountsPerRow({
      annotations: [],
      primers,
      orfs: [],
      cpr,
      seqLen: 400,
      isCircular: true,
      normalizedBpOffset: 0,
      topBufferCount: 2,
      realRowCount: 4,
      bottomBufferCount: 2,
      showPrimers: true,
    });

    const rowIdx3 = 5;
    expect(lanes[rowIdx3].forwardPrimerLaneCount).toBe(1);
  });
});
