import type { SequenceDrawingContext } from './rendering/drawing-context';

import { getCanvasTheme } from './canvas-theme';

export interface AnnotationStateIdentity {
  type: string;
  name: string;
  start: number;
  end: number;

  direction?: number;

  segments?: { start: number; end: number }[];
}

export interface AnnotationRenderStateInput {
  hovered?: AnnotationStateIdentity | null;
  selected?: AnnotationStateIdentity | null;
}

export type AnnotationRenderState = 'default' | 'hovered' | 'selected';

export function annotationKeyOf(ann: AnnotationStateIdentity): string {
  return `${ann.type}|${ann.name}|${ann.start}|${ann.end}|${ann.direction ?? 0}`;
}

function sameIdentityNumber(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

function sameIdentityCoordinates(a: AnnotationStateIdentity, b: AnnotationStateIdentity): boolean {
  return (
    sameIdentityNumber(a.start, b.start) &&
    sameIdentityNumber(a.end, b.end) &&
    sameIdentityNumber(a.direction ?? 0, b.direction ?? 0)
  );
}

export function annotationRenderState(
  ann: AnnotationStateIdentity,
  input?: AnnotationRenderStateInput | null
): AnnotationRenderState {
  if (!input?.selected && !input?.hovered) return 'default';

  const selectedMatches = input.selected && sameIdentityCoordinates(ann, input.selected);
  const hoveredMatches = input.hovered && sameIdentityCoordinates(ann, input.hovered);
  if (!selectedMatches && !hoveredMatches) return 'default';
  const key = annotationKeyOf(ann);
  if (selectedMatches && input.selected && annotationKeyOf(input.selected) === key)
    return 'selected';
  if (hoveredMatches && input.hovered && annotationKeyOf(input.hovered) === key) return 'hovered';
  return 'default';
}

export interface AnnotationOutlineStrokeSpec {
  lineWidth: number;

  alpha: number;

  dash: number[];
}

export function annotationOutlineStrokeSpec(
  state: AnnotationRenderState
): AnnotationOutlineStrokeSpec | null {
  switch (state) {
    case 'selected':
      return { lineWidth: 2.5, alpha: 0.95, dash: [] };
    case 'hovered':
      return { lineWidth: 1.5, alpha: 0.55, dash: [] };
    case 'default':
    default:
      return null;
  }
}

export function paintAnnotationOutline(
  ctx: SequenceDrawingContext,
  state: AnnotationRenderState,
  strokeStyle: string,
  paintGeometry: (ctx: SequenceDrawingContext, lineWidth: number) => void
): void {
  const spec = annotationOutlineStrokeSpec(state);
  if (!spec) return;
  ctx.save();
  ctx.setLineDash(spec.dash);

  ctx.strokeStyle =
    state === 'hovered' ? hoverOutlineStroke(getCanvasTheme().isDark, spec.alpha) : strokeStyle;
  ctx.lineWidth = spec.lineWidth;
  paintGeometry(ctx, spec.lineWidth);
  ctx.restore();
}

function hoverOutlineStroke(isDark: boolean, alpha: number): string {
  return isDark ? `rgba(248, 250, 252, ${alpha})` : `rgba(17, 24, 39, ${alpha})`;
}
