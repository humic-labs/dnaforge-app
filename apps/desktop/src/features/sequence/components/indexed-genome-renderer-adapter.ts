import type {
  Feature,
  Genome,
  GenomeTileRendererAnnotationGlyph,
  GenomeTileRendererAnnotationGlyphPayload,
} from '@waypoint/genome-renderer';
import { featureTypeColor } from '@waypoint/genome-renderer';
import { rendererFeatureCandidateFromAnnotationGlyph } from '../../../shared/indexed-genome-annotation-feature-mapper';
import type { IndexedGenomeScene, IndexedGenomeSceneTileSlot } from './indexed-genome-scene';
import { mergeWithTransitionContinuity } from './annotation-tile-transition';

const TRANSCRIPT_PRESENTATION_GLYPH_TYPES: ReadonlySet<string> = new Set([
  'mRNA',
  'transcript',
  'ncRNA',
  'lnc_RNA',
  'lncRNA',
]);

export interface IndexedGenomeRendererAdapterOptions {
  includeSequenceWindow?: boolean;
  previousLaneAssignments?: ReadonlyMap<number, number>;
  enableTransitionRetention?: boolean;
  previousAnnotationFeatures?: ReadonlyMap<string, Feature>;
}

export function featureRetentionIdentity(
  f: Pick<Feature, 'type' | 'annotationTrackId' | 'direction' | 'transcriptId' | 'qualifiers'>
): string | null {
  const id = f.transcriptId ?? f.qualifiers?.ID ?? null;
  if (!id) return null;
  return [f.annotationTrackId ?? f.type, f.type, id, f.direction].join('|');
}

export function indexedGenomeSceneToRendererGenome(
  scene: IndexedGenomeScene,
  options: IndexedGenomeRendererAdapterOptions = {}
): Genome {
  const includeSequenceWindow = options.includeSequenceWindow ?? true;
  const sequenceSlot = includeSequenceWindow ? currentSequencePayloadSlot(scene) : null;
  const features = constrainFeaturesToExplicitAnnotationLayout(
    currentAnnotationFeatures(scene, options),
    scene.annotationLayout
  );
  const annotationLayout = authoritativeAnnotationLayout(
    scene.annotationLayout,
    currentAnnotationLayout(features)
  );
  const annotationLayerTypes = currentAnnotationLayerTypes(scene, features);
  return {
    name: scene.chrom,
    sourceIdentity: scene.sourceFingerprint,
    length: scene.length ?? inferredSceneLength(scene),
    circular: false,
    ...(annotationLayout ? { annotationLayout } : {}),
    ...(annotationLayerTypes.length > 0 ? { annotationLayerTypes } : {}),
    features,
    sequence: undefined,
    ...(sequenceSlot?.payload?.type === 'sequence'
      ? {
          sequenceWindow: {
            startBp: sequenceSlot.payload.startBp,
            bases: sequenceSlot.payload.bases,
          },
        }
      : {}),
  };
}

function currentSequencePayloadSlot(scene: IndexedGenomeScene): IndexedGenomeSceneTileSlot | null {
  return (
    scene.tileSlots.find(
      (slot) =>
        slot.kind === 'sequence' &&
        slot.currentForViewport &&
        slot.state === 'ready' &&
        slot.fidelity === 'exact' &&
        slot.payload?.type === 'sequence'
    ) ?? null
  );
}

function currentAnnotationLayerTypes(
  scene: IndexedGenomeScene,
  features: readonly Feature[]
): string[] {
  const layerTypes = new Set<string>();
  if (scene.annotationLayerTypes && scene.annotationLayerTypes.length > 0) {
    for (const layerType of scene.annotationLayerTypes) {
      if (layerType) layerTypes.add(layerType);
    }
  }
  for (const slot of annotationPayloadSlotsForRenderer(scene)) {
    for (const layerType of slot.layerTypes ?? []) {
      if (layerType) layerTypes.add(layerType);
    }
  }
  for (const feature of features) {
    const layerType = feature.annotationTrackId ?? feature.type;
    if (layerType) layerTypes.add(layerType);
  }
  return [...layerTypes].sort((a, b) => a.localeCompare(b));
}

function authoritativeAnnotationLayout(
  explicit: Genome['annotationLayout'] | null | undefined,
  inferred: Genome['annotationLayout'] | null | undefined
): Genome['annotationLayout'] | null {
  return explicit ?? inferred ?? null;
}

function constrainFeaturesToExplicitAnnotationLayout(
  features: Feature[],
  explicit: Genome['annotationLayout'] | null | undefined
): Feature[] {
  if (!explicit) return features;
  return features.filter((feature) => {
    if (!Number.isSafeInteger(feature.lane) || feature.lane < 0) return false;
    const maxLane = feature.type === 'CDS' ? explicit.maxCdsLane : explicit.maxAnnotationLane;
    return feature.lane <= maxLane;
  });
}

function currentAnnotationFeatures(
  scene: IndexedGenomeScene,
  options: IndexedGenomeRendererAdapterOptions
): Feature[] {
  const featuresByKey = new Map<string, Feature>();
  const keyByGlyphId = new Map<string, string>();
  const payloadSlots = annotationPayloadSlotsForRenderer(scene);
  const preserveAuthoritativePayloadMultiplicity = payloadSlots.length === 1;
  let authoritativePayloadOrdinal = 0;
  const detailReplacementRanges = currentDetailAnnotationReplacementRanges(scene);
  let activeRangeStart = Number.POSITIVE_INFINITY;
  let activeRangeEnd = Number.NEGATIVE_INFINITY;
  for (const slot of payloadSlots) {
    if (slot.payload?.type !== 'annotation-glyphs') continue;
    if (slot.startBp < activeRangeStart) activeRangeStart = slot.startBp;
    if (slot.endBp > activeRangeEnd) activeRangeEnd = slot.endBp;
    const suppressOverviewGlyphs =
      detailReplacementRanges.length > 0 && isOverviewAnnotationSlot(slot, scene);
    for (const glyph of annotationGlyphsFromPayload(slot, scene)) {
      if (suppressOverviewGlyphs && glyphOverlapsAnyRange(glyph, detailReplacementRanges)) {
        continue;
      }
      const color = slot.payload.styleByType?.[glyph.trackId ?? glyph.type]?.color ?? glyph.color;
      const exons = glyph.exons && glyph.exons.length > 0 ? glyph.exons : [];
      if (
        slot.fidelity !== 'summary' &&
        TRANSCRIPT_PRESENTATION_GLYPH_TYPES.has(glyph.type) &&
        exons.length === 0
      ) {
        continue;
      }
      const candidate = rendererFeatureCandidateFromAnnotationGlyph({
        glyph,
        genomeIdentity: scene.sourceFingerprint,
        genomeName: scene.chrom,
        color,
      });
      if (preserveAuthoritativePayloadMultiplicity) {
        featuresByKey.set(`authoritative-payload|${authoritativePayloadOrdinal}`, candidate);
        authoritativePayloadOrdinal += 1;
        continue;
      }
      const key = stableGlyphMergeKey(glyph);
      const aliasKey = `${glyph.id}|${glyph.trackId ?? glyph.type}|${glyph.type}|${glyph.strand}`;
      const aliasedKey = keyByGlyphId.get(aliasKey);
      const existingKey = featuresByKey.has(key)
        ? key
        : aliasedKey && featuresByKey.has(aliasedKey)
          ? aliasedKey
          : null;
      const existing = existingKey ? featuresByKey.get(existingKey) : undefined;
      if (existing && !candidateIsMoreComplete(candidate, existing)) {
        keyByGlyphId.set(aliasKey, existingKey ?? key);
        continue;
      }
      if (existingKey && existingKey !== key) featuresByKey.delete(existingKey);
      featuresByKey.set(key, candidate);
      keyByGlyphId.set(aliasKey, key);
    }
  }

  const previous =
    options.enableTransitionRetention === false ? undefined : options.previousAnnotationFeatures;
  const activeRange = annotationRetentionActiveRange(
    detailReplacementRanges,
    activeRangeStart,
    activeRangeEnd
  );
  const mergedFeaturesByKey =
    previous && previous.size > 0
      ? mergeWithTransitionContinuity({
          current: featuresByKey,
          previous,
          activeRange,
          identityOf: featureRetentionIdentity,
        })
      : featuresByKey;
  if (detailReplacementRanges.length > 0) {
    for (const [key, feature] of mergedFeaturesByKey) {
      if (!key.startsWith('retained|')) continue;
      if (featureOverlapsAnyRange(feature, detailReplacementRanges)) {
        mergedFeaturesByKey.delete(key);
      }
    }
  }

  const merged = [...mergedFeaturesByKey.values()].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.id - b.id
  );

  resolveCrossTileLaneCollisions(merged, options.previousLaneAssignments);
  if (options.enableTransitionRetention === false) {
    for (let featureIndex = 0; featureIndex < merged.length; featureIndex += 1) {
      merged[featureIndex].id = featureIndex;
    }
  }
  return merged;
}

function resolveCrossTileLaneCollisions(
  features: Feature[],
  previousLaneAssignments?: ReadonlyMap<number, number>
): void {
  const laneEndsByTrack = new Map<string, Map<number, number>>();
  const surviving: Feature[] = [];

  for (const f of features) {
    if (typeof f.lane !== 'number') continue;
    const pool = f.type === 'CDS' ? 'cds' : 'annotation';
    const finiteTrackCapacity =
      Number.isSafeInteger(f.annotationTrackLaneCapacity) &&
      (f.annotationTrackLaneCapacity ?? 0) > 0
        ? f.annotationTrackLaneCapacity!
        : null;
    const trackAware = Boolean(
      f.annotationTrackId &&
      Number.isSafeInteger(f.annotationTrackLane) &&
      (f.annotationTrackLane ?? -1) >= 0 &&
      finiteTrackCapacity !== null
    );
    const trackKey = trackAware ? `${pool}:${f.annotationTrackId}` : `${pool}:legacy-shared-pool`;
    let lanes = laneEndsByTrack.get(trackKey);
    if (!lanes) {
      lanes = new Map<number, number>();
      laneEndsByTrack.set(trackKey, lanes);
    }

    const sourceLocalLane = trackAware ? (f.annotationTrackLane ?? f.lane) : f.lane;
    const globalLaneBase = trackAware ? f.lane - sourceLocalLane : 0;
    const previousGlobalLane = previousLaneAssignments?.get(f.id);
    const previousLocalLane =
      previousGlobalLane === undefined ? null : previousGlobalLane - globalLaneBase;
    const capacity = trackAware ? finiteTrackCapacity! : Number.POSITIVE_INFINITY;
    let localLane =
      previousLocalLane !== null && previousLocalLane >= 0 && previousLocalLane < capacity
        ? previousLocalLane
        : sourceLocalLane;

    while (localLane < capacity) {
      const existingEnd = lanes.get(localLane);
      if (existingEnd === undefined || existingEnd <= f.start) break;
      localLane += 1;
    }
    if (localLane >= capacity) continue;

    const globalLane = globalLaneBase + localLane;
    f.lane = globalLane;
    if (f.type === 'CDS') f.cdsLane = globalLane;
    if (trackAware) f.annotationTrackLane = localLane;
    if (f.qualifiers) f.qualifiers._lane = String(globalLane);
    lanes.set(localLane, f.end);
    surviving.push(f);
  }
  features.splice(0, features.length, ...surviving);
}

export function buildLaneAssignmentMap(features: Iterable<Feature>): Map<number, number> {
  const out = new Map<number, number>();
  for (const f of features) {
    if (typeof f.lane === 'number') out.set(f.id, f.lane);
  }
  return out;
}

function readyAnnotationPayloadSlots(scene: IndexedGenomeScene): IndexedGenomeSceneTileSlot[] {
  const currentEpoch = scene.laneEpoch;
  return scene.tileSlots.filter(
    (slot) =>
      slot.kind === 'annotation' &&
      (slot.state === 'ready' || slot.state === 'empty') &&
      slot.payload?.type === 'annotation-glyphs' &&
      slot.laneEpoch === currentEpoch
  );
}

function annotationPayloadSlotsForRenderer(
  scene: IndexedGenomeScene
): IndexedGenomeSceneTileSlot[] {
  const readyPayloadSlots = readyAnnotationPayloadSlots(scene);
  const viewport = scene.viewport;
  const currentReadyDetailSlots = readyPayloadSlots.filter(
    (slot) => slot.currentForViewport && slot.fidelity !== 'summary'
  );
  const visibleSlots = viewport
    ? readyPayloadSlots.filter((slot) => {
        if (!slotOverlapsViewport(slot, viewport)) return false;
        if (isOverviewAnnotationSlot(slot, scene)) return true;
        if (currentReadyDetailSlots.length > 0) return slot.currentForViewport;
        return true;
      })
    : readyPayloadSlots.filter((slot) => slot.currentForViewport);
  return visibleSlots.sort((a, b) => annotationSlotPriority(a) - annotationSlotPriority(b));
}

function currentDetailAnnotationReplacementRanges(
  scene: IndexedGenomeScene
): Array<{ chrom: string; startBp: number; endBp: number }> {
  const currentEpoch = scene.laneEpoch;
  const viewport = scene.viewport;
  return scene.tileSlots
    .filter((slot) => {
      if (slot.kind !== 'annotation') return false;
      if (!slot.currentForViewport) return false;
      if (slot.state !== 'ready' && slot.state !== 'empty') return false;
      if (slot.fidelity === 'summary') return false;
      if (slot.laneEpoch !== currentEpoch) return false;
      if (isOverviewAnnotationSlot(slot, scene)) return false;
      if (viewport && !slotOverlapsViewport(slot, viewport)) return false;
      return slot.endBp > slot.startBp;
    })
    .map((slot) => ({ chrom: slot.chrom, startBp: slot.startBp, endBp: slot.endBp }));
}

function annotationRetentionActiveRange(
  detailReplacementRanges: ReadonlyArray<{ startBp: number; endBp: number }>,
  activeRangeStart: number,
  activeRangeEnd: number
): { start: number; end: number } | null {
  if (detailReplacementRanges.length > 0) {
    const start = Math.min(...detailReplacementRanges.map((range) => range.startBp));
    const end = Math.max(...detailReplacementRanges.map((range) => range.endBp));
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
  }
  return Number.isFinite(activeRangeStart) && Number.isFinite(activeRangeEnd)
    ? { start: activeRangeStart, end: activeRangeEnd }
    : null;
}

function slotOverlapsViewport(
  slot: IndexedGenomeSceneTileSlot,
  viewport: NonNullable<IndexedGenomeScene['viewport']>
): boolean {
  if (slot.chrom !== viewport.chrom) return false;
  return slot.startBp < viewport.endBp && slot.endBp > viewport.startBp;
}

function glyphOverlapsViewport(
  glyph: { startBp: number; endBp: number },
  viewport: NonNullable<IndexedGenomeScene['viewport']>
): boolean {
  return glyph.startBp < viewport.endBp && glyph.endBp > viewport.startBp;
}

function glyphOverlapsAnyRange(
  glyph: { startBp: number; endBp: number },
  ranges: ReadonlyArray<{ startBp: number; endBp: number }>
): boolean {
  return ranges.some((range) => glyph.startBp < range.endBp && glyph.endBp > range.startBp);
}

function featureOverlapsAnyRange(
  feature: Pick<Feature, 'start' | 'end'>,
  ranges: ReadonlyArray<{ startBp: number; endBp: number }>
): boolean {
  return ranges.some((range) => feature.start < range.endBp && feature.end > range.startBp);
}

function annotationSlotPriority(slot: IndexedGenomeSceneTileSlot): number {
  if (
    slot.fidelity === 'summary' ||
    (slot.payload?.type === 'annotation-glyphs' && slot.payload.compactGlyphs)
  ) {
    return 0;
  }
  if (slot.fidelity === 'best_available') return 1;
  if (slot.fidelity === 'exact') return 2;
  return 3;
}

function candidateIsMoreComplete(candidate: Feature, existing: Feature): boolean {
  const candidateSpan = candidate.end - candidate.start;
  const existingSpan = existing.end - existing.start;
  if (candidateSpan !== existingSpan) return candidateSpan > existingSpan;
  const candidateExons = candidate.exons?.length ?? 0;
  const existingExons = existing.exons?.length ?? 0;
  return candidateExons > existingExons;
}

function stableGlyphMergeKey(glyph: {
  id: string;
  type: string;
  trackId?: string;
  label: string;
  startBp: number;
  endBp: number;
  strand: '+' | '-' | '.';
  transcriptId?: string;
}): string {
  const idKey = glyph.transcriptId ?? glyph.id;
  return [idKey, glyph.trackId ?? glyph.type, glyph.type, glyph.strand].join('|');
}

function annotationGlyphsFromPayload(
  slot: IndexedGenomeSceneTileSlot,
  scene: IndexedGenomeScene
): GenomeTileRendererAnnotationGlyph[] {
  if (slot.payload?.type !== 'annotation-glyphs') return [];
  const payload = slot.payload;
  const compactGeometryById = new Map(
    (payload.compactGeometry ?? []).map((geometry) => [geometry[0], geometry] as const)
  );
  const compactGlyphs = (payload.compactGlyphs ?? []).map(
    ([id, type, label, startBp, endBp, strand, lane, trackId, trackLane, trackLaneCapacity]) => {
      const trackMetadata = normalizedAnnotationTrackMetadata(
        trackId,
        trackLane,
        trackLaneCapacity
      );
      return compactGlyphWithGeometry({
        id,
        type,
        label,
        startBp,
        endBp,
        strand,
        lane,
        ...trackMetadata,
        color:
          payload.styleByType?.[trackMetadata.trackId ?? type]?.color ?? featureTypeColor(type),
        geometry: compactGeometryById.get(id),
      });
    }
  );
  const glyphs = [...compactGlyphs, ...payload.glyphs.map(normalizeGlyphTrackMetadata)];
  if (!isOverviewAnnotationSlot(slot, scene) || !scene.viewport) {
    return glyphs;
  }
  return glyphs.filter((glyph) => glyphOverlapsViewport(glyph, scene.viewport!));
}

function compactGlyphWithGeometry(input: {
  id: string;
  type: string;
  label: string;
  startBp: number;
  endBp: number;
  strand: '+' | '-' | '.';
  lane: number;
  trackId?: string;
  trackLane?: number;
  trackLaneCapacity?: number;
  color: number;
  geometry:
    | NonNullable<GenomeTileRendererAnnotationGlyphPayload['compactGeometry']>[number]
    | undefined;
}): GenomeTileRendererAnnotationGlyph {
  const glyph: GenomeTileRendererAnnotationGlyph = {
    id: input.id,
    type: input.type,
    label: input.label,
    startBp: input.startBp,
    endBp: input.endBp,
    strand: input.strand,
    lane: input.lane,
    ...(input.trackId ? { trackId: input.trackId } : {}),
    ...(input.trackLane == null ? {} : { trackLane: input.trackLane }),
    ...(input.trackLaneCapacity == null ? {} : { trackLaneCapacity: input.trackLaneCapacity }),
    color: input.color,
  };
  const geometry = input.geometry;
  if (!geometry) return glyph;
  const exonRanges = rangesFromFlatArray(geometry[1]);
  const cdsRanges = rangesFromFlatArray(geometry[2]);
  if (exonRanges.length > 0) glyph.exons = exonRanges;
  if (geometry.length >= 3) glyph.cds = cdsRanges;
  if (geometry.length >= 4 && geometry[3]) glyph.transcriptId = geometry[3];
  return glyph;
}

function normalizedAnnotationTrackMetadata(
  trackId: unknown,
  trackLane: unknown,
  trackLaneCapacity: unknown
): { trackId?: string; trackLane?: number; trackLaneCapacity?: number } {
  if (typeof trackId !== 'string' || trackId.length === 0) return {};
  if (!Number.isSafeInteger(trackLane) || (trackLane as number) < 0) return { trackId };
  const normalized = { trackId, trackLane: trackLane as number };
  return Number.isSafeInteger(trackLaneCapacity) &&
    (trackLaneCapacity as number) > normalized.trackLane
    ? { ...normalized, trackLaneCapacity: trackLaneCapacity as number }
    : normalized;
}

function normalizeGlyphTrackMetadata(
  glyph: GenomeTileRendererAnnotationGlyph
): GenomeTileRendererAnnotationGlyph {
  const trackMetadata = normalizedAnnotationTrackMetadata(
    glyph.trackId,
    glyph.trackLane,
    glyph.trackLaneCapacity
  );
  if (
    trackMetadata.trackId === glyph.trackId &&
    trackMetadata.trackLane === glyph.trackLane &&
    trackMetadata.trackLaneCapacity === glyph.trackLaneCapacity
  ) {
    return glyph;
  }
  const normalized = { ...glyph };
  delete normalized.trackId;
  delete normalized.trackLane;
  delete normalized.trackLaneCapacity;
  return Object.assign(normalized, trackMetadata);
}

function rangesFromFlatArray(
  flatRanges: ReadonlyArray<number> | undefined
): Array<{ start: number; end: number }> {
  if (!flatRanges) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + 1 < flatRanges.length; i += 2) {
    const start = flatRanges[i];
    const end = flatRanges[i + 1];
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    ranges.push({ start, end });
  }
  return ranges;
}

function isOverviewAnnotationSlot(
  slot: IndexedGenomeSceneTileSlot,
  scene: IndexedGenomeScene
): boolean {
  if (slot.kind !== 'annotation' || slot.payload?.type !== 'annotation-glyphs') return false;
  if (slot.fidelity === 'summary') return true;
  const sceneLength = scene.length ?? slot.endBp;
  return (
    slot.startBp <= 0 && slot.endBp >= sceneLength && (slot.payload.compactGlyphs?.length ?? 0) > 0
  );
}

function currentAnnotationLayout(
  features: ReadonlyArray<Feature>
): Genome['annotationLayout'] | null {
  let maxAnnotationLane = -1;
  let maxCdsLane = -1;
  for (const feature of features) {
    if (feature.type === 'CDS') maxCdsLane = Math.max(maxCdsLane, feature.lane);
    else maxAnnotationLane = Math.max(maxAnnotationLane, feature.lane);
  }
  return maxAnnotationLane >= 0 || maxCdsLane >= 0 ? { maxAnnotationLane, maxCdsLane } : null;
}

function inferredSceneLength(scene: IndexedGenomeScene): number {
  return Math.max(
    1,
    scene.viewport?.endBp ?? 0,
    ...scene.tileSlots.map((slot) => Math.max(0, slot.endBp))
  );
}
