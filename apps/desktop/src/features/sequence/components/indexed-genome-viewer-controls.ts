import { selectableAnnotationLayerTypesForGlyphMode } from '../annotation-layer-identity';

const DEFAULT_ANNOTATION_TRACK_PREFERENCE = [
  'mRNA',
  'transcript',
  'CDS',
  'ncRNA',
  'rRNA',
  'tRNA',
  'gene',
] as const;

export function defaultVisibleAnnotationTypes(
  publishedTrackTypes: ReadonlyArray<string> | undefined
): ReadonlySet<string> {
  if (publishedTrackTypes === undefined) return new Set(['mRNA']);
  const roster = [
    ...new Set(publishedTrackTypes.map((trackType) => trackType.trim()).filter(Boolean)),
  ];
  if (roster.length === 0) return new Set();
  const preferred = DEFAULT_ANNOTATION_TRACK_PREFERENCE.find((trackType) =>
    roster.includes(trackType)
  );
  return new Set([preferred ?? roster[0]]);
}

export function reconcileVisibleAnnotationTypes(
  visibleTypes: ReadonlySet<string>,
  publishedTrackTypes: ReadonlyArray<string> | undefined,
  fallback: ReadonlySet<string>
): ReadonlySet<string> {
  if (publishedTrackTypes === undefined || visibleTypes.size === 0) return visibleTypes;
  const published = new Set(
    publishedTrackTypes.map((trackType) => trackType.trim()).filter(Boolean)
  );
  const admitted = new Set([...visibleTypes].filter((trackType) => published.has(trackType)));
  if (admitted.size === visibleTypes.size) return visibleTypes;
  if (admitted.size > 0) return admitted;
  return new Set([...fallback].filter((trackType) => published.has(trackType)));
}

export function visibleTypesForGlyphMode(
  visibleTypes: ReadonlySet<string>,
  glyphV2Enabled: boolean,
  resolvedTrackTypes?: ReadonlyArray<string>
): ReadonlySet<string> {
  if (!glyphV2Enabled) return visibleTypes;
  if (resolvedTrackTypes === undefined) {
    return new Set(selectableAnnotationLayerTypesForGlyphMode(visibleTypes, true));
  }
  const resolved = new Set(
    selectableAnnotationLayerTypesForGlyphMode(resolvedTrackTypes, true, {
      inventory: 'resolved',
    })
  );
  return new Set([...visibleTypes].filter((type) => resolved.has(type)));
}

export function toggleVisibleFeatureType(
  visibleTypes: ReadonlySet<string>,
  type: string
): ReadonlySet<string> {
  const next = new Set(visibleTypes);
  if (next.has(type)) next.delete(type);
  else next.add(type);
  return next;
}

export function toggleAnnotationLaneVisible(
  visibleTypes: ReadonlySet<string>,
  previous: ReadonlySet<string> | null,
  fallback: ReadonlySet<string>
): { next: ReadonlySet<string>; stash: ReadonlySet<string> | null } {
  if (visibleTypes.size > 0) {
    return { next: new Set(), stash: new Set(visibleTypes) };
  }
  const restore = previous && previous.size > 0 ? previous : fallback;
  return { next: new Set(restore), stash: null };
}
