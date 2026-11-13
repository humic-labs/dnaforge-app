import type { Annotation } from '@waypoint/sequence-utils';
import type { SequenceDrawingContext } from './rendering/drawing-context';
import { TRANSLATION_PILL_HEIGHT, TRANSLATION_LABEL_FONT_SIZE } from './layout-constants';
import { fitCanvasLabel } from './canvas-drawing';
import { getCanvasTheme } from './canvas-theme';
import { isLightColor } from './canvas-colors';
import {
  resolveAnnotationDraftStyle,
  ANNOTATION_DRAFT_OUTLINE_DASH,
  ANNOTATION_DRAFT_THIN_OUTLINE_WIDTH,
  ANNOTATION_DRAFT_OUTLINE_ALPHA,
} from './annotation-draft-style';
import {
  annotationRenderState,
  paintAnnotationOutline,
  type AnnotationRenderStateInput,
} from './annotation-render-state';
import { getEmphasizedColor } from './utils/color-utils';

export interface CdsChipPart {
  text: string;
  x: number;
  width: number;
}

export function paintCdsChipText(
  ctx: SequenceDrawingContext,
  parts: readonly CdsChipPart[],
  y: number,
  annotation: Annotation,
  color: string,
  fontFamily: string
): void {
  const draft = resolveAnnotationDraftStyle(annotation);
  const theme = getCanvasTheme();
  ctx.save();
  ctx.font = `500 ${TRANSLATION_LABEL_FONT_SIZE}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = draft.isHollow
    ? color
    : isLightColor(color)
      ? theme.fgMuted
      : 'rgba(255,255,255,0.85)';
  const opacity = ctx.globalAlpha;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const text = fitCanvasLabel(ctx, part.text, Math.max(0, part.width - 6));
    if (text) ctx.fillText(text, part.x + part.width / 2, y + TRANSLATION_PILL_HEIGHT / 2);
    if (i) {
      ctx.globalAlpha = opacity * 0.3;
      ctx.fillRect(part.x - 2, y + 2, 1, TRANSLATION_PILL_HEIGHT - 4);
      ctx.globalAlpha = opacity;
    }
  }
  ctx.restore();
}

export function paintCdsCompoundChip(
  ctx: SequenceDrawingContext,
  parts: readonly CdsChipPart[],
  y: number,
  annotation: Annotation,
  color: string,
  fontFamily: string,
  renderStateInput?: AnnotationRenderStateInput,
  opacity = 1,
  suppressInteractionOutline = false,
  radii: number | [number, number, number, number] = 3
): void {
  if (!parts.length) return;
  const left = parts[0].x,
    right = parts[parts.length - 1].x + parts[parts.length - 1].width;
  if (right <= left) return;
  const draft = resolveAnnotationDraftStyle(annotation);
  const theme = getCanvasTheme();
  const state = draft.suppressInteractionOutline
    ? 'default'
    : annotationRenderState(annotation, renderStateInput);
  const path = () => {
    ctx.beginPath();
    ctx.roundRect(left, y, right - left, TRANSLATION_PILL_HEIGHT, radii);
  };
  ctx.save();
  ctx.globalAlpha = opacity;
  path();
  if (draft.isHollow) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.globalAlpha = draft.fillAlpha * opacity;
    ctx.fill();
    ctx.globalAlpha = opacity;
  }
  if (!suppressInteractionOutline)
    paintAnnotationOutline(ctx, state, getEmphasizedColor(color, theme.isDark), (c) => c.stroke());
  if (draft.hasDottedOutline) {
    ctx.save();
    ctx.setLineDash([...ANNOTATION_DRAFT_OUTLINE_DASH]);
    ctx.strokeStyle = color;
    ctx.lineWidth = ANNOTATION_DRAFT_THIN_OUTLINE_WIDTH;
    ctx.globalAlpha = ANNOTATION_DRAFT_OUTLINE_ALPHA * opacity;
    path();
    ctx.stroke();
    ctx.restore();
  }
  paintCdsChipText(ctx, parts, y, annotation, color, fontFamily);
  ctx.restore();
}
