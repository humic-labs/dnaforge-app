import type { LayoutSnapshot2D, Layout2DRow, WorkspaceEditorConfig } from './types';
import { ANNOTATION_ROW_HEIGHT, ANNOTATION_LANE_PADDING } from './layout-constants';

export interface Segment {
  x: number;
  y: number;
  width: number;
  height: number;
  startsAtRangeStart: boolean;
  endsAtRangeEnd: boolean;
  baseStart: number;
  baseEnd: number;
}

export interface HitResult {
  baseIndex: number;
  laneIndex?: number;
}

export interface Tick {
  position: number;
  x: number;
  y: number;
  label?: string;
  major: boolean;
}

export interface SequenceLayout {
  getRectsForBaseRange(start: number, end: number): Segment[];

  getBaseAtPoint(x: number, y: number): HitResult | null;

  getTotalSize(): { width: number; height: number };

  getRulerTicks(viewportStart: number, viewportEnd: number): Tick[];
}

export function create2DLayoutAdapter(
  snapshot: LayoutSnapshot2D,
  config: WorkspaceEditorConfig
): SequenceLayout {
  const { marginLeft, charWidth, rulerInterval } = config;

  function rowAnnotationBandHeight(row: Layout2DRow): number {
    if (!config.showAnnotations || row.annotationLaneCount <= 0) return 0;
    let h = row.annotationLaneCount * (ANNOTATION_ROW_HEIGHT + ANNOTATION_LANE_PADDING);
    if ((row.translationLaneCount ?? 0) > 0) h -= ANNOTATION_LANE_PADDING;
    return h;
  }

  return {
    getRectsForBaseRange(start: number, end: number): Segment[] {
      if (end <= start) return [];
      const segments: Segment[] = [];
      for (const row of snapshot.lines) {
        const rowStart = row.startPos;
        const rowEnd = row.endPos;
        const rowSpansOrigin = rowEnd < rowStart;
        const rowLen = rowSpansOrigin
          ? (snapshot.sequenceLength ?? 0) - rowStart + rowEnd
          : rowEnd - rowStart;
        if (rowLen <= 0) continue;

        const rowIntervals: Array<{ a: number; b: number; offset: number }> = rowSpansOrigin
          ? [
              { a: rowStart, b: snapshot.sequenceLength ?? rowStart, offset: 0 },
              {
                a: 0,
                b: rowEnd,
                offset: (snapshot.sequenceLength ?? rowStart) - rowStart,
              },
            ]
          : [{ a: rowStart, b: rowEnd, offset: 0 }];

        for (const iv of rowIntervals) {
          const a = Math.max(start, iv.a);
          const b = Math.min(end, iv.b);
          if (b <= a) continue;

          const x = marginLeft + (a - iv.a + iv.offset) * charWidth;
          const width = (b - a) * charWidth;
          const bandTop = row.y;
          const annBand = rowAnnotationBandHeight(row);
          const y = bandTop + annBand;
          const height = config.rowHeight;

          segments.push({
            x,
            y,
            width,
            height,
            startsAtRangeStart: a === start,
            endsAtRangeEnd: b === end,
            baseStart: a,
            baseEnd: b,
          });
        }
      }
      return segments;
    },

    getBaseAtPoint(x: number, y: number): HitResult | null {
      if (x < marginLeft) return null;
      for (let i = 0; i < snapshot.lines.length; i++) {
        const row = snapshot.lines[i];
        const next = snapshot.lines[i + 1];
        const rowEndY = next ? next.y : snapshot.totalHeight;
        if (y < row.y || y >= rowEndY) continue;

        const xInSeq = x - marginLeft;
        const charIndex = Math.floor(xInSeq / charWidth);
        if (charIndex < 0) return null;

        const rowSpansOrigin = row.endPos < row.startPos;
        const rowLen = rowSpansOrigin
          ? (snapshot.sequenceLength ?? 0) - row.startPos + row.endPos
          : row.endPos - row.startPos;
        if (charIndex >= rowLen) return null;

        const baseIndex = rowSpansOrigin
          ? (row.startPos + charIndex) % (snapshot.sequenceLength ?? 1)
          : row.startPos + charIndex;

        return { baseIndex };
      }
      return null;
    },

    getTotalSize() {
      return { width: snapshot.totalWidth, height: snapshot.totalHeight };
    },

    getRulerTicks(viewportStart: number, viewportEnd: number): Tick[] {
      const ticks: Tick[] = [];
      const step = Math.max(1, rulerInterval);
      const firstTick = Math.ceil(viewportStart / step) * step;
      for (let pos = firstTick; pos < viewportEnd; pos += step) {
        for (const row of snapshot.lines) {
          const rowSpansOrigin = row.endPos < row.startPos;
          const inRow = rowSpansOrigin
            ? pos >= row.startPos || pos < row.endPos
            : pos >= row.startPos && pos < row.endPos;
          if (!inRow) continue;

          const offset =
            rowSpansOrigin && pos < row.endPos
              ? (snapshot.sequenceLength ?? 0) - row.startPos + pos
              : pos - row.startPos;
          ticks.push({
            position: pos,
            x: marginLeft + offset * charWidth + charWidth / 2,
            y: row.y,
            label: String(pos),
            major: true,
          });
          break;
        }
      }
      return ticks;
    },
  };
}
