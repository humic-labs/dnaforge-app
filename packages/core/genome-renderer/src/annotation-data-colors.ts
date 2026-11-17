import type { Feature } from './types';

export function resolveAnnotationDataColors(
  features: readonly Feature[],
  colorsByIdentity: ReadonlyMap<string, string>,
  missingColor?: string
): ReadonlyMap<number, number> {
  const result = new Map<number, number>();
  for (const feature of features) {
    const identities = new Set(
      [
        feature.canonicalIdentity,
        feature.sourceId,
        feature.qualifiers?.locus_tag,
        feature.qualifiers?.ID,
        ...(feature.qualifierValues?.locus_tag ?? []),
        ...(feature.qualifierValues?.ID ?? []),
      ].filter((identity): identity is string => Boolean(identity))
    );
    const colors = new Set(
      [...identities].flatMap((identity) => {
        const color = colorsByIdentity.get(identity);
        return color === undefined ? [] : [color.toLowerCase()];
      })
    );
    if (colors.size > 1) {
      throw new Error('Annotation identities resolve to conflicting data colors.');
    }
    const color = colors.values().next().value ?? missingColor;
    if (color === undefined) continue;
    if (!/^#[0-9a-f]{6}$/i.test(color)) {
      throw new Error('Annotation data colors must use six-digit hex colors.');
    }
    result.set(feature.id, Number.parseInt(color.slice(1), 16));
  }
  return result;
}
