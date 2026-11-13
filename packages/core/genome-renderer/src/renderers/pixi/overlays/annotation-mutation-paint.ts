import { CDS_MUTATION_MARKUP } from '@waypoint/sequence-utils/sequence-edit-markup';
import type { CodonInfo } from '../../../biology/translation';
import type { Feature, LinearSequencePresentation } from '../../../types';

export type AnnotationMutationSector = Readonly<{ start: number; end: number; color: number }>;
export type AnnotationMutationPaint = Readonly<{
  baseColor: number;
  coding: boolean;
  sectors: readonly AnnotationMutationSector[];
}>;

export function annotationMutationBodyColor(
  feature: Feature,
  presentation: LinearSequencePresentation | undefined
): number | undefined {
  if (
    presentation?.cdsComparisonLayout === 'diff' &&
    presentation.codingFeatures?.get(feature.id)?.source === 'query'
  )
    return 0x9e9e9e;
  if (presentation?.nucleotideChanges && feature.type !== 'CDS' && !feature.cds?.length)
    return presentation.annotationUnchangedColor ?? 0x9ca3af;
  return presentation?.annotationColors?.get(feature.id);
}

const bodyColorsCache = new WeakMap<
  LinearSequencePresentation,
  {
    features: readonly Feature[];
    colors: ReadonlyMap<number, number> | undefined;
  }
>();

export function annotationMutationBodyColors(
  features: readonly Feature[],
  presentation: LinearSequencePresentation | undefined
): ReadonlyMap<number, number> | undefined {
  if (!presentation) return undefined;
  if (!presentation.nucleotideChanges && presentation.cdsComparisonLayout !== 'diff')
    return presentation.annotationColors;
  const cached = bodyColorsCache.get(presentation);
  if (cached?.features === features) return cached.colors;
  const colors = new Map(presentation.annotationColors);
  for (const feature of features) {
    const color = annotationMutationBodyColor(feature, presentation);
    if (color !== undefined) colors.set(feature.id, color);
  }
  const result = colors.size ? colors : undefined;
  bodyColorsCache.set(presentation, { features, colors: result });
  return result;
}

export function codonMutationColor(codon: CodonInfo): number | null {
  const mutation = codon.mutation;
  if (!mutation || !['substitution', 'inserted', 'frameshifted'].includes(mutation.kind))
    return null;
  return codon.isStop
    ? CDS_MUTATION_MARKUP.prematureStop.background.color
    : mutation.frameShifted
      ? CDS_MUTATION_MARKUP.frameshifted.background.color
      : mutation.kind === 'inserted'
        ? CDS_MUTATION_MARKUP.inserted.background.color
        : CDS_MUTATION_MARKUP.substitution.background.color;
}

function mergeSectors(sectors: AnnotationMutationSector[]): AnnotationMutationSector[] {
  const merged: AnnotationMutationSector[] = [];
  for (const sector of sectors.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged[merged.length - 1];
    if (previous && previous.end === sector.start && previous.color === sector.color)
      merged[merged.length - 1] = { ...previous, end: sector.end };
    else merged.push(sector);
  }
  return merged;
}

export function buildAnnotationMutationPaint(
  features: readonly Feature[],
  presentation: LinearSequencePresentation | undefined,
  genomeLength: number
): ReadonlyMap<number, AnnotationMutationPaint> {
  const paints = new Map<number, AnnotationMutationPaint>();
  if (
    !presentation ||
    (!presentation.nucleotideChanges && presentation.cdsComparisonLayout !== 'diff')
  )
    return paints;
  for (const feature of features) {
    const coding =
      presentation.cdsComparisonLayout === 'diff'
        ? presentation.codingFeatures?.get(feature.id)
        : undefined;
    if (coding?.source === 'query') {
      const sectors = coding.codons.flatMap((codon) => {
        const color = codonMutationColor(codon);
        return color === null || codon.endBp <= codon.startBp
          ? []
          : [{ start: codon.startBp, end: codon.endBp, color }];
      });
      paints.set(feature.id, { baseColor: 0x9e9e9e, coding: true, sectors: mergeSectors(sectors) });
    } else if (presentation.nucleotideChanges && feature.type !== 'CDS' && !feature.cds?.length) {
      const parts = feature.exons?.length ? feature.exons : feature.segments;
      const ranges = parts?.length
        ? parts.flatMap((part) =>
            part.start <= part.end
              ? [{ start: part.start - 1, end: part.end }]
              : [
                  { start: part.start - 1, end: genomeLength },
                  { start: 0, end: part.end },
                ]
          )
        : feature.start <= feature.end
          ? [{ start: feature.start, end: feature.end }]
          : [
              { start: feature.start, end: genomeLength },
              { start: 0, end: feature.end },
            ];
      const sectors = ranges.flatMap((range) =>
        presentation.nucleotideChanges!.flatMap((change) => {
          const start = Math.max(range.start, change.start);
          const end = Math.min(range.end, change.end);
          return end > start ? [{ start, end, color: change.color }] : [];
        })
      );
      paints.set(feature.id, {
        baseColor: presentation.annotationUnchangedColor ?? 0x9ca3af,
        coding: false,
        sectors: mergeSectors(sectors),
      });
    }
  }
  return paints;
}
