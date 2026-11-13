import type { SequenceDrawingContext } from './rendering/drawing-context';
import type { LinePositions, MutationMarker, WorkspaceEditorConfig } from './types';
import { CHANGE_COLORS } from './types';
import { getCanvasTheme } from './canvas-theme';

export function drawDiffSequenceHighlights(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  mutations: MutationMarker[],
  startX: number,
  config: WorkspaceEditorConfig,
  cachedMutationMap?: Map<number, MutationMarker>
): void {
  if (mutations.length === 0) return;

  const { charWidth, rowHeight } = config;

  const mutationMap =
    cachedMutationMap ??
    (() => {
      const map = new Map<number, MutationMarker>();
      for (const m of mutations) {
        const endCol = m.endColumn ?? m.column;
        for (let col = m.column; col <= endCol; col++) {
          map.set(col, m);
        }
      }
      return map;
    })();

  ctx.save();

  for (const lp of linePositions) {
    const { line, sequenceY } = lp;
    const lineLength = line.sequence.length;

    for (let i = 0; i < lineLength; i++) {
      const col = line.startPos + i;
      const mutation = mutationMap.get(col);

      if (mutation) {
        const cellX = startX + i * charWidth;
        const colorEntry = CHANGE_COLORS[mutation.type];
        ctx.fillStyle = typeof colorEntry === 'string' ? colorEntry : colorEntry.accent;
        ctx.globalAlpha = 0.25;
        ctx.fillRect(cellX, sequenceY, charWidth, rowHeight);
      }
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

export function drawMutationTrack(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  mutations: MutationMarker[],
  alignedQuery: string | undefined,
  startX: number,
  config: WorkspaceEditorConfig,
  cachedMutationMap?: Map<number, MutationMarker>
): void {
  if (!alignedQuery && mutations.length === 0) return;

  const { charWidth, rowHeight, fontSize, fontFamily } = config;

  const mutationMap =
    cachedMutationMap ??
    (() => {
      const map = new Map<number, MutationMarker>();
      for (const m of mutations) {
        const endCol = m.endColumn ?? m.column;
        for (let col = m.column; col <= endCol; col++) {
          map.set(col, m);
        }
      }
      return map;
    })();

  ctx.save();

  for (const lp of linePositions) {
    if (!lp.hasMutationTrack) continue;

    const { line, mutationTrackY } = lp;
    const lineLength = line.sequence.length;

    for (let i = 0; i < lineLength; i++) {
      const col = line.startPos + i;
      const mutation = mutationMap.get(col);

      if (mutation) {
        const cellX = startX + i * charWidth;
        const colorEntry = CHANGE_COLORS[mutation.type];
        ctx.fillStyle = typeof colorEntry === 'string' ? colorEntry : colorEntry.bg;
        ctx.fillRect(cellX, mutationTrackY, charWidth, rowHeight);
      }
    }

    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    for (let i = 0; i < lineLength; i++) {
      const col = line.startPos + i;
      const charX = startX + i * charWidth;

      let queryBase: string;
      if (alignedQuery && col < alignedQuery.length) {
        queryBase = alignedQuery[col];
      } else {
        const mutation = mutationMap.get(col);
        queryBase = mutation ? mutation.queryBase : line.sequence[i];
      }

      const mutation = mutationMap.get(col);
      ctx.fillStyle = mutation ? '#000' : getCanvasTheme().fgMuted;

      ctx.fillText(queryBase, charX + charWidth / 2, mutationTrackY + rowHeight / 2);
    }
  }

  ctx.restore();
}

export function getMutationTrackHeight(
  mutations: MutationMarker[],
  config: WorkspaceEditorConfig
): number {
  return mutations.length > 0 ? config.rowHeight : 0;
}

export function drawMutationTrack1D(
  ctx: SequenceDrawingContext,
  params: {
    bandY: number;
    bandHeight: number;
    visibleStart: number;
    visibleEnd: number;
    referenceSequence: string;
    alignedQuery: string | undefined;
    mutations: readonly MutationMarker[];
    originX: number;
    pxPerBase: number;
    fontSize: number;
    fontFamily: string;
    showText: boolean;
  }
): void {
  const {
    bandY,
    bandHeight,
    visibleStart,
    visibleEnd,
    referenceSequence,
    alignedQuery,
    mutations,
    originX,
    pxPerBase,
    fontSize,
    fontFamily,
    showText,
  } = params;
  if (!alignedQuery && mutations.length === 0) return;

  const mutationMap = new Map<number, MutationMarker>();
  for (const m of mutations) {
    const endCol = m.endColumn ?? m.column;
    for (let col = m.column; col <= endCol; col++) {
      mutationMap.set(col, m);
    }
  }

  ctx.save();

  for (let col = visibleStart; col < visibleEnd; col++) {
    const mutation = mutationMap.get(col);
    if (!mutation) continue;
    const colorEntry = CHANGE_COLORS[mutation.type];
    ctx.fillStyle = typeof colorEntry === 'string' ? colorEntry : colorEntry.bg;
    const cellX = originX + col * pxPerBase;
    ctx.fillRect(cellX, bandY, pxPerBase, bandHeight);
  }

  if (showText) {
    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const muted = getCanvasTheme().fgMuted;

    for (let col = visibleStart; col < visibleEnd; col++) {
      let queryBase: string;
      if (alignedQuery && col < alignedQuery.length) {
        queryBase = alignedQuery[col];
      } else {
        const mutation = mutationMap.get(col);
        queryBase = mutation ? mutation.queryBase : (referenceSequence[col] ?? '');
      }
      if (!queryBase) continue;
      const mutation = mutationMap.get(col);
      ctx.fillStyle = mutation ? '#000' : muted;
      const charX = originX + col * pxPerBase + pxPerBase / 2;
      ctx.fillText(queryBase, charX, bandY + bandHeight / 2);
    }
  }

  ctx.restore();
}
