import { expect, it } from 'vitest';
import { captureScreenTracks, morphScreenTracks } from './screen-track-morph';
import { computeSequenceLayoutImpl } from './useSequenceLayout';
import { computeLineTrackPositions, lineTrackBoundaries } from './line-track-layout';
import { rowHitY, rowPaintY, rowPaintBounds } from './predictive-wrap-layout';
import { DEFAULT_EDITOR_CONFIG } from './types';

for (const hz of [60, 120]) {
  for (const detail of [false, true]) {
    for (const grow of [false, true]) {
      it(`vertical track accommodation settles within 56 ms at ${hz} Hz, ${detail ? 'detail' : 'feature'}, ${grow ? 'gaining' : 'losing'} tracks`, () => {
        const sequence = {
          id: 'width-changes-track-count',
          name: 'width-changes-track-count',
          sequence: 'N'.repeat(3000),
          length: 3000,
          circular: false,
          annotations: Array.from({ length: 4 }, (_, lane) => ({
            name: `coding-${lane}`,
            type: 'CDS',
            start: lane === 0 ? 90 : 100 + lane,
            end: 180 - lane,
            direction: 1 as const,
          })),
        };
        const base = {
          ...DEFAULT_EDITOR_CONFIG,
          rowHeight: detail ? 20 : 4,
          lodLevel: detail ? ('detail' as const) : ('feature' as const),
          showTranslation: detail,
          showReverseComplement: detail,
        };
        const beforeConfig = { ...base, charsPerLine: grow ? 100 : 120 };
        const config = { ...base, charsPerLine: grow ? 120 : 100 };
        const before = computeSequenceLayoutImpl(sequence, beforeConfig);
        const target = computeSequenceLayoutImpl(sequence, config);
        expect(
          Math.abs(
            detail
              ? target.lines[0].translationLaneCount! - before.lines[0].translationLaneCount!
              : target.lines[0].annotationLaneCount - before.lines[0].annotationLaneCount
          )
        ).toBe(3);
        let result = morphScreenTracks(
          target,
          config,
          captureScreenTracks(before, beforeConfig, 43, 0),
          43,
          0,
          { min: 0, max: 5 },
          { fastZoomInternal: true }
        );
        let frame = result.frame;
        let firstSettledFrameAt: number | undefined;
        for (let time = 1000 / hz; time < 56; time += 1000 / hz) {
          result = morphScreenTracks(
            target,
            config,
            frame,
            43,
            time,
            { min: 0, max: 5 },
            { fastZoomInternal: true }
          );
          frame = result.frame;
          if (!result.pending && firstSettledFrameAt === undefined) firstSettledFrameAt = time;
          for (const row of result.layout.lines) {
            const natural = lineTrackBoundaries(row, config);
            const painted = row.trackMorph?.painted ?? natural;
            for (const band of [0, 1, 2, 3, 4, 8])
              expect(painted[band + 1] - painted[band]).toBeGreaterThanOrEqual(
                natural[band + 1] - natural[band] - 0.00001
              );
            const tracks = computeLineTrackPositions(row, config);
            expect(rowPaintBounds(row, tracks.sequenceY, config.rowHeight).height).toBeCloseTo(
              config.rowHeight
            );
          }
        }
        result = morphScreenTracks(
          target,
          config,
          frame,
          43,
          56,
          { min: 0, max: 5 },
          { fastZoomInternal: true }
        );
        expect(result.pending, 'all row height, spacing and stripe debt must finish').toBe(false);
        expect(Array.from(result.layout.summary!.rowHeights)).toEqual(
          Array.from(target.summary!.rowHeights)
        );
        expect(result.frame.stripeTopOffsets.size).toBe(0);
        expect(result.layout.lines.every((row) => !row.stripeInsetPx)).toBe(true);

        for (
          let time = Math.ceil(56 / (1000 / hz)) * (1000 / hz);
          firstSettledFrameAt === undefined && time <= 100;
          time += 1000 / hz
        ) {
          const presented = morphScreenTracks(
            target,
            config,
            frame,
            43,
            time,
            { min: 0, max: 5 },
            { fastZoomInternal: true }
          );
          frame = presented.frame;
          if (!presented.pending) firstSettledFrameAt = time;
        }
        expect(firstSettledFrameAt, 'a scheduled frame must finish the motion').toBeDefined();
        expect(
          firstSettledFrameAt,
          'visible track settling retains its deadline'
        ).toBeLessThanOrEqual(65);
      });
    }
  }
}

it('retargets vertical accommodation from the presented bands without restarting its deadline', () => {
  const sequence = {
    id: 'retarget',
    name: 'retarget',
    sequence: 'N'.repeat(3000),
    length: 3000,
    circular: false,
    annotations: Array.from({ length: 4 }, (_, lane) => ({
      name: `gene-${lane}`,
      type: 'gene',
      start: lane === 0 ? 90 : 100 + lane,
      end: 180 - lane,
      direction: 1 as const,
    })),
  };
  const wideConfig = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 120 };
  const narrowConfig = { ...wideConfig, charsPerLine: 100 };
  const wide = computeSequenceLayoutImpl(sequence, wideConfig);
  const narrow = computeSequenceLayoutImpl(sequence, narrowConfig);
  const start = morphScreenTracks(
    narrow,
    narrowConfig,
    captureScreenTracks(wide, wideConfig, 43, 0),
    43,
    0
  );
  const painted = morphScreenTracks(narrow, narrowConfig, start.frame, 43, 16);
  const reversed = morphScreenTracks(wide, wideConfig, painted.frame, 43, 16, undefined, {
    fastZoomInternal: true,
  });

  expect(reversed.frame.stripes.get(0)).toBeCloseTo(painted.frame.stripes.get(0)!);
  expect(reversed.frame.settleBy).toBe(start.frame.settleBy);
  const finished = morphScreenTracks(wide, wideConfig, reversed.frame, 43, 56, undefined, {
    fastZoomInternal: true,
  });
  expect(finished.pending).toBe(false);
  expect(finished.layout.summary!.rowHeights[0]).toBe(wide.summary!.rowHeights[0]);
  expect(finished.frame.stripeTopOffsets.size).toBe(0);
});

it('starts after idle and catches up a delayed vertical frame without extending the deadline', () => {
  const sequence = {
    id: 'idle',
    name: 'idle',
    sequence: 'N'.repeat(300),
    length: 300,
    circular: false,
    annotations: [{ name: 'gene', type: 'gene', start: 90, end: 180, direction: 1 as const }],
  };
  const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 };
  const before = computeSequenceLayoutImpl(sequence, config);
  const target = computeSequenceLayoutImpl({ ...sequence, annotations: [] }, config);
  const started = morphScreenTracks(
    target,
    config,
    captureScreenTracks(before, config, 43, 0),
    43,
    10_000
  );
  expect(started.pending).toBe(true);
  expect(started.layout.summary!.rowHeights[0]).toBe(before.summary!.rowHeights[0]);
  const late = morphScreenTracks(target, config, started.frame, 43, 10_100);
  expect(late.pending).toBe(false);
  expect(late.layout.summary!.rowHeights[0]).toBe(target.summary!.rowHeights[0]);
});

it('releases idle vertical track reservation without changing horizontal wrap positions', () => {
  const sequence = {
    id: 'idle-forecast',
    name: 'idle-forecast',
    sequence: 'N'.repeat(300),
    length: 300,
    circular: false,
    annotations: Array.from({ length: 4 }, (_, lane) => ({
      name: `lane-${lane}`,
      type: 'gene',
      start: lane === 0 ? 95 : 100 + lane,
      end: 150 - lane,
      direction: 1 as const,
    })),
  };
  const config = {
    ...DEFAULT_EDITOR_CONFIG,
    charsPerLine: 100,
    wrapCapacity: 100,
    wrapPreviewTargetCpr: 120,
    wrapAnchorBp: 43,
    wrapAnchorViewportX: DEFAULT_EDITOR_CONFIG.marginLeft + 43 * DEFAULT_EDITOR_CONFIG.charWidth,
  };
  const reserved = computeSequenceLayoutImpl(sequence, config);
  const idle = computeSequenceLayoutImpl(sequence, { ...config, wrapTrackForecast: false });
  expect(reserved.lines[0].trackMorph!.painted[1]).toBeGreaterThan(
    reserved.lines[0].trackMorph!.natural[1]
  );
  for (const row of idle.lines) {
    expect(row.trackMorph?.painted ?? lineTrackBoundaries(row, config)).toEqual(
      lineTrackBoundaries(row, config)
    );
    expect(row.xOffset).toBe(
      reserved.lines.find((prior) => prior.lineIndex === row.lineIndex)!.xOffset
    );
    expect(row.startPos).toBe(
      reserved.lines.find((prior) => prior.lineIndex === row.lineIndex)!.startPos
    );
  }
});

it('prepares detail-only translation and complement space before the LOD boundary', () => {
  const sequence = {
    id: 'detail-boundary',
    name: 'detail-boundary',
    sequence: 'N'.repeat(3000),
    length: 3000,
    circular: true,
    annotations: [{ name: 'coding', type: 'CDS', start: 990, end: 1110, direction: 1 as const }],
  };
  const featureConfig = {
    ...DEFAULT_EDITOR_CONFIG,
    charsPerLine: 100,
    lodLevel: 'feature' as const,
    showTranslation: false,
    showReverseComplement: false,
    previewDetailTracks: {
      progress: 1,
      showTranslation: true,
      showReverseComplement: true,
      showResidueNumbers: false,
    },
  };
  const detailConfig = {
    ...featureConfig,
    lodLevel: 'detail' as const,
    showTranslation: true,
    showReverseComplement: true,
    previewDetailTracks: undefined,
  };
  const prepared = computeSequenceLayoutImpl(sequence, featureConfig, 0, 12);
  const detail = computeSequenceLayoutImpl(sequence, detailConfig, 0, 12);
  const row = prepared.lines.find((line) => line.lineIndex === 22)!;
  const detailRow = detail.lines.find((line) => line.lineIndex === 22)!;
  const featureBands = row.trackMorph!;
  const detailBands = lineTrackBoundaries(detailRow, detailConfig);
  expect(featureBands).toBeDefined();
  expect(featureBands.natural[2] - featureBands.natural[1]).toBe(0);
  expect(featureBands.painted[2] - featureBands.painted[1]).toBeGreaterThanOrEqual(
    detailBands[2] - detailBands[1]
  );
  expect(featureBands.painted[7] - featureBands.painted[6]).toBeGreaterThanOrEqual(
    detailBands[7] - detailBands[6]
  );
  const morphed = morphScreenTracks(
    detail,
    detailConfig,
    captureScreenTracks(prepared, featureConfig, 1043, 0),
    1043,
    1000 / 60
  );
  expect(
    Math.abs(morphed.layout.summary!.rowHeights[22] - prepared.summary!.rowHeights[22])
  ).toBeLessThanOrEqual(8.01);
});

it('finishes a normal annotation-lane change within 100 ms at 60 Hz', () => {
  const sequence = {
    id: 'fast-lanes',
    name: 'fast-lanes',
    sequence: 'N'.repeat(3000),
    length: 3000,
    circular: true,
    annotations: [{ name: 'one', type: 'gene', start: 990, end: 1110, direction: 1 as const }],
  };
  const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 };
  const before = computeSequenceLayoutImpl(sequence, config, 0, 12);
  const target = computeSequenceLayoutImpl(
    {
      ...sequence,
      annotations: [
        ...sequence.annotations,
        { ...sequence.annotations[0], name: 'two', start: 991, end: 1109 },
      ],
    },
    config,
    0,
    12
  );
  expect(target.summary!.rowHeights[22]).toBeGreaterThan(before.summary!.rowHeights[22]);
  let frame = captureScreenTracks(before, config, 1043, 0);
  let result;
  for (let i = 1; i <= 6; i++) {
    result = morphScreenTracks(target, config, frame, 1043, i * (1000 / 60));
    frame = result.frame;
  }
  expect(result!.pending).toBe(false);
  expect(result!.layout.summary!.rowHeights[22]).toBeCloseTo(target.summary!.rowHeights[22]);
});

it('finishes zoom-out ruler and row shrink together within five frames', () => {
  const annotations = Array.from({ length: 3 }, (_, lane) => ({
    name: `overlap-${lane}`,
    type: 'gene',
    start: 990 + lane,
    end: 1110 - lane,
    direction: 1 as const,
  }));
  const sequence = {
    id: 'fast-zoom-out-lanes',
    name: 'fast-zoom-out-lanes',
    sequence: 'N'.repeat(3000),
    length: 3000,
    circular: true,
    annotations,
  };
  const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 };
  const before = computeSequenceLayoutImpl(sequence, config, 0, 12);
  const target = computeSequenceLayoutImpl(
    { ...sequence, annotations: annotations.slice(0, 1) },
    config,
    0,
    12
  );
  const rowIndex = 22;
  expect(
    before.summary!.rowHeights[rowIndex] - target.summary!.rowHeights[rowIndex]
  ).toBeGreaterThan(30);
  let frame = captureScreenTracks(before, config, 1043, 0);
  let result;
  for (let i = 1; i <= 5; i++) {
    result = morphScreenTracks(
      target,
      config,
      frame,
      1043,
      i * (1000 / 60),
      { min: -5, max: 5 },
      { fastZoomInternal: true }
    );
    const height = result.layout.summary!.rowHeights[rowIndex];
    const progress = Math.min(1, ((i - 1) * (1000 / 60)) / 48);
    expect(height, `frame ${i} follows the short duration`).toBeCloseTo(
      before.summary!.rowHeights[rowIndex] +
        (target.summary!.rowHeights[rowIndex] - before.summary!.rowHeights[rowIndex]) * progress
    );
    frame = result.frame;
  }
  expect(result!.layout.summary!.rowHeights[rowIndex]).toBeCloseTo(
    target.summary!.rowHeights[rowIndex]
  );
  const painted = result!.layout.lines.find((row) => row.lineIndex === rowIndex)!.trackMorph
    ?.painted;
  const goal = lineTrackBoundaries(target.lines.find((row) => row.lineIndex === rowIndex)!, config);
  expect(painted?.[9] ?? goal[9]).toBeCloseTo(goal[9]);
});

it('finishes the whole visible row stack on one deadline around the zoom anchor', () => {
  const sequence = {
    id: 'stacked-visible-lanes',
    name: 'stacked-visible-lanes',
    sequence: 'N'.repeat(1200),
    length: 1200,
    circular: false,
    annotations: Array.from({ length: 12 }, (_, row) => [
      {
        name: `one-${row}`,
        type: 'gene',
        start: row * 100 + 2,
        end: row * 100 + 90,
        direction: 1 as const,
      },
      {
        name: `two-${row}`,
        type: 'gene',
        start: row * 100 + 3,
        end: row * 100 + 89,
        direction: 1 as const,
      },
    ]).flat(),
  };
  const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 };
  const before = computeSequenceLayoutImpl(sequence, config);
  const target = computeSequenceLayoutImpl(
    { ...sequence, annotations: sequence.annotations.filter((_, index) => index % 2 === 0) },
    config
  );
  const focal = 5;
  const anchorBp = 550;
  let frame = captureScreenTracks(before, config, anchorBp, 0);
  const oldOffsets = before.summary!.rowYOffsets;
  expect(before.summary!.rowHeights[0] - target.summary!.rowHeights[0]).toBeGreaterThan(15);
  for (const time of [0, 16, 32, 56]) {
    const result = morphScreenTracks(target, config, frame, anchorBp, time, { min: -5, max: 5 });
    const newOffsets = result.layout.summary!.rowYOffsets;
    for (let row = 0; row <= 10; row++) {
      const beforeY = oldOffsets[row] - oldOffsets[focal];
      const goalY = target.summary!.rowYOffsets[row] - target.summary!.rowYOffsets[focal];
      expect(newOffsets[row] - newOffsets[focal], `row ${row} at ${time} ms`).toBeCloseTo(
        beforeY + (goalY - beforeY) * Math.min(1, time / 48)
      );
    }
    expect(result.pending).toBe(time < 56);
    frame = result.frame;
  }
});

it('borrows blank row space when a newly wrapped annotation needs full height immediately', () => {
  const sequence = {
    id: 'borrow-inward-gap',
    name: 'borrow-inward-gap',
    sequence: 'N'.repeat(2686),
    length: 2686,
    circular: true,
    annotations: [{ name: 'new row', type: 'gene', start: 915, end: 916, direction: 1 as const }],
  };
  const beforeConfig = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 61 };
  const nextConfig = { ...beforeConfig, charsPerLine: 60 };
  const before = computeSequenceLayoutImpl(sequence, beforeConfig, 1096, 10);
  const target = computeSequenceLayoutImpl(sequence, nextConfig, 1096, 10);
  const anchorBp = 1122;
  const row = 6;
  expect(target.summary!.rowHeights[row] - before.summary!.rowHeights[row]).toBeGreaterThan(15);
  let frame = captureScreenTracks(before, beforeConfig, anchorBp, 0);
  let previous = before;
  let previousStripeHeight = before.summary!.rowHeights[row];
  for (let step = 1; step <= 12; step++) {
    const result = morphScreenTracks(target, nextConfig, frame, anchorBp, (step * 1000) / 60, {
      min: -5,
      max: 5,
    });
    const summary = result.layout.summary!;
    const rowGap =
      summary.rowYOffsets[row + 1] - summary.rowYOffsets[row] - summary.rowHeights[row];
    const paintedRow = result.layout.lines.find((line) => line.lineIndex === row)!;
    const stripeHeight = summary.rowHeights[row] - (paintedRow.stripeInsetPx ?? 0);
    expect(summary.rowHeights[row]).toBeGreaterThanOrEqual(target.summary!.rowHeights[row]);
    if (step === 1) {
      expect(rowGap).toBeLessThan(summary.rowGapPx - 8);
      expect(paintedRow.stripeInsetPx).toBeGreaterThan(8);
    }
    const progress = Math.min(1, ((step - 1) * (1000 / 60)) / 48);
    expect(stripeHeight).toBeCloseTo(
      before.summary!.rowHeights[row] +
        (target.summary!.rowHeights[row] - before.summary!.rowHeights[row]) * progress
    );
    expect(stripeHeight).toBeGreaterThanOrEqual(previousStripeHeight - 0.00001);
    expect(rowGap).toBeGreaterThanOrEqual(0);
    if (step >= 5) expect(result.pending).toBe(false);
    frame = result.frame;
    previous = result.layout;
    previousStripeHeight = stripeHeight;
  }
  const summary = previous.summary!;
  expect(
    summary.rowYOffsets[row + 1] - summary.rowYOffsets[row] - summary.rowHeights[row]
  ).toBeCloseTo(summary.rowGapPx);
  expect(previous.lines.find((line) => line.lineIndex === row)?.stripeInsetPx).toBeUndefined();
});

it('preallocates future lanes from the last painted height while keeping nucleotide geometry exact', () => {
  const sequence = {
    id: 'lanes',
    name: 'lanes',
    sequence: 'N'.repeat(300),
    length: 300,
    circular: false,
    annotations: Array.from({ length: 4 }, (_, i) => ({
      name: `lane-${i}`,
      type: 'gene',
      start: i === 0 ? 95 : 100 + i,
      end: 150 - i,
      direction: 1 as const,
    })),
  };
  const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 };
  const before = computeSequenceLayoutImpl(sequence, config);
  const previewConfig = { ...config, wrapCapacity: 100, wrapPreviewTargetCpr: 120 };
  const target = computeSequenceLayoutImpl(sequence, previewConfig);
  const focal = 0,
    anchor = 43;
  expect(before.lines[0].annotationLaneCount).toBe(1);
  expect(target.lines[0].annotationLaneCount).toBe(1);
  expect(target.lines[0].trackMorph?.painted[1]).toBeGreaterThan(
    target.lines[0].trackMorph!.natural[1]
  );
  let frame = captureScreenTracks(before, config, anchor, 0);
  const initial = morphScreenTracks(target, previewConfig, frame, anchor, 0);
  const oldRow = before.lines.find((r) => r.lineIndex === focal)!;
  const firstRow = initial.layout.lines.find((r) => r.lineIndex === focal)!;
  const oldTracks = computeLineTrackPositions(oldRow, config),
    firstTracks = computeLineTrackPositions(firstRow, previewConfig);
  expect(rowPaintY(firstRow, firstTracks.sequenceY) - firstRow.y).toBeCloseTo(
    oldTracks.sequenceY - oldRow.y
  );
  expect(initial.pending).toBe(true);
  frame = initial.frame;
  let previousHeight = initial.layout.summary!.rowHeights[focal];
  let result = initial;
  for (let i = 1; i <= 8; i++) {
    result = morphScreenTracks(target, previewConfig, frame, anchor, (i * 1000) / 60);
    frame = result.frame;
    const row = result.layout.lines.find((r) => r.lineIndex === focal)!,
      tracks = computeLineTrackPositions(row, previewConfig);
    const height = result.layout.summary!.rowHeights[focal];
    expect(height).toBeGreaterThanOrEqual(previousHeight - 0.0001);
    expect(height).toBeCloseTo(
      before.summary!.rowHeights[focal] +
        (target.summary!.rowHeights[focal] - before.summary!.rowHeights[focal]) *
          Math.min(1, (i * (1000 / 60)) / 48)
    );
    const painted = rowPaintY(row, tracks.sequenceY + config.rowHeight / 2);
    expect(rowHitY(row, painted)).toBeCloseTo(tracks.sequenceY + config.rowHeight / 2);
    expect(
      rowPaintY(row, tracks.sequenceY + config.rowHeight) - rowPaintY(row, tracks.sequenceY)
    ).toBeCloseTo(config.rowHeight);
    const s = result.layout.summary!;
    expect(s.rowYOffsets[focal + 1] - s.rowYOffsets[focal]).toBeCloseTo(height + s.rowGapPx);
    expect(result.layout.totalHeight).toBe(s.rowYOffsets[s.totalRows]);
    previousHeight = height;
  }
  expect(result.pending).toBe(false);
  expect(result.layout.summary!.rowHeights[focal]).toBeCloseTo(target.summary!.rowHeights[focal]);
});

it('never clips a newly visible annotation lane when wrapping outruns its forecast', () => {
  const sequence = {
    id: 'lane-floor',
    name: 'lane-floor',
    sequence: 'N'.repeat(3000),
    length: 3000,
    circular: true,
    annotations: [{ name: 'one', type: 'gene', start: 990, end: 1110, direction: 1 as const }],
  };
  const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 };
  const before = computeSequenceLayoutImpl(sequence, config, 0, 12);
  const after = computeSequenceLayoutImpl(
    {
      ...sequence,
      annotations: Array.from({ length: 4 }, (_, i) => ({
        ...sequence.annotations[0],
        name: `lane-${i}`,
        start: 990 + i,
        end: 1110 - i,
      })),
    },
    config,
    0,
    12
  );
  const result = morphScreenTracks(
    after,
    config,
    captureScreenTracks(before, config, 1043, 0),
    1043,
    1000 / 60
  );
  const row = result.layout.lines.find((line) => line.lineIndex === 22)!;
  const paintedAnnotationEnd = row.trackMorph?.painted[1] ?? lineTrackBoundaries(row, config)[1];
  expect(paintedAnnotationEnd).toBeGreaterThanOrEqual(lineTrackBoundaries(row, config)[1]);
  expect(rowPaintBounds(row, row.y + 1, 18).height).toBe(18);
});

it('moves gray and white stripe tops across frames when a new lane appears under the zoom anchor', () => {
  const sequence = {
    id: 'lane-stripe-reversal',
    name: 'lane-stripe-reversal',
    sequence: 'N'.repeat(3000),
    length: 3000,
    circular: true,
    annotations: [] as Array<{
      name: string;
      type: string;
      start: number;
      end: number;
      direction: 1;
    }>,
  };
  const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 };
  const before = computeSequenceLayoutImpl(sequence, config, 0, 12);
  const target = computeSequenceLayoutImpl(
    {
      ...sequence,
      annotations: [
        { name: 'new lane', type: 'gene', start: 1001, end: 1100, direction: 1 as const },
      ],
    },
    config,
    0,
    12
  );
  const anchorBp = 1043;
  const focal = 22;
  let frame = captureScreenTracks(before, config, anchorBp, 0);
  let sawDebt = false;
  for (let step = 1; step <= 12; step++) {
    const result = morphScreenTracks(
      target,
      config,
      frame,
      anchorBp,
      (step * 1000) / 60,
      { min: -4, max: 4 },
      { fastZoomInternal: true }
    );
    const row = result.layout.lines.find((line) => line.lineIndex === focal)!;
    const currentStripe =
      -(row.trackMorph?.painted[5] ?? lineTrackBoundaries(row, config)[5]) +
      (row.stripeTopOffsetPx ?? 0);
    const naturalStripe = -lineTrackBoundaries(
      target.lines.find((row) => row.lineIndex === focal)!,
      config
    )[5];
    const initialStripe = -lineTrackBoundaries(
      before.lines.find((row) => row.lineIndex === focal)!,
      config
    )[5];
    expect(currentStripe, `stripe top on frame ${step}`).toBeCloseTo(
      initialStripe + (naturalStripe - initialStripe) * Math.min(1, ((step - 1) * (1000 / 60)) / 48)
    );
    if (row.stripeTopOffsetPx) sawDebt = true;
    frame = result.frame;
  }
  expect(sawDebt).toBe(true);
  expect(frame.stripeTopOffsets.size).toBe(0);
});

it('preserves the bounded row window and interpolates the same screen rows across circular rebases', () => {
  const sequence = {
    id: 'origin',
    name: 'origin',
    sequence: 'N'.repeat(20000),
    length: 20000,
    circular: true,
    annotations: [{ name: 'one', type: 'gene', start: 19800, end: 20000, direction: 1 as const }],
  };
  const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 };
  const before = computeSequenceLayoutImpl(sequence, config, 0, 12, [], false, [], 0, {
    firstRowIndex: 207,
    lastRowIndex: 217,
    emitOnlyViewportLines: true,
  });
  const frame = captureScreenTracks(before, config, 19990, 0);
  const target = computeSequenceLayoutImpl(
    {
      ...sequence,
      annotations: Array.from({ length: 3 }, (_, i) => ({
        ...sequence.annotations[0],
        name: `lane-${i}`,
        start: 19800 + i,
        end: 20000 - i,
      })),
    },
    config,
    19947,
    12,
    [],
    false,
    [],
    0,
    { firstRowIndex: 7, lastRowIndex: 17, emitOnlyViewportLines: true }
  );
  const result = morphScreenTracks(target, config, frame, 19990, 0);
  expect(result.layout.lines.length).toBe(11);
  expect(result.layout.summary?.topBufferCount).toBe(12);
  expect(result.layout.summary?.bottomBufferCount).toBe(12);
  expect(result.pending).toBe(true);
  expect(result.layout.summary?.rowHeights[12]).toBeGreaterThanOrEqual(
    target.summary!.rowHeights[12]
  );
  expect(result.layout.summary?.rowYOffsets[0]).toBe(target.summary!.rowYOffsets[0]);
});

it('keeps every circular row offset exact when two distant visible lanes morph', () => {
  const sequence = {
    id: 'sparse-circular-morph',
    name: 'sparse-circular-morph',
    sequence: 'N'.repeat(5000),
    length: 5000,
    circular: true,
    annotations: [
      { name: 'a', type: 'gene', start: 1, end: 90, direction: 1 as const },
      { name: 'b', type: 'gene', start: 601, end: 690, direction: 1 as const },
    ],
  };
  const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 };
  const range = { firstRowIndex: 5, lastRowIndex: 16, emitOnlyViewportLines: true };
  const before = computeSequenceLayoutImpl(
    {
      ...sequence,
      annotations: [
        ...sequence.annotations,
        { name: 'a2', type: 'gene', start: 2, end: 89, direction: 1 as const },
        { name: 'b2', type: 'gene', start: 602, end: 689, direction: 1 as const },
      ],
    },
    config,
    0,
    5,
    [],
    false,
    [],
    0,
    range
  );
  const target = computeSequenceLayoutImpl(sequence, config, 0, 5, [], false, [], 0, range);
  const targetOffsets = Float64Array.from(target.summary!.rowYOffsets);
  const result = morphScreenTracks(
    target,
    config,
    captureScreenTracks(before, config, 650, 0),
    650,
    1000 / 60
  );
  const summary = result.layout.summary!;
  expect(summary.rowHeights[5]).toBeGreaterThan(target.summary!.rowHeights[5]);
  expect(summary.rowHeights[11]).toBeGreaterThan(target.summary!.rowHeights[11]);
  for (let i = 0; i < summary.totalRows; i++) {
    const spacing = i === summary.totalRows - 1 ? 32 : summary.rowGapPx;
    expect(summary.rowYOffsets[i + 1] - summary.rowYOffsets[i]).toBeCloseTo(
      summary.rowHeights[i] + spacing
    );
  }
  expect(summary.rowYOffsets[5]).toBe(targetOffsets[5]);
  expect(summary.rowYOffsets[11]).toBeGreaterThan(targetOffsets[11]);
  expect(summary.rowYOffsets[summary.totalRows]).toBe(result.layout.totalHeight);
  expect(target.summary!.rowYOffsets).toEqual(targetOffsets);
  expect(result.layout.lines).toHaveLength(12);
});

it('preserves fractional offsets and the exact tail when separated gap changes cancel', () => {
  const sequence = {
    id: 'cancelled-gap-shifts',
    name: 'cancelled-gap-shifts',
    sequence: 'N'.repeat(5000),
    length: 5000,
    circular: true,
    annotations: [],
  };
  const config = { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100, rowHeight: 17.25 };
  const target = computeSequenceLayoutImpl(sequence, config, 0, 5, [], false, [], 0, {
    firstRowIndex: 5,
    lastRowIndex: 16,
    emitOnlyViewportLines: true,
  });
  const anchorBp = 650;
  const frame = captureScreenTracks(target, config, anchorBp, 0);
  const first = 5;
  const second = 11;
  const shift = 0.125;

  frame.gaps.set(-6, frame.rowGapPx + shift);
  frame.gaps.set(0, frame.rowGapPx - shift);
  const targetOffsets = Float64Array.from(target.summary!.rowYOffsets);
  const expected = targetOffsets.map((offset, row) =>
    row > first && row <= second ? offset + shift : offset
  );

  const result = morphScreenTracks(target, config, frame, anchorBp, 1000 / 60);
  const summary = result.layout.summary!;
  expect(result.pending).toBe(true);
  expect(result.frame.gaps.get(-6)).toBe(frame.rowGapPx + shift);
  expect(result.frame.gaps.get(0)).toBe(frame.rowGapPx - shift);
  expect(summary.rowYOffsets[first + 1] % 1).not.toBe(0);
  expect(summary.rowYOffsets).toEqual(expected);
  expect(summary.rowYOffsets.subarray(second + 1)).toEqual(targetOffsets.subarray(second + 1));
  expect(summary.rowHeights).toBe(target.summary!.rowHeights);
  expect(result.layout.totalHeight).toBe(target.totalHeight);
  expect(target.summary!.rowYOffsets).toEqual(targetOffsets);
  for (const row of result.layout.lines) expect(row.y).toBe(expected[row.lineIndex]);
});

it.each([false, true])(
  'bounds row pitch when complementary strand visibility changes to %s',
  (visible) => {
    const sequence = {
      id: 'visibility',
      name: 'visibility',
      sequence: 'N'.repeat(3000),
      length: 3000,
      circular: true,
      annotations: [],
    };
    const beforeConfig = {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 100,
      rowHeight: 9.72,
      showReverseComplement: !visible,
    };
    const nextConfig = { ...beforeConfig, rowHeight: 8.72, showReverseComplement: visible };
    const before = computeSequenceLayoutImpl(sequence, beforeConfig, 0, 12);
    const target = computeSequenceLayoutImpl(sequence, nextConfig, 0, 12);
    let frame = captureScreenTracks(before, beforeConfig, 1043, 0);
    let previousPitch = before.summary!.rowHeights[22] + before.summary!.rowGapPx;
    const maxFrameChange = 8.01;
    let result;
    for (let i = 1; i <= 8; i++) {
      result = morphScreenTracks(target, nextConfig, frame, 1043, (i * 1000) / 60);
      const pitch = result.layout.summary!.rowHeights[22] + result.layout.summary!.rowGapPx;
      expect(Math.abs(pitch - previousPitch)).toBeLessThanOrEqual(maxFrameChange);
      const row = result.layout.lines.find((r) => r.lineIndex === 22)!;
      const tracks = computeLineTrackPositions(row, nextConfig);
      expect(rowPaintBounds(row, tracks.sequenceY, nextConfig.rowHeight).height).toBeCloseTo(
        nextConfig.rowHeight
      );
      frame = result.frame;
      previousPitch = pitch;
    }
    expect(result!.pending).toBe(false);
    expect(previousPitch).toBeCloseTo(target.summary!.rowHeights[22] + target.summary!.rowGapPx);
  }
);

it.each([false, true])(
  'smoothly changes row gaps and hidden ruler space when density becomes %s',
  (density) => {
    const sequence = {
      id: 'density',
      name: 'density',
      sequence: 'N'.repeat(3000),
      length: 3000,
      circular: true,
      annotations: [],
    };
    const beforeConfig = {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 100,
      rowHeight: 1,
      showReverseComplement: false,
      lodLevel: (density ? 'feature' : 'density') as 'feature' | 'density',
    };
    const nextConfig = {
      ...beforeConfig,
      lodLevel: (density ? 'density' : 'feature') as 'feature' | 'density',
    };
    const before = computeSequenceLayoutImpl(sequence, beforeConfig, 0, 12);
    const target = computeSequenceLayoutImpl(sequence, nextConfig, 0, 12);
    let frame = captureScreenTracks(before, beforeConfig, 1043, 0);
    let previousPitch = before.summary!.rowHeights[22] + before.summary!.rowGapPx;
    let result;
    for (let i = 1; i <= 10; i++) {
      result = morphScreenTracks(target, nextConfig, frame, 1043, (i * 1000) / 60);
      const summary = result.layout.summary!;
      const pitch = summary.rowHeights[22] + summary.rowGapPx;
      const beforePitch = before.summary!.rowHeights[22] + before.summary!.rowGapPx;
      const goalPitch = target.summary!.rowHeights[22] + target.summary!.rowGapPx;
      expect(pitch).toBeCloseTo(
        beforePitch + (goalPitch - beforePitch) * Math.min(1, ((i - 1) * (1000 / 60)) / 48)
      );
      expect(summary.rowYOffsets[23] - summary.rowYOffsets[22]).toBeCloseTo(pitch);
      expect(summary.rowYOffsets[0]).toBeCloseTo(summary.topPaddingPx);
      expect(summary.rowYOffsets[summary.totalRows]).toBe(result.layout.totalHeight);
      frame = result.frame;
      previousPitch = pitch;
    }
    expect(result!.pending).toBe(false);
    expect(previousPitch).toBeCloseTo(target.summary!.rowHeights[22] + target.summary!.rowGapPx);
  }
);
