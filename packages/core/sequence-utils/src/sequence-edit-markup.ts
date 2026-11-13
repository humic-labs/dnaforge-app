export const SEQUENCE_EDIT_MARKUP = {
  deletion: {
    text: { color: 0xf44336, alpha: 0.6 },
    background: { color: 0xf44336, alpha: 0.15 },
    strike: { color: 0xf44336, alpha: 0.8, width: 1.5 },
  },
  insertion: {
    text: { color: 0x22c55e, alpha: 1 },
    background: { color: 0x22c55e, alpha: 0.15 },
  },
  substitution: {
    text: { color: 0xe09c07, alpha: 1 },
    background: { color: 0xffc800, alpha: 0.15 },
  },
} as const;

export interface SequenceEditMarkupStyle {
  readonly text: { readonly color: number; readonly alpha: number };
  readonly background: { readonly color: number; readonly alpha: number };
  readonly strike?: { readonly color: number; readonly alpha: number; readonly width: number };
}

export function sequenceEditMarkupStyle(
  kind: keyof typeof SEQUENCE_EDIT_MARKUP,
  color?: number
): SequenceEditMarkupStyle {
  const style = SEQUENCE_EDIT_MARKUP[kind];
  if (color === undefined) return style;
  return {
    text: { ...style.text, color },
    background: { ...style.background, color },
    ...(kind === 'deletion' ? { strike: { ...SEQUENCE_EDIT_MARKUP.deletion.strike, color } } : {}),
  };
}

export function sequenceEditMarkupCss(paint: {
  readonly color: number;
  readonly alpha: number;
}): string {
  if (paint.alpha === 1) return `#${paint.color.toString(16).padStart(6, '0')}`;
  return `rgba(${(paint.color >> 16) & 255}, ${(paint.color >> 8) & 255}, ${paint.color & 255}, ${paint.alpha})`;
}

export const CDS_MUTATION_MARKUP = {
  inserted: {
    background: { color: 0x4caf50, alpha: 0.5 },
    outline: { color: 0x388e3c, alpha: 0.9, width: 1 },
  },
  frameshifted: {
    background: { color: 0xff9800, alpha: 0.55 },
    outline: { color: 0xe67e00, alpha: 0.9, width: 2 },
  },
  deleted: {
    background: { color: 0xf44336, alpha: 0.35 },
    outline: { color: 0xf44336, alpha: 0.9, width: 1 },
  },
  substitution: {
    background: { color: SEQUENCE_EDIT_MARKUP.substitution.background.color, alpha: 1 },
    outline: { color: SEQUENCE_EDIT_MARKUP.substitution.text.color, alpha: 0.95, width: 1.5 },
  },
  synonymous: {
    outline: { color: SEQUENCE_EDIT_MARKUP.substitution.text.color, alpha: 0.65, width: 1 },
  },
  prematureStop: {
    background: { color: 0xf44336, alpha: 1 },
    outline: { color: 0xcc0000, alpha: 0.95, width: 2 },
  },
} as const;
