import { describe, expect, it } from 'vitest';
import {
  buildPaintInfo,
  createProbeContext,
  runExtraLaneContractTests,
} from '@waypoint/workspace-editor';
import type { TraceData } from '../../../trace';
import { chromatogramLane } from '../chromatogram-lane';

function syntheticTrace(numPeaks: number, samplesPerPeak = 12): TraceData {
  const totalSamples = numPeaks * samplesPerPeak;
  const A = new Array(totalSamples).fill(0);
  const C = new Array(totalSamples).fill(0);
  const G = new Array(totalSamples).fill(0);
  const T = new Array(totalSamples).fill(0);
  const peakPositions: number[] = [];
  const channels = [A, C, G, T];

  for (let i = 0; i < numPeaks; i++) {
    const center = i * samplesPerPeak + Math.floor(samplesPerPeak / 2);
    peakPositions.push(center);
    const channel = channels[i % 4];
    for (let dx = -3; dx <= 3; dx++) {
      const pos = center + dx;
      if (pos < 0 || pos >= totalSamples) continue;
      channel[pos] = Math.round(1000 * (1 - Math.abs(dx) / 4));
    }
  }

  return {
    channels: { A, C, G, T },
    peakPositions,
    baseOrder: 'GATC',
    maxValue: 1000,
  };
}

function asymmetricTrace(numPeaks: number, samplesPerPeak = 12): TraceData {
  const totalSamples = numPeaks * samplesPerPeak;
  const A = new Array(totalSamples).fill(0);
  const C = new Array(totalSamples).fill(0);
  const G = new Array(totalSamples).fill(0);
  const T = new Array(totalSamples).fill(0);
  const peakPositions: number[] = [];
  for (let i = 0; i < numPeaks; i++) {
    const center = i * samplesPerPeak + Math.floor(samplesPerPeak / 2);
    peakPositions.push(center);
    for (let dx = -3; dx <= 3; dx++) {
      const pos = center + dx;
      if (pos < 0 || pos >= totalSamples) continue;
      A[pos] = Math.round(1000 * (1 - Math.abs(dx) / 4));
    }
  }
  return {
    channels: { A, C, G, T },
    peakPositions,
    baseOrder: 'GATC',
    maxValue: 1000,
  };
}

function mixedTrace(): TraceData {
  const totalSamples = 12;
  const A = new Array(totalSamples).fill(0);
  const C = new Array(totalSamples).fill(0);
  const G = new Array(totalSamples).fill(0);
  const T = new Array(totalSamples).fill(0);
  for (let dx = -3; dx <= 3; dx++) {
    const pos = 6 + dx;
    if (pos < 0 || pos >= totalSamples) continue;
    const v = Math.round(800 * (1 - Math.abs(dx) / 4));
    C[pos] = v;
    T[pos] = v;
  }
  return {
    channels: { A, C, G, T },
    peakPositions: [6],
    baseOrder: 'GATC',
    maxValue: 800,
  };
}

runExtraLaneContractTests('chromatogramLane', (columnCount) =>
  chromatogramLane({ trace: syntheticTrace(Math.max(2, columnCount)) })
);

describe('chromatogramLane — visualization encoding', () => {
  it('strokes 4 separate channel paths (one per A/C/G/T)', () => {
    const trace = syntheticTrace(20);
    const lane = chromatogramLane({ trace });
    const probe = createProbeContext(800);
    const info = buildPaintInfo({ columnCount: 20, pxPerBase: 20, viewportWidth: 800 });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const strokeCount = probe.log.filter((op) => op.op === 'stroke').length;
    expect(strokeCount, 'expected ≥ 5 stroke ops (4 channels + baseline)').toBeGreaterThanOrEqual(
      5
    );

    const lineToCount = probe.log.filter((op) => op.op === 'lineTo').length;
    expect(lineToCount, 'expected many lineTo ops for smooth chromatogram').toBeGreaterThan(20);
  });

  it('curve points stay within the lane vertical band', () => {
    const trace = syntheticTrace(30);
    const lane = chromatogramLane({ trace, height: 80 });
    const probe = createProbeContext(800);
    const info = buildPaintInfo({
      columnCount: 30,
      pxPerBase: 20,
      laneY: 100,
      laneHeight: 80,
      viewportWidth: 800,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const lineToOps = probe.log.filter((op) => op.op === 'lineTo');
    expect(lineToOps.length).toBeGreaterThan(0);
    for (const op of lineToOps) {
      if (op.op !== 'lineTo') continue;
      expect(op.y).toBeGreaterThanOrEqual(info.laneY);
      expect(op.y).toBeLessThanOrEqual(info.laneY + info.laneHeight);
    }
  });

  it('renders IUPAC code for a mixed C/T peak when zoom is high enough', () => {
    const trace = mixedTrace();
    const lane = chromatogramLane({ trace });
    const probe = createProbeContext(400);
    const info = buildPaintInfo({
      columnCount: 1,
      pxPerBase: 40,
      laneHeight: 112,
      viewportWidth: 400,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const fillTextOps = probe.log.filter((op) => op.op === 'fillText');
    const codes = fillTextOps.map((op) => (op.op === 'fillText' ? op.text : ''));
    expect(
      codes.some((c) => c === 'Y'),
      `expected an IUPAC 'Y' overlay for the C/T mixed peak; got ${JSON.stringify(codes)}`
    ).toBe(true);
  });

  it('omits letter glyphs at low zoom (no room for letters per column)', () => {
    const trace = mixedTrace();
    const lane = chromatogramLane({ trace });
    const probe = createProbeContext(400);
    const info = buildPaintInfo({
      columnCount: 1,
      pxPerBase: 2,
      laneHeight: 112,
      viewportWidth: 400,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const fillTextOps = probe.log.filter((op) => op.op === 'fillText');
    const codes = fillTextOps.map((op) => (op.op === 'fillText' ? op.text : ''));
    expect(codes.includes('Y')).toBe(false);
  });

  it('renders called-base letters from the sequence prop at high zoom', () => {
    const trace = syntheticTrace(8);
    const lane = chromatogramLane({
      trace,
      sequence: 'ACGTACGT',
      quality: [40, 40, 40, 40, 40, 40, 40, 40],
    });
    const probe = createProbeContext(800);
    const info = buildPaintInfo({
      columnCount: 8,
      pxPerBase: 40,
      laneHeight: 112,
      viewportWidth: 800,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const fillTextOps = probe.log.filter((op) => op.op === 'fillText');
    const letters = fillTextOps
      .map((op) => (op.op === 'fillText' ? op.text : ''))
      .filter((c) => /^[ACGT]$/.test(c));
    expect(letters).toEqual(['A', 'C', 'G', 'T', 'A', 'C', 'G', 'T']);
  });

  it('positions peaks on a host column grid when baseToColumn is provided (path 2)', () => {
    const trace = syntheticTrace(10);
    const lane = chromatogramLane({
      trace,
      sequence: 'ACGTACGTAC',
      quality: new Array(10).fill(40),
      baseToColumn: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109],
      totalColumns: 500,
    });

    const probe = createProbeContext(800);
    const info = buildPaintInfo({
      columnCount: 500,
      pxPerBase: 40,
      laneHeight: 112,
      viewportWidth: 800,
      visibleStart: 95,
      visibleEnd: 115,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const fillTextOps = probe.log.filter((op) => op.op === 'fillText');
    const letterXs = fillTextOps
      .filter((op) => op.op === 'fillText' && /^[ACGT]$/.test(op.text))
      .map((op) => (op.op === 'fillText' ? op.x : 0));
    expect(letterXs.length).toBe(10);
    expect(Math.min(...letterXs)).toBeCloseTo(8 + 100.5 * 40, 0);
    expect(Math.max(...letterXs)).toBeCloseTo(8 + 109.5 * 40, 0);
  });

  it('returns null sample positions for columns outside the read coverage span (path 2)', () => {
    const trace = syntheticTrace(5);
    const lane = chromatogramLane({
      trace,
      sequence: 'ACGTA',
      quality: [40, 40, 40, 40, 40],
      baseToColumn: [50, 51, 52, 53, 54],
      totalColumns: 200,
    });

    const probe = createProbeContext(800);
    const info = buildPaintInfo({
      columnCount: 200,
      pxPerBase: 40,
      laneHeight: 112,
      viewportWidth: 800,
      visibleStart: 0,
      visibleEnd: 20,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const lineToCount = probe.log.filter((op) => op.op === 'lineTo').length;
    expect(lineToCount).toBeLessThanOrEqual(5);
    const fillTextOps = probe.log.filter((op) => op.op === 'fillText');
    const letters = fillTextOps
      .filter((op) => op.op === 'fillText' && /^[ACGT]$/.test(op.text))
      .map((op) => (op.op === 'fillText' ? op.text : ''));
    expect(letters).toEqual([]);
  });

  it('renders a column highlight + hyphen glyph for each column in deletionColumns (path 2)', () => {
    const trace = syntheticTrace(5);
    const lane = chromatogramLane({
      trace,
      sequence: 'ACGTA',
      quality: [40, 40, 40, 40, 40],
      baseToColumn: [0, 1, 2, 4, 5],
      totalColumns: 6,
      deletionColumns: [3],
    });
    const probe = createProbeContext(800);
    const info = buildPaintInfo({
      columnCount: 6,
      pxPerBase: 40,
      laneHeight: 132,
      viewportWidth: 800,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const dashes = probe.log.filter((op) => op.op === 'fillText' && op.text === '-');
    expect(
      dashes.length,
      'expected one hyphen glyph for the deletion column'
    ).toBeGreaterThanOrEqual(1);

    const optsBase = {
      trace,
      sequence: 'ACGTA',
      quality: [40, 40, 40, 40, 40] as ReadonlyArray<number>,
      baseToColumn: [0, 1, 2, 4, 5],
      totalColumns: 6,
    };
    const drawAndCount = (l: ReturnType<typeof chromatogramLane>) => {
      const p = createProbeContext(800);
      p.ctx.save();
      p.ctx.translate(-info.scrollLeft, 0);
      l.draw(p.ctx, info);
      p.ctx.restore();
      return p.log.filter((op) => op.op === 'fillRect').length;
    };
    const without = drawAndCount(chromatogramLane(optsBase));
    const withDel = drawAndCount(chromatogramLane({ ...optsBase, deletionColumns: [3] }));
    expect(
      withDel - without,
      'expected 2 extra fillRects per deletion (wash + bottom marker)'
    ).toBe(2);
  });

  it("preserves parser-emitted N's: displays the letter and amber-highlights the column", () => {
    const trace = syntheticTrace(5);
    const lane = chromatogramLane({
      trace,
      sequence: 'ACNTA',
      quality: [40, 40, 40, 40, 40],
    });
    const probe = createProbeContext(800);
    const info = buildPaintInfo({
      columnCount: 5,
      pxPerBase: 40,
      laneHeight: 132,
      viewportWidth: 800,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const letters = probe.log
      .filter((op) => op.op === 'fillText')
      .map((op) => (op.op === 'fillText' ? op.text : ''));
    expect(letters.filter((l) => l === 'N').length).toBeGreaterThanOrEqual(1);
  });

  it('RC mode: caller-provided sequence/quality are NOT re-reversed by the lane (path-2 dataflow)', () => {
    const trace = syntheticTrace(4);
    const lane = chromatogramLane({
      trace,
      sequence: 'TACG',
      quality: [40, 30, 20, 10],
      reverseComplemented: true,
    });
    const probe = createProbeContext(800);
    const info = buildPaintInfo({
      columnCount: 4,
      pxPerBase: 40,
      laneHeight: 132,
      viewportWidth: 800,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const letters = probe.log
      .filter((op) => op.op === 'fillText')
      .map((op) => (op.op === 'fillText' ? op.text : ''))
      .filter((c) => /^[ACGT]$/.test(c));
    expect(letters).toEqual(['T', 'A', 'C', 'G']);
  });

  it('chromatogram curve breaks at gap columns instead of connecting across them', () => {
    const trace = syntheticTrace(4);
    const lane = chromatogramLane({
      trace,
      sequence: 'ACGT',
      quality: [40, 40, 40, 40],
      baseToColumn: [0, 1, 3, 4],
      totalColumns: 5,
      deletionColumns: [2],
    });
    const probe = createProbeContext(800);
    const info = buildPaintInfo({
      columnCount: 5,
      pxPerBase: 40,
      laneHeight: 132,
      viewportWidth: 800,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const moveTos = probe.log.filter((op) => op.op === 'moveTo').length;
    expect(
      moveTos,
      'expected ≥ 8 moveTos (2 sub-paths × 4 channels) for path-break across deletion'
    ).toBeGreaterThanOrEqual(8);
  });

  it('renders a column highlight for each column listed in mutationColumns (path 2)', () => {
    const trace = syntheticTrace(5);
    const optsBase = {
      trace,
      sequence: 'ACGTA',
      quality: [40, 40, 40, 40, 40] as ReadonlyArray<number>,
    };
    const drawAndCount = (lane: ReturnType<typeof chromatogramLane>) => {
      const probe = createProbeContext(800);
      const info = buildPaintInfo({
        columnCount: 5,
        pxPerBase: 40,
        laneHeight: 132,
        viewportWidth: 800,
      });
      probe.ctx.save();
      probe.ctx.translate(-info.scrollLeft, 0);
      lane.draw(probe.ctx, info);
      probe.ctx.restore();
      return probe.log.filter((op) => op.op === 'fillRect').length;
    };

    const without = drawAndCount(chromatogramLane(optsBase));
    const with2Mut = drawAndCount(chromatogramLane({ ...optsBase, mutationColumns: [1, 3] }));
    expect(
      with2Mut - without,
      `expected 4 extra fillRect ops for 2 mutation columns (wash + top marker per column); got ${with2Mut - without}`
    ).toBe(4);
  });

  it('Phred bars are full-column-width (no inset gaps between adjacent bars)', () => {
    const trace = syntheticTrace(3);
    const lane = chromatogramLane({
      trace,
      sequence: 'ACG',
      quality: [40, 40, 40],
    });
    const probe = createProbeContext(800);
    const PX = 30;
    const info = buildPaintInfo({
      columnCount: 3,
      pxPerBase: PX,
      laneHeight: 132,
      viewportWidth: 800,
    });
    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const candidateBars = probe.log.filter(
      (op) => op.op === 'fillRect' && op.w === PX && op.h <= 30
    );
    expect(candidateBars.length).toBeGreaterThanOrEqual(3);
  });

  it('renders Phred bars (as fillRect ops) behind the letter row when quality > 0', () => {
    const trace = syntheticTrace(5);
    const laneWithQ = chromatogramLane({
      trace,
      sequence: 'ACGTA',
      quality: [40, 30, 20, 10, 0],
    });
    const laneNoQ = chromatogramLane({ trace, sequence: 'ACGTA', quality: [0, 0, 0, 0, 0] });

    const draw = (lane: ReturnType<typeof chromatogramLane>) => {
      const probe = createProbeContext(400);
      const info = buildPaintInfo({
        columnCount: 5,
        pxPerBase: 40,
        laneHeight: 112,
        viewportWidth: 400,
      });
      probe.ctx.save();
      probe.ctx.translate(-info.scrollLeft, 0);
      lane.draw(probe.ctx, info);
      probe.ctx.restore();
      return probe.log.filter((op) => op.op === 'fillRect').length;
    };

    expect(draw(laneWithQ)).toBeGreaterThan(draw(laneNoQ));
  });

  it('circular host: peaks render in the wrap-buffer copy when viewport straddles origin', () => {
    const trace = syntheticTrace(5);
    const lane = chromatogramLane({
      trace,
      sequence: 'ACGTA',
      quality: [40, 40, 40, 40, 40],
      baseToColumn: [0, 1, 2, 3, 4],
      totalColumns: 100,
    });
    const probe = createProbeContext(800);
    const info = buildPaintInfo({
      columnCount: 100,
      pxPerBase: 8,
      laneHeight: 132,
      viewportWidth: 800,
      visibleStart: 95,
      visibleEnd: 145,
      isCircular: true,
    });
    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const letterXs = probe.log
      .filter((op) => op.op === 'fillText' && /^[ACGT]$/.test(op.text))
      .map((op) => (op.op === 'fillText' ? op.x : 0));
    expect(letterXs.length).toBe(5);
    const sortedVCols = letterXs
      .map((x) => Math.round((x - info.horizontalPadding) / info.pxPerBase - 0.5))
      .sort((a, b) => a - b);
    expect(sortedVCols).toEqual([100, 101, 102, 103, 104]);
  });

  it('non-circular host: visibleEnd beyond columnCount does NOT trigger wrap rendering', () => {
    const trace = syntheticTrace(5);
    const lane = chromatogramLane({
      trace,
      sequence: 'ACGTA',
      quality: [40, 40, 40, 40, 40],
      baseToColumn: [0, 1, 2, 3, 4],
      totalColumns: 100,
    });
    const probe = createProbeContext(800);
    const info = buildPaintInfo({
      columnCount: 100,
      pxPerBase: 8,
      laneHeight: 132,
      viewportWidth: 800,
      visibleStart: 95,
      visibleEnd: 145,
      isCircular: false,
    });
    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();
    const letters = probe.log
      .filter((op) => op.op === 'fillText' && /^[ACGT]$/.test(op.text))
      .map((op) => (op.op === 'fillText' ? op.text : ''));
    expect(letters.length).toBe(0);
  });

  it('emits referenceColumnOverlays for mutationColumns (mut-wash + mut-marker, red, sequenceBand-bound)', () => {
    const trace = syntheticTrace(5);
    const lane = chromatogramLane({
      trace,
      sequence: 'ACGTA',
      quality: [40, 40, 40, 40, 40],
      mutationColumns: [1, 3],
    });
    expect(lane.referenceColumnOverlays).toBeDefined();
    const overlays = lane.referenceColumnOverlays!;
    const mut = overlays.filter((o) => o.id.startsWith('mut-'));
    expect(mut.length).toBe(2);
    const wash = mut.find((o) => o.kind === 'columnWash');
    const marker = mut.find((o) => o.kind === 'topMarker');
    expect(wash).toBeDefined();
    expect(marker).toBeDefined();
    expect(wash!.color).toBe('#dc2626');
    expect(wash!.columns).toEqual([1, 3]);
    expect(marker!.color).toBe('#dc2626');
    expect(marker!.columns).toEqual([1, 3]);
  });

  it('emits referenceColumnOverlays for deletionColumns (del-wash + del-marker, bottomMarker)', () => {
    const trace = syntheticTrace(5);
    const lane = chromatogramLane({
      trace,
      sequence: 'ACGTA',
      quality: [40, 40, 40, 40, 40],
      baseToColumn: [0, 1, 3, 4, 5],
      totalColumns: 6,
      deletionColumns: [2],
    });
    const overlays = lane.referenceColumnOverlays!;
    const del = overlays.filter((o) => o.id.startsWith('del-'));
    expect(del.length).toBe(2);
    expect(del.find((o) => o.kind === 'columnWash')).toBeDefined();
    expect(del.find((o) => o.kind === 'bottomMarker')).toBeDefined();
    expect(del[0].columns).toEqual([2]);
  });

  it('emits referenceColumnOverlays for ambiguous columns (amber wash, derived from channels OR parser)', () => {
    const trace = mixedTrace();
    const lane = chromatogramLane({ trace });
    const overlays = lane.referenceColumnOverlays!;
    const amb = overlays.find((o) => o.id === 'amb-wash');
    expect(amb).toBeDefined();
    expect(amb!.color).toBe('#f59e0b');
    expect(amb!.columns).toEqual([0]);
  });

  it('omits referenceColumnOverlays entirely when no mut/del/amb input', () => {
    const trace = syntheticTrace(5);
    const lane = chromatogramLane({
      trace,
      sequence: 'ACGTA',
      quality: [40, 40, 40, 40, 40],
    });
    expect(lane.referenceColumnOverlays).toBeUndefined();
  });

  it('uses caller-provided laneId verbatim; derives a unique one when omitted (multi-read collision fix)', () => {
    const trace1 = syntheticTrace(5);
    const trace2 = syntheticTrace(8);
    const explicit = chromatogramLane({ trace: trace1, laneId: 'my-stable-id' });
    expect(explicit.id).toBe('my-stable-id');
    const a = chromatogramLane({ trace: trace1 });
    const b = chromatogramLane({ trace: trace2 });
    expect(a.id).not.toBe(b.id);
    const a2 = chromatogramLane({ trace: trace1 });
    expect(a.id).toBe(a2.id);
  });

  it('wrap-aware (cycleLength set): peaks past cycleLength wrap to bio cols 0+; renders as one continuous lane', () => {
    const trace = syntheticTrace(10);
    const lane = chromatogramLane({
      trace,
      sequence: 'ACGTACGTAC',
      quality: new Array(10).fill(40),
      baseToColumn: [95, 96, 97, 98, 99, 100, 101, 102, 103, 104],
      totalColumns: 100,
      cycleLength: 100,
    });

    const probe = createProbeContext(800);
    const info = buildPaintInfo({
      columnCount: 100,
      pxPerBase: 8,
      laneHeight: 132,
      viewportWidth: 800,
      visibleStart: 90,
      visibleEnd: 110,
      isCircular: true,
    });
    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const letterXs = probe.log
      .filter((op) => op.op === 'fillText' && /^[ACGT]$/.test(op.text))
      .map((op) => (op.op === 'fillText' ? op.x : 0));
    expect(letterXs.length).toBe(10);
    const sortedVCols = letterXs
      .map((x) => Math.round((x - info.horizontalPadding) / info.pxPerBase - 0.5))
      .sort((a, b) => a - b);
    expect(sortedVCols).toEqual([95, 96, 97, 98, 99, 100, 101, 102, 103, 104]);
  });

  it('wrap-aware: mutationColumns in virtual space mod-by-cycleLength for overlay emission', () => {
    const trace = syntheticTrace(10);
    const lane = chromatogramLane({
      trace,
      sequence: 'ACGTACGTAC',
      quality: new Array(10).fill(40),
      baseToColumn: [95, 96, 97, 98, 99, 100, 101, 102, 103, 104],
      totalColumns: 100,
      cycleLength: 100,
      mutationColumns: [96, 102],
    });
    expect(lane.referenceColumnOverlays).toBeDefined();
    const overlays = lane.referenceColumnOverlays!;
    const mutWash = overlays.find((o) => o.id === 'mut-wash');
    expect(mutWash).toBeDefined();
    expect([...mutWash!.columns].sort((a, b) => a - b)).toEqual([2, 96]);
  });

  it('reverseComplemented:true flips peak order — the fwd lane and RC lane draw at different positions', () => {
    const trace = asymmetricTrace(20);
    const fwdLane = chromatogramLane({ trace });
    const rcLane = chromatogramLane({ trace, reverseComplemented: true });

    const drawAt = (lane: ReturnType<typeof chromatogramLane>) => {
      const probe = createProbeContext(800);
      const info = buildPaintInfo({
        columnCount: 20,
        pxPerBase: 40,
        viewportWidth: 800,
      });
      probe.ctx.save();
      probe.ctx.translate(-info.scrollLeft, 0);
      lane.draw(probe.ctx, info);
      probe.ctx.restore();
      return probe.log;
    };

    const fwdLog = drawAt(fwdLane);
    const rcLog = drawAt(rcLane);

    const fwdStrokes = fwdLog.filter((op) => op.op === 'stroke').length;
    const rcStrokes = rcLog.filter((op) => op.op === 'stroke').length;
    expect(rcStrokes).toBe(fwdStrokes);

    const fwdLineTos = fwdLog
      .filter((op) => op.op === 'lineTo')
      .map((op) => (op.op === 'lineTo' ? `${op.x.toFixed(1)},${op.y.toFixed(1)}` : ''))
      .join('|');
    const rcLineTos = rcLog
      .filter((op) => op.op === 'lineTo')
      .map((op) => (op.op === 'lineTo' ? `${op.x.toFixed(1)},${op.y.toFixed(1)}` : ''))
      .join('|');
    expect(fwdLineTos).not.toBe(rcLineTos);
  });
});
