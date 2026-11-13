import { compileDataColors, dataColor } from '@waypoint/platform';
import { SEQUENCE_EDIT_MARKUP } from '@waypoint/sequence-utils/sequence-edit-markup';
import type { AnnotationDnaData } from './alignment-annotation-data';

export type ComparisonColorKey = keyof typeof SEQUENCE_EDIT_MARKUP | 'unchanged';
export type ComparisonColorOverrides = Readonly<Partial<Record<ComparisonColorKey, string>>>;

export function comparisonChangeColor(
  kind: ComparisonColorKey,
  overrides: ComparisonColorOverrides = {}
): number {
  const colors = Object.fromEntries(
    Object.entries(SEQUENCE_EDIT_MARKUP).map(([kind, style]) => [
      kind,
      `#${style.text.color.toString(16).padStart(6, '0')}`,
    ])
  );
  const color = dataColor(kind, {
    kind: 'categorical',
    colors: { ...colors, unchanged: '#9ca3af', ...overrides },
    missingColor: '#cbd5e1',
  });
  if (!/^#[0-9a-f]{6}$/i.test(color))
    throw new Error('A comparison color must be a six-digit hex color.');
  return Number.parseInt(color.slice(1), 16);
}

export function annotationDnaColorKey(change: AnnotationDnaData['dnaChange']): ComparisonColorKey {
  return change === 'added'
    ? 'insertion'
    : change === 'removed'
      ? 'deletion'
      : change === 'modified'
        ? 'substitution'
        : 'unchanged';
}

export function annotationDnaColors(
  records: readonly (AnnotationDnaData & { readonly featureId: number })[],
  colors: ComparisonColorOverrides = {}
): ReadonlyMap<number, number> {
  const resolved = compileDataColors({
    records,
    bindings: records.map((record, inputIndex) => ({ inputIndex, target: record.featureId })),
    targetKey: (target) => target,
    color: (record) =>
      `#${comparisonChangeColor(annotationDnaColorKey(record.dnaChange), colors).toString(16).padStart(6, '0')}`,
  });
  return new Map(
    resolved.map(({ target, color }) => [target, Number.parseInt(color.slice(1), 16)])
  );
}
