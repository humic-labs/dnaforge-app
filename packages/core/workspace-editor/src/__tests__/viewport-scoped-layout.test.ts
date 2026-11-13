import { describe, it, expect } from 'vitest';
import type { AnnotatedSequence, ORF } from '@waypoint/sequence-utils';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import { DEFAULT_EDITOR_CONFIG } from '../types';

const makeSeq = (opts?: Partial<AnnotatedSequence>): AnnotatedSequence => ({
  id: 's',
  name: 's',
  sequence: 'ACGT'.repeat(250),
  length: 1000,
  annotations: [
    { name: 'a1', type: 'misc_feature', start: 50, end: 150, direction: 1 },
    { name: 'cds', type: 'CDS', start: 200, end: 400, direction: 1 },
    { name: 'a2', type: 'misc_feature', start: 500, end: 700, direction: 1 },
  ],
  circular: false,
  ...opts,
});

describe('viewport-scoped layout — geometry invariance', () => {
  it('prepares dense rows by their actual pixel extent while preserving every row and offset', () => {
    for (const circular of [false, true]) {
      const sequence = makeSeq({
        sequence: 'ACGT'.repeat(2000),
        length: 8000,
        circular,
        annotations: Array.from({ length: 80 }, (_, row) =>
          Array.from({ length: 8 }, (_, lane) => ({
            name: `feature-${row}-${lane}`,
            type: 'misc_feature',
            start: row * 100 + 1 + lane,
            end: row * 100 + 90,
            direction: 1,
          }))
        ).flat(),
      });
      const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 };
      const range = { firstRowIndex: 0, lastRowIndex: 89, emitOnlyViewportLines: true };
      const layout = (extra = {}) =>
        computeSequenceLayoutImpl(sequence, config, 0, circular ? 5 : 0, [], false, [], 0, {
          ...range,
          ...extra,
        });
      const reference = layout();
      const anchorRowIndex = 40;
      const radiusPx = 240;
      const bounded = layout({ anchorRowIndex, radiusPx });
      expect(bounded.lines.length).toBeLessThan(reference.lines.length / 4);
      expect(bounded.summary!.rowHeights).toEqual(reference.summary!.rowHeights);
      expect(bounded.summary!.rowYOffsets).toEqual(reference.summary!.rowYOffsets);
      expect(bounded.totalHeight).toBe(reference.totalHeight);
      for (const row of bounded.lines)
        expect(row).toEqual(
          reference.lines.find((candidate) => candidate.lineIndex === row.lineIndex)
        );
      const offsets = bounded.summary!.rowYOffsets;
      expect(offsets[anchorRowIndex] - offsets[bounded.lines[0].lineIndex]).toBeGreaterThanOrEqual(
        radiusPx
      );
      expect(
        offsets[bounded.lines.at(-1)!.lineIndex + 1] - offsets[anchorRowIndex + 1]
      ).toBeGreaterThanOrEqual(radiusPx);

      const expanding = layout({ anchorRowIndex, radiusPx, maxPaintedRowPitch: 20 });
      expect(expanding.lines[0].lineIndex).toBeLessThanOrEqual(anchorRowIndex - 12);
      expect(expanding.lines.at(-1)!.lineIndex).toBeGreaterThanOrEqual(anchorRowIndex + 12);
      expect(expanding.summary!.rowYOffsets).toEqual(reference.summary!.rowYOffsets);
    }
  });

  it('matches every forecasted height and offset when sparse preparation skips circular and linear rows', () => {
    for (const circular of [false, true])
      for (const cpr of [11, 31, 103])
        for (const direction of [-1, 1] as const) {
          const sequence = makeSeq({
            sequence: 'ACGT'.repeat(800),
            length: 3200,
            circular,
            annotations: [
              { name: 'first', type: 'gene', start: 8, end: 87, direction: 1 },
              { name: 'overlap', type: 'gene', start: 54, end: 190, direction: 1 },
              { name: 'coding', type: 'CDS', start: 211, end: 702, direction: -1 },
              { name: 'last', type: 'gene', start: 3099, end: 3188, direction: 1 },
            ],
          });
          const config = {
            ...DEFAULT_EDITOR_CONFIG,
            charsPerLine: cpr,
            wrapCapacity: cpr + 0.37,
            wrapAnchorBp: 119,
            wrapAnchorViewportX: 360,
            wrapForecastDirection: direction,
            predictedTopBp: 37,
          };
          const range = { firstRowIndex: 4, lastRowIndex: 10 };
          const reference = computeSequenceLayoutImpl(
            sequence,
            config,
            29,
            circular ? 5 : 0,
            [],
            false,
            [],
            0,
            range
          );
          const sparse = computeSequenceLayoutImpl(
            sequence,
            config,
            29,
            circular ? 5 : 0,
            [],
            false,
            [],
            0,
            {
              ...range,
              emitOnlyViewportLines: true,
            }
          );
          expect(sparse.summary!.rowHeights).toEqual(reference.summary!.rowHeights);
          expect(sparse.summary!.rowYOffsets).toEqual(reference.summary!.rowYOffsets);
          expect(sparse.totalHeight).toBe(reference.totalHeight);
          expect(sparse.realRowsStartY).toBe(reference.realRowsStartY);
          expect(sparse.bottomBufferStartY).toBe(reference.bottomBufferStartY);
        }
  });

  it('totalHeight and rowYOffsets identical with and without viewportRange', () => {
    const seq = makeSeq();
    const cpr = 100;
    const full = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr });
    const scoped = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      0,
      [],
      false,
      [],
      0,
      { firstRowIndex: 2, lastRowIndex: 4 }
    );
    expect(scoped.totalHeight).toBe(full.totalHeight);
    expect(scoped.summary!.totalRows).toBe(full.summary!.totalRows);
    for (let i = 0; i <= full.summary!.totalRows; i++) {
      expect(scoped.summary!.rowYOffsets[i], `rowYOffsets[${i}]`).toBe(
        full.summary!.rowYOffsets[i]
      );
    }
    for (let i = 0; i < full.summary!.totalRows; i++) {
      expect(scoped.summary!.rowHeights[i], `rowHeights[${i}]`).toBe(full.summary!.rowHeights[i]);
    }
  });

  it('in-viewport rows have full annotations data', () => {
    const seq = makeSeq();
    const cpr = 100;
    const full = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr });
    const scoped = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      0,
      [],
      false,
      [],
      0,
      { firstRowIndex: 0, lastRowIndex: 3 }
    );
    for (let i = 0; i <= 3; i++) {
      expect(scoped.lines[i].annotationLaneCount).toBe(full.lines[i].annotationLaneCount);
      expect(scoped.lines[i].translationLaneCount).toBe(full.lines[i].translationLaneCount);
      expect(scoped.lines[i].y).toBe(full.lines[i].y);
      expect(scoped.lines[i].startPos).toBe(full.lines[i].startPos);
      expect(scoped.lines[i].endPos).toBe(full.lines[i].endPos);
      const fullKeys = new Set(
        full.lines[i].annotations.map((a) => `${a.name}-${a.start}-${a.end}`)
      );
      const scopedKeys = new Set(
        scoped.lines[i].annotations.map((a) => `${a.name}-${a.start}-${a.end}`)
      );
      expect(scopedKeys).toEqual(fullKeys);
      expect(scoped.lines[i].complementSequence.length).toBe(scoped.lines[i].sequence.length);
    }
  });

  it('out-of-viewport rows are skeletons but preserve geometry', () => {
    const seq = makeSeq();
    const cpr = 100;
    const full = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr });
    const scoped = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      0,
      [],
      false,
      [],
      0,
      { firstRowIndex: 0, lastRowIndex: 3 }
    );
    for (let i = 4; i < full.lines.length; i++) {
      const skel = scoped.lines[i];
      expect(skel.y).toBe(full.lines[i].y);
      expect(skel.startPos).toBe(full.lines[i].startPos);
      expect(skel.endPos).toBe(full.lines[i].endPos);
      expect(skel.annotationLaneCount).toBe(full.lines[i].annotationLaneCount);
      expect(skel.translationLaneCount).toBe(full.lines[i].translationLaneCount);
      expect(skel.forwardOrfLaneCount).toBe(full.lines[i].forwardOrfLaneCount);
      expect(skel.reverseOrfLaneCount).toBe(full.lines[i].reverseOrfLaneCount);
      expect(skel.annotations).toEqual([]);
      expect(skel.classifiedCDSs).toEqual([]);
      expect(skel.forwardOrfs).toBeUndefined();
      expect(skel.reverseOrfs).toBeUndefined();
      expect(skel.sequence.length).toBe(full.lines[i].sequence.length);
      expect(skel.complementSequence).toBe('');
    }
  });

  it('can omit off-viewport skeleton lines while preserving summary offsets approximately', () => {
    const seq = makeSeq();
    const cpr = 100;
    const scoped = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      0,
      [],
      false,
      [],
      0,
      {
        firstRowIndex: 3,
        lastRowIndex: 4,
        approximateOffscreenRowHeight: 17,
        emitOnlyViewportLines: true,
      }
    );

    expect(scoped.summary!.totalRows).toBe(10);
    expect(scoped.lines.map((line) => line.lineIndex)).toEqual([3, 4]);
    expect(scoped.summary!.rowHeights[0]).toBe(17);
    expect(scoped.summary!.rowHeights[2]).toBe(17);
    expect(scoped.summary!.rowHeights[5]).toBe(17);
    expect(scoped.summary!.rowYOffsets[1]).toBe(32 + 17 + 32);
  });

  it('circular sequence with buffer rows works with viewport scoping', () => {
    const seq = makeSeq({ circular: true });
    const cpr = 100;
    const virtualRowCount = 3;
    const full = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      virtualRowCount,
      [],
      false,
      [],
      0
    );
    const scoped = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      virtualRowCount,
      [],
      false,
      [],
      0,
      { firstRowIndex: 5, lastRowIndex: 7 }
    );
    expect(scoped.totalHeight).toBe(full.totalHeight);
    expect(scoped.summary!.totalRows).toBe(full.summary!.totalRows);
    for (let i = 0; i <= full.summary!.totalRows; i++) {
      expect(scoped.summary!.rowYOffsets[i]).toBe(full.summary!.rowYOffsets[i]);
    }
  });

  it('ORFs contribute to per-row height via sweep-line in skeleton path', () => {
    const orfs: ORF[] = [
      { start: 0, end: 90, strand: '+' },
      { start: 50, end: 140, strand: '+' },
      { start: 200, end: 290, strand: '-' },
    ];
    const seq: AnnotatedSequence = {
      id: 'orf',
      name: 'orf',
      sequence: 'A'.repeat(1000),
      length: 1000,
      annotations: [],
      circular: false,
    };
    const cpr = 100;
    const full = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      0,
      [],
      false,
      orfs
    );
    const scoped = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      0,
      [],
      false,
      orfs,
      0,
      { firstRowIndex: 0, lastRowIndex: 0 }
    );
    expect(scoped.totalHeight).toBe(full.totalHeight);
    expect(scoped.summary!.rowHeights[2]).toBe(full.summary!.rowHeights[2]);
  });

  it('empty viewportRange at start (first row only)', () => {
    const seq = makeSeq();
    const cpr = 100;
    const full = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr });
    const scoped = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      0,
      [],
      false,
      [],
      0,
      { firstRowIndex: 0, lastRowIndex: 0 }
    );
    expect(scoped.totalHeight).toBe(full.totalHeight);
    expect(scoped.lines[0].annotations.length).toBe(full.lines[0].annotations.length);
    for (let i = 1; i < scoped.lines.length; i++) {
      expect(scoped.lines[i].annotations).toEqual([]);
    }
  });

  it('overview LOD collapses fixed vertical chrome enough for a genome viewport fit', () => {
    const seq: AnnotatedSequence = {
      id: 'mg1655-like',
      name: 'mg1655-like',
      sequence: 'A'.repeat(4_641_652),
      length: 4_641_652,
      annotations: [],
      circular: true,
    };
    const layout = computeSequenceLayoutImpl(seq, {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 10125,
      charWidth: 0.08,
      rowHeight: 0.2,
      showAnnotations: false,
      showTranslation: false,
      showReverseComplement: false,
      showPrimers: false,
      overviewLod: true,
    });

    expect(layout.totalHeight).toBeLessThanOrEqual(520);
    expect(layout.summary!.rowGapPx).toBe(0);
    expect(layout.summary!.topPaddingPx).toBe(0);
    expect(layout.summary!.rowHeights[0]).toBe(1);
  });

  it('density LOD preserves annotation data for semantic overview rendering', () => {
    const seq: AnnotatedSequence = {
      id: 'density-annotated',
      name: 'density-annotated',
      sequence: 'A'.repeat(100_000),
      length: 100_000,
      annotations: [
        { id: 'gene-a', name: 'geneA', type: 'gene', start: 1000, end: 5000, strand: 1 },
        { id: 'cds-a', name: 'cdsA', type: 'CDS', start: 20_000, end: 28_000, strand: 1 },
      ],
      circular: false,
    };

    const layout = computeSequenceLayoutImpl(seq, {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 5000,
      charWidth: 0.08,
      rowHeight: 0.2,
      showAnnotations: true,
      showTranslation: false,
      showReverseComplement: false,
      showPrimers: false,
      overviewLod: true,
    });

    expect(layout.totalHeight).toBeLessThanOrEqual(20);
    expect(layout.lines.some((line) => line.annotations.length > 0)).toBe(true);
    expect(
      new Set(
        layout.lines
          .flatMap((line) => [...line.annotations, ...(line.classifiedCDSs ?? [])])
          .map((ann) => ann.name)
      )
    ).toEqual(new Set(['geneA', 'cdsA']));
  });

  it('viewportRange covering all rows = full build', () => {
    const seq = makeSeq();
    const cpr = 100;
    const full = computeSequenceLayoutImpl(seq, { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr });
    const scoped = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: cpr },
      0,
      0,
      [],
      false,
      [],
      0,
      { firstRowIndex: 0, lastRowIndex: 999 }
    );
    expect(scoped.totalHeight).toBe(full.totalHeight);
    for (let i = 0; i < full.lines.length; i++) {
      const fullKeys = new Set(
        full.lines[i].annotations.map((a) => `${a.name}-${a.start}-${a.end}`)
      );
      const scopedKeys = new Set(
        scoped.lines[i].annotations.map((a) => `${a.name}-${a.start}-${a.end}`)
      );
      expect(scopedKeys, `row ${i}`).toEqual(fullKeys);
    }
  });
});
