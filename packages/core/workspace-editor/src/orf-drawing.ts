import type { SequenceDrawingContext } from './rendering/drawing-context';

import type { GeneticCodeSpec } from '@waypoint/sequence-utils';
import type { WorkspaceEditorConfig, ORFWithLane } from './types';
import { CHEVRON_WIDTH_RATIO, buildChevronStripOuterPath } from './rendering';
import { TRANSLATION_AA_HEIGHT_RATIO } from './layout-constants';
import { getCanvasTheme } from './canvas-theme';
import {
  computeCodonCells,
  fillCodonCells,
  drawCodonLetters,
  type CodonMode,
} from './codon-rendering';

export type OrfRenderState = 'default' | 'hovered' | 'selected' | 'candidate';

interface OrfStateStyle {
  fillColor: string;
  borderColor: string;
  textColor: string;

  outline?: {
    color: string;
    lineWidth: number;

    dash?: number[];
  };
}

export const ORF_LANE_GAP = 4;

function getOrfStyle(state: OrfRenderState, isDark: boolean): OrfStateStyle {
  const fillRgb = isDark ? '140, 140, 140' : '140, 140, 140';
  const borderRgb = isDark ? '130, 130, 130' : '140, 140, 140';
  const textRgb = isDark ? '170, 170, 170' : '120, 120, 120';

  const outlineRgb = isDark ? '140, 140, 140' : '90, 90, 90';

  switch (state) {
    case 'hovered':
      return {
        fillColor: `rgba(${fillRgb}, 0.18)`,
        borderColor: `rgba(${borderRgb}, 0.55)`,
        textColor: `rgba(${textRgb}, 0.85)`,
      };
    case 'selected':
      return {
        fillColor: `rgba(${fillRgb}, 0.18)`,
        borderColor: `rgba(${borderRgb}, 0.6)`,
        textColor: `rgba(${textRgb}, 0.95)`,
        outline: { color: `rgba(${outlineRgb}, 0.95)`, lineWidth: 2 },
      };
    case 'candidate':
      return {
        fillColor: `rgba(${fillRgb}, 0.14)`,
        borderColor: `rgba(${borderRgb}, 0.5)`,
        textColor: `rgba(${textRgb}, 0.85)`,
        outline: { color: `rgba(${outlineRgb}, 0.85)`, lineWidth: 1.5, dash: [5, 3] },
      };
    case 'default':
    default:
      return {
        fillColor: `rgba(${fillRgb}, 0.08)`,
        borderColor: `rgba(${borderRgb}, 0.25)`,
        textColor: `rgba(${textRgb}, 0.6)`,
      };
  }
}

export function drawORFTracks(
  ctx: SequenceDrawingContext,
  orfs: ORFWithLane[],
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  y: number,
  config: WorkspaceEditorConfig,
  fullSequence: string,
  sequenceLength: number,
  mode: CodonMode = { type: 'normal' },
  getRenderState?: (orf: ORFWithLane) => OrfRenderState,

  sequenceGeneticCode?: GeneticCodeSpec
): boolean {
  if (orfs.length === 0) return false;
  let drawn = false;

  const { charWidth, rowHeight, fontFamily, fontSize } = config;
  const aaTrackHeight = rowHeight * TRANSLATION_AA_HEIGHT_RATIO;
  const laneStep = aaTrackHeight + ORF_LANE_GAP;
  const chevronDepth = Math.round(aaTrackHeight * CHEVRON_WIDTH_RATIO);
  const isDark = getCanvasTheme().isDark;

  ctx.save();

  for (const orf of orfs) {
    const state = getRenderState?.(orf) ?? 'default';
    const style = getOrfStyle(state, isDark);

    const direction = (orf.strand === '+' ? 1 : -1) as 1 | -1;
    const laneY = y + orf.lane * laneStep;

    const renderData = computeCodonCells(
      { start: orf.start, end: orf.end, direction },
      lineStartPos,
      lineEndPos,
      x,
      charWidth,
      fullSequence,
      sequenceLength,
      mode,
      sequenceGeneticCode
    );

    if (renderData.length === 0) continue;

    fillCodonCells(
      ctx,
      renderData,
      laneY,
      aaTrackHeight,
      chevronDepth,
      direction,
      style.fillColor,
      style.borderColor,
      1.0,
      1.0
    );
    drawn = drawn || (aaTrackHeight > 0 && renderData.some((cell) => cell.visibleWidth > 0));

    drawCodonLetters(
      ctx,
      renderData,
      laneY,
      aaTrackHeight,
      chevronDepth,
      direction,
      style.textColor,
      fontSize,
      fontFamily
    );

    if (style.outline) {
      const cellsByX =
        direction === -1 ? [...renderData].sort((a, b) => a.codonX - b.codonX) : renderData;
      ctx.save();
      ctx.strokeStyle = style.outline.color;
      ctx.lineWidth = style.outline.lineWidth;
      ctx.setLineDash(style.outline.dash ?? []);
      buildChevronStripOuterPath(ctx, cellsByX, laneY, aaTrackHeight, chevronDepth, direction);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.restore();
  return drawn;
}

export interface OrfStateIdentity {
  start: number;
  end: number;
  strand: '+' | '-';
}

export interface OrfRenderStateInput {
  hovered?: OrfStateIdentity | null;
  selected?: OrfStateIdentity | null;
  candidate?: OrfStateIdentity | null;
}

export function makeOrfRenderStateFn(
  input: OrfRenderStateInput
): (orf: ORFWithLane) => OrfRenderState {
  const matches = (orf: ORFWithLane, target?: OrfStateIdentity | null): boolean => {
    if (!target) return false;
    return orf.start === target.start && orf.end === target.end && orf.strand === target.strand;
  };
  return (orf) => {
    if (matches(orf, input.candidate)) return 'candidate';
    if (matches(orf, input.selected)) return 'selected';
    if (matches(orf, input.hovered)) return 'hovered';
    return 'default';
  };
}

export function drawORFOverviewBars(
  ctx: SequenceDrawingContext,
  orfs: ORFWithLane[],
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  y: number,
  config: WorkspaceEditorConfig,
  fullSequence: string,
  sequenceLength: number,
  mode: CodonMode = { type: 'normal' },
  getRenderState?: (orf: ORFWithLane) => OrfRenderState,
  sequenceGeneticCode?: GeneticCodeSpec
): boolean {
  if (orfs.length === 0) return false;
  let drawn = false;

  const { charWidth, rowHeight } = config;
  const aaTrackHeight = rowHeight * TRANSLATION_AA_HEIGHT_RATIO;
  const laneStep = aaTrackHeight + ORF_LANE_GAP;

  const barHeight = 4;

  ctx.save();
  for (const orf of orfs) {
    const state = getRenderState?.(orf) ?? 'default';

    const overview =
      state === 'candidate'
        ? { rgb: '85, 85, 85', alpha: 0.5 }
        : state === 'selected'
          ? { rgb: '75, 85, 99', alpha: 0.58 }
          : state === 'hovered'
            ? { rgb: '111, 111, 111', alpha: 0.42 }
            : { rgb: '140, 140, 140', alpha: 0.22 };

    const direction = (orf.strand === '+' ? 1 : -1) as 1 | -1;
    const laneY = y + orf.lane * laneStep;
    const barY = laneY + (aaTrackHeight - barHeight) / 2;

    const renderData = computeCodonCells(
      { start: orf.start, end: orf.end, direction },
      lineStartPos,
      lineEndPos,
      x,
      charWidth,
      fullSequence,
      sequenceLength,
      mode,
      sequenceGeneticCode
    );
    if (renderData.length === 0) continue;

    let minX = Infinity;
    let maxX = -Infinity;
    for (const cell of renderData) {
      if (cell.codonX < minX) minX = cell.codonX;
      const cellRight = cell.codonX + cell.visibleWidth;
      if (cellRight > maxX) maxX = cellRight;
    }
    if (!Number.isFinite(minX) || maxX <= minX) continue;

    const cy = barY + barHeight / 2;
    const span = maxX - minX;
    ctx.fillStyle = `rgba(${overview.rgb}, ${overview.alpha})`;
    ctx.fillRect(minX, barY, span, barHeight);
    drawn = true;

    const triHalfH = Math.min(barHeight * 0.85, 7);
    const triLen = triHalfH * 0.7;
    if (triHalfH > 0.5 && span > triLen * 2 + 2) {
      const cxMid = (minX + maxX) / 2;
      const apexX = cxMid + direction * triLen;
      const baseX = cxMid - direction * triLen;
      ctx.beginPath();
      ctx.moveTo(baseX, cy - triHalfH);
      ctx.lineTo(apexX, cy);
      ctx.lineTo(baseX, cy + triHalfH);
      ctx.closePath();

      ctx.fillStyle = 'rgba(150, 150, 150, 0.65)';
      ctx.fill();
    }
  }
  ctx.restore();
  return drawn;
}

export function calculateOrfHeight(laneCount: number, rowHeight: number): number {
  if (laneCount <= 0) return 0;
  const aaTrackHeight = rowHeight * TRANSLATION_AA_HEIGHT_RATIO;
  return laneCount * aaTrackHeight + (laneCount - 1) * ORF_LANE_GAP;
}
