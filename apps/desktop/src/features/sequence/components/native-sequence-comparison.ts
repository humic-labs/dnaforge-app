import type {
  AnnotationChangeDecoration,
  Feature,
  Genome,
  LinearSequencePresentation,
} from '@waypoint/genome-renderer';
import { sequenceEditMarkupStyle } from '@waypoint/sequence-utils/sequence-edit-markup';
import { compileDataColors, type DataColorMapping } from '@waypoint/platform';
import {
  alignmentColumnChanges,
  annotationColumnRanges,
  annotationDnaData,
  type AnnotationComparisonData,
} from './alignment-annotation-data';
import {
  annotationDnaColorKey,
  annotationDnaColors,
  comparisonChangeColor,
  type ComparisonColorOverrides,
} from './sequence-comparison-colors';
export { comparisonChangeColor, type ComparisonColorOverrides } from './sequence-comparison-colors';
import {
  buildSharedSequenceReadScene,
  type SharedSequenceAxis,
  type SharedSequenceReadScene,
} from './shared-sequence-read-model';

type ColumnRange = { readonly start: number; readonly end: number };
type ComparisonChange = ColumnRange & {
  readonly kind: 'insertion' | 'deletion' | 'substitution';
};

export interface NativeSequenceComparisonInput {
  readonly id: string;
  readonly before: Genome;
  readonly after: Genome;
  readonly oldGapped: string;
  readonly newGapped: string;

  readonly changes: ReadonlyArray<ComparisonChange>;
  readonly referenceName: string;
  readonly referenceOrigin: number;
}

export interface SequenceComparisonAppearance {
  readonly scene: SharedSequenceReadScene;
  readonly annotationChangeDecorations: ReadonlyMap<number, AnnotationChangeDecoration>;
  readonly nucleotideChanges: NonNullable<LinearSequencePresentation['nucleotideChanges']>;
  readonly annotationColors?: ReadonlyMap<number, number>;
}

export interface NativeSequenceComparisonScene extends SequenceComparisonAppearance {
  readonly annotationData: ReadonlyMap<number, AnnotationComparisonData>;
  readonly beforeAxis: SharedSequenceAxis;
  readonly afterAxis: SharedSequenceAxis;
  readonly referenceCodingGenome: Genome;

  readonly correspondenceComplete: boolean;
}

export type SequenceComparisonColorTarget =
  | { readonly kind: 'annotation'; readonly id: number }
  | { readonly kind: 'nucleotide-change'; readonly index: number };

export function mapSequenceComparisonDataColors<
  Input,
  Appearance extends SequenceComparisonAppearance,
>(
  scene: Appearance,
  mapping: Omit<DataColorMapping<Input, SequenceComparisonColorTarget>, 'targetKey'>
): Appearance {
  const resolved = compileDataColors({
    ...mapping,
    targetKey: (target) =>
      target.kind === 'annotation' ? `annotation:${target.id}` : `change:${target.index}`,
  });
  const annotationIds = new Set((scene.scene.genome.features ?? []).map((feature) => feature.id));
  const annotationColors = new Map(scene.annotationColors);
  const nucleotideChanges = [...scene.nucleotideChanges];
  const annotationChangeDecorations = new Map(scene.annotationChangeDecorations);
  for (const { target, color: hex } of resolved) {
    const color = Number.parseInt(hex.slice(1), 16);
    if (target.kind === 'annotation') {
      if (!annotationIds.has(target.id)) {
        throw new Error('A color binding names an annotation outside this sequence view.');
      }
      annotationColors.set(target.id, color);
      const decoration = annotationChangeDecorations.get(target.id);
      if (decoration) annotationChangeDecorations.set(target.id, { ...decoration, color });
    } else {
      const change = nucleotideChanges[target.index];
      if (!Number.isInteger(target.index) || !change) {
        throw new Error('A color binding names a nucleotide change outside this sequence view.');
      }
      nucleotideChanges[target.index] = {
        ...change,
        color,
        style: sequenceEditMarkupStyle(change.kind, color),
      };
    }
  }
  return { ...scene, annotationColors, nucleotideChanges, annotationChangeDecorations };
}

export { mapSequenceComparisonDataColors as mapNativeSequenceComparisonDataColors };

export function remapNativeSequenceComparisonColors(
  scene: NativeSequenceComparisonScene,
  colors: ComparisonColorOverrides
): NativeSequenceComparisonScene {
  if (!Object.keys(colors).length) return scene;
  return {
    ...scene,
    annotationColors: annotationDnaColors([...scene.annotationData.values()], colors),
    nucleotideChanges: scene.nucleotideChanges.map((change) => ({
      ...change,
      color: comparisonChangeColor(change.kind, colors),
      ...(colors[change.kind] !== undefined
        ? {
            style: sequenceEditMarkupStyle(change.kind, comparisonChangeColor(change.kind, colors)),
          }
        : {}),
    })),
    annotationChangeDecorations: new Map(
      [...scene.annotationChangeDecorations].map(([id, decoration]) => [
        id,
        {
          ...decoration,
          color: comparisonChangeColor(
            annotationDnaColorKey(scene.annotationData.get(id)!.dnaChange),
            colors
          ),
        },
      ])
    ),
  };
}

function identities(feature: Feature): string[] {
  return [
    ...(feature.sourceId ? [`source:${feature.sourceId}`] : []),
    ...(feature.canonicalIdentity ? [`canonical:${feature.canonicalIdentity}`] : []),
  ];
}

function identityIndex(features: readonly Feature[]): Map<string, Feature[]> {
  const index = new Map<string, Feature[]>();
  for (const feature of features) {
    for (const identity of identities(feature)) {
      const bucket = index.get(identity) ?? [];
      bucket.push(feature);
      index.set(identity, bucket);
    }
  }
  return index;
}

function completeIdentities(features: readonly Feature[]): boolean {
  const index = identityIndex(features);
  return features.every((feature) => {
    const keys = identities(feature);
    return keys.length > 0 && keys.every((key) => index.get(key)?.length === 1);
  });
}

function pairFeatures(
  before: readonly Feature[],
  after: readonly Feature[]
): { pairs: Map<Feature, Feature>; unambiguous: boolean } {
  const beforeIndex = identityIndex(before);
  const afterIndex = identityIndex(after);
  const pairs = new Map<Feature, Feature>();
  const pairedBefore = new Set<Feature>();
  let unambiguous = true;
  for (const feature of after) {
    const candidates = new Set(
      identities(feature).flatMap((identity) => {
        const old = beforeIndex.get(identity);
        return old?.length === 1 && afterIndex.get(identity)?.length === 1 ? old : [];
      })
    );
    if (candidates.size > 1) unambiguous = false;
    if (candidates.size !== 1) continue;
    const previous = candidates.values().next().value as Feature;
    if (pairedBefore.has(previous)) {
      unambiguous = false;
      continue;
    }
    pairs.set(feature, previous);
    pairedBefore.add(previous);
  }
  return { pairs, unambiguous };
}

function metadata(feature: Feature): string {
  const qualifiers = Object.entries(
    feature.qualifierValues ??
      Object.fromEntries(
        Object.entries(feature.qualifiers ?? {}).map(([key, value]) => [
          key,
          value === undefined ? [] : [value],
        ])
      )
  )
    .filter(([key]) => key !== '_locationString' && key !== 'translation')
    .map<[string, string[]]>(([key, values]) => [
      key,
      key === 'note'
        ? values
            .map((value) =>
              value
                .replace(
                  /Source feature clipped by the transformation: retained \d+ of \d+ annotated bases\./g,
                  ''
                )
                .trim()
            )
            .filter(Boolean)
        : [...values],
    ])
    .filter(([, values]) => values.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([feature.type, feature.direction, feature.displayName, qualifiers]);
}

function featureRanges(feature: Feature): ColumnRange[] {
  return annotationColumnRanges(feature);
}

function intersectRanges(
  ranges: readonly ColumnRange[],
  changes: readonly ColumnRange[]
): ColumnRange[] {
  const intersections = ranges
    .flatMap((range) =>
      changes.flatMap((change) => {
        const start = Math.max(range.start, change.start);
        const end = Math.min(range.end, change.end);
        return start < end ? [{ start, end }] : [];
      })
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of intersections) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function subtractRanges(
  ranges: readonly ColumnRange[],
  occupied: readonly ColumnRange[]
): ColumnRange[] {
  return ranges.flatMap((range) => {
    let remaining: ColumnRange[] = [range];
    for (const other of occupied) {
      remaining = remaining.flatMap((piece) => {
        if (other.end <= piece.start || other.start >= piece.end) return [piece];
        return [
          ...(piece.start < other.start ? [{ start: piece.start, end: other.start }] : []),
          ...(piece.end > other.end ? [{ start: other.end, end: piece.end }] : []),
        ];
      });
    }
    return remaining;
  });
}

function removedFeatureFragment(
  previous: Feature,
  current: Feature,
  changes: readonly ComparisonChange[],
  afterAxis: SharedSequenceAxis
): Feature | null {
  const deleted = intersectRanges(
    featureRanges(previous),
    changes.filter((change) => change.kind === 'deletion')
  );
  const removed = subtractRanges(
    deleted,
    representedColumnRanges(intersectRanges(featureRanges(current), deleted), afterAxis)
  );
  return featureFragment(previous, removed);
}

function representedColumnRanges(
  ranges: readonly ColumnRange[],
  axis: SharedSequenceAxis
): ColumnRange[] {
  const represented: ColumnRange[] = [];
  for (const range of ranges) {
    let start: number | null = null;
    for (let column = range.start; column < range.end; column++) {
      if (axis.columnToBio(column) !== null) {
        start ??= column;
      } else if (start !== null) {
        represented.push({ start, end: column });
        start = null;
      }
    }
    if (start !== null) represented.push({ start, end: range.end });
  }
  return represented;
}

function featureFragment(previous: Feature, removed: readonly ColumnRange[]): Feature | null {
  if (!removed.length) return null;
  const inclusive = removed.map(({ start, end }) => ({ start: start + 1, end }));
  const clipIntervals = (intervals: Feature['exons']) =>
    intervals === undefined
      ? undefined
      : intersectRanges(
          intervals.map(({ start, end }) => ({ start: start - 1, end })),
          removed
        ).map(({ start, end }) => ({ start: start + 1, end }));
  return {
    ...previous,
    start: Math.min(...removed.map((range) => range.start)),
    end: Math.max(...removed.map((range) => range.end)),
    outlineOnly: true,

    segments:
      previous.segments || removed.length > 1
        ? (clipIntervals(previous.segments) ?? inclusive)
        : undefined,
    exons: clipIntervals(previous.exons),
    cds: clipIntervals(previous.cds),
  };
}

export function buildNativeSequenceComparisonScene(
  input: NativeSequenceComparisonInput,
  colorOverrides: ComparisonColorOverrides = {}
): NativeSequenceComparisonScene {
  const changeColor = (kind: ComparisonChange['kind']) => comparisonChangeColor(kind);
  if (input.oldGapped.length !== input.newGapped.length || !input.oldGapped.length) {
    throw new Error('Recorded comparison columns must be nonempty and have equal length.');
  }
  for (const change of input.changes) {
    if (
      !Number.isInteger(change.start) ||
      !Number.isInteger(change.end) ||
      change.start < 0 ||
      change.start >= change.end ||
      change.end > input.newGapped.length
    ) {
      throw new Error('A recorded change lies outside the comparison columns.');
    }
  }
  const beforeScene = buildSharedSequenceReadScene({
    genome: input.before,
    documentId: `${input.id}:before`,
    coordinateSpace: {
      mode: 'gapped',
      gappedSequence: input.oldGapped,
      alignedQuery: input.newGapped,
    },
    alignmentLanes: [],
  });
  const afterScene = buildSharedSequenceReadScene({
    genome: input.after,
    documentId: `${input.id}:after`,
    coordinateSpace: {
      mode: 'gapped',
      gappedSequence: input.newGapped,
      alignedQuery: input.oldGapped,
    },
    alignmentLanes: [],
  });
  const before = beforeScene.genome.features ?? [];
  const after = afterScene.genome.features ?? [];
  const afterIds = new Set<number>();
  let greatestAfterId = -1;
  for (const feature of after) {
    if (!Number.isSafeInteger(feature.id) || feature.id < 0 || afterIds.has(feature.id)) {
      throw new Error('Resulting native feature IDs must be unique nonnegative safe integers.');
    }
    afterIds.add(feature.id);
    greatestAfterId = Math.max(greatestAfterId, feature.id);
  }
  let nextGhostId = greatestAfterId + 1;
  const allocateGhostId = () => {
    if (!Number.isSafeInteger(nextGhostId))
      throw new Error('Native ghost feature identity exceeds the supported integer range.');
    return nextGhostId++;
  };
  const pairing = pairFeatures(before, after);
  const pairs = pairing.pairs;
  const correspondenceComplete =
    Boolean(before.length) === Boolean(after.length) &&
    completeIdentities(before) &&
    completeIdentities(after) &&
    pairing.unambiguous;
  const pairedBefore = new Set(pairs.values());
  const features: Feature[] = [];
  const annotationData = new Map<number, AnnotationComparisonData>();
  const previousFeatures = new Map<number, Feature>();
  const removedFragments: Array<{
    feature: Feature;
    recordChange: AnnotationComparisonData['recordChange'];
  }> = [];
  const append = (
    feature: Feature,
    source: 'before' | 'after',
    recordChange: AnnotationComparisonData['recordChange'],
    previous?: Feature
  ) => {
    features.push(feature);
    annotationData.set(feature.id, {
      featureId: feature.id,
      source,
      recordChange,
      ...annotationDnaData(feature, input.oldGapped, input.newGapped, previous),
    });
    if (previous) previousFeatures.set(feature.id, previous);
  };
  for (const feature of after) {
    const previous = pairs.get(feature);
    const recordChange = previous
      ? metadata(previous) === metadata(feature)
        ? 'unchanged'
        : 'modified'
      : correspondenceComplete
        ? 'added'
        : null;
    append(feature, 'after', recordChange, previous);
    const removedFragment = previous
      ? removedFeatureFragment(previous, feature, input.changes, afterScene.axis)
      : null;
    if (removedFragment) removedFragments.push({ feature: removedFragment, recordChange });
  }
  for (const { feature, recordChange } of removedFragments) {
    const id = allocateGhostId();
    append({ ...feature, id }, 'before', recordChange);
  }
  const referenceIds = new Set<number>();
  for (const feature of before) {
    if (pairedBefore.has(feature)) continue;
    if (!after.length) {
      if (!Number.isSafeInteger(feature.id) || feature.id < 0 || referenceIds.has(feature.id)) {
        throw new Error('Native reference feature IDs must be unique nonnegative safe integers.');
      }
      referenceIds.add(feature.id);
      const removed =
        annotationDnaData(feature, input.oldGapped, input.newGapped).dnaChange === 'removed';
      append(removed ? { ...feature, outlineOnly: true } : feature, 'before', null);
      continue;
    }
    const removed = correspondenceComplete
      ? feature
      : featureFragment(
          feature,
          intersectRanges(
            featureRanges(feature),
            input.changes.filter((change) => change.kind === 'deletion')
          )
        );
    if (!removed) continue;
    const id = allocateGhostId();
    const allDnaRemoved =
      annotationDnaData(removed, input.oldGapped, input.newGapped).dnaChange === 'removed';
    append(
      { ...removed, id, ...(allDnaRemoved ? { outlineOnly: true } : {}) },
      'before',
      correspondenceComplete ? 'removed' : null
    );
  }
  const columnChanges = alignmentColumnChanges(input.oldGapped, input.newGapped);
  const annotationChangeDecorations = new Map<number, AnnotationChangeDecoration>();
  for (const feature of features) {
    const data = annotationData.get(feature.id)!;
    if (!data.dnaChanged) continue;
    const previous = previousFeatures.get(feature.id);
    const ranges = intersectRanges(
      [...featureRanges(feature), ...(previous ? featureRanges(previous) : [])],
      columnChanges
    );
    annotationChangeDecorations.set(feature.id, {
      kind: data.dnaChange as AnnotationChangeDecoration['kind'],
      color: comparisonChangeColor(annotationDnaColorKey(data.dnaChange)),
      ...(data.dnaChange === 'modified' ? { ranges } : {}),
    });
  }
  return remapNativeSequenceComparisonColors(
    {
      scene: { ...afterScene, genome: { ...afterScene.genome, features } },
      annotationChangeDecorations,
      annotationData,
      annotationColors: annotationDnaColors([...annotationData.values()]),
      nucleotideChanges: input.changes.map((change) => ({
        start: change.start,
        end: change.end,
        kind: change.kind,
        color: changeColor(change.kind),
      })),
      beforeAxis: beforeScene.axis,
      afterAxis: afterScene.axis,
      referenceCodingGenome: {
        ...input.before,
        features: !after.length
          ? input.before.features
          : [...previousFeatures].flatMap(([id, previous]) => {
              const original = input.before.features?.find((feature) => feature.id === previous.id);
              return original ? [{ ...original, id }] : [];
            }),
      },
      correspondenceComplete,
    },
    colorOverrides
  );
}
