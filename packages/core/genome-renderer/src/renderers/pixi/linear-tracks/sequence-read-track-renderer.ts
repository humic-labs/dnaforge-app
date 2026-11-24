import { Container, Graphics, Text } from 'pixi.js';
import type { BUILTIN_TRACK_TYPES } from '../../../tracks/builtins';
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
  | {
      readonly kind: 'alignment';
      readonly label: string;
      readonly alignedReference: string;
      readonly alignedQuery: string;
    }
  | {
      readonly kind: 'sanger';
      readonly label: string;
      readonly trace: TraceData;
      readonly gain?: number;
      readonly mixedCalls?: ReadonlyMap<number, string>;
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
  readonly gain: number;
  readonly mixedCalls: number;
  readonly coverageSegments: number;
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
  readonly labels: Map<string, { texts: Text[]; used: number }>;
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
const CHANNEL_COLORS = { A: 0x22c55e, C: 0x3b82f6, G: 0x0f172a, T: 0xef4444 };

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

function sampleAmplitude(samples: ReadonlyArray<number>, index: number): number {
  const left = Math.max(0, Math.min(samples.length - 1, Math.floor(index)));
  const right = Math.min(samples.length - 1, left + 1);
  const fraction = Math.max(0, Math.min(1, index - left));
  return Math.abs(samples[left] ?? 0) * (1 - fraction) + Math.abs(samples[right] ?? 0) * fraction;
}

function textAt(
  state: MountedState,
  value: string,
  x: number,
  y: number,
  color: number,
  size: number
): Text {
  const key = `${size}:${color}:${value}`;
  let pool = state.labels.get(key);
  if (!pool) {
    pool = { texts: [], used: 0 };
    state.labels.set(key, pool);
  }
  let label = pool.texts[pool.used++];
  if (!label) {
    label = new Text({
      text: value,
      style: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: size, fill: color },
    });
    pool.texts.push(label);
    state.container.addChild(label);
  }
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
  constructor(
    readonly type:
      | typeof SEQUENCE_READ_TRACK_TYPE
      | typeof BUILTIN_TRACK_TYPES.chromatogram = SEQUENCE_READ_TRACK_TYPE
  ) {}
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
      labels: new Map(),
      painted: null,
      diagnostics: {
        kind: null,
        gain: 1,
        mixedCalls: 0,
        coverageSegments: 0,
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
    for (const pool of state.labels.values()) pool.used = 0;
    const data = args.data;
    if (!data) {
      for (const pool of state.labels.values())
        for (const label of pool.texts) label.visible = false;
      return;
    }

    const width = args.viewportWidthPx;
    const height = args.layoutEntry.height;
    const dark = args.theme.mode === 'dark';
    const ink = dark ? 0xe2e8f0 : 0x334155;
    const muted = dark ? 0x94a3b8 : 0x64748b;
    const bounds = visibleColumns(
      args,
      data.kind === 'alignment' ? data.alignedQuery.length : args.chromosome.length
    );
    const backgroundColor = data.kind === 'sanger' ? 0xfafafa : 0xf8fafc;
    background.rect(0, 0, width, height).fill({ color: dark ? 0x17212f : backgroundColor });
    background.rect(0, height - 1, width, 1).fill({ color: dark ? 0x334155 : 0xe2e8f0 });
    textAt(state, data.label, 8, 3, muted, 11);

    const counts = {
      gain: data.kind === 'sanger' ? (data.gain ?? 1) : 1,
      mixedCalls: 0,
      coverageSegments: 0,
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
    for (const pool of state.labels.values()) {
      for (let i = pool.used; i < pool.texts.length; i++) pool.texts[i].visible = false;
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
    if (pixelsPerBase < 7) {
      state.marks.rect(0, 25, args.viewportWidthPx, 6).fill({ color: 0x8b5cf6, alpha: 0.55 });
      return;
    }
    for (let column = bounds.start; column < bounds.end; column += 1) {
      const query = data.alignedQuery[column] ?? '-';
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
      gain: number;
      mixedCalls: number;
      coverageSegments: number;
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
    const height = args.layoutEntry.height;
    const traceTop = Math.min(14, Math.floor(height * 0.11));
    const letterHeight = 14;
    const qualityHeight = 22;
    const lettersTop = height - Math.min(4, Math.floor(height * 0.03)) - letterHeight;
    const baseline = lettersTop - qualityHeight;
    const traceHeight = Math.max(0, baseline - traceTop - 1);
    const dark = args.theme.mode === 'dark';
    for (let column = bounds.start; pixelsPerBase >= 1.5 && column < bounds.end; column += 1) {
      const virtual = virtualColumn(column, data.baseToColumn, cycle);
      const peak = virtual === null ? -1 : calledBaseIndex(data.baseToColumn, virtual);
      const x = args.pathMapper.bpLeftX(column);
      if (x > args.viewportWidthPx || x + pixelsPerBase < 0) continue;
      if (mutationSet.has(column)) {
        state.marks
          .rect(x, traceTop, pixelsPerBase, lettersTop + letterHeight - traceTop)
          .fill({ color: 0xef4444, alpha: 0.16 });
        counts.mutationColumns += 1;
      }
      if (deletionSet.has(column)) {
        state.marks
          .rect(x, traceTop, pixelsPerBase, lettersTop + letterHeight - traceTop)
          .fill({ color: 0xf97316, alpha: 0.22 });
        counts.deletionColumns += 1;
      }
      if (peak < 0) continue;
      const quality = Math.max(0, Math.min(1, (data.quality?.[peak] ?? 0) / 40));
      if (quality > 0) {
        const barHeight = Math.max(1, qualityHeight * quality);
        state.marks
          .rect(x, lettersTop - barHeight, pixelsPerBase, barHeight)
          .fill({ color: dark ? 0xe2e8f0 : 0x0f172a, alpha: 0.05 + 0.13 * quality });
        counts.qualityBars += 1;
        visibility.qualityVisible ||= primitiveIntersectsViewport(
          args,
          x,
          lettersTop - barHeight,
          pixelsPerBase,
          barHeight
        );
      }
      if (pixelsPerBase >= 2) {
        state.marks
          .rect(x + pixelsPerBase - 1, baseline, 1, qualityHeight)
          .fill({ color: 0x94a3b8, alpha: 0.18 });
      }
      const mixed = data.mixedCalls?.get(peak);
      if (mixed) counts.mixedCalls += 1;
      if (pixelsPerBase < 4) continue;
      const glyph = textAt(
        state,
        mixed ?? data.sequence[peak] ?? '',
        x + (pixelsPerBase - 7) / 2,
        lettersTop,
        mutationSet.has(column) ? 0xdc2626 : mixed ? 0xb45309 : ink,
        11
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
      if (first === undefined || last === undefined) return;
      const drawSpan = (start: number, end: number) => {
        const left = Math.max(0, args.pathMapper.bpLeftX(start));
        const right = Math.min(args.viewportWidthPx, args.pathMapper.bpLeftX(end));
        if (right <= left) return;
        state.curves.rect(left, 62, right - left, 12).fill({ color: 0x6366f1, alpha: 0.55 });
        counts.coverageSegments += 1;
      };
      if (!cycle) {
        drawSpan(first, last + 1);
      } else if (last - first + 1 >= cycle) {
        drawSpan(0, cycle);
      } else {
        const start = ((first % cycle) + cycle) % cycle;
        const end = start + last - first + 1;
        drawSpan(start, Math.min(end, cycle));
        if (end > cycle) drawSpan(0, end - cycle);
      }
      return;
    }

    if (!traceHeight) return;
    state.marks.rect(0, baseline, args.viewportWidthPx, 1).fill({ color: 0x64748b, alpha: 0.25 });
    const maxValue = Math.max(1, data.trace.maxValue);
    const amplitudeScale = counts.gain / maxValue;
    const stepsPerHalf = Math.max(2, Math.min(8, Math.ceil(pixelsPerBase / 2)));
    const { baseToColumn, trace } = data;
    for (const channel of CHANNELS) {
      const values = trace.channels[channel];
      if (!values.length) continue;
      let previousX = 0;
      let previousY = 0;
      let previousPeak = -2;
      let hasStroke = false;
      for (let column = bounds.start; column < bounds.end; column++) {
        const virtual = virtualColumn(column, baseToColumn, cycle);
        const peak = virtual === null ? -1 : calledBaseIndex(baseToColumn, virtual);
        if (virtual === null || peak < 0) {
          previousPeak = -2;
          continue;
        }
        const center = trace.peakPositions[peak];
        const left =
          baseToColumn[peak - 1] === virtual - 1
            ? (trace.peakPositions[peak - 1] + center) / 2
            : center;
        const right =
          baseToColumn[peak + 1] === virtual + 1
            ? (trace.peakPositions[peak + 1] + center) / 2
            : center;
        const columnX = args.pathMapper.bpLeftX(column);
        const connected = peak === previousPeak + 1;
        for (let step = connected ? 1 : 0; step <= 2 * stepsPerHalf; step++) {
          const t = step / stepsPerHalf;
          const sample = t <= 1 ? left + (center - left) * t : center + (right - center) * (t - 1);
          const x = columnX + (t / 2) * pixelsPerBase;
          const y =
            traceTop +
            traceHeight * (1 - Math.min(1, sampleAmplitude(values, sample) * amplitudeScale));
          if (step === 0) {
            state.curves.moveTo(x, y);
          } else {
            state.curves.lineTo(x, y);
            counts.curveSegments++;
            const radius = 1.25 / 2;
            visibility.traceVisible ||= primitiveIntersectsViewport(
              args,
              previousX - radius,
              Math.min(previousY, y) - radius,
              x - previousX + 2 * radius,
              Math.abs(y - previousY) + 2 * radius
            );
          }
          previousX = x;
          previousY = y;
        }
        hasStroke = true;
        previousPeak = peak;
      }
      if (hasStroke) {
        const color = channel === 'G' && dark ? 0xcbd5e1 : CHANNEL_COLORS[channel];
        state.curves.stroke({ color, width: 1.25, join: 'miter' });
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
    return {
      kind: 'select-bp-range',
      trackId: args.layoutEntry.id,
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
