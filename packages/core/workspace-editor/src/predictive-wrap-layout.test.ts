import { describe, expect, it } from 'vitest';
import {
  continuousWrapRowOffset,
  paintedWrapRowXOffset,
  sharedWrapRowXs,
  sameWrapRowContent,
  morphRowHeights,
  wrapPrediction,
  rowPaintY,
  rowHitY,
  rowPaintBounds,
  morphBandY,
} from './predictive-wrap-layout';
import { computeSequenceLayoutImpl, getPositionFromCoordinates } from './useSequenceLayout';
import { DEFAULT_EDITOR_CONFIG } from './types';
import { computeLineTrackPositions, lineTrackBoundaries } from './line-track-layout';
import { detectAnnotationHit } from './hit-detection/annotation';
import { calculateLineTrackBounds } from './hit-detection/track-bounds';
import { ANNOTATION_BAR_HEIGHT } from './layout-constants';

describe('ahead-of-wrap row geometry', () => {
  it.each([{ painted: [0, 34, 60] }, { painted: [0, 8, 20] }])(
    'keeps external row padding rigid while its tracks accommodate: $painted',
    ({ painted }) => {
      const natural = [0, 16, 36];
      const row = { y: 753.674, trackMorph: { natural, painted } };
      const bounds = rowPaintBounds(row, row.y - 32, 36 + 32 + 12);
      expect(bounds.y).toBeCloseTo(row.y - 32, 8);
      expect(bounds.height).toBeCloseTo(painted[2] + 32 + 12, 8);
      expect(bounds.y).toBeGreaterThan(691);
      expect(morphBandY(natural, painted, 8)).toBe(painted[1] / 2);
      expect(morphBandY(natural, painted, 36 + 12)).toBe(painted[2] + 12);
    }
  );
  it('maps the external boundaries of zero-height tracks to their actual row edges', () => {
    const source = [0, 0, 16, 16];
    const target = [0, 12, 34, 40];
    expect(morphBandY(source, target, 0)).toBe(0);
    expect(morphBandY(source, target, -0.0001)).toBeCloseTo(-0.0001, 8);
    expect(morphBandY(source, target, 16)).toBe(40);
    expect(morphBandY(source, target, 16.0001)).toBeCloseTo(40.0001, 8);
  });
  it('retains offset motion only when the complete biological row is still prepared', () => {
    const row = {
      start: 2_568_742,
      length: 193,
      offset: 0,
      charWidth: 2,
      marginLeft: 4,
      circularLength: 4_641_652,
    };
    expect(sameWrapRowContent(row, { ...row, offset: -0.5 })).toBe(true);
    expect(sameWrapRowContent(row, { ...row, start: row.start + row.circularLength })).toBe(true);
    expect(sharedWrapRowXs(row, { ...row, start: row.start - 80, length: 273 })).not.toBeNull();
    expect(sameWrapRowContent(row, { ...row, start: row.start - 80, length: 273 })).toBe(false);
    expect(sameWrapRowContent(row, { ...row, length: 194 })).toBe(false);
    expect(
      sameWrapRowContent(
        { ...row, circularLength: 0 },
        { ...row, start: row.start + row.circularLength, circularLength: 0 }
      )
    ).toBe(false);
  });
  it('moves a distant row through intermediate x positions while zoom targets change immediately', () => {
    const previous = {
      start: 2_000_000,
      length: 49_003,
      offset: 0,
      charWidth: 0.022,
      marginLeft: 50,
      circularLength: 4_641_652,
    };
    const target = {
      ...previous,
      start: previous.start - 5_046,
      length: 48_162,
      charWidth: 0.0224,
    };
    const shared = sharedWrapRowXs(previous, target)!;
    expect(shared).not.toBeNull();
    expect(Math.abs(shared.targetX - shared.previousX)).toBeGreaterThan(100);
    const fromOffset = target.offset + 0.9 * (shared.previousX - shared.targetX);
    const atCommit = paintedWrapRowXOffset(fromOffset, target.offset, 100, 100, 112);
    const mid = paintedWrapRowXOffset(fromOffset, target.offset, 100, 156, 112);
    const atEnd = paintedWrapRowXOffset(fromOffset, target.offset, 100, 212, 112);
    expect(atCommit).toBe(fromOffset);
    expect(mid).toBeCloseTo((fromOffset + target.offset) / 2);
    expect(atEnd).toBe(target.offset);
    const nextTarget = { ...target, start: target.start - 800 };
    const nextShared = sharedWrapRowXs({ ...target, offset: mid }, nextTarget)!;
    const retargeted = nextTarget.offset + 0.9 * (nextShared.previousX - nextShared.targetX);
    expect(Math.abs(retargeted - nextTarget.offset)).toBeGreaterThan(1);
    expect(paintedWrapRowXOffset(retargeted, nextTarget.offset, 156, 268, 112)).toBe(0);
  });

  it('cancels the integer row-start step without moving the captured circular copy', () => {
    const width = 1248;
    const initialCapacity = 207.65;
    const bias = 207 - initialCapacity;
    const beforeCapacity = 207.999999;
    const afterCapacity = 208.000001;
    const beforeWidth = width / beforeCapacity;
    const afterWidth = width / afterCapacity;
    const anchorX = DEFAULT_EDITOR_CONFIG.marginLeft + 89 * (width / initialCapacity);
    const bp = 1754;
    const beforeOffset = continuousWrapRowOffset(
      -1035,
      31,
      29,
      -1360,
      anchorX,
      DEFAULT_EDITOR_CONFIG.marginLeft,
      beforeWidth,
      beforeCapacity + bias
    );
    const afterOffset = continuousWrapRowOffset(
      -1033,
      31,
      29,
      -1360,
      anchorX,
      DEFAULT_EDITOR_CONFIG.marginLeft,
      afterWidth,
      afterCapacity + bias
    );
    const beforeX = (bp - 1651) * beforeWidth + beforeOffset;
    const afterX = (bp - 1653) * afterWidth + afterOffset;
    expect(afterX).toBeCloseTo(beforeX, 3);
    const anchorOffset = continuousWrapRowOffset(
      -1449,
      29,
      29,
      -1360,
      anchorX,
      DEFAULT_EDITOR_CONFIG.marginLeft,
      width / initialCapacity,
      initialCapacity + bias
    );
    expect(anchorOffset).toBeCloseTo(0, 5);
  });

  for (const circular of [false, true]) {
    it(`keeps shared base columns continuous across a ${circular ? 'circular' : 'linear'} wrap`, () => {
      const sequence = {
        id: 'fractional-wrap',
        name: 'fractional-wrap',
        sequence: 'ACGT'.repeat(5000),
        length: 20000,
        circular,
        annotations: [],
      };
      const anchor = 1300;
      const column = 14;
      const currentCpr = 30;
      const nextCpr = 31;
      const currentTop = circular
        ? anchor - column
        : -((((column - anchor) % currentCpr) + currentCpr) % currentCpr);
      const futureTop = circular
        ? anchor - column
        : -((((column - anchor) % nextCpr) + nextCpr) % nextCpr);
      const base = {
        ...DEFAULT_EDITOR_CONFIG,
        charWidth: 10,
        charsPerLine: currentCpr,
        linearWrapPhase: true,
        wrapCapacity: nextCpr - 0.000001,
        wrapAnchorBp: anchor,
        wrapAnchorViewportX: DEFAULT_EDITOR_CONFIG.marginLeft + column * 10,
        predictedTopBp: futureTop,
        showTranslation: false,
      };
      const before = computeSequenceLayoutImpl(sequence, base, currentTop, circular ? 5 : 0);
      const after = computeSequenceLayoutImpl(
        sequence,
        { ...base, charsPerLine: nextCpr, wrapCapacity: nextCpr },
        futureTop,
        circular ? 5 : 0
      );
      const currentAnchorIndex =
        Math.floor((anchor - currentTop) / currentCpr) + (circular ? 5 : 0);
      const futureAnchorIndex = Math.floor((anchor - futureTop) / nextCpr) + (circular ? 5 : 0);
      for (let delta = -3; delta <= 3; delta++) {
        const oldRow = before.lines.find((row) => row.lineIndex === currentAnchorIndex + delta)!;
        const newRow = after.lines.find((row) => row.lineIndex === futureAnchorIndex + delta)!;
        const bp = Math.max(oldRow.startPos, newRow.startPos) + 8;
        const oldX = (bp - oldRow.startPos) * base.charWidth + (oldRow.xOffset ?? 0);
        const newX = (bp - newRow.startPos) * base.charWidth + (newRow.xOffset ?? 0);
        expect(
          oldX,
          JSON.stringify({
            delta,
            oldIndex: oldRow.lineIndex,
            newIndex: newRow.lineIndex,
            oldStart: oldRow.startPos,
            newStart: newRow.startPos,
            oldOffset: oldRow.xOffset,
            newOffset: newRow.xOffset,
          })
        ).toBeCloseTo(newX, 3);
      }
    });
  }

  it('never reserves less space than the annotations painted on the current wrap', () => {
    const sequence = {
      id: 'current-annotations',
      name: 'current-annotations',
      sequence: 'N'.repeat(300),
      length: 300,
      circular: false,
      annotations: [
        { name: 'a', type: 'gene', start: 1, end: 101, direction: 1 as const },
        { name: 'b', type: 'gene', start: 101, end: 200, direction: 1 as const },
      ],
    };
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 100,
      wrapCapacity: 100.5,
      showTranslation: false,
    };
    const layout = computeSequenceLayoutImpl(sequence, config);
    for (const line of layout.lines) {
      const annotationBand = line.trackMorph;
      if (!annotationBand) continue;
      expect(annotationBand.painted[1]).toBeGreaterThanOrEqual(annotationBand.natural[1]);
    }
  });

  it('reserves the requested zoom destination lanes before the current bases rewrap', () => {
    const sequence = {
      id: 'destination-annotations',
      name: 'destination-annotations',
      sequence: 'N'.repeat(300),
      length: 300,
      circular: false,
      annotations: [
        { name: 'a', type: 'gene', start: 1, end: 101, direction: 1 as const },
        { name: 'b', type: 'gene', start: 101, end: 200, direction: 1 as const },
      ],
    };
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 100,
      wrapCapacity: 100,
      wrapPreviewTargetCpr: 120,
      showTranslation: false,
    };
    const preview = computeSequenceLayoutImpl(sequence, config);
    const destination = computeSequenceLayoutImpl(sequence, {
      ...config,
      charsPerLine: 120,
      wrapCapacity: 120,
      wrapPreviewTargetCpr: undefined,
    });
    expect(preview.lines[0].annotationLaneCount).toBe(1);
    expect(destination.lines[0].annotationLaneCount).toBe(2);
    expect(preview.lines[0].trackMorph?.painted[1]).toBeCloseTo(
      lineTrackBoundaries(destination.lines[0], config)[1]
    );
  });

  it('reserves an inward annotation lane two wraps before its circular row appears', () => {
    const sequence = {
      id: 'inward-two-wrap-lane',
      name: 'inward-two-wrap-lane',
      sequence: 'N'.repeat(2686),
      length: 2686,
      circular: true,
      annotations: [
        { name: 'future lane', type: 'gene', start: 915, end: 916, direction: 1 as const },
      ],
    };
    const capacity = 62.1;
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 62,
      wrapCapacity: capacity,
      wrapAnchorBp: 1122,
      wrapAnchorViewportX:
        DEFAULT_EDITOR_CONFIG.marginLeft + (26 * DEFAULT_EDITOR_CONFIG.charWidth * capacity) / 61,
      wrapForecastDirection: 1 as const,
      showTranslation: false,
    };
    const prepared = computeSequenceLayoutImpl(sequence, config, 1096, 10);
    const next = computeSequenceLayoutImpl(
      sequence,
      {
        ...config,
        charsPerLine: 60,
        wrapCapacity: 60.9,
        wrapAnchorBp: undefined,
        wrapAnchorViewportX: undefined,
        wrapForecastDirection: undefined,
      },
      1096,
      10
    );
    const before = prepared.lines.find((row) => row.lineIndex === 6)!;
    const after = next.lines.find((row) => row.lineIndex === 6)!;
    expect(before.annotationLaneCount).toBe(0);
    expect(after.annotationLaneCount).toBe(1);
    expect(before.trackMorph?.painted[1]).toBeGreaterThanOrEqual(
      lineTrackBoundaries(after, config)[1]
    );
  });

  it('moves annotation geometry without stretching its body or hit area', () => {
    const row = {
      y: 500,
      trackMorph: { natural: [0, 66, 86], painted: [0, 22, 42] },
    };
    expect(rowPaintBounds(row, 502, 18)).toEqual({ y: 502, height: 18 });
    expect(rowPaintY(row, 511)).toBe(511);
    expect(rowHitY(row, 511)).toBe(511);
    expect(rowPaintBounds(row, 568, 14)).toEqual({ y: 524, height: 14 });
    expect(rowHitY(row, 531)).toBe(575);
    expect(rowPaintBounds(row, 546, 18).height).toBe(0);
  });
  it('uses the next track at a rounded absolute boundary during row morphing', () => {
    const row = {
      y: 4093.81,
      trackMorph: { natural: [0, 18, 35], painted: [0, 30, 47] },
    };
    const naturalEdge = row.y + row.trackMorph.natural[1];
    const paintedEdge = row.y + row.trackMorph.painted[1];
    expect(rowPaintY(row, naturalEdge)).toBeCloseTo(paintedEdge, 8);
    expect(rowHitY(row, paintedEdge)).toBeCloseTo(naturalEdge, 8);
  });
  it('does not turn newly reserved blank space into an annotation or nucleotide hit', () => {
    const row = {
      y: 500,
      trackMorph: { natural: [0, 22, 42], painted: [0, 66, 86] },
    };
    expect(rowHitY(row, 540)).toBe(Number.POSITIVE_INFINITY);
    expect(rowHitY(row, 571)).toBe(527);
  });
  it('hits the visible full-height annotation instead of another compressed lane', () => {
    const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100, showTranslation: false };
    const sequence = {
      id: 'rigid-hits',
      name: 'rigid-hits',
      sequence: 'N'.repeat(300),
      length: 300,
      circular: false,
      annotations: Array.from({ length: 3 }, (_, i) => ({
        name: `lane-${i}`,
        type: 'gene',
        start: 1 + i,
        end: 60 - i,
        direction: 1 as const,
      })),
    };
    const layout = computeSequenceLayoutImpl(sequence, config);
    const row = layout.lines[0];
    const natural = lineTrackBoundaries(row, config);
    expect(natural[1]).toBeGreaterThan(22);
    const painted = natural.map((y, i) => (i === 0 ? 0 : y - natural[1] + 22));
    const presented = { ...row, trackMorph: { natural, painted } };
    const hit = detectAnnotationHit(
      config.marginLeft + config.charWidth * 20,
      rowHitY(presented, row.y + ANNOTATION_BAR_HEIGHT - 1),
      presented,
      calculateLineTrackBounds(presented, config),
      config,
      300
    );
    expect(hit?.annotation).toBe(row.annotations.find((ann) => ann.lane === 0));
    const reserved = {
      ...row,
      trackMorph: { natural, painted: natural.map((y, i) => (i === 0 ? 0 : y + 30)) },
    };
    expect(
      getPositionFromCoordinates(
        config.marginLeft + config.charWidth * 20,
        row.y + natural[1] + 15,
        { ...layout, lines: [reserved] },
        config
      )
    ).toBeNull();
  });
  it('keeps nucleotide bounds exact at fractional absolute coordinates beside a disappearing track', () => {
    const row = {
      y: 234.32,
      trackMorph: {
        natural: [0, 75.4, 84.12, 84.12, 114.12],
        painted: [0, 75.4, 84.12, 93.84, 123.84],
      },
    };
    expect(rowPaintBounds(row, row.y + 75.4, 8.72).height).toBeCloseTo(8.72);
  });
  it('keeps label hit rectangles out of a newly reserved empty track', () => {
    const row = { y: 500, trackMorph: { natural: [0, 20, 20, 40], painted: [0, 20, 50, 70] } };
    expect(rowPaintBounds(row, 500, 20)).toEqual({ y: 500, height: 20 });
    expect(rowPaintBounds(row, 520, 20)).toEqual({ y: 550, height: 20 });
  });
  it('predicts the next single-base wrap before its boundary', () => {
    expect(wrapPrediction(1050, 50, 10)).toEqual({ current: 100, next: 101, progress: 0 });
    const prediction = wrapPrediction(1055, 50, 10);
    expect(prediction.current).toBe(100);
    expect(prediction.next).toBe(101);
    expect(prediction.progress).toBeCloseTo(0.5);
    const live = wrapPrediction(1055, 50, 10, 0.65);
    expect(live.progress).toBeGreaterThan(0.85);
    expect(wrapPrediction(1056.5, 50, 10, 0.65).progress).toBe(1);
    expect(wrapPrediction(1059.9, 50, 10, 0.65).progress).toBe(1);
  });

  it('starts both lane growth and lane shrink before the bases rewrap', () => {
    expect([
      ...morphRowHeights(new Float64Array([100, 200]), new Float64Array([200, 100]), 0.5),
    ]).toEqual([150, 150]);
  });

  it('has the same heights on both sides of a wrap boundary', () => {
    const old = morphRowHeights(new Float64Array([100]), new Float64Array([200]), 1 - 1e-6)[0];
    const next = morphRowHeights(new Float64Array([200]), new Float64Array([300]), 0)[0];
    expect(Math.abs(old - next)).toBeLessThan(0.001);
  });

  it('uses inverse paint geometry for annotation, codon, and cursor hits', () => {
    const row = { y: 500, heightScale: 0.75 };
    expect(rowPaintY(row, 540)).toBe(530);
    expect(rowHitY(row, 530)).toBe(540);
    expect(rowHitY(row, rowPaintY(row, 617.25))).toBeCloseTo(617.25);
  });

  it('predicts actual overlapping feature lanes and exact whole-document offsets', () => {
    const sequence = {
      id: 'predict',
      name: 'predict',
      sequence: 'N'.repeat(300),
      length: 300,
      circular: false,
      annotations: [
        { name: 'a', type: 'gene', start: 1, end: 101, direction: 1 as const },
        { name: 'b', type: 'gene', start: 101, end: 200, direction: 1 as const },
      ],
    };
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 100,
      wrapCapacity: 100,
      showTranslation: false,
    };
    const before = computeSequenceLayoutImpl(sequence, config);
    const morphing = computeSequenceLayoutImpl(sequence, { ...config, wrapCapacity: 100.5 });
    const after = computeSequenceLayoutImpl(sequence, {
      ...config,
      charsPerLine: 101,
      wrapCapacity: 101,
    });
    expect(morphing.summary!.rowHeights[0]).toBeCloseTo(
      before.summary!.rowHeights[0] +
        (after.summary!.rowHeights[0] - before.summary!.rowHeights[0]) *
          wrapPrediction(100.5, 0, 1).progress
    );
    expect(morphing.summary!.rowHeights[1]).toBe(before.summary!.rowHeights[1]);
    expect(morphing.lines[0].heightScale).toBeGreaterThan(1);
    expect(morphing.lines[1].heightScale).toBe(1);
    for (const line of morphing.lines) {
      const tracks = computeLineTrackPositions(line, config);
      expect(
        rowPaintY(line, tracks.sequenceY + config.rowHeight) - rowPaintY(line, tracks.sequenceY)
      ).toBeCloseTo(config.rowHeight);
      expect(rowPaintY(line, tracks.lineEndY) - line.y).toBeCloseTo(
        morphing.summary!.rowHeights[line.lineIndex]
      );
      for (const y of [tracks.sequenceY + 1, tracks.complementY + 1, tracks.rulerY + 1])
        expect(rowHitY(line, rowPaintY(line, y))).toBeCloseTo(y);
    }
    for (const line of morphing.lines)
      expect(line.y).toBe(morphing.summary!.rowYOffsets[line.lineIndex]);
    const scoped = computeSequenceLayoutImpl(
      sequence,
      { ...config, wrapCapacity: 100.5 },
      0,
      0,
      [],
      false,
      [],
      0,
      { firstRowIndex: 1, lastRowIndex: 1, emitOnlyViewportLines: true }
    );
    expect(scoped.lines).toHaveLength(1);
    expect([...scoped.summary!.rowYOffsets]).toEqual([...morphing.summary!.rowYOffsets]);
  });

  it('predicts the future circular offset required to preserve the zoom anchor', () => {
    const sequence = {
      id: 'circular-predict',
      name: 'circular-predict',
      sequence: 'N'.repeat(1000),
      length: 1000,
      circular: true,
      annotations: [
        { name: 'a', type: 'gene', start: 1, end: 110, direction: 1 as const },
        { name: 'b', type: 'gene', start: 110, end: 210, direction: 1 as const },
      ],
    };
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 100,
      wrapCapacity: 100,
      showTranslation: false,
    };
    const before = computeSequenceLayoutImpl(sequence, config);
    const morphing = computeSequenceLayoutImpl(sequence, {
      ...config,
      wrapCapacity: 100.5,
      predictedTopBp: 10,
    });
    const after = computeSequenceLayoutImpl(
      sequence,
      { ...config, charsPerLine: 101, wrapCapacity: 101 },
      10
    );
    const first = before.summary!.topBufferCount;
    expect(morphing.summary!.rowHeights[first]).toBeCloseTo(
      before.summary!.rowHeights[first] +
        (after.summary!.rowHeights[first] - before.summary!.rowHeights[first]) *
          wrapPrediction(100.5, 0, 1).progress
    );
    expect(after.summary!.rowHeights[first]).toBeGreaterThan(before.summary!.rowHeights[first]);
  });
});

it('keeps the visible anchor and neighboring row bands continuous when their absolute row indices change', () => {
  const anchor = 12345;
  const sequence = {
    id: 'screen-anchor',
    name: 'screen-anchor',
    sequence: 'N'.repeat(20000),
    length: 20000,
    circular: true,
    annotations: Array.from({ length: 5 }, (_, index) => ({
      name: `lane-${index}`,
      type: 'gene',
      start: anchor - 40 + index,
      end: anchor + 70 - index,
      direction: 1 as const,
    })),
  };
  function at(capacity: number) {
    const cpr = Math.floor(capacity),
      col = Math.round(0.43 * capacity);
    const offset = (((anchor - col) % cpr) + cpr) % cpr;
    const nextCol = Math.round(0.43 * (cpr + 1));
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: cpr,
      wrapCapacity: capacity,
      predictedTopBp: (((anchor - nextCol) % (cpr + 1)) + cpr + 1) % (cpr + 1),
      wrapAnchorBp: anchor,
      showTranslation: false,
    };
    const layout = computeSequenceLayoutImpl(sequence, config, 0, 5, [], false, [], offset);
    const index = Math.floor((anchor - layout.summary!.topBp) / cpr) + 5;
    const row = layout.lines.find((line) => line.lineIndex === index)!;
    const baseline = rowPaintY(row, computeLineTrackPositions(row, config).sequenceY);
    return [-2, -1, 0, 1, 2].map((delta) => {
      const neighbor = layout.lines.find((line) => line.lineIndex === index + delta)!;
      return {
        top: neighbor.y - baseline,
        dna: rowPaintY(neighbor, computeLineTrackPositions(neighbor, config).sequenceY) - baseline,
        height: layout.summary!.rowHeights[index + delta],
      };
    });
  }
  const before = at(30.999999),
    after = at(31.000001);
  for (let index = 0; index < before.length; index++) {
    expect(Math.abs(before[index].top - after[index].top)).toBeLessThan(0.001);
    expect(Math.abs(before[index].dna - after[index].dna)).toBeLessThan(0.001);
    expect(Math.abs(before[index].height - after[index].height)).toBeLessThan(0.001);
  }
});

it('projects a newly scrolled origin window by its bases when the previous zoom anchor is far away', () => {
  const sequence = {
    id: 'far-anchor',
    name: 'far-anchor',
    sequence: 'N'.repeat(200000),
    length: 200000,
    circular: true,
    annotations: Array.from({ length: 4 }, (_, i) => ({
      name: `origin-${i}`,
      type: 'gene',
      start: 1 + i,
      end: 30 - i,
      direction: 1 as const,
    })),
  };
  const config = {
    ...DEFAULT_EDITOR_CONFIG,
    charsPerLine: 100,
    wrapCapacity: 100,
    wrapAnchorBp: 10000,
    predictedTopBp: 9960,
    showTranslation: false,
  };
  const before = computeSequenceLayoutImpl(sequence, config, 9960, 12);
  const row = before.lines.find(
    (line) => (10 - line.startPos + sequence.length) % sequence.length < 100
  )!;
  const morphing = computeSequenceLayoutImpl(
    sequence,
    { ...config, wrapCapacity: 100.5 },
    9960,
    12
  );
  expect(morphing.summary!.rowHeights[row.lineIndex]).toBe(
    before.summary!.rowHeights[row.lineIndex]
  );
});
