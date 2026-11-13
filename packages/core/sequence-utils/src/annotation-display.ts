import { getFeatureColor } from './colors';
import type { Annotation } from './types';

export const ANNOTATION_COLOR_MODES = ['auto-type', 'manual', 'imported'] as const;

export type AnnotationColorMode = (typeof ANNOTATION_COLOR_MODES)[number];

export const DEFAULT_ANNOTATION_COLOR_MODE: AnnotationColorMode = 'auto-type';

export type AnnotationColorSource =
  | 'auto-type'
  | 'manual'
  | 'imported'
  | 'render-override'
  | 'fallback';

export interface AnnotationColorFacts {
  manualColor?: string | null;
  importedColor?: string | null;
}

export interface AnnotationDisplayProfile {
  colorMode: AnnotationColorMode;
}

export interface AnnotationDisplayContext {
  profile?: Partial<AnnotationDisplayProfile> | null;
  colorFacts?: AnnotationColorFacts | null;
}

export interface AnnotationDisplayStyle {
  color: string;
  colorSource: AnnotationColorSource;
}

export interface AnnotationDisplayColorOption {
  id: AnnotationColorMode;
  label: string;
  description: string;
}

export const ANNOTATION_DISPLAY_COLOR_OPTIONS: readonly AnnotationDisplayColorOption[] = [
  {
    id: 'auto-type',
    label: 'Type',
    description: 'Color annotations by feature type.',
  },
  {
    id: 'manual',
    label: 'Manual',
    description: 'Use saved annotation colors, falling back to type colors.',
  },
  {
    id: 'imported',
    label: 'Imported',
    description: 'Use imported colors when present, falling back to type colors.',
  },
] as const;

const RENDER_OVERRIDE_COLORS = new Set(['#e5e7eb']);

export function normalizeAnnotationColorMode(input: unknown): AnnotationColorMode {
  return typeof input === 'string' && (ANNOTATION_COLOR_MODES as readonly string[]).includes(input)
    ? (input as AnnotationColorMode)
    : DEFAULT_ANNOTATION_COLOR_MODE;
}

function cleanColor(input: unknown): string | null {
  return typeof input === 'string' && input.trim().length > 0 ? input : null;
}

export function resolveAnnotationDisplayStyle(
  annotation: Pick<Annotation, 'type' | 'color'>,
  context: AnnotationDisplayContext = {}
): AnnotationDisplayStyle {
  const legacyColor = cleanColor(annotation.color);
  if (legacyColor && RENDER_OVERRIDE_COLORS.has(legacyColor.toLowerCase())) {
    return { color: legacyColor, colorSource: 'render-override' };
  }

  const colorMode = normalizeAnnotationColorMode(context.profile?.colorMode);
  const typeColor = getFeatureColor(annotation.type);
  const manualColor = cleanColor(context.colorFacts?.manualColor) ?? legacyColor;
  const importedColor = cleanColor(context.colorFacts?.importedColor);

  if (colorMode === 'manual' && manualColor) {
    return { color: manualColor, colorSource: 'manual' };
  }

  if (colorMode === 'imported') {
    const importedOrLegacy = importedColor ?? legacyColor;
    if (importedOrLegacy) return { color: importedOrLegacy, colorSource: 'imported' };
  }

  if (typeColor) return { color: typeColor, colorSource: 'auto-type' };
  if (manualColor) return { color: manualColor, colorSource: 'manual' };
  return { color: '#9CA3AF', colorSource: 'fallback' };
}

export function resolveAnnotationDisplayColor(
  annotation: Pick<Annotation, 'type' | 'color'>,
  context: AnnotationDisplayContext = {}
): string {
  return resolveAnnotationDisplayStyle(annotation, context).color;
}
