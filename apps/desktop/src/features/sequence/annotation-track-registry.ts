export const DEFAULT_TRACK_ORDER: ReadonlyArray<string> = [
  'gene',
  'mRNA',
  'lncRNA',
  'ncRNA',
  'miRNA',
  'snoRNA',
  'snRNA',
  'tRNA',
  'rRNA',
  'pseudogene',
  'CDS',
  'exon',
  'regulatory',
  'enhancer',
  'silencer',
  'promoter',
  'TATA_box',
  'CAAT_signal',
  'response_element',
  'insulator',
  'origin_of_replication',
  'rep_origin',
  'protein_bind',
  'misc_feature',
  'misc_RNA',
];

export interface AnnotationTrackDefinition {
  trackId: string;
  label: string;
  order: number;
  visible: boolean;
}

export interface AnnotationTrackPreferences {
  visibilityByTrackId: ReadonlyMap<string, boolean>;
  orderedTrackIds: ReadonlyArray<string>;
}

export const EMPTY_ANNOTATION_TRACK_PREFERENCES: AnnotationTrackPreferences = {
  visibilityByTrackId: new Map<string, boolean>(),
  orderedTrackIds: [],
};

export function deriveAnnotationTrackRegistry(
  presentTypes: Iterable<string>,
  preferences: AnnotationTrackPreferences = EMPTY_ANNOTATION_TRACK_PREFERENCES
): AnnotationTrackDefinition[] {
  const presentSet = new Set<string>();
  for (const t of presentTypes) {
    if (typeof t === 'string' && t.length > 0) presentSet.add(t);
  }
  if (presentSet.size === 0) return [];

  const defaultOrderIndex = new Map<string, number>();
  for (let i = 0; i < DEFAULT_TRACK_ORDER.length; i++) {
    defaultOrderIndex.set(DEFAULT_TRACK_ORDER[i], i);
  }

  const userOrderIndex = new Map<string, number>();
  for (let i = 0; i < preferences.orderedTrackIds.length; i++) {
    userOrderIndex.set(preferences.orderedTrackIds[i], i);
  }

  const sorted = [...presentSet].sort((a, b) => {
    const userA = userOrderIndex.get(a);
    const userB = userOrderIndex.get(b);
    if (userA !== undefined && userB !== undefined) return userA - userB;
    if (userA !== undefined) return -1;
    if (userB !== undefined) return 1;
    const defA = defaultOrderIndex.get(a) ?? Number.POSITIVE_INFINITY;
    const defB = defaultOrderIndex.get(b) ?? Number.POSITIVE_INFINITY;
    if (defA !== defB) return defA - defB;
    return a.localeCompare(b);
  });

  return sorted.map((trackId, order) => ({
    trackId,
    label: trackLabelFor(trackId),
    order,
    visible: preferences.visibilityByTrackId.get(trackId) ?? true,
  }));
}

export function visibleTracks(
  registry: ReadonlyArray<AnnotationTrackDefinition>
): AnnotationTrackDefinition[] {
  return registry.filter((t) => t.visible);
}

const TRACK_LABEL_ALIASES: ReadonlyMap<string, string> = new Map([
  ['regulatory', 'Regulatory'],
  ['enhancer', 'Enhancer'],
  ['silencer', 'Silencer'],
  ['promoter', 'Promoter'],
  ['protein_bind', 'Protein-binding site'],
  ['rep_origin', 'Replication origin'],
  ['origin_of_replication', 'Replication origin'],
  ['misc_feature', 'Misc. feature'],
  ['misc_RNA', 'Misc. RNA'],
  ['response_element', 'Response element'],
  ['TATA_box', 'TATA box'],
  ['CAAT_signal', 'CAAT signal'],
  ['pseudogene', 'Pseudogene'],
]);

function trackLabelFor(trackId: string): string {
  return TRACK_LABEL_ALIASES.get(trackId) ?? trackId;
}
