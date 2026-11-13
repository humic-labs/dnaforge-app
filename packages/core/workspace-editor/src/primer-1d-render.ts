import type { CSSProperties } from 'react';
import type { PrimerDisplay, RenderedPrimerSegment, WorkspaceEditorConfig } from './types';
import { PRIMER_CANVAS_CONSTANTS } from './canvas-constants';
import { drawPrimers } from './canvas-drawing';
import { computeRenderedPrimerSegments } from './primer-render-geometry';
import { HORIZONTAL_PADDING_1D } from './layout-1d';

export interface Primer1DRenderInput {
  ctx: CanvasRenderingContext2D;
  primers: PrimerDisplay[];
  showPrimers: boolean;
  columnCount: number;
  pxPerBase: number;
  isCircular: boolean;
  sharedConfig: WorkspaceEditorConfig;
  forwardPrimerLaneCount: number;
  forwardPrimerBandTop: number;
  reversePrimerLaneCount: number;
  reversePrimerBandTop: number;
  scrollLeft: number;
  cssWidth: number;
  hoveredPrimerId?: string | null;
  suppressDrawing?: boolean;
}

export function render1DPrimers(input: Primer1DRenderInput): RenderedPrimerSegment[] {
  const {
    ctx,
    primers,
    showPrimers,
    columnCount,
    pxPerBase,
    isCircular,
    sharedConfig,
    forwardPrimerLaneCount,
    forwardPrimerBandTop,
    reversePrimerLaneCount,
    reversePrimerBandTop,
    scrollLeft,
    cssWidth,
    hoveredPrimerId,
    suppressDrawing,
  } = input;

  const rendered: RenderedPrimerSegment[] = [];
  if (!showPrimers || !primers || primers.length === 0) return rendered;

  const primerCfg = { ...sharedConfig, showPrimers: true };
  const sharedLabelPositions = new Map<number, Array<{ x: number; width: number }>>();
  const cycleOffsets1D: number[] = isCircular ? [-columnCount, 0, columnCount] : [0];
  const primerArrowPadding = sharedConfig.rowHeight * PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO;
  const hoveredId = hoveredPrimerId ?? null;

  for (const cycleOff of cycleOffsets1D) {
    const xOrigin = HORIZONTAL_PADDING_1D + cycleOff * pxPerBase;

    if (forwardPrimerLaneCount > 0) {
      if (!suppressDrawing) {
        drawPrimers(
          ctx,
          primers,
          0,
          columnCount,
          xOrigin,
          forwardPrimerBandTop + primerArrowPadding,
          primerCfg,
          'forward',
          'above',
          columnCount,
          sharedLabelPositions,
          cycleOff,
          undefined,
          null,
          hoveredId,
          null
        );
      }
      rendered.push(
        ...computeRenderedPrimerSegments({
          primers,
          direction: 'forward',
          lineStartPos: 0,
          lineEndPos: columnCount,
          originX: xOrigin,
          bandTop: forwardPrimerBandTop + primerArrowPadding,
          charWidth: pxPerBase,
          rowHeight: sharedConfig.rowHeight,
          sequenceLength: columnCount,
          cycleOffset: cycleOff,
          viewportLeftX: scrollLeft,
          viewportRightX: scrollLeft + cssWidth,
        })
      );
    }

    if (reversePrimerLaneCount > 0) {
      if (!suppressDrawing) {
        drawPrimers(
          ctx,
          primers,
          0,
          columnCount,
          xOrigin,
          reversePrimerBandTop,
          primerCfg,
          'reverse',
          'below',
          columnCount,
          sharedLabelPositions,
          cycleOff,
          undefined,
          null,
          hoveredId,
          null
        );
      }
      rendered.push(
        ...computeRenderedPrimerSegments({
          primers,
          direction: 'reverse',
          lineStartPos: 0,
          lineEndPos: columnCount,
          originX: xOrigin,
          bandTop: reversePrimerBandTop,
          charWidth: pxPerBase,
          rowHeight: sharedConfig.rowHeight,
          sequenceLength: columnCount,
          cycleOffset: cycleOff,
          viewportLeftX: scrollLeft,
          viewportRightX: scrollLeft + cssWidth,
        })
      );
    }
  }

  return rendered;
}

export type { CSSProperties };
