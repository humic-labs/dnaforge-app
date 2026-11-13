export type AnnotationLayerFeature = {
  type: string;
  attributes?: Record<string, string[]>;
};

const SOURCE_LAYER_TYPE = 'source';

export const NON_USER_ANNOTATION_LAYER_TYPES: ReadonlySet<string> = new Set([SOURCE_LAYER_TYPE]);

export const TRANSCRIPT_GLYPH_INTERNAL_LAYER_TYPES: ReadonlySet<string> = new Set([
  'CDS',
  'exon',
  'gene',
  'five_prime_UTR',
  'three_prime_UTR',
  'UTR',
  'start_codon',
  'stop_codon',
]);

export const LAYER_IDENTITY_QUALIFIER_SUFFIXES: readonly string[] = ['_class', '_type'];

const TRACK_IDENTITY_QUALIFIERS: readonly string[] = [
  'ncRNA_class',
  'regulatory_class',
  'mobile_element_type',
];

export const ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN =
  'annotation-layer-identity.v2.mobile-family-copy-suffix' as const;

export const ANNOTATION_RESOLVED_TRACK_CONTRACT_TOKEN =
  'annotation-resolved-track.v2.mobile-elements-one-row' as const;

export const ANNOTATION_TRACK_IDENTITY_CONTRACT_TOKEN =
  `${ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN}|${ANNOTATION_RESOLVED_TRACK_CONTRACT_TOKEN}` as const;

export const ANNOTATION_TRACK_IDENTITY_MOBILE_FAMILY_ROWS_CONTRACT_TOKEN =
  `${ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN}|annotation-resolved-track.v1.pseudogene-own-track` as const;

export const ANNOTATION_TRACK_IDENTITY_PRE_PSEUDOGENE_CONTRACT_TOKEN =
  ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN;

export const ANNOTATION_TRACK_IDENTITY_PREVIOUS_CONTRACT_TOKENS = [
  ANNOTATION_TRACK_IDENTITY_MOBILE_FAMILY_ROWS_CONTRACT_TOKEN,
  ANNOTATION_TRACK_IDENTITY_PRE_PSEUDOGENE_CONTRACT_TOKEN,
] as const;

export const ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN =
  'annotation-layer-identity.v1.raw-qualifier' as const;

export type AnnotationTrackIdentityPublishedContractToken =
  | typeof ANNOTATION_TRACK_IDENTITY_CONTRACT_TOKEN
  | (typeof ANNOTATION_TRACK_IDENTITY_PREVIOUS_CONTRACT_TOKENS)[number]
  | typeof ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN;

const MOBILE_ELEMENT_TYPE_QUALIFIER = 'mobile_element_type';

export const MOBILE_ELEMENT_LAYER_TYPE = 'mobile_genetic_element';

const MOBILE_ELEMENT_CATEGORIES: ReadonlySet<string> = new Set([
  'insertion sequence',
  'retrotransposon',
  'non-LTR retrotransposon',
  'transposon',
  'integron',
  'SINE',
  'MITE',
  'LINE',
]);

const MOBILE_ELEMENT_FEATURE_TYPES: ReadonlySet<string> = new Set([
  MOBILE_ELEMENT_LAYER_TYPE,
  'transposable_element',
  'insertion_sequence',
  'retrotransposon',
  'LTR_retrotransposon',
  'non_LTR_retrotransposon',
  'SINE_element',
  'LINE_element',
  'MITE',
  'integron',
]);

const SUPERSEDED_QUALIFIER_IDENTITIES: ReadonlyMap<string, string> = new Map([
  ...[
    'genomic DNA',
    'genomic RNA',
    'other DNA',
    'other RNA',
    'transcribed RNA',
    'viral cRNA',
    'unassigned DNA',
    'unassigned RNA',
  ].map((v) => [v, SOURCE_LAYER_TYPE] as const),
  ...['direct', 'dispersed', 'tandem', 'inverted', 'flanking', 'nested', 'terminal'].map(
    (v) => [v, 'repeat_region'] as const
  ),
  ...['meiotic', 'mitotic', 'non_allelic_homologous'].map(
    (v) => [v, 'recombination_feature'] as const
  ),
]);

function canonicalLayerIdentity(value: string): string {
  const superseded = SUPERSEDED_QUALIFIER_IDENTITIES.get(value);
  if (superseded) return superseded;
  if (MOBILE_ELEMENT_FEATURE_TYPES.has(value)) return MOBILE_ELEMENT_LAYER_TYPE;
  const separator = value.indexOf(':');
  const category = separator < 0 ? value : value.slice(0, separator).trim();
  if (MOBILE_ELEMENT_CATEGORIES.has(category)) return MOBILE_ELEMENT_LAYER_TYPE;
  if (separator > 0 && category === 'other') return MOBILE_ELEMENT_LAYER_TYPE;
  return value;
}

export function isLayerIdentityAttributeKey(key: string): boolean {
  return LAYER_IDENTITY_QUALIFIER_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

export function annotationLayerType(feature: AnnotationLayerFeature): string {
  if (feature.type === 'region' && firstNonEmpty(feature.attributes?.mol_type) !== null) {
    return SOURCE_LAYER_TYPE;
  }
  return annotationLayerLabel(layerIdentityFromAttributes(feature.attributes) ?? feature.type);
}

export function annotationLayerLabel(value: string): string {
  return canonicalLayerIdentity(value.trim());
}

export function isUserAnnotationLayer(type: string): boolean {
  return !NON_USER_ANNOTATION_LAYER_TYPES.has(type);
}

export function selectableAnnotationLayerTypesForGlyphMode(
  types: Iterable<string>,
  glyphV2Enabled: boolean,
  options: Readonly<{ inventory?: 'source' | 'resolved' }> = {}
): string[] {
  const inventory = options.inventory ?? 'source';
  const selectable = new Set<string>();
  for (const value of types) {
    const type = inventory === 'resolved' ? value.trim() : annotationLayerLabel(value);
    if (
      type.length === 0 ||
      !isUserAnnotationLayer(type) ||
      (glyphV2Enabled && inventory === 'source' && TRANSCRIPT_GLYPH_INTERNAL_LAYER_TYPES.has(type))
    ) {
      continue;
    }
    selectable.add(type);
  }
  return [...selectable].sort((left, right) => left.localeCompare(right));
}

export function uniqueAnnotationLayerTypes(features: Iterable<AnnotationLayerFeature>): string[] {
  const seen = new Set<string>();
  for (const feature of features) {
    const layer = annotationLayerType(feature);
    if (isUserAnnotationLayer(layer)) seen.add(layer);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function layerIdentityFromAttributes(
  attributes: Record<string, string[]> | undefined
): string | null {
  if (!attributes) return null;
  for (const key of TRACK_IDENTITY_QUALIFIERS) {
    const first = firstNonEmpty(attributes[key]);
    if (first !== null) return layerIdentityFromQualifier(key, first);
  }
  return null;
}

function layerIdentityFromQualifier(key: string, value: string): string {
  return key === MOBILE_ELEMENT_TYPE_QUALIFIER ? MOBILE_ELEMENT_LAYER_TYPE : value;
}

function firstNonEmpty(values: string[] | undefined): string | null {
  if (!values) return null;
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}
