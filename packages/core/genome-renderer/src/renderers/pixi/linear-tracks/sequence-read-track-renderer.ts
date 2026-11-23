import { Container, Graphics, Text } from 'pixi.js';
import type { TraceData } from '@waypoint/sequence-utils';
import type {
  PixiLinearTrackRenderer,
  TrackHitResult,
  TrackHoverArgs,
  TrackMountArgs,
  TrackPaintArgs,
} from './types';

export const SEQUENCE_READ_TRACK_TYPE = 'sequence-read';

export type SequenceReadTrackData =
  | ({
      readonly kind: 'alignment';
      readonly label: string;
      readonly alignedReference: string;
    } & (
      | { readonly alignedQuery: string; readonly queryColumns?: never }
      | { readonly alignedQuery?: never; readonly queryColumns: ReadonlyArray<string | null> }
    ))
  | {
      readonly kind: 'sanger';
      readonly label: string;
      readonly trace: TraceData;
      readonly sequence: string;
      readonly quality?: ReadonlyArray<number>;
      readonly baseToColumn: ReadonlyArray<number>;
      readonly mutationColumns: ReadonlyArray<number>;
      readonly deletionColumns: ReadonlyArray<number>;
      readonly cycleLength?: number;
    };

export interface SequenceReadPaintReceipt {
  readonly paintCount: number;
  readonly traceVisible: boolean;
  readonly qualityVisible: boolean;
  readonly basesVisible: boolean;
}

interface ReadTrackDiagnostics {
  readonly kind: 'alignment' | 'sanger' | null;
  readonly paintCount: number;
  readonly channelStrokes: number;
  readonly curveSegments: number;
  readonly qualityBars: number;
  readonly baseGlyphs: number;
  readonly mutationColumns: number;
  readonly deletionColumns: number;
  readonly visibleStart: number;
  readonly visibleEnd: number;
}

interface MountedState {
  readonly container: Container;
  readonly background: Graphics;
  readonly marks: Graphics;
  readonly curves: Graphics;
  readonly texts: Text[];
  data: SequenceReadTrackData | null;
  diagnostics: ReadTrackDiagnostics;
  painted: {
    readonly data: Extract<SequenceReadTrackData, { kind: 'sanger' }>;
    readonly receipt: SequenceReadPaintReceipt;
  } | null;
}

interface ReadPaintVisibility {
  traceVisible: boolean;
  qualityVisible: boolean;
  basesVisible: boolean;
}

const CHANNELS = ['A', 'C', 'G', 'T'] as const;
const CHANNEL_COLORS = { A: 0x22c55e, C: 0x3b82f6, G: 0x64748b, T: 0xef4444 };

function visibleColumns(args: TrackPaintArgs, length: number): { start: number; end: number } {
  return {
    start: Math.max(0, Math.floor(args.viewportBpRange.start)),
    end: Math.min(length, Math.ceil(args.viewportBpRange.end)),
  };
}

function virtualColumn(
  column: number,
  columns: ReadonlyArray<number>,
  cycleLength?: number
): number | null {
  if (columns.length === 0) return null;
  const first = columns[0];
  const last = columns[columns.length - 1];
  if (!cycleLength) return column >= first && column <= last ? column : null;
  const turn = Math.ceil((first - column) / cycleLength);
  const candidate = column + turn * cycleLength;
  return candidate <= last ? candidate : null;
}

function calledBaseIndex(columns: ReadonlyArray<number>, column: number): number {
  let lo = 0;
  let hi = columns.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (columns[mid] < column) lo = mid + 1;
    else hi = mid;
  }
  return lo < columns.length && columns[lo] === column ? lo : -1;
}

function traceSampleAt(
  data: Extract<SequenceReadTrackData, { kind: 'sanger' }>,
  column: number,
  fraction: number
): number | null {
  const index = calledBaseIndex(data.baseToColumn, column);
  if (index < 0) return null;
  const current = data.trace.peakPositions[index];
  if (fraction < 0.5 && index > 0 && data.baseToColumn[index - 1] === column - 1) {
    const previous = data.trace.peakPositions[index - 1];
    return previous + (current - previous) * (fraction + 0.5);
  }
  if (
    fraction > 0.5 &&
    index + 1 < data.baseToColumn.length &&
    data.baseToColumn[index + 1] === column + 1
  ) {
    const next = data.trace.peakPositions[index + 1];
    return current + (next - current) * (fraction - 0.5);
  }
  return current;
}

function sampleAmplitude(samples: ReadonlyArray<number>, index: number): number {
  const left = Math.max(0, Math.min(samples.length - 1, Math.floor(index)));
  const right = Math.min(samples.length - 1, left + 1);
  const fraction = Math.max(0, Math.min(1, index - left));
  return (samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction;
}

function textAt(
  state: MountedState,
  index: number,
  value: string,
  x: number,
  y: number,
  color: number,
  size: number
): Text {
  let label = state.texts[index];
  if (!label) {
    label = new Text({
      text: value,
      style: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: size, fill: color },
    });
    state.texts.push(label);
    state.container.addChild(label);
  }
  label.text = value;
  label.style.fontSize = size;
  label.style.fill = color;
  label.position.set(x, y);
  label.visible = true;
  return label;
}

function primitiveIntersectsViewport(
  args: TrackPaintArgs,
  x: number,
  y: number,
  width: number,
  height: number
): boolean {
  const top = Math.max(0, args.contentClipTopPx ?? 0, args.containerTopPx);
  const bottom = Math.min(args.viewportHeightPx, args.containerTopPx + args.layoutEntry.height);
  const absoluteY = args.containerTopPx + y;
  return (
    width > 0 &&
    height > 0 &&
    x < args.viewportWidthPx &&
    x + width > 0 &&
    absoluteY < bottom &&
    absoluteY + height > top
  );
}

export class PixiSequenceReadTrackRenderer implements PixiLinearTrackRenderer<SequenceReadTrackData> {
  readonly type = SEQUENCE_READ_TRACK_TYPE;
  private readonly states = new WeakMap<Container, MountedState>();

  mount(_args: TrackMountArgs): Container {
    const container = new Container();
    const background = new Graphics();
    const marks = new Graphics();
    const curves = new Graphics();
    container.addChild(background, marks, curves);
    this.states.set(container, {
      container,
      background,
      marks,
      curves,
      texts: [],
      data: null,
      painted: null,
      diagnostics: {
        kind: null,
        paintCount: 0,
        channelStrokes: 0,
        curveSegments: 0,
        qualityBars: 0,
        baseGlyphs: 0,
        mutationColumns: 0,
        deletionColumns: 0,
        visibleStart: 0,
        visibleEnd: 0,
      },
    });
    return container;
  }

  paint(args: TrackPaintArgs<SequenceReadTrackData>): void {
    const state = this.states.get(args.container);
    if (!state) return;
    state.painted = null;
    const { background, marks, curves } = state;
    background.clear();
    marks.clear();
    curves.clear();
    for (const text of state.texts) text.visible = false;
    const data = args.data;
    state.data = data;
    if (!data) return;

    const width = args.viewportWidthPx;
    const height = args.layoutEntry.height;
    const dark = args.theme.mode === 'dark';
    const ink = dark ? 0xe2e8f0 : 0x334155;
    const muted = dark ? 0x94a3b8 : 0x64748b;
    const bounds = visibleColumns(
      args,
      data.kind === 'alignment'
        ? (data.queryColumns ?? data.alignedQuery).length
        : args.chromosome.length
    );
    background.rect(0, 0, width, height).fill({ color: dark ? 0x17212f : 0xf8fafc });
    background.rect(0, height - 1, width, 1).fill({ color: dark ? 0x334155 : 0xe2e8f0 });
    textAt(state, 0, data.label, 8, 3, muted, 11);

    const counts = {
      channelStrokes: 0,
      curveSegments: 0,
      qualityBars: 0,
      baseGlyphs: 0,
      mutationColumns: 0,
      deletionColumns: 0,
    };
    const visibility: ReadPaintVisibility = {
      traceVisible: false,
      qualityVisible: false,
      basesVisible: false,
    };
    if (data.kind === 'alignment') {
      this.paintAlignment(args, state, data, bounds, ink, counts);
    } else {
      this.paintSanger(args, state, data, bounds, ink, counts, visibility);
    }
    state.diagnostics = {
      kind: data.kind,
      paintCount: state.diagnostics.paintCount + 1,
      ...counts,
      visibleStart: bounds.start,
      visibleEnd: bounds.end,
    };
    if (
      data.kind === 'sanger' &&
      args.container.visible &&
      !args.layoutEntry.hidden &&
      width > 0 &&
      height > 0 &&
      args.containerTopPx < args.viewportHeightPx &&
      args.containerTopPx + height > 0
    ) {
      state.painted = {
        data,
        receipt: {
          paintCount: state.diagnostics.paintCount,
          ...visibility,
        },
      };
    }
  }

  private paintAlignment(
    args: TrackPaintArgs<SequenceReadTrackData>,
    state: MountedState,
    data: Extract<SequenceReadTrackData, { kind: 'alignment' }>,
    bounds: { start: number; end: number },
    ink: number,
    counts: { baseGlyphs: number; mutationColumns: number }
  ): void {
    const pixelsPerBase = args.pathMapper.pixelsPerBp;
    const columns = data.queryColumns ?? data.alignedQuery;
    if (pixelsPerBase < 7) {
      let start: number | null = null;
      for (let column = bounds.start; column <= bounds.end; column++) {
        if (column < bounds.end && columns[column] != null) {
          start ??= column;
        } else if (start !== null) {
          const left = Math.max(0, args.pathMapper.bpLeftX(start));
          const right = Math.min(args.viewportWidthPx, args.pathMapper.bpLeftX(column));
          if (right > left)
            state.marks.rect(left, 25, right - left, 6).fill({ color: 0x8b5cf6, alpha: 0.55 });
          start = null;
        }
      }
      return;
    }
    let textIndex = 1;
    for (let column = bounds.start; column < bounds.end; column += 1) {
      const query = columns[column];
      if (query == null) continue;
      const reference = data.alignedReference[column] ?? '-';
      const x = args.pathMapper.bpLeftX(column);
      if (x > args.viewportWidthPx || x + pixelsPerBase < 0) continue;
      const changed = query !== reference;
      if (changed) {
        state.marks
          .rect(x, 19, Math.max(1, pixelsPerBase), 19)
          .fill({ color: query === '-' || reference === '-' ? 0xf97316 : 0xef4444, alpha: 0.2 });
        counts.mutationColumns += 1;
      }
      textAt(
        state,
        textIndex++,
        query,
        x + Math.max(0, (pixelsPerBase - 8) / 2),
        20,
        changed ? 0xdc2626 : ink,
        13
      );
      counts.baseGlyphs += 1;
    }
  }

  private paintSanger(
    args: TrackPaintArgs<SequenceReadTrackData>,
    state: MountedState,
    data: Extract<SequenceReadTrackData, { kind: 'sanger' }>,
    bounds: { start: number; end: number },
    ink: number,
    counts: {
      channelStrokes: number;
      curveSegments: number;
      qualityBars: number;
      baseGlyphs: number;
      mutationColumns: number;
      deletionColumns: number;
    },
    visibility: ReadPaintVisibility
  ): void {
    const pixelsPerBase = args.pathMapper.pixelsPerBp;
    const cycle = data.cycleLength;
    const mutationSet = new Set(
      data.mutationColumns.map((column) => (cycle ? ((column % cycle) + cycle) % cycle : column))
    );
    const deletionSet = new Set(
      data.deletionColumns.map((column) => (cycle ? ((column % cycle) + cycle) % cycle : column))
    );
    let textIndex = 1;
    for (let column = bounds.start; pixelsPerBase >= 7 && column < bounds.end; column += 1) {
      const virtual = virtualColumn(column, data.baseToColumn, cycle);
      const peak = virtual === null ? -1 : calledBaseIndex(data.baseToColumn, virtual);
      const x = args.pathMapper.bpLeftX(column);
      if (x > args.viewportWidthPx || x + pixelsPerBase < 0) continue;
      if (mutationSet.has(column)) {
        state.marks
          .rect(x, 18, Math.max(1, pixelsPerBase), 36)
          .fill({ color: 0xef4444, alpha: 0.16 });
        counts.mutationColumns += 1;
      }
      if (deletionSet.has(column)) {
        state.marks
          .rect(x, 18, Math.max(1, pixelsPerBase), 36)
          .fill({ color: 0xf97316, alpha: 0.22 });
        counts.deletionColumns += 1;
      }
      if (peak < 0 || pixelsPerBase < 7) continue;
      const quality = data.quality?.[peak] ?? 0;
      if (quality > 0) {
        state.marks
          .rect(
            x + 1,
            30 - Math.min(24, quality * 0.55),
            Math.max(1, pixelsPerBase - 2),
            Math.min(24, quality * 0.55)
          )
          .fill({ color: quality < 20 ? 0xf59e0b : 0x22c55e, alpha: 0.25 });
        counts.qualityBars += 1;
        visibility.qualityVisible ||= primitiveIntersectsViewport(
          args,
          x + 1,
          30 - Math.min(24, quality * 0.55),
          Math.max(1, pixelsPerBase - 2),
          Math.min(24, quality * 0.55)
        );
      }
      const glyph = textAt(
        state,
        textIndex++,
        data.sequence[peak] ?? '',
        x + Math.max(0, (pixelsPerBase - 8) / 2),
        34,
        mutationSet.has(column) ? 0xdc2626 : ink,
        12
      );
      counts.baseGlyphs += 1;
      visibility.basesVisible ||= primitiveIntersectsViewport(
        args,
        glyph.x,
        glyph.y,
        glyph.width,
        glyph.height
      );
    }

    if (pixelsPerBase < 1.5) {
      const first = data.baseToColumn[0];
      const last = data.baseToColumn[data.baseToColumn.length - 1];
      if (first !== undefined && last !== undefined && !cycle) {
        const left = Math.max(0, args.pathMapper.bpLeftX(first));
        const right = Math.min(args.viewportWidthPx, args.pathMapper.bpLeftX(last + 1));
        if (right > left)
          state.curves.rect(left, 62, right - left, 12).fill({ color: 0x6366f1, alpha: 0.55 });
      }
      return;
    }

    const traceTop = 58;
    const traceHeight = Math.max(15, args.layoutEntry.height - traceTop - 8);
    const maxValue = Math.max(1, data.trace.maxValue);
    const origin = bounds.start;
    const originX = args.pathMapper.bpLeftX(origin);
    for (const channel of CHANNELS) {
      const values = data.trace.channels[channel];
      if (values.length === 0) continue;
      let active = false;
      let hasStroke = false;
      let previousX = 0;
      let previousY = 0;
      for (let x = 0; x < args.viewportWidthPx; x += 2) {
        const position = origin + (x - originX) / pixelsPerBase;
        const canonical = Math.floor(position);
        const fraction = position - canonical;
        const virtual = virtualColumn(canonical, data.baseToColumn, cycle);
        const sample = virtual === null ? null : traceSampleAt(data, virtual, fraction);
        if (sample === null || canonical < bounds.start || canonical >= bounds.end) {
          active = false;
          continue;
        }
        const y =
          traceTop + traceHeight * (1 - Math.min(1, sampleAmplitude(values, sample) / maxValue));
        if (active) {
          state.curves.lineTo(x, y);
          counts.curveSegments += 1;
          visibility.traceVisible ||= primitiveIntersectsViewport(
            args,
            previousX - 0.75,
            Math.min(previousY, y) - 0.75,
            x - previousX + 1.5,
            Math.abs(y - previousY) + 1.5
          );
        } else {
          state.curves.moveTo(x, y);
          active = true;
        }
        previousX = x;
        previousY = y;
        hasStroke = true;
      }
      if (hasStroke) {
        state.curves.stroke({ color: CHANNEL_COLORS[channel], width: 1.5 });
        counts.channelStrokes += 1;
      }
    }
  }

  hitTest(args: TrackHoverArgs): TrackHitResult | null {
    const column = Math.floor(
      args.viewportBpRange.start +
        (args.localX - args.pathMapper.bpLeftX(args.viewportBpRange.start)) /
          args.pathMapper.pixelsPerBp
    );
    if (column < 0 || column >= args.chromosome.length) return null;
    const data = this.states.get(args.container)?.data;
    if (data?.kind === 'alignment' && data.queryColumns && data.queryColumns[column] == null)
      return null;
    return {
      kind: 'select-bp-range',
      startBp: column,
      endBp: column + 1,
      chromosomeId: args.chromosome.id,
    };
  }

  getDiagnostics(container: Container): ReadTrackDiagnostics | null {
    return this.states.get(container)?.diagnostics ?? null;
  }

  getPaintReceipt(
    container: Container,
    expectedData: SequenceReadTrackData
  ): SequenceReadPaintReceipt | null {
    const painted = this.states.get(container)?.painted;
    if (!container.visible || !painted || painted.data !== expectedData) return null;
    return painted.receipt;
  }

  unmount(container: Container): void {
    this.states.delete(container);
    container.destroy({ children: true });
  }
}
