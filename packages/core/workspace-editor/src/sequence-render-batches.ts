import type { SequenceDrawingContext } from './rendering/drawing-context';
import { resolveGoldenGateJunctionVisual, type ColoredCutSite } from '@waypoint/sequence-utils';
import type {
  CoordinateSpace,
  DeletedRange,
  InsertedRange,
  LayoutSnapshot2D,
  PrimerDisplay,
  RenderedGGProductLabel,
  RulerDecoration,
  WorkspaceEditorConfig,
} from './types';
import type { AlignmentCodonInfo } from './translation-drawing';
import type { CodonMode } from './codon-rendering';
import { getVisibleRangeSegments, type LinePositions } from './canvas-drawing';
import { drawCutSites, type RenderedCutSite } from './restriction-enzymes/drawCutSites';
import { primerOverlapsLine } from './primer-layout';

export type SequenceLodKind = 'density' | 'feature' | 'detail';

export function sequenceLodKind(
  overviewLod: boolean,
  lodLevel: SequenceLodKind | undefined
): SequenceLodKind {
  if (overviewLod) return 'density';
  return lodLevel ?? 'detail';
}

export function sequenceAlignmentModeOptions(coordinateSpace: CoordinateSpace | undefined):
  | {
      alignedRef: string;
      alignedQuery: string;
    }
  | undefined {
  if (
    coordinateSpace?.mode === 'gapped' &&
    coordinateSpace.gappedSequence &&
    coordinateSpace.alignedQuery
  ) {
    return {
      alignedRef: coordinateSpace.gappedSequence,
      alignedQuery: coordinateSpace.alignedQuery,
    };
  }
  return undefined;
}

export function sequenceCodonMode(
  alignmentMode:
    | {
        alignedRef: string;
        alignedQuery: string;
      }
    | undefined,
  precomputedAlignmentCodons: Map<string, AlignmentCodonInfo[]> | undefined,
  insertedRanges: readonly InsertedRange[],
  deletedRanges: readonly DeletedRange[]
): CodonMode {
  if (alignmentMode) {
    return {
      type: 'alignment',
      alignedRef: alignmentMode.alignedRef,
      alignedQuery: alignmentMode.alignedQuery,
      precomputed: precomputedAlignmentCodons,
    };
  }
  if (insertedRanges.length > 0 || deletedRanges.length > 0) {
    return { type: 'draft', insertedRanges, deletedRanges };
  }
  return { type: 'normal' };
}

export function goldenGateScarLabels(
  primers: readonly PrimerDisplay[],
  sequenceLength: number
): RenderedGGProductLabel[] {
  if (!(sequenceLength > 0)) return [];
  return primers.flatMap((primer) => {
    const junction = resolveGoldenGateJunctionVisual(primer, sequenceLength);
    return junction
      ? [
          {
            primer,
            labelBounds: { x: 0, y: 0, width: 0, height: 0 },
            scarStart: junction.scarStart,
            scarEnd: junction.scarEnd,
            lineIndex: 0,
          },
        ]
      : [];
  });
}

export function buildLiveRulerDecorations(
  rulerDecorations: readonly RulerDecoration[] | undefined,
  insertedRanges: readonly InsertedRange[],
  deletedRanges: readonly DeletedRange[]
): RulerDecoration[] {
  const allDecorations: RulerDecoration[] = [];
  if (rulerDecorations && rulerDecorations.length > 0) {
    for (const deco of rulerDecorations) {
      let adjStart = deco.start;
      let adjEnd = deco.end;
      for (const ins of insertedRanges) {
        const insLen = ins.end - ins.start;
        if (ins.start <= adjStart) {
          adjStart += insLen;
          adjEnd += insLen;
        } else if (ins.start <= adjEnd) {
          adjEnd += insLen;
        }
      }
      for (const del of deletedRanges) {
        const delLen = del.end - del.start;
        if (del.start <= adjStart) {
          adjStart -= delLen;
          adjEnd -= delLen;
        }
      }
      allDecorations.push({ ...deco, start: Math.max(0, adjStart), end: Math.max(0, adjEnd) });
    }
  }
  for (const range of insertedRanges) {
    allDecorations.push({
      start: range.start,
      end: range.end - 1,
      color: 'hsl(152, 55%, 42%)',
      layer: 'edit',
      style: 'solid',
    });
  }
  for (const range of deletedRanges) {
    allDecorations.push({
      start: range.start,
      end: range.end - 1,
      color: 'hsl(0, 72%, 55%)',
      layer: 'edit',
      style: 'strikethrough',
    });
  }
  return allDecorations;
}

export function primerVisibleSegmentsOnLine(
  primer: Pick<PrimerDisplay, 'start' | 'end'>,
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): Array<{ start: number; end: number; charIndexStart: number }> {
  const primerSpansOrigin = primer.start > primer.end;
  const lineSpans = lineStartPos > lineEndPos;
  if (primerSpansOrigin && sequenceLength > 0) {
    return [
      ...getVisibleRangeSegments(
        primer.start,
        sequenceLength,
        lineStartPos,
        lineEndPos,
        sequenceLength
      ),
      ...getVisibleRangeSegments(0, primer.end, lineStartPos, lineEndPos, sequenceLength),
    ];
  }
  if (lineSpans && sequenceLength > 0) {
    return getVisibleRangeSegments(
      primer.start,
      primer.end,
      lineStartPos,
      lineEndPos,
      sequenceLength
    );
  }
  const visibleStart = Math.max(primer.start, lineStartPos);
  const visibleEnd = Math.min(primer.end, lineEndPos);
  if (visibleEnd > visibleStart) {
    return [
      {
        start: visibleStart,
        end: visibleEnd,
        charIndexStart: visibleStart - lineStartPos,
      },
    ];
  }
  return [];
}

export function collectRenderedPrimerHits(args: {
  primers: readonly PrimerDisplay[];
  lineStartPos: number;
  lineEndPos: number;
  sequenceLength: number;
  forwardPrimerY: number;
  reversePrimerY: number;
  fwdLaneMap: Map<string, number>;
  revLaneMap: Map<string, number>;
  hitLaneHeight: number;
  trackHeight: number;
  originX: number;
  charWidth: number;
}): Array<{
  primer: PrimerDisplay;
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const hits: Array<{
    primer: PrimerDisplay;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];
  for (const primer of args.primers) {
    if (!primerOverlapsLine(primer, args.lineStartPos, args.lineEndPos, args.sequenceLength)) {
      continue;
    }
    const baseY = primer.direction === 'forward' ? args.forwardPrimerY : args.reversePrimerY;
    const hitLane =
      (primer.direction === 'forward' ? args.fwdLaneMap : args.revLaneMap).get(primer.id) ?? 0;
    const primerYPos = baseY + hitLane * args.hitLaneHeight;
    const segments = primerVisibleSegmentsOnLine(
      primer,
      args.lineStartPos,
      args.lineEndPos,
      args.sequenceLength
    );
    for (const segment of segments) {
      if (segment.end <= segment.start) continue;
      hits.push({
        primer,
        x: args.originX + segment.charIndexStart * args.charWidth,
        y: primerYPos - 1,
        width: (segment.end - segment.start) * args.charWidth,
        height: args.trackHeight,
      });
    }
  }
  return hits;
}

export function paintSequenceCutSites(args: {
  ctx: SequenceDrawingContext;
  showCutSites: boolean;
  lodLevel: SequenceLodKind;
  scannedCutSites: ColoredCutSite[];
  cutSites: ColoredCutSite[];
  layout: LayoutSnapshot2D;
  config: WorkspaceEditorConfig;
  viewport: { scrollTop: number; height: number };
  hoveredCutSite: ColoredCutSite | null;
  linePositions: LinePositions[];
  hoveredEnzymeName: string | null;
  hoveredPositionInfo: { enzymeName: string; position: number } | null;
  primers: PrimerDisplay[];
  sharedLabelPositions: Map<number, Array<{ x: number; width: number }>>;
}): RenderedCutSite[] {
  if (!args.showCutSites || (args.lodLevel !== 'detail' && args.lodLevel !== 'feature')) {
    return [];
  }
  const hoveredPosition = args.hoveredPositionInfo
    ? {
        enzymeName: args.hoveredPositionInfo.enzymeName,
        position: args.hoveredPositionInfo.position,
      }
    : null;
  const rendered: RenderedCutSite[] = [];
  if (args.scannedCutSites.length > 0) {
    rendered.push(
      ...drawCutSites(
        args.ctx as CanvasRenderingContext2D,
        args.scannedCutSites,
        args.layout,
        args.config,
        args.viewport,
        args.hoveredCutSite,
        args.config.showReverseComplement,
        args.linePositions,
        false,
        args.hoveredEnzymeName,
        hoveredPosition,
        args.primers,
        args.sharedLabelPositions
      )
    );
  }
  if (args.cutSites.length > 0) {
    rendered.push(
      ...drawCutSites(
        args.ctx as CanvasRenderingContext2D,
        args.cutSites,
        args.layout,
        args.config,
        args.viewport,
        args.hoveredCutSite,
        args.config.showReverseComplement,
        args.linePositions,
        false,
        args.hoveredEnzymeName,
        hoveredPosition,
        args.primers,
        args.sharedLabelPositions
      )
    );
  }
  return rendered;
}
