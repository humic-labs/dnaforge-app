import { describe, it, expect } from 'vitest';
import { computeLaneCountsPerRow, computeSequenceLayoutImpl } from '../useSequenceLayout';
import type { WorkspaceEditorConfig } from '../types';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';

function mkSeq(length: number, circular = false): AnnotatedSequence {
  return {
    id: 'test',
    name: 'test',
    sequence: 'A'.repeat(length),
    annotations: [],
    circular,
  };
}

function mkConfig(overrides: Partial<WorkspaceEditorConfig> = {}): WorkspaceEditorConfig {
  return {
    ...DEFAULT_EDITOR_CONFIG,
    charsPerLine: 80,
    charWidth: 8,
    rowHeight: 20,
    marginLeft: 40,
    ...overrides,
  };
}

describe('computeSequenceLayoutImpl — bpOffset on linear sequences', () => {
  it('without bpOffset, row 0 starts at bp 0', () => {
    const layout = computeSequenceLayoutImpl(mkSeq(200), mkConfig(), 0, 0, [], false, [], 0);
    expect(layout.lines[0].startPos).toBe(0);
  });

  it('with bpOffset=500, row 0 starts at bp 500', () => {
    const layout = computeSequenceLayoutImpl(mkSeq(2000), mkConfig(), 0, 0, [], false, [], 500);
    expect(layout.lines[0].startPos).toBe(500);
  });

  it('row N always starts at bpOffset + N × charsPerLine (linear)', () => {
    const cfg = mkConfig({ charsPerLine: 80 });
    const layout = computeSequenceLayoutImpl(mkSeq(2000), cfg, 0, 0, [], false, [], 100);
    expect(layout.lines[0].startPos).toBe(100);
    expect(layout.lines[1].startPos).toBe(180);
    expect(layout.lines[2].startPos).toBe(260);
  });

  it('last line is truncated if bpOffset + N × charsPerLine + charsPerLine > seqLen', () => {
    const layout = computeSequenceLayoutImpl(mkSeq(200), mkConfig(), 0, 0, [], false, [], 150);
    expect(layout.lines[0].startPos).toBe(150);
    expect(layout.lines[0].sequence.length).toBe(50);
    expect(layout.lines.length).toBe(1);
  });

  it('bpOffset=0 is equivalent to no bpOffset', () => {
    const a = computeSequenceLayoutImpl(mkSeq(500), mkConfig(), 0, 0, [], false, [], 0);
    const b = computeSequenceLayoutImpl(mkSeq(500), mkConfig(), 0, 0, [], false, []);
    expect(a.lines.length).toBe(b.lines.length);
    expect(a.lines.map((l) => l.startPos)).toEqual(b.lines.map((l) => l.startPos));
  });
});

describe('computeSequenceLayoutImpl — bpOffset on circular sequences', () => {
  it('circular: bpOffset shifts row 0 like linear (no virtual rows)', () => {
    const layout = computeSequenceLayoutImpl(
      mkSeq(2000, true),
      mkConfig(),
      0,
      0,
      [],
      false,
      [],
      500
    );
    expect(layout.lines[0].startPos).toBe(500);
  });

  it('circular: bpOffset combines with circularOffset', () => {
    const layout = computeSequenceLayoutImpl(
      mkSeq(2000, true),
      mkConfig(),
      200,
      0,
      [],
      false,
      [],
      50
    );
    expect(layout.lines[0].startPos).toBe(250);
  });

  it('circular: row 0 wraps around the origin when bpOffset + circularOffset >= seqLen', () => {
    const layout = computeSequenceLayoutImpl(
      mkSeq(1000, true),
      mkConfig(),
      900,
      0,
      [],
      false,
      [],
      200
    );
    expect(layout.lines[0].startPos).toBe(100);
  });

  it('keeps post-origin annotations and CDSs on the row that crosses origin', () => {
    const cpr = 100;
    const seq: AnnotatedSequence = {
      id: 'origin-row',
      name: 'origin-row',
      sequence: 'A'.repeat(1000),
      length: 1000,
      annotations: [
        { name: 'pre-origin-misc', type: 'misc_feature', start: 970, end: 990, direction: 1 },
        { name: 'post-origin-misc', type: 'misc_feature', start: 10, end: 40, direction: 1 },
        { name: 'post-origin-cds', type: 'CDS', start: 15, end: 45, direction: 1 },
      ],
      circular: true,
    };

    const layout = computeSequenceLayoutImpl(seq, mkConfig({ charsPerLine: cpr }), 950);
    const originLine = layout.lines[0];
    const names = originLine.annotations.map((a) => a.name);

    expect(originLine.startPos).toBe(950);
    expect(originLine.endPos).toBe(50);
    expect(originLine.originPosition).toBe(50);
    expect(names).toEqual(expect.arrayContaining(['pre-origin-misc', 'post-origin-misc']));
    expect(originLine.annotationLaneCount).toBeGreaterThan(0);
    expect(originLine.classifiedCDSs.some((cds) => cds.name === 'post-origin-cds')).toBe(true);
    expect(originLine.translationLaneCount).toBeGreaterThan(0);

    const laneCounts = computeLaneCountsPerRow({
      annotations: seq.annotations,
      primers: [],
      orfs: [],
      cpr,
      seqLen: seq.length ?? seq.sequence.length,
      isCircular: true,
      normalizedBpOffset: 950,
      topBufferCount: 0,
      realRowCount: Math.ceil((seq.length ?? seq.sequence.length) / cpr),
      bottomBufferCount: 0,
      showPrimers: false,
    });
    expect(laneCounts[0].annotationLaneCount).toBe(originLine.annotationLaneCount);
    expect(laneCounts[0].translationLaneCount).toBe(originLine.translationLaneCount);
  });
});

describe('computeSequenceLayoutImpl — bpOffset default', () => {
  it('bpOffset defaults to 0', () => {
    const layout = computeSequenceLayoutImpl(mkSeq(500), mkConfig(), 0, 0, [], false, []);
    expect(layout.lines[0].startPos).toBe(0);
  });
});
