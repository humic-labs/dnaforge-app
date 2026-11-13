import type { Annotation } from '@waypoint/sequence-utils';

const PLANNOTATE_DRAFT_SOURCE = 'pLannotate-draft';
const AUTHORED_DRAFT_SOURCES = new Set(['orf-candidate-cds', 'annotation-draft']);

export const ANNOTATION_DRAFT_OUTLINE_DASH = [2, 2] as const;
export const ANNOTATION_DRAFT_OUTLINE_ALPHA = 0.95;
export const ANNOTATION_DRAFT_OUTLINE_WIDTH = 1.75;
export const ANNOTATION_DRAFT_THIN_OUTLINE_WIDTH = 1.5;
export const ANNOTATION_DRAFT_FILL_ALPHA = 1.0;
export const PLANNOTATE_UNCHECKED_CONNECTOR_ALPHA_MULTIPLIER = 0.7;

export type AnnotationDraftRenderKind =
  | 'none'
  | 'authored'
  | 'plannotate-accepted'
  | 'plannotate-unchecked';

export interface AnnotationDraftRenderStyle {
  kind: AnnotationDraftRenderKind;
  hasDottedOutline: boolean;
  isHollow: boolean;
  fillAlpha: number;
  connectorAlphaMultiplier: number;
  suppressInteractionOutline: boolean;
}

export const DEFAULT_ANNOTATION_DRAFT_RENDER_STYLE: AnnotationDraftRenderStyle = {
  kind: 'none',
  hasDottedOutline: false,
  isHollow: false,
  fillAlpha: 1.0,
  connectorAlphaMultiplier: 1.0,
  suppressInteractionOutline: false,
};

export function resolveAnnotationDraftStyle(ann: Annotation): AnnotationDraftRenderStyle {
  const sources = ann.qualifiers?.source ?? [];
  if (sources.includes(PLANNOTATE_DRAFT_SOURCE)) {
    const accepted = ann.qualifiers?.status?.[0] === 'accepted';
    return {
      kind: accepted ? 'plannotate-accepted' : 'plannotate-unchecked',
      hasDottedOutline: true,
      isHollow: !accepted,
      fillAlpha: accepted ? ANNOTATION_DRAFT_FILL_ALPHA : 1.0,
      connectorAlphaMultiplier: accepted ? 1.0 : PLANNOTATE_UNCHECKED_CONNECTOR_ALPHA_MULTIPLIER,
      suppressInteractionOutline: true,
    };
  }

  if (sources.some((source) => AUTHORED_DRAFT_SOURCES.has(source))) {
    return {
      kind: 'authored',
      hasDottedOutline: true,
      isHollow: false,
      fillAlpha: ANNOTATION_DRAFT_FILL_ALPHA,
      connectorAlphaMultiplier: 1.0,
      suppressInteractionOutline: true,
    };
  }

  return DEFAULT_ANNOTATION_DRAFT_RENDER_STYLE;
}
