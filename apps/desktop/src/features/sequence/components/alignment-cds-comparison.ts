import {
  assignFeatureLanes,
  compareProjectedCodons,
  projectCodonColumns,
  projectIntronColumns,
  recomputeCds,
  type Feature,
  type LinearSequencePresentation,
  type RecomputedCds,
} from '@waypoint/genome-renderer';
import type { AlignmentCodingProjection } from './alignment-coding-genome';
import type { SharedSequenceAxis, SharedSequenceReadScene } from './shared-sequence-read-model';

export type CdsComparisonLayout = 'rows' | 'shared' | 'diff';
type CodingPayload =
  NonNullable<LinearSequencePresentation['codingFeatures']> extends ReadonlyMap<number, infer Value>
    ? Value
    : never;
type ComputedPair = {
  readonly id: number;
  readonly original?: RecomputedCds;
  readonly query?: RecomputedCds;
  readonly referenceCoding?: CodingPayload;
  readonly queryCoding?: CodingPayload;
};
export interface AlignmentCdsComparison {
  readonly reference: AlignmentCodingProjection;
  readonly query: AlignmentCodingProjection;
  readonly pairs: readonly ComputedPair[];
}

const isCoding = (feature: Feature) => feature.type === 'CDS' || !!feature.cds?.length;

export function rebindCdsAnnotationColors(
  features: readonly Feature[],
  colors: ReadonlyMap<number, number> | undefined
): ReadonlyMap<number, number> | undefined {
  if (!colors) return undefined;
  const rebound = new Map(colors);
  for (const feature of features) {
    const color = colors.get(feature.codingSourceFeatureId ?? feature.id);
    if (color !== undefined) rebound.set(feature.id, color);
  }
  return rebound;
}

export function computeAlignmentCdsComparison(
  reference: AlignmentCodingProjection,
  query: AlignmentCodingProjection
): AlignmentCdsComparison {
  const referenceFeatures = new Map(
    reference.genome.features?.filter(isCoding).map((feature) => [feature.id, feature])
  );
  const queryFeatures = new Map(
    query.genome.features?.filter(isCoding).map((feature) => [feature.id, feature])
  );
  const ids = new Set([...referenceFeatures.keys(), ...queryFeatures.keys()]);
  const pairs: ComputedPair[] = [...ids].map((id) => {
    const original = referenceFeatures.has(id)
      ? recomputeCds(referenceFeatures.get(id)!, reference.genome)
      : undefined;
    const changed = queryFeatures.has(id)
      ? recomputeCds(queryFeatures.get(id)!, query.genome)
      : undefined;
    const referenceCoding: CodingPayload | undefined = original
      ? {
          source: 'reference',
          codons: projectCodonColumns(
            original.codons,
            reference.axis.biologicalLength,
            reference.axis.bioToColumn
          ),
          introns: projectIntronColumns(
            original.introns,
            reference.axis.biologicalLength,
            reference.axis.bioToColumn
          ),
        }
      : undefined;
    let queryCoding: CodingPayload | undefined;
    if (changed) {
      const projected = projectFeature(changed.feature, query.axis);
      const ranges = projected.segments?.length
        ? projected.segments.map((part) => ({ start: part.start - 1, end: part.end }))
        : [{ start: projected.start, end: projected.end }];
      const codons = original
        ? compareProjectedCodons({
            reference: original.codons,
            referenceAxis: reference.axis,
            query: changed.codons,
            queryAxis: query.axis,
            columnLength: reference.axis.length,
            direction: changed.feature.direction === 'reverse' ? 'reverse' : 'forward',
          })
        : projectCodonColumns(changed.codons, query.axis.biologicalLength, query.axis.bioToColumn);
      queryCoding = {
        source: 'query',
        codons: codons.filter(
          (codon) =>
            codon.mutation?.kind !== 'deleted' ||
            ranges.some((range) => codon.startBp >= range.start && codon.endBp <= range.end)
        ),
        introns: projectIntronColumns(
          changed.introns,
          query.axis.biologicalLength,
          query.axis.bioToColumn
        ),
      };
    }
    return { id, original, query: changed, referenceCoding, queryCoding };
  });
  const replace = (
    projection: AlignmentCodingProjection,
    role: 'original' | 'query'
  ): AlignmentCodingProjection => ({
    ...projection,
    genome: {
      ...projection.genome,
      features: projection.genome.features?.map(
        (feature) => pairs.find((pair) => pair.id === feature.id)?.[role]?.feature ?? feature
      ),
    },
  });
  return { reference: replace(reference, 'original'), query: replace(query, 'query'), pairs };
}

function projectFeature(feature: Feature, axis: SharedSequenceAxis): Feature {
  const start = axis.bioToColumn(feature.start);
  const last = axis.bioToColumn((feature.end - 1 + axis.biologicalLength) % axis.biologicalLength);
  if (start === null || last === null)
    throw new Error('Computed CDS lies outside the actual alignment');
  const intervals = (parts: Readonly<Feature['segments']>) =>
    parts?.flatMap((part) => {
      const first = axis.bioToColumn(part.start - 1);
      const end = axis.bioToColumn(part.end - 1);
      return first === null || end === null ? [] : [{ start: first + 1, end: end + 1 }];
    });
  return {
    ...feature,
    start,
    end: last + 1,
    segments: intervals(feature.segments),
    cds: intervals(feature.cds),
    exons: intervals(feature.exons),
  };
}

export function presentAlignmentCdsComparison(
  scene: SharedSequenceReadScene,
  model: AlignmentCdsComparison,
  layout: CdsComparisonLayout
) {
  const codingIds = new Set(model.pairs.map((pair) => pair.id));
  const features = (scene.genome.features ?? [])
    .filter((feature) => !codingIds.has(feature.id))
    .map((feature) => ({ ...feature }));
  const codingFeatures = new Map<
    number,
    NonNullable<LinearSequencePresentation['codingFeatures']> extends ReadonlyMap<
      number,
      infer Value
    >
      ? Value
      : never
  >();
  const bindings = new Map<
    number,
    {
      readonly source: 'reference' | 'query';
      readonly computation: RecomputedCds;
      readonly axis: SharedSequenceAxis;
    }
  >();
  let nextId = Math.max(-1, ...(scene.genome.features ?? []).map((feature) => feature.id)) + 1;
  const projectedPairs = model.pairs.map((pair) => {
    const reference = pair.original
      ? projectFeature(pair.original.feature, model.reference.axis)
      : undefined;
    const query = pair.query ? projectFeature(pair.query.feature, model.query.axis) : undefined;
    const parts = [reference, query].filter((feature): feature is Feature => !!feature);
    return {
      pair,
      reference,
      query,
      envelope: {
        ...parts[0],
        start: Math.min(...parts.map((feature) => feature.start)),
        end: Math.max(...parts.map((feature) => feature.end)),
      },
    };
  });
  const renderedPairs =
    layout === 'diff' ? projectedPairs.filter((pair) => pair.query) : projectedPairs;
  const lanes = assignFeatureLanes(
    renderedPairs.map((pair) => (layout === 'diff' ? pair.query! : pair.envelope)),
    scene.genome.length
  ).laneAssignments;
  for (let index = 0; index < renderedPairs.length; index++) {
    const { pair, reference, query } = renderedPairs[index];
    const baseLane = lanes.get(index) ?? 0;
    for (const source of ['reference', 'query'] as const) {
      if (layout === 'diff' && source === 'reference') continue;
      const computed = source === 'reference' ? pair.original : pair.query;
      const projected = source === 'reference' ? reference : query;
      if (!computed || !projected) continue;
      const axis = source === 'reference' ? model.reference.axis : model.query.axis;
      const id = source === 'reference' ? pair.id : nextId++;
      const lane = layout === 'rows' ? baseLane * 2 + (source === 'reference' ? 1 : 0) : baseLane;
      const displayName =
        layout === 'shared' && source === 'reference'
          ? ''
          : `${computed.feature.displayName} · ${source === 'reference' ? 'Original' : 'Mutant'}`;
      const feature = {
        ...projected,
        id,
        displayName,
        codingSource: source,
        codingSourceFeatureId: pair.id,
        sourceId: `cds-${source}:${computed.feature.sourceId ?? pair.id}`,
        canonicalIdentity: `cds-${source}:${computed.feature.canonicalIdentity ?? pair.id}`,
        outlineOnly: layout === 'shared' && source === 'reference',
        codingGhostOnly: layout === 'diff' && source === 'reference',
        color: source === 'reference' ? 0x8b95a5 : computed.feature.color,
        lane,
        cdsLane: lane,
        qualifiers: { ...projected.qualifiers, _lane: String(lane) },
      };
      features.push(feature);
      const coding = (source === 'reference' ? pair.referenceCoding : pair.queryCoding)!;
      codingFeatures.set(
        id,
        layout === 'diff'
          ? {
              ...coding,
              codons: coding.codons.filter((codon) => codon.mutation?.kind !== 'deleted'),
              introns: coding.introns,
            }
          : coding
      );
      bindings.set(id, { source, computation: computed, axis });
    }
  }
  const navigationFeatures = [
    ...features.filter((feature) => !feature.codingSource),
    ...projectedPairs.map(({ pair, reference, query }) => ({
      ...(query ?? reference)!,
      id: pair.id,
      displayName: (pair.query ?? pair.original)!.feature.displayName,
    })),
  ];
  return {
    navigationFeatures,
    scene: { ...scene, genome: { ...scene.genome, features } },
    codingFeatures,
    bindings,
    model,
  };
}
