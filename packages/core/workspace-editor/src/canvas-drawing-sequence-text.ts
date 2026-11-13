import type { SequenceDrawingContext } from './rendering/drawing-context';
import { repeatedTextPainter } from './rendering/repeated-text';

import type {
  LinePositions,
  WorkspaceEditorConfig,
  InsertedRange,
  DeletedRange,
  SubstitutedRange,
} from './types';
import { getCanvasTheme } from './canvas-theme';
import {
  SEQUENCE_EDIT_MARKUP,
  sequenceEditMarkupCss,
} from '@waypoint/sequence-utils/sequence-edit-markup';

export function drawSequenceText(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  x: number,
  config: WorkspaceEditorConfig,
  deletedRanges?: DeletedRange[],
  insertedRanges?: InsertedRange[],
  substitutedRanges?: SubstitutedRange[]
): void {
  ctx.font = `${config.fontSize}px ${config.fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  const theme = getCanvasTheme();
  const defaultColor = theme.fg;
  const deleteColor = sequenceEditMarkupCss(SEQUENCE_EDIT_MARKUP.deletion.text);
  const insertColor = sequenceEditMarkupCss(SEQUENCE_EDIT_MARKUP.insertion.text);
  const substituteColor = sequenceEditMarkupCss(SEQUENCE_EDIT_MARKUP.substitution.text);

  const deleteBg = sequenceEditMarkupCss(SEQUENCE_EDIT_MARKUP.deletion.background);
  const insertBg = sequenceEditMarkupCss(SEQUENCE_EDIT_MARKUP.insertion.background);
  const substituteBg = sequenceEditMarkupCss(SEQUENCE_EDIT_MARKUP.substitution.background);

  const textCtx = ctx as CanvasRenderingContext2D & {
    letterSpacing?: string;
    fontKerning?: string;
  };
  const canUseLineTextFastPath = typeof textCtx.letterSpacing === 'string';

  let deletedPositions: Set<number> | null = null;
  let insertedPositions: Set<number> | null = null;
  let substitutedPositions: Set<number> | null = null;

  if (deletedRanges && deletedRanges.length > 0) {
    deletedPositions = new Set<number>();
    for (const r of deletedRanges) {
      for (let p = r.start; p < r.end; p++) deletedPositions.add(p);
    }
  }
  if (insertedRanges && insertedRanges.length > 0) {
    insertedPositions = new Set<number>();
    for (const r of insertedRanges) {
      for (let p = r.start; p < r.end; p++) insertedPositions.add(p);
    }
  }
  if (substitutedRanges && substitutedRanges.length > 0) {
    substitutedPositions = new Set<number>();
    for (const r of substitutedRanges) {
      for (let p = r.start; p < r.end; p++) substitutedPositions.add(p);
    }
  }

  const hasEdits = deletedPositions || insertedPositions || substitutedPositions;
  let glyphAdvance = 0;
  if (canUseLineTextFastPath && !hasEdits) {
    glyphAdvance = ctx.measureText('A').width;
  }

  for (const { line, sequenceY } of linePositions) {
    const centerY = sequenceY + config.rowHeight / 2;
    const paintLetter = repeatedTextPainter(ctx, centerY);
    let strikeStart = -1;

    let currentColor = defaultColor;
    ctx.fillStyle = currentColor;

    if (canUseLineTextFastPath && !hasEdits && line.sequence.length > 0) {
      const prevLetterSpacing = textCtx.letterSpacing;
      const prevFontKerning = textCtx.fontKerning;
      const prevTextAlign: CanvasTextAlign = ctx.textAlign;
      textCtx.letterSpacing = `${config.charWidth - glyphAdvance}px`;
      if (typeof prevFontKerning === 'string') {
        textCtx.fontKerning = 'none';
      }
      ctx.textAlign = 'left';
      ctx.fillText(line.sequence, x, centerY);
      ctx.textAlign = prevTextAlign;
      textCtx.letterSpacing = prevLetterSpacing;
      if (typeof prevFontKerning === 'string') {
        textCtx.fontKerning = prevFontKerning;
      }
      continue;
    }

    for (let i = 0; i < line.sequence.length; i++) {
      const absPos = line.startPos + i;
      const charX = x + i * config.charWidth;
      const charCenterX = charX + config.charWidth / 2;

      const isDeleted = deletedPositions?.has(absPos);
      const isInserted = insertedPositions?.has(absPos);
      const isSubstituted = substitutedPositions?.has(absPos);

      const hasEditBg = isDeleted || isInserted || isSubstituted;
      if (hasEditBg) {
        const bg = isDeleted ? deleteBg : isSubstituted ? substituteBg : insertBg;
        ctx.fillStyle = bg;
        ctx.fillRect(charX, sequenceY, config.charWidth, config.rowHeight);
      }

      let charColor = defaultColor;
      if (isDeleted) charColor = deleteColor;
      else if (isSubstituted) charColor = substituteColor;
      else if (isInserted) charColor = insertColor;

      if (charColor !== currentColor || hasEditBg) {
        currentColor = charColor;
        ctx.fillStyle = currentColor;
      }

      paintLetter(line.sequence[i], charCenterX);

      if (isDeleted) {
        if (strikeStart < 0) strikeStart = charX;
      } else if (strikeStart >= 0) {
        ctx.strokeStyle = sequenceEditMarkupCss(SEQUENCE_EDIT_MARKUP.deletion.strike);
        ctx.lineWidth = SEQUENCE_EDIT_MARKUP.deletion.strike.width;
        ctx.beginPath();
        ctx.moveTo(strikeStart, centerY);
        ctx.lineTo(charX, centerY);
        ctx.stroke();
        strikeStart = -1;
      }
    }

    if (strikeStart >= 0) {
      const endX = x + line.sequence.length * config.charWidth;
      ctx.strokeStyle = sequenceEditMarkupCss(SEQUENCE_EDIT_MARKUP.deletion.strike);
      ctx.lineWidth = SEQUENCE_EDIT_MARKUP.deletion.strike.width;
      ctx.beginPath();
      ctx.moveTo(strikeStart, centerY);
      ctx.lineTo(endX, centerY);
      ctx.stroke();
    }

    ctx.fillStyle = defaultColor;
    currentColor = defaultColor;
  }
}

export function drawComplementText(
  ctx: SequenceDrawingContext,
  linePositions: LinePositions[],
  x: number,
  config: WorkspaceEditorConfig,
  deletedRanges?: DeletedRange[],
  insertedRanges?: InsertedRange[],
  substitutedRanges?: SubstitutedRange[]
): void {
  if (!config.showReverseComplement) return;

  ctx.font = `${config.fontSize}px ${config.fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  const theme = getCanvasTheme();
  const defaultColor = theme.fgMuted;

  const deleteColor = 'rgba(244, 67, 54, 0.4)';
  const insertColor = 'rgba(34, 197, 94, 0.4)';
  const substituteColor = 'rgba(217, 119, 6, 0.4)';

  const textCtx = ctx as CanvasRenderingContext2D & {
    letterSpacing?: string;
    fontKerning?: string;
  };
  const canUseLineTextFastPath = typeof textCtx.letterSpacing === 'string';

  let deletedPositions: Set<number> | null = null;
  let insertedPositions: Set<number> | null = null;
  let substitutedPositions: Set<number> | null = null;

  if (deletedRanges && deletedRanges.length > 0) {
    deletedPositions = new Set<number>();
    for (const r of deletedRanges) {
      for (let p = r.start; p < r.end; p++) deletedPositions.add(p);
    }
  }
  if (insertedRanges && insertedRanges.length > 0) {
    insertedPositions = new Set<number>();
    for (const r of insertedRanges) {
      for (let p = r.start; p < r.end; p++) insertedPositions.add(p);
    }
  }
  if (substitutedRanges && substitutedRanges.length > 0) {
    substitutedPositions = new Set<number>();
    for (const r of substitutedRanges) {
      for (let p = r.start; p < r.end; p++) substitutedPositions.add(p);
    }
  }

  const hasEdits = deletedPositions || insertedPositions || substitutedPositions;
  let glyphAdvance = 0;
  if (canUseLineTextFastPath && !hasEdits) {
    glyphAdvance = ctx.measureText('A').width;
  }

  for (const { line, complementY } of linePositions) {
    const centerY = complementY + config.rowHeight / 2;
    const paintLetter = repeatedTextPainter(ctx, centerY);
    let currentColor = defaultColor;
    ctx.fillStyle = currentColor;
    let strikeStart = -1;

    if (canUseLineTextFastPath && !hasEdits && line.complementSequence.length > 0) {
      const prevLetterSpacing = textCtx.letterSpacing;
      const prevFontKerning = textCtx.fontKerning;
      const prevTextAlign: CanvasTextAlign = ctx.textAlign;
      textCtx.letterSpacing = `${config.charWidth - glyphAdvance}px`;
      if (typeof prevFontKerning === 'string') {
        textCtx.fontKerning = 'none';
      }
      ctx.textAlign = 'left';
      ctx.fillText(line.complementSequence, x, centerY);
      ctx.textAlign = prevTextAlign;
      textCtx.letterSpacing = prevLetterSpacing;
      if (typeof prevFontKerning === 'string') {
        textCtx.fontKerning = prevFontKerning;
      }
      continue;
    }

    for (let i = 0; i < line.complementSequence.length; i++) {
      const absPos = line.startPos + i;
      const charX = x + i * config.charWidth;

      if (hasEdits) {
        const isDeleted = deletedPositions?.has(absPos);
        const isInserted = insertedPositions?.has(absPos);
        const isSubstituted = substitutedPositions?.has(absPos);

        let charColor = defaultColor;
        if (isDeleted) charColor = deleteColor;
        else if (isSubstituted) charColor = substituteColor;
        else if (isInserted) charColor = insertColor;

        if (charColor !== currentColor) {
          currentColor = charColor;
          ctx.fillStyle = currentColor;
        }

        paintLetter(line.complementSequence[i], charX + config.charWidth / 2);

        if (isDeleted) {
          if (strikeStart < 0) strikeStart = charX;
        } else if (strikeStart >= 0) {
          ctx.strokeStyle = 'rgba(244, 67, 54, 0.4)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(strikeStart, centerY);
          ctx.lineTo(charX, centerY);
          ctx.stroke();
          strikeStart = -1;
        }
      } else {
        paintLetter(line.complementSequence[i], charX + config.charWidth / 2);
      }
    }

    if (strikeStart >= 0) {
      const endX = x + line.complementSequence.length * config.charWidth;
      ctx.strokeStyle = 'rgba(244, 67, 54, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(strikeStart, centerY);
      ctx.lineTo(endX, centerY);
      ctx.stroke();
    }

    ctx.fillStyle = defaultColor;
    currentColor = defaultColor;
  }
}
