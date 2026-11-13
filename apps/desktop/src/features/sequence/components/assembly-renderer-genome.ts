import { assignFeatureLanesByType, type Assembly, type Feature } from '@waypoint/genome-renderer';

import { annotationLayerType } from '../annotation-layer-identity';
import type {
  AssemblyOverviewTextureManifest,
  GenomeAnnotationGlyphPayload,
  GenomeSessionShell,
  GenomeTrackTile,
} from '../../../shared/indexed-genome';
import { buildIndexedGenomeScene, type IndexedGenomeScene } from './indexed-genome-scene';

const ANNOTATION_TYPE_SPACER_LANES = 1;

export interface AssemblyRendererGenomeInput {
  rendererAssembly: Assembly | null | undefined;
  assemblyByChrom?: ReadonlyMap<string, ReadonlyArray<Feature>> | null;
  assemblyDetailByChrom: ReadonlyMap<string, ReadonlyArray<Feature>>;
  assemblyFeatures?: ReadonlyArray<Feature> | null;
  visibleTypes: ReadonlySet<string>;
  visibleChroms?: ReadonlySet<string> | null;
}

export interface AssemblyRendererLaneControlResult {
  features: Feature[];
  droppedCount: number;
  typeFilteredCount: number;
}

export function applyAssemblyRendererLaneControls(input: {
  features: ReadonlyArray<Feature>;
  length: number;
  visibleTypes: ReadonlySet<string>;
  laneLimit: number | null;
  typeOrder?: ReadonlyArray<string>;
  spacerLanes?: number;
}): AssemblyRendererLaneControlResult {
  const filtered = input.features.filter((feature) => input.visibleTypes.has(layerType(feature)));
  const fixedFiniteNonCdsBands =
    input.laneLimit !== null && !input.visibleTypes.has('CDS')
      ? {
          bandTypes: [...input.visibleTypes],
          fixedBandCapacity: input.laneLimit,
        }
      : {};
  const { laneAssignments, localLaneAssignments, droppedCount } = assignFeatureLanesByType(
    filtered.map((feature) => ({
      start: feature.start,
      end: feature.end,
      type: layerType(feature),
    })),
    Math.max(1, Math.trunc(input.length)),
    {
      ...(input.laneLimit === null ? {} : { maxLanes: input.laneLimit }),
      ...(input.typeOrder ? { typeOrder: input.typeOrder } : {}),
      ...(input.spacerLanes === undefined ? {} : { spacerLanes: input.spacerLanes }),
      ...fixedFiniteNonCdsBands,
    }
  );
  const features: Feature[] = [];
  for (let index = 0; index < filtered.length; index += 1) {
    const lane = laneAssignments.get(index);
    if (lane === undefined) continue;
    const feature = filtered[index];
    features.push({
      ...feature,
      lane,
      annotationTrackId: layerType(feature),
      annotationTrackLane: localLaneAssignments.get(index) ?? lane,
      ...(input.laneLimit !== null && !input.visibleTypes.has('CDS')
        ? { annotationTrackLaneCapacity: input.laneLimit }
        : {}),
      qualifiers: {
        ...(feature.qualifiers ?? {}),
        _lane: String(lane),
      },
    });
  }
  return { features, droppedCount, typeFilteredCount: filtered.length };
}

export function hasCompleteIndexedAssemblyOverview(input: {
  assemblyByChrom: ReadonlyMap<string, ReadonlyArray<Feature>> | null | undefined;
  indexedChroms: ReadonlyArray<string>;
}): boolean {
  if (!input.assemblyByChrom || input.indexedChroms.length === 0) return false;
  const indexed = new Set(input.indexedChroms);
  return [...indexed].every((chrom) => input.assemblyByChrom!.has(chrom));
}

export function buildAssemblyComposedFeatures({
  rendererAssembly,
  assemblyByChrom,
  assemblyDetailByChrom,
  assemblyFeatures,
  visibleTypes,
  visibleChroms,
}: AssemblyRendererGenomeInput): ReadonlyArray<Feature> | null {
  if (!rendererAssembly) return null;
  const hasDetail = assemblyDetailByChrom.size > 0;
  if (!assemblyByChrom && !hasDetail) return assemblyFeatures ?? null;

  const merged: Feature[] = [];
  for (const placement of rendererAssembly.chromosomes) {
    const chrom = placement.chromosome.id;
    if (visibleChroms && !visibleChroms.has(chrom)) continue;
    const source = assemblyDetailByChrom.get(chrom) ?? assemblyByChrom?.get(chrom);
    if (!source) continue;
    const filtered = source.filter((feature) => visibleTypes.has(layerType(feature)));
    if (filtered.length === 0) continue;
    merged.push(...filtered);
  }
  return merged;
}

export function assemblyAnnotationLayerTypes(
  features: ReadonlyArray<Feature> | null | undefined,
  prebuiltLayerTypes: ReadonlyArray<string> = []
): string[] {
  const types = new Set<string>();
  for (const type of prebuiltLayerTypes) if (type) types.add(type);
  for (const feature of features ?? []) types.add(layerType(feature));
  return [...types].sort((a, b) => a.localeCompare(b));
}

export function buildAssemblyAnnotationScene(input: {
  rendererAssembly: Assembly | null | undefined;
  sourceIdentity?: string | null;
  features: ReadonlyArray<Feature> | null | undefined;
  payload: GenomeAnnotationGlyphPayload | null | undefined;
  annotationLayerTypes?: ReadonlyArray<string> | null | undefined;
  laneLimit?: number | null;
  prebuiltOverviewTextureManifest?: AssemblyOverviewTextureManifest | null | undefined;
  viewportRange: { start: number; end: number } | null | undefined;
  viewportWidthPx: number;
  viewportHeightPx: number;
  generation: number;
  payloadByteCount?: number;
}): IndexedGenomeScene | null {
  const assembly = input.rendererAssembly;
  if (!assembly) return null;
  const totalLength = Math.max(1, Math.trunc(assembly.totalLengthBp));
  const range = normalizeAssemblyViewport(input.viewportRange, totalLength);
  const sessionId = `assembly:${assembly.id}`;
  const annotationTrackId = `${assembly.id}:annotations`;
  const laneEpoch = assemblyLaneEpoch(assembly);
  const featureCount = input.features?.length ?? 0;
  const hasExplicitRequestedContract =
    input.annotationLayerTypes !== null && input.annotationLayerTypes !== undefined;
  const contractLayerTypes = hasExplicitRequestedContract
    ? assemblyAnnotationLayerTypes(null, input.annotationLayerTypes ?? [])
    : assemblyAnnotationLayerTypes(
        input.features,
        input.prebuiltOverviewTextureManifest?.layerTypes ?? []
      );
  const requestedLayerContract = annotationLayoutContractForLayerTypes(
    contractLayerTypes,
    input.laneLimit
  );
  const realizedFeatureContract = annotationLayoutForFeatures(input.features);
  const prebuiltContract = input.prebuiltOverviewTextureManifest
    ? {
        maxAnnotationLane: input.prebuiltOverviewTextureManifest.maxAnnotationLane,
        maxCdsLane: input.prebuiltOverviewTextureManifest.maxCdsLane,
        layerTypes: input.prebuiltOverviewTextureManifest.layerTypes,
      }
    : null;
  const finiteNonCdsContract =
    requestedLayerContract &&
    requestedLayerContract.maxAnnotationLane >= 0 &&
    requestedLayerContract.maxCdsLane < 0 &&
    input.laneLimit !== null &&
    input.laneLimit !== undefined;
  const realizedRequestedContract = requestedLayerContract
    ? {
        maxAnnotationLane:
          requestedLayerContract.maxAnnotationLane < 0
            ? -1
            : Math.max(
                realizedFeatureContract?.maxAnnotationLane ?? -1,
                prebuiltContract?.maxAnnotationLane ?? -1
              ),
        maxCdsLane:
          requestedLayerContract.maxCdsLane < 0
            ? -1
            : Math.max(
                realizedFeatureContract?.maxCdsLane ?? -1,
                prebuiltContract?.maxCdsLane ?? -1
              ),
      }
    : null;
  const annotationContract = finiteNonCdsContract
    ? {
        maxAnnotationLane: requestedLayerContract.maxAnnotationLane,
        maxCdsLane: -1,
        layerTypes: contractLayerTypes,
      }
    : realizedRequestedContract &&
        (realizedRequestedContract.maxAnnotationLane >= 0 ||
          realizedRequestedContract.maxCdsLane >= 0)
      ? {
          ...realizedRequestedContract,
          layerTypes: contractLayerTypes,
        }
      : !hasExplicitRequestedContract && prebuiltContract
        ? {
            maxAnnotationLane: prebuiltContract.maxAnnotationLane,
            maxCdsLane: prebuiltContract.maxCdsLane,
            layerTypes: contractLayerTypes,
          }
        : null;
  const hasAnnotationAuthority =
    Boolean(input.payload && featureCount > 0) || Boolean(prebuiltContract);
  const shell: GenomeSessionShell = {
    sessionId,
    sourcePath: `assembly:${assembly.id}`,
    sourceFingerprint: input.sourceIdentity?.trim() || assemblySourceFingerprint(assembly),
    chrom: assembly.id,
    openReady: true,
    coordinateReady: true,
    length: totalLength,
    validationState: 'strong_match',
    openedAt: 0,
    tracks: [
      {
        id: annotationTrackId,
        kind: 'annotation',
        label: 'Annotations',
        state: hasAnnotationAuthority ? 'ready' : 'coordinate_ready',
        userState:
          input.payload && featureCount > 0
            ? 'Showing overview'
            : prebuiltContract
              ? 'Showing overview'
              : 'Preparing',
      },
    ],
  };
  const tiles: GenomeTrackTile[] =
    input.payload && featureCount > 0
      ? [
          {
            sessionId,
            requestId: `assembly-detail:${Math.max(0, Math.trunc(input.generation))}`,
            trackId: annotationTrackId,
            chrom: assembly.id,
            start: range.start,
            end: range.end,
            generation: Math.max(0, Math.trunc(input.generation)),
            state: 'ready',
            fidelity: 'best_available',
            validationState: 'strong_match',
            cacheState: 'none',
            byteCount: input.payloadByteCount ?? estimatePayloadBytes(input.payload),
            recordCount: featureCount,
            sourceRecordCount: featureCount,
            layerTypes: [...new Set(input.features!.map((feature) => layerType(feature)))].sort(
              (a, b) => a.localeCompare(b)
            ),
            featureModel: input.payload.featureModel,
            laneEpoch,
            payload: input.payload,
          },
        ]
      : [];
  return buildIndexedGenomeScene({
    shell,
    viewport: {
      chrom: assembly.id,
      startBp: range.start,
      endBp: range.end,
      widthPx: Math.max(1, Math.floor(input.viewportWidthPx || 1)),
      heightPx: Math.max(1, Math.floor(input.viewportHeightPx || 1)),
      pixelsPerBp: Math.max(1, Math.floor(input.viewportWidthPx || 1)) / (range.end - range.start),
      generation: Math.max(0, Math.trunc(input.generation)),
    },
    tiles,
    laneEpoch,
    ...(annotationContract
      ? {
          annotationLayout: {
            maxAnnotationLane: annotationContract.maxAnnotationLane,
            maxCdsLane: annotationContract.maxCdsLane,
          },
          annotationLayerTypes: annotationContract.layerTypes,
        }
      : {}),
  });
}

function annotationLayoutContractForLayerTypes(
  layerTypes: ReadonlyArray<string>,
  laneLimit: number | null | undefined
): { maxAnnotationLane: number; maxCdsLane: number } | null {
  let hasAnnotationLayer = false;
  let hasCdsLayer = false;
  const annotationLayerTypes = new Set<string>();
  for (const type of layerTypes) {
    if (!type) continue;
    if (type === 'CDS') hasCdsLayer = true;
    else {
      hasAnnotationLayer = true;
      annotationLayerTypes.add(type);
    }
  }
  if (!hasAnnotationLayer && !hasCdsLayer) return null;
  const finiteAnnotationLaneCount =
    laneLimit !== null && laneLimit !== undefined
      ? annotationLayerTypes.size * laneLimit +
        Math.max(0, annotationLayerTypes.size - 1) * ANNOTATION_TYPE_SPACER_LANES
      : null;
  return {
    maxAnnotationLane:
      hasAnnotationLayer && finiteAnnotationLaneCount !== null
        ? finiteAnnotationLaneCount - 1
        : hasAnnotationLayer
          ? 0
          : -1,
    maxCdsLane: hasCdsLayer ? 0 : -1,
  };
}

function annotationLayoutForFeatures(
  features: ReadonlyArray<Feature> | null | undefined
): { maxAnnotationLane: number; maxCdsLane: number } | null {
  let maxAnnotationLane = -1;
  let maxCdsLane = -1;
  for (const feature of features ?? []) {
    if (feature.type === 'CDS') maxCdsLane = Math.max(maxCdsLane, feature.lane);
    else maxAnnotationLane = Math.max(maxAnnotationLane, feature.lane);
  }
  return maxAnnotationLane >= 0 || maxCdsLane >= 0 ? { maxAnnotationLane, maxCdsLane } : null;
}

export function assemblyAnnotationLayoutOwnershipKey(input: {
  laneLimit: number | null;
  requestedLayerTypes: ReadonlyArray<string>;
  realizedLayout: { maxAnnotationLane: number; maxCdsLane: number } | null | undefined;
}): string {
  return [
    'annotation-layout.v2',
    input.laneLimit === null ? 'all' : `finite:${input.laneLimit}`,
    [...new Set(input.requestedLayerTypes)].join(','),
    input.realizedLayout?.maxAnnotationLane ?? 'none',
    input.realizedLayout?.maxCdsLane ?? 'none',
  ].join(':');
}

function layerType(feature: Feature): string {
  return (
    feature.annotationTrackId ??
    annotationLayerType(feature as Parameters<typeof annotationLayerType>[0])
  );
}

function normalizeAssemblyViewport(
  viewportRange: { start: number; end: number } | null | undefined,
  totalLength: number
): { start: number; end: number } {
  const rawStart = viewportRange?.start ?? 0;
  const rawEnd = viewportRange?.end ?? totalLength;
  const start = Math.max(0, Math.min(totalLength - 1, Math.floor(rawStart)));
  const end = Math.max(start + 1, Math.min(totalLength, Math.ceil(rawEnd)));
  return { start, end };
}

function assemblySourceFingerprint(assembly: Assembly): string {
  return [
    'assembly-v1',
    assembly.id,
    ...assembly.chromosomes.map(
      (placement) =>
        `${placement.chromosome.id}:${placement.globalStartBp}:${placement.chromosome.length}`
    ),
  ].join('|');
}

function assemblyLaneEpoch(assembly: Assembly): string {
  return `${assemblySourceFingerprint(assembly)}:${assembly.id}:lane-v0`;
}

function estimatePayloadBytes(payload: GenomeAnnotationGlyphPayload): number {
  const serialized = JSON.stringify(payload);
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(serialized).byteLength;
  }
  return serialized.length;
}
