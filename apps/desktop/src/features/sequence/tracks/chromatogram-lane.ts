import {
  buildColumnGridMapping,
  detectMixedCall,
  reverseComplementTrace,
  type TraceData,
} from '../../trace/public';
import {
  DEFAULT_EDITOR_CONFIG,
  getCanvasTheme,
  type ReferenceColumnOverlay,
  type SequenceExtraLane,
  type SequenceExtraLanePaintInfo,
} from '@waypoint/workspace-editor';
import { recordDraw } from './trace-probe';

const CHANNEL_COLORS: Record<'A' | 'C' | 'G' | 'T', string> = {
  A: '#22c55e',
  C: '#3b82f6',
  G: '#0f172a',
  T: '#ef4444',
};

const BG = '#fafafa';
const LABEL_COLOR = '#475569';
const FONT = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const AMBIGUOUS_BASE_RE = /^[NRYSWKMBDHV]$/;

export interface ChromatogramLaneOptions {
  trace: TraceData;
  sequence?: string;
  quality?: ReadonlyArray<number>;
  baseToColumn?: ReadonlyArray<number>;
  totalColumns?: number;
  mutationColumns?: ReadonlyArray<number>;
  deletionColumns?: ReadonlyArray<number>;
  reverseComplemented?: boolean;
  iupacThreshold?: number;
  height?: number;
  label?: string;
  laneId?: string;
  cycleLength?: number;
}

function chromatogramLaneLayout(
  laneY: number,
  laneHeight: number,
  baseFontSize: number
): {
  labelStripH: number;
  letterRowH: number;
  phredRowH: number;
  innerY: number;
  innerH: number;
  phredRowY: number;
  letterRowY: number;
} {
  const labelStripH = Math.min(14, Math.max(0, Math.floor(laneHeight * 0.11)));
  const letterRowH = Math.max(baseFontSize + 3, 14);
  const phredRowH = Math.max(Math.round(letterRowH * 1.6), 22);
  const bottomPad = Math.min(4, Math.max(0, Math.floor(laneHeight * 0.03)));
  const innerY = laneY + labelStripH;
  const innerH = Math.max(0, laneHeight - labelStripH - phredRowH - letterRowH - bottomPad);
  return {
    labelStripH,
    letterRowH,
    phredRowH,
    innerY,
    innerH,
    phredRowY: innerY + innerH,
    letterRowY: innerY + innerH + phredRowH,
  };
}

function strokeChromatogramChannels(
  ctx: CanvasRenderingContext2D,
  args: {
    trace: TraceData;
    startCol: number;
    endCol: number;
    toBioCol: (virtualCol: number) => number;
    bioColCount: number;
    columnToBaseIndex: ArrayLike<number>;
    baseToColumn: ArrayLike<number>;
    isWrapAware: boolean;
    mapping: { sampleAtColumnX: (col: number, frac: number) => number | null };
    stepsPerColumn: number;
    horizontalPadding: number;
    pxPerBase: number;
    innerY: number;
    curveSpan: number;
    maxAmp: number;
  }
): { channelStrokes: number; lineTos: number } {
  let channelStrokes = 0;
  let lineTos = 0;
  const channels = ['A', 'C', 'G', 'T'] as const;
  for (const base of channels) {
    const channelData = args.trace.channels[base];
    ctx.strokeStyle = CHANNEL_COLORS[base];
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let started = false;
    let everStarted = false;
    let pathLineTos = 0;
    for (let v = args.startCol; v < args.endCol; v++) {
      const bio = args.toBioCol(v);
      if (bio < 0 || bio >= args.bioColCount || args.columnToBaseIndex[bio] < 0) {
        started = false;
        continue;
      }
      const peakIdx = args.columnToBaseIndex[bio];
      const colForMapping = args.isWrapAware ? args.baseToColumn[peakIdx] : bio;
      for (let s = 0; s <= args.stepsPerColumn; s++) {
        const frac = s / args.stepsPerColumn;
        const sample = args.mapping.sampleAtColumnX(colForMapping, frac);
        if (sample === null) continue;
        const i0 = Math.floor(sample);
        const i1 = Math.min(channelData.length - 1, i0 + 1);
        const fr = sample - i0;
        const a = Math.abs(channelData[i0] ?? 0);
        const b = Math.abs(channelData[i1] ?? 0);
        const amp = a + (b - a) * fr;
        const x = args.horizontalPadding + (v + frac) * args.pxPerBase;
        const y = args.innerY + args.curveSpan * (1 - amp / args.maxAmp);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
          everStarted = true;
        } else {
          ctx.lineTo(x, y);
          pathLineTos += 1;
        }
      }
    }
    ctx.stroke();
    if (everStarted) channelStrokes += 1;
    lineTos += pathLineTos;
  }
  return { channelStrokes, lineTos };
}

function chromatogramVisibleColumnWindow(
  info: SequenceExtraLanePaintInfo,
  isWrapAware: boolean,
  bioCycleLength: number,
  totalColumns: number
): {
  startCol: number;
  endCol: number;
  toBioCol: (virtualCol: number) => number;
} {
  const cycle = isWrapAware
    ? bioCycleLength
    : info.columnCount > 0
      ? info.columnCount
      : totalColumns;
  const startCol = Math.max(0, Math.floor(info.visibleStart));
  const endCol = info.isCircular
    ? Math.ceil(info.visibleEnd)
    : Math.min(totalColumns, Math.ceil(info.visibleEnd));
  return {
    startCol,
    endCol,
    toBioCol: (virtualCol: number): number => {
      if (!info.isCircular || cycle <= 0) return virtualCol;
      return ((virtualCol % cycle) + cycle) % cycle;
    },
  };
}

export function chromatogramLane(opts: ChromatogramLaneOptions): SequenceExtraLane {
  const trace = opts.reverseComplemented ? reverseComplementTrace(opts.trace) : opts.trace;
  const sequence = opts.sequence ?? '';
  const quality = opts.quality ?? [];
  const N = trace.peakPositions.length;
  const baseToColumn = opts.baseToColumn
    ? Array.from(opts.baseToColumn)
    : trace.peakPositions.map((_, i) => i);
  const maxBaseToColumn = baseToColumn.length > 0 ? Math.max(...baseToColumn) + 1 : 0;
  const totalColumns = Math.max(opts.totalColumns ?? maxBaseToColumn, baseToColumn.length);

  const bioCycleLength = opts.cycleLength;
  const isWrapAware = typeof bioCycleLength === 'number' && bioCycleLength > 0;
  const bioColCount = isWrapAware ? bioCycleLength : totalColumns;
  const toBio = (col: number): number =>
    isWrapAware ? ((col % bioCycleLength) + bioCycleLength) % bioCycleLength : col;

  const mappingUpperBound = isWrapAware ? Math.max(totalColumns, maxBaseToColumn) : totalColumns;
  const mapping = buildColumnGridMapping(trace.peakPositions, baseToColumn, mappingUpperBound);

  const mutationCols = new Set<number>();
  for (const c of opts.mutationColumns ?? []) mutationCols.add(toBio(c));
  const deletionCols = new Set<number>();
  for (const c of opts.deletionColumns ?? []) deletionCols.add(toBio(c));

  const columnToBaseIndex = new Int32Array(bioColCount);
  columnToBaseIndex.fill(-1);
  for (let i = 0; i < baseToColumn.length; i++) {
    const bioCol = toBio(baseToColumn[i]);
    if (bioCol >= 0 && bioCol < bioColCount) columnToBaseIndex[bioCol] = i;
  }
  const iupacThreshold = opts.iupacThreshold ?? 0.5;
  const height = opts.height ?? 132;
  const label = opts.label ?? 'Sanger trace';
  const maxAmp = Math.max(trace.maxValue, 1);
  const baseFontFamily = DEFAULT_EDITOR_CONFIG.fontFamily;
  const baseFontSize = DEFAULT_EDITOR_CONFIG.fontSize;
  const PHRED_CAP = 40;

  const traceFingerprint =
    trace.peakPositions.length > 0
      ? `${trace.peakPositions[0]}-${trace.peakPositions[trace.peakPositions.length - 1]}-${trace.peakPositions.length}`
      : 'empty';
  const laneId = opts.laneId ?? `sanger-chromatogram-${traceFingerprint}-${label}`;

  const ambiguousColumns: number[] = [];
  for (let col = 0; col < totalColumns; col++) {
    const baseIdx = columnToBaseIndex[col];
    if (baseIdx < 0) continue;
    const peakSample = trace.peakPositions[baseIdx];
    const call = detectMixedCall(trace.channels, peakSample, iupacThreshold);
    const calledLetter = (sequence[baseIdx] ?? call.dominant).toUpperCase();
    const isAmbiguous = call.iupacCode !== call.dominant || AMBIGUOUS_BASE_RE.test(calledLetter);
    if (isAmbiguous) ambiguousColumns.push(col);
  }

  const overlayMutCols = [...new Set((opts.mutationColumns ?? []).map(toBio))];
  const overlayDelCols = [...new Set((opts.deletionColumns ?? []).map(toBio))];
  const referenceColumnOverlays: ReadonlyArray<ReferenceColumnOverlay> = [];
  if (overlayMutCols.length > 0) {
    (referenceColumnOverlays as ReferenceColumnOverlay[]).push(
      {
        id: 'mut-wash',
        target: 'sequenceBand',
        columns: overlayMutCols,
        color: '#dc2626',
        kind: 'columnWash',
        alpha: 0.28,
      },
      {
        id: 'mut-marker',
        target: 'sequenceBand',
        columns: overlayMutCols,
        color: '#dc2626',
        kind: 'topMarker',
        thickness: 2,
      }
    );
  }
  if (overlayDelCols.length > 0) {
    (referenceColumnOverlays as ReferenceColumnOverlay[]).push(
      {
        id: 'del-wash',
        target: 'sequenceBand',
        columns: overlayDelCols,
        color: '#dc2626',
        kind: 'columnWash',
        alpha: 0.28,
      },
      {
        id: 'del-marker',
        target: 'sequenceBand',
        columns: overlayDelCols,
        color: '#dc2626',
        kind: 'bottomMarker',
        thickness: 2,
      }
    );
  }
  if (ambiguousColumns.length > 0) {
    (referenceColumnOverlays as ReferenceColumnOverlay[]).push({
      id: 'amb-wash',
      target: 'sequenceBand',
      columns: ambiguousColumns,
      color: '#f59e0b',
      kind: 'columnWash',
      alpha: 0.2,
    });
  }

  return {
    id: laneId,
    height,
    referenceColumnOverlays:
      referenceColumnOverlays.length > 0 ? referenceColumnOverlays : undefined,
    draw: (ctx, info) => {
      const { laneY, laneHeight, pxPerBase, visibleStart, visibleEnd, horizontalPadding } = info;
      let columnsDrawn = 0;
      let channelStrokes = 0;
      let lineTos = 0;
      let iupacOverlays = 0;
      let letterGlyphs = 0;
      let phredBars = 0;

      const worldLeft = info.scrollLeft;
      const worldRight = info.scrollLeft + info.viewportWidth;
      ctx.fillStyle = BG;
      ctx.fillRect(worldLeft, laneY, info.viewportWidth, laneHeight);

      const { letterRowH, phredRowH, innerY, innerH, phredRowY, letterRowY } =
        chromatogramLaneLayout(laneY, laneHeight, baseFontSize);
      if (innerH < 4 || pxPerBase <= 0 || N === 0) {
        drawLabel(ctx, label, worldLeft, laneY);
        recordDraw({
          laneY,
          laneHeight,
          pxPerBase,
          visibleStart,
          visibleEnd,
          columnsDrawn,
          channelStrokes,
          lineTos,
          iupacOverlays,
          letterGlyphs,
          phredBars,
        });
        return;
      }

      const { startCol, endCol, toBioCol } = chromatogramVisibleColumnWindow(
        info,
        isWrapAware,
        bioCycleLength ?? 0,
        totalColumns
      );
      if (endCol <= startCol) {
        drawLabel(ctx, label, worldLeft, laneY);
        recordDraw({
          laneY,
          laneHeight,
          pxPerBase,
          visibleStart,
          visibleEnd,
          columnsDrawn,
          channelStrokes,
          lineTos,
          iupacOverlays,
          letterGlyphs,
          phredBars,
        });
        return;
      }
      columnsDrawn = endCol - startCol;

      const stepsPerColumn = Math.max(4, Math.min(16, Math.ceil(pxPerBase)));
      const baselineY = innerY + innerH;

      ctx.strokeStyle = 'rgba(100, 116, 139, 0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(worldLeft, baselineY + 0.5);
      ctx.lineTo(worldRight, baselineY + 0.5);
      ctx.stroke();

      const curveSpan = Math.max(1, innerH - 1);
      const channelStrokeCounts = strokeChromatogramChannels(ctx, {
        trace,
        startCol,
        endCol,
        toBioCol,
        bioColCount,
        columnToBaseIndex,
        baseToColumn,
        isWrapAware,
        mapping,
        stepsPerColumn,
        horizontalPadding,
        pxPerBase,
        innerY,
        curveSpan,
        maxAmp,
      });
      channelStrokes += channelStrokeCounts.channelStrokes;
      lineTos += channelStrokeCounts.lineTos;

      const theme = getCanvasTheme();
      const lettersFitColumn = pxPerBase >= 4;

      for (let v = startCol; v < endCol; v++) {
        const bio = toBioCol(v);
        if (bio < 0 || bio >= bioColCount) continue;
        const colX = horizontalPadding + v * pxPerBase;

        if (deletionCols.has(bio)) {
          ctx.fillStyle = 'rgba(220, 38, 38, 0.28)';
          ctx.fillRect(colX, innerY, pxPerBase, innerH + phredRowH + letterRowH);
          ctx.fillStyle = '#dc2626';
          ctx.fillRect(colX, letterRowY + letterRowH - 2, pxPerBase, 2);
          continue;
        }

        const baseIdx = columnToBaseIndex[bio];
        if (baseIdx < 0) continue;

        if (mutationCols.has(bio)) {
          ctx.fillStyle = 'rgba(220, 38, 38, 0.28)';
          ctx.fillRect(colX, innerY, pxPerBase, innerH + phredRowH + letterRowH);
          ctx.fillStyle = '#dc2626';
          ctx.fillRect(colX, innerY, pxPerBase, 2);
          continue;
        }

        const peakSample = trace.peakPositions[baseIdx];
        const call = detectMixedCall(trace.channels, peakSample, iupacThreshold);
        const calledLetter = (sequence[baseIdx] ?? call.dominant).toUpperCase();
        const isAmbiguous =
          call.iupacCode !== call.dominant || AMBIGUOUS_BASE_RE.test(calledLetter);
        if (isAmbiguous) {
          ctx.fillStyle = 'rgba(245, 158, 11, 0.20)';
          ctx.fillRect(colX, innerY, pxPerBase, innerH + phredRowH + letterRowH);
        }
      }

      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      for (let v = startCol; v < endCol; v++) {
        const bio = toBioCol(v);
        if (bio < 0 || bio >= bioColCount) continue;
        const colX = horizontalPadding + v * pxPerBase;

        if (deletionCols.has(bio)) {
          if (lettersFitColumn) {
            ctx.font = `700 ${baseFontSize + 2}px ${baseFontFamily}`;
            ctx.fillStyle = '#7f1d1d';
            ctx.fillText('-', colX + pxPerBase / 2, letterRowY + letterRowH / 2);
            letterGlyphs += 1;
          }
          continue;
        }

        const baseIdx = columnToBaseIndex[bio];
        if (baseIdx < 0) continue;
        const peakSample = trace.peakPositions[baseIdx];
        const call = detectMixedCall(trace.channels, peakSample, iupacThreshold);
        const calledLetter = (sequence[baseIdx] ?? call.dominant).toUpperCase();
        const isMixed = call.iupacCode !== call.dominant || AMBIGUOUS_BASE_RE.test(calledLetter);
        const isMutation = mutationCols.has(bio);
        const phred = quality[baseIdx] ?? 0;
        const ratio = Math.min(1, Math.max(0, phred / PHRED_CAP));

        if (ratio > 0) {
          const barH = Math.max(1, phredRowH * ratio);
          ctx.fillStyle = `rgba(15, 23, 42, ${0.05 + 0.13 * ratio})`;
          ctx.fillRect(colX, phredRowY + phredRowH - barH, pxPerBase, barH);
          phredBars += 1;
        }

        if (pxPerBase >= 2) {
          ctx.fillStyle = 'rgba(148, 163, 184, 0.18)';
          ctx.fillRect(colX + pxPerBase - 1, phredRowY, 1, phredRowH);
        }

        if (lettersFitColumn) {
          const display = call.iupacCode !== call.dominant ? call.iupacCode : calledLetter;
          if (isMutation) {
            ctx.font = `700 ${baseFontSize + 2}px ${baseFontFamily}`;
            ctx.fillStyle = '#7f1d1d';
          } else if (isMixed) {
            ctx.font = `700 ${baseFontSize + 1}px ${baseFontFamily}`;
            ctx.fillStyle = '#92400e';
          } else {
            ctx.font = `${baseFontSize}px ${baseFontFamily}`;
            ctx.fillStyle = theme.fg;
          }
          const cx = colX + pxPerBase / 2;
          ctx.fillText(display, cx, letterRowY + letterRowH / 2);
          letterGlyphs += 1;
          if (isMixed) iupacOverlays += 1;
        } else if (isMixed) {
          iupacOverlays += 1;
        }
      }

      drawLabel(ctx, label, worldLeft, laneY);
      recordDraw({
        laneY,
        laneHeight,
        pxPerBase,
        visibleStart,
        visibleEnd,
        columnsDrawn,
        channelStrokes,
        lineTos,
        iupacOverlays,
        letterGlyphs,
        phredBars,
      });
    },
  };
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  worldLeft: number,
  laneY: number
): void {
  ctx.fillStyle = LABEL_COLOR;
  ctx.font = `600 10px ${FONT}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(text, worldLeft + 6, laneY + 2);
}
