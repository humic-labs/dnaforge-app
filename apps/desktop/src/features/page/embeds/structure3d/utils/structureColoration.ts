import type { CSSProperties } from 'react';
import type { StructureColoration } from '../types';

export const UNREPRESENTED_COLORATION: StructureColoration = { kind: 'unrepresented' };
export const NEUTRAL_CHAIN_COLOR = 'hsl(var(--color-fg))';

export function structureResidueColorKey(
  unit: { id: string | number; model?: { id?: string } },
  residueIndex: number,
  structureRef?: string
): string {
  if (structureRef !== undefined)
    return JSON.stringify([structureRef, unit.model?.id ?? '', unit.id, residueIndex]);
  return `${unit.model?.id ?? ''}:${unit.id}:${residueIndex}`;
}

export function colorationFromColors(colors: Iterable<number>): StructureColoration {
  const distinct = [...new Set(colors)].sort((a, b) => a - b);
  if (distinct.length === 0) return UNREPRESENTED_COLORATION;
  if (distinct.length === 1) return { kind: 'uniform', color: distinct[0] };
  return { kind: 'multiple', colors: distinct };
}

export function colorsForColoration(coloration: StructureColoration): readonly number[] {
  if (coloration.kind === 'uniform') return [coloration.color];
  if (coloration.kind === 'multiple' || coloration.kind === 'partial') return coloration.colors;
  return [];
}

export function mergeStructureColorations(
  colorations: Iterable<StructureColoration>
): StructureColoration {
  const colors = new Set<number>();
  let hasUnrepresented = false;
  for (const coloration of colorations) {
    if (coloration.kind === 'unavailable') return { kind: 'unavailable' };
    if (coloration.kind === 'unrepresented' || coloration.kind === 'partial')
      hasUnrepresented = true;
    for (const color of colorsForColoration(coloration)) colors.add(color);
  }
  if (hasUnrepresented && colors.size > 0)
    return { kind: 'partial', colors: [...colors].sort((a, b) => a - b) };
  return colorationFromColors(colors);
}

export function molecularColorCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export function chainTitleColor(coloration: StructureColoration): string {
  return coloration.kind === 'uniform' ? molecularColorCss(coloration.color) : NEUTRAL_CHAIN_COLOR;
}

export function residueColorationStyle(coloration: StructureColoration): CSSProperties {
  if (coloration.kind === 'uniform') return { color: molecularColorCss(coloration.color) };
  if (coloration.kind === 'unrepresented')
    return {
      color: 'hsl(var(--color-fg-muted))',
      opacity: 0.4,
      textDecorationLine: 'line-through',
    };
  if (coloration.kind !== 'multiple') return { color: 'hsl(var(--color-fg-muted))' };
  return { color: NEUTRAL_CHAIN_COLOR };
}
