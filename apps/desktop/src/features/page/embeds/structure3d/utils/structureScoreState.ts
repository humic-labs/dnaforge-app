import type {
  Structure3dAttrs,
  Structure3dColorMode,
  StructureViewState,
  StructureVisualColorMode,
} from '../types';

export type StructureScoreContext = Partial<
  Pick<
    Structure3dAttrs,
    | 'source'
    | 'sourceId'
    | 'providerIdentityKey'
    | 'accession'
    | 'uniprotId'
    | 'url'
    | 'pdbId'
    | 'coordinateScores'
    | 'structureArtifactRef'
    | 'coordinateSource'
    | 'coordinateSha256'
    | 'predictionProvenance'
    | 'catalogProvenance'
  >
>;

export type StructureScoreState =
  | { kind: 'prediction'; colorMode: 'plddt'; label: 'pLDDT'; alphaFold: boolean }
  | { kind: 'prediction'; colorMode: null; label: null; alphaFold: false }
  | { kind: 'experimental'; colorMode: 'bfactor'; label: 'B-factor (Å²)'; alphaFold: false }
  | { kind: 'unknown'; colorMode: null; label: null; alphaFold: false };

const BASE_COLOR_OPTIONS: { value: Structure3dColorMode; label: string }[] = [
  { value: 'chain', label: 'Chain' },
  { value: 'element', label: 'Element' },
];

export function getColorOptions(
  source: string | StructureScoreContext
): { value: Structure3dColorMode; label: string }[] {
  const state = structureScoreState(source);
  if (state.colorMode === 'plddt') {
    return [
      ...BASE_COLOR_OPTIONS,
      { value: 'plddt', label: 'pLDDT' },
      ...(state.alphaFold ? [{ value: 'alphamissense' as const, label: 'Pathogenicity' }] : []),
    ];
  }

  return state.colorMode === 'bfactor'
    ? [...BASE_COLOR_OPTIONS, { value: 'bfactor', label: 'B-factor' }]
    : [...BASE_COLOR_OPTIONS];
}

export function structureScoreState(
  context: StructureScoreContext | string | undefined
): StructureScoreState {
  const attrs: StructureScoreContext | undefined =
    typeof context === 'string' ? { source: context as Structure3dAttrs['source'] } : context;
  if (!attrs) return { kind: 'unknown', colorMode: null, label: null, alphaFold: false };
  const currentDigest =
    attrs.coordinateSha256 ?? attrs.structureArtifactRef?.coordinateDigestSha256;
  const scores =
    attrs.coordinateScores && (!currentDigest || currentDigest === attrs.coordinateScores.sha256)
      ? attrs.coordinateScores
      : undefined;
  const pinned = attrs.coordinateSource;
  const original =
    pinned && (!currentDigest || currentDigest === pinned.sha256) ? pinned.source : undefined;
  const source = original?.source ?? attrs.source;
  const sourceId = original?.sourceId ?? attrs.sourceId;
  const identity = original?.providerIdentityKey ?? attrs.providerIdentityKey;
  const predictionCandidate = original?.prediction ?? attrs.predictionProvenance;
  const prediction =
    predictionCandidate &&
    (!currentDigest || currentDigest === predictionCandidate.coordinateSha256)
      ? predictionCandidate
      : undefined;
  const catalogCandidate = original?.catalogObservation ?? attrs.catalogProvenance;
  const catalog =
    catalogCandidate && (!currentDigest || currentDigest === catalogCandidate.coordinateSha256)
      ? catalogCandidate
      : undefined;
  const raw = attrs.source === 'file' ? (attrs.sourceId ?? '') : '';
  const rawConfidence = /_ma_qa_metric\.(?:name|type)\b/.test(raw) && /\bpLDDT\b/.test(raw);
  const rawPrediction = /_ma_model_list\./.test(raw) || rawConfidence;
  const alphaFold =
    scores?.alphaFold === true ||
    source === 'alphafold' ||
    /^AF:/i.test(identity ?? '') ||
    /^AF:/i.test(sourceId ?? '') ||
    isAlphaFoldUrl(attrs.url) ||
    isAlphaFoldUrl(sourceId) ||
    (source === 'file' && hasAlphaFoldCoordinates(attrs.sourceId)) ||
    (!source && Boolean(attrs.accession || attrs.uniprotId));
  if (alphaFold) return { kind: 'prediction', colorMode: 'plddt', label: 'pLDDT', alphaFold: true };
  if (scores || prediction || catalog?.sourceKind === 'prediction' || rawPrediction) {
    const tool = prediction?.toolId ?? catalog?.run?.toolId ?? '';
    const metrics = prediction?.metrics ?? catalog?.metrics ?? {};
    const plddt =
      scores?.kind === 'plddt' ||
      rawConfidence ||
      /alphafold|esmfold/i.test(tool) ||
      Object.keys(metrics).some((key) => /plddt/i.test(key));
    return plddt
      ? { kind: 'prediction', colorMode: 'plddt', label: 'pLDDT', alphaFold: false }
      : { kind: 'prediction', colorMode: null, label: null, alphaFold: false };
  }
  if (
    source === 'pdb' ||
    source === 'url' ||
    source === 'file' ||
    attrs.pdbId ||
    /^RCSB:/i.test(identity ?? sourceId ?? '')
  )
    return { kind: 'experimental', colorMode: 'bfactor', label: 'B-factor (Å²)', alphaFold: false };
  return { kind: 'unknown', colorMode: null, label: null, alphaFold: false };
}

export function normalizeStructureScoreColor(
  mode: Structure3dColorMode,
  context: StructureScoreContext | undefined
): Structure3dColorMode {
  const state = structureScoreState(context);
  return mode === 'bfactor' && state.kind === 'prediction' ? (state.colorMode ?? 'chain') : mode;
}

function isAlphaFoldUrl(value: string | undefined): boolean {
  if (!value || !/^https?:\/\//i.test(value)) return false;
  try {
    return /(?:^|\.)alphafold\.ebi\.ac\.uk$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

function hasAlphaFoldCoordinates(text: string | undefined): boolean {
  if (!text) return false;
  return (
    /^(?:data_AF-[A-Z0-9]+-F\d+|_entry\.id\s+['"]?AF-[A-Z0-9]+-F\d+)/im.test(text) ||
    /^TITLE\s+.*ALPHAFOLD/im.test(text)
  );
}

export function normalizeStructureViewScores(
  view: StructureViewState,
  context: StructureScoreContext
): StructureViewState {
  const normalize = (mode: StructureVisualColorMode) =>
    mode === 'bfactor' ? normalizeStructureScoreColor(mode, context) : mode;
  const layers = view.recipe.layers.map((layer) => {
    const mode = normalize(layer.color.mode);
    return mode === layer.color.mode ? layer : { ...layer, color: { ...layer.color, mode } };
  });
  const overrides = view.layerOverrides?.map((layer) => {
    if (!layer.color) return layer;
    const mode = normalize(layer.color.mode);
    return mode === layer.color.mode ? layer : { ...layer, color: { ...layer.color, mode } };
  });
  if (
    layers.every((layer, index) => layer === view.recipe.layers[index]) &&
    (!overrides || overrides.every((layer, index) => layer === view.layerOverrides?.[index]))
  )
    return view;
  return {
    ...view,
    recipe: { ...view.recipe, layers },
    ...(overrides ? { layerOverrides: overrides } : {}),
  };
}

export function structureCoordinateScores(
  data: string | Uint8Array,
  sha256: string
): Structure3dAttrs['coordinateScores'] {
  if (typeof data !== 'string') return undefined;
  const state = structureScoreState({ source: 'file', sourceId: data });
  return state.kind === 'prediction'
    ? {
        sha256,
        kind: state.colorMode === 'plddt' ? 'plddt' : 'unscored-prediction',
        alphaFold: state.alphaFold,
      }
    : undefined;
}
