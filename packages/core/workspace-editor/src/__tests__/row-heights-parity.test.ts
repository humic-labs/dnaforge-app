import { describe, it, expect } from 'vitest';
import type { AnnotatedSequence, ORF } from '@waypoint/sequence-utils';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import {
  yForAbsoluteRowIndex,
  absoluteRowIndexForY,
  yForBp,
  bpForY,
  getScrollYForSequencePosition,
} from '../layout-utils';
import { DEFAULT_EDITOR_CONFIG } from '../types';

describe('summary rowHeights / rowYOffsets parity with full-build y', () => {
  it('linear sequence with annotations', () => {
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'ACGT'.repeat(100),
      length: 400,
      annotations: [
        { name: 'a1', type: 'misc_feature', start: 20, end: 80, direction: 1 },
        { name: 'cds', type: 'CDS', start: 100, end: 200, direction: 1 },
      ],
      circular: false,
    };
    const cpr = 80;
    const layout = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr });
    const s = layout.summary!;

    expect(s.totalRows).toBe(layout.lines.length);
    for (let i = 0; i < layout.lines.length; i++) {
      expect(s.rowYOffsets[i], `row ${i} rowYOffsets vs lines[i].y`).toBe(layout.lines[i].y);
    }
    expect(s.rowYOffsets[s.totalRows]).toBe(layout.totalHeight);
  });

  it('circular sequence with buffer rows', () => {
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'ACGT'.repeat(100),
      length: 400,
      annotations: [{ name: 'a1', type: 'misc_feature', start: 50, end: 150, direction: 1 }],
      circular: true,
    };
    const cpr = 80;
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
    const s = layout.summary!;
    for (let i = 0; i < layout.lines.length; i++) {
      expect(s.rowYOffsets[i], `row ${i} y`).toBe(layout.lines[i].y);
    }
    expect(s.rowYOffsets[s.totalRows]).toBe(layout.totalHeight);
  });

  it('origin-spanning annotation with buffer rows', () => {
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'ACGT'.repeat(100),
      length: 400,
      annotations: [
        { name: 'wrap', type: 'misc_feature', start: 380, end: 50, direction: 1 },
        { name: 'norm', type: 'misc_feature', start: 100, end: 200, direction: 1 },
      ],
      circular: true,
    };
    const cpr = 100;
    const layout = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      2,
      [],
      false,
      [],
      0
    );
    const s = layout.summary!;
    for (let i = 0; i < layout.lines.length; i++) {
      expect(s.rowYOffsets[i]).toBe(layout.lines[i].y);
    }
    expect(s.rowYOffsets[s.totalRows]).toBe(layout.totalHeight);
  });

  it('ORFs contribute to per-row heights correctly', () => {
    const orfs: ORF[] = [
      { start: 0, end: 100, strand: '+' },
      { start: 50, end: 150, strand: '+' },
      { start: 200, end: 280, strand: '-' },
    ];
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'A'.repeat(400),
      length: 400,
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
    const s = layout.summary!;
    for (let i = 0; i < layout.lines.length; i++) {
      expect(s.rowYOffsets[i]).toBe(layout.lines[i].y);
    }
    expect(s.rowYOffsets[s.totalRows]).toBe(layout.totalHeight);
  });

  it('yForAbsoluteRowIndex returns exact y for in-range rows', () => {
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'A'.repeat(400),
      length: 400,
      annotations: [],
      circular: false,
    };
    const layout = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 });
    const s = layout.summary!;
    for (let i = 0; i < s.totalRows; i++) {
      expect(yForAbsoluteRowIndex(i, s)).toBe(layout.lines[i].y);
    }
    expect(yForAbsoluteRowIndex(s.totalRows, s)).toBe(layout.totalHeight);
  });

  it('absoluteRowIndexForY is inverse of yForAbsoluteRowIndex', () => {
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'A'.repeat(1000),
      length: 1000,
      annotations: [],
      circular: false,
    };
    const layout = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 });
    const s = layout.summary!;
    for (let i = 0; i < s.totalRows; i++) {
      const y = yForAbsoluteRowIndex(i, s);
      expect(absoluteRowIndexForY(y, s)).toBe(i);
    }
  });

  it('yForBp / bpForY match the walk-the-lines result', () => {
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'A'.repeat(500),
      length: 500,
      annotations: [{ name: 'a', type: 'misc_feature', start: 50, end: 150, direction: 1 }],
      circular: false,
    };
    const cpr = 80;
    const layout = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr });
    const s = layout.summary!;
    for (let i = 0; i < s.totalRows; i++) {
      const line = layout.lines[i];
      const yFromSummary = yForBp(line.startPos, s);
      expect(yFromSummary).not.toBeNull();
      expect(yFromSummary!).toBe(line.y);
      const yFromWalk = getScrollYForSequencePosition(line.startPos, layout);
      expect(yFromWalk).not.toBeNull();
      expect(yFromWalk!).toBe(line.y);
    }
  });

  it('circular sequence bpForY at row starts', () => {
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'A'.repeat(500),
      length: 500,
      annotations: [],
      circular: true,
    };
    const cpr = 100;
    const layout = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      2,
      [],
      false,
      [],
      0
    );
    const s = layout.summary!;
    for (let i = 0; i < s.totalRows; i++) {
      const line = layout.lines[i];
      expect(bpForY(line.y, s)).toBe(line.startPos);
    }
  });
});
