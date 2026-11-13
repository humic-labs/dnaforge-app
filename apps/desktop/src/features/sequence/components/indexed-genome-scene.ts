import type {
  GenomeTileRendererScene,
  GenomeTileRendererSlotPayload,
  GenomeTileRendererSlot,
  GenomeTileRendererTrack,
  GenomeTileRendererViewport,
} from '@waypoint/genome-renderer';
import type {
  GenomeSessionShell,
  GenomeTileCacheState,
  GenomeTileFidelity,
  GenomeTileState,
  GenomeTrackDescriptor,
  GenomeTrackState,
  GenomeTrackUserState,
  GenomeTrackTile,
  GenomeValidationState,
} from '../../../shared/indexed-genome';

export type IndexedGenomeLengthState = 'length_unknown' | 'coordinate_ready';

export interface IndexedGenomeSceneViewport extends GenomeTileRendererViewport {}

export interface IndexedGenomeSceneTrack extends GenomeTileRendererTrack<
  GenomeTrackState,
  GenomeTrackUserState,
  GenomeTrackDescriptor['kind']
> {}

export interface IndexedGenomeSceneTileSlot extends GenomeTileRendererSlot<
  GenomeTileState,
  GenomeTileFidelity,
  GenomeValidationState,
  GenomeTileCacheState,
  GenomeTrackDescriptor['kind']
> {}

export interface IndexedGenomeScene extends GenomeTileRendererScene<
  GenomeTrackState,
  GenomeTrackUserState,
  GenomeTileState,
  GenomeTileFidelity,
  GenomeValidationState,
  GenomeTileCacheState,
  GenomeTrackDescriptor['kind']
> {
  lengthState: IndexedGenomeLengthState;
  viewport: IndexedGenomeSceneViewport | null;
  tracks: IndexedGenomeSceneTrack[];
  tileSlots: IndexedGenomeSceneTileSlot[];
  annotationLayout?: {
    maxAnnotationLane: number;
    maxCdsLane: number;
  };
  annotationLayerTypes?: string[];
}

export interface IndexedGenomeSceneInvariantOptions {
  maxSequencePayloadBases?: number;
  maxAnnotationTileBytes?: number;
  maxAnnotationSummaryTileBytes?: number;
}

export interface IndexedGenomeSceneInvariantReport {
  ok: boolean;
  violations: string[];
  currentTileSlots: number;
  retainedTileSlots: number;
  sequencePayloadBases: number;
  annotationGlyphs: number;
  staleEpochSlotsDropped: number;
  maxSequencePayloadBases: number;
  maxAnnotationTileBytes: number;
  maxAnnotationSummaryTileBytes: number;
}

const DEFAULT_MAX_SEQUENCE_PAYLOAD_BASES = 512 * 1024;
const DEFAULT_MAX_ANNOTATION_TILE_BYTES = 512 * 1024;
const DEFAULT_MAX_ANNOTATION_SUMMARY_TILE_BYTES = 4_000_000;
const RAW_FEATURE_GLYPH_KEYS = new Set([
  'attributes',
  'chrom',
  'phase',
  'raw',
  'score',
  'source',
  'transcripts',
]);

export function buildIndexedGenomeScene(input: {
  shell: GenomeSessionShell;
  viewport?: IndexedGenomeSceneViewport | null;
  tiles?: GenomeTrackTile[];
  laneEpoch?: string;
  annotationLayout?: IndexedGenomeScene['annotationLayout'];
  annotationLayerTypes?: string[];
}): IndexedGenomeScene {
  const viewport = input.viewport ? normalizeViewport(input.viewport) : null;
  const tracks = input.shell.tracks.map((track) => ({ ...track }));

  return {
    mode: 'tile-native-session-shell',
    sessionId: input.shell.sessionId,
    sourceId: input.shell.sourcePath,
    sourceFingerprint: input.shell.sourceFingerprint,
    chrom: input.shell.chrom,
    lengthState: input.shell.coordinateReady ? 'coordinate_ready' : 'length_unknown',
    length:
      typeof input.shell.length === 'number' && Number.isFinite(input.shell.length)
        ? Math.max(0, Math.trunc(input.shell.length))
        : null,
    coordinateReady: input.shell.coordinateReady,
    validationState: input.shell.validationState,
    laneEpoch: input.laneEpoch ?? defaultLaneEpoch(input.shell),
    viewport,
    tracks,
    tileSlots: (input.tiles ?? [])
      .filter((tile) => tile.sessionId === input.shell.sessionId)
      .map((tile) =>
        buildTileSlot({
          tile,
          viewport,
          kind: kindForTrackId(tracks, tile.trackId),
        })
      ),
    ...(input.annotationLayout ? { annotationLayout: { ...input.annotationLayout } } : {}),
    ...(input.annotationLayerTypes && input.annotationLayerTypes.length > 0
      ? { annotationLayerTypes: normalizeAnnotationLayerTypes(input.annotationLayerTypes) }
      : {}),
  };
}

function normalizeAnnotationLayerTypes(layerTypes: readonly string[]): string[] {
  return [...new Set(layerTypes.map((type) => type.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

export function indexedGenomeSceneHasWholeFeaturePayload(scene: IndexedGenomeScene): boolean {
  return Object.values(scene as unknown as Record<string, unknown>).some(containsFeatureArray);
}

export function evaluateIndexedGenomeSceneInvariants(
  scene: IndexedGenomeScene,
  options: IndexedGenomeSceneInvariantOptions = {}
): IndexedGenomeSceneInvariantReport {
  const maxSequencePayloadBases =
    positiveInteger(options.maxSequencePayloadBases) ?? DEFAULT_MAX_SEQUENCE_PAYLOAD_BASES;
  const maxAnnotationTileBytes =
    positiveInteger(options.maxAnnotationTileBytes) ?? DEFAULT_MAX_ANNOTATION_TILE_BYTES;
  const maxAnnotationSummaryTileBytes =
    positiveInteger(options.maxAnnotationSummaryTileBytes) ??
    DEFAULT_MAX_ANNOTATION_SUMMARY_TILE_BYTES;
  const violations: string[] = [];
  let currentTileSlots = 0;
  let retainedTileSlots = 0;
  let sequencePayloadBases = 0;
  let annotationGlyphs = 0;
  let staleEpochSlotsDropped = 0;
  const sceneEpoch = scene.laneEpoch;

  if (indexedGenomeSceneHasWholeFeaturePayload(scene)) {
    violations.push('scene contains a whole GenomeFeature payload');
  }

  scene.tileSlots.forEach((slot, index) => {
    const slotLabel = `${slot.trackId}[${index}]`;
    if (slot.kind === 'annotation' && slot.laneEpoch !== sceneEpoch) {
      staleEpochSlotsDropped += 1;
    }
    if (
      !Number.isFinite(slot.startBp) ||
      !Number.isFinite(slot.endBp) ||
      slot.endBp <= slot.startBp
    ) {
      violations.push(`${slotLabel} has an invalid bp range`);
    }
    if (!Number.isFinite(slot.generation) || slot.generation < 0) {
      violations.push(`${slotLabel} has an invalid generation`);
    }
    const maxAnnotationBytes =
      slot.fidelity === 'summary' ? maxAnnotationSummaryTileBytes : maxAnnotationTileBytes;
    if (slot.byteCount > maxAnnotationBytes && slot.kind === 'annotation' && slot.payload) {
      violations.push(`${slotLabel} exceeds the annotation tile byte budget`);
    }

    if (slot.currentForViewport) {
      currentTileSlots += 1;
      validateCurrentSlot(slot, scene.viewport, slotLabel, violations);
    } else {
      retainedTileSlots += 1;
    }

    if (!slot.payload) return;
    if (slot.payload.type === 'sequence') {
      sequencePayloadBases += slot.payload.bases.length;
      validateSequencePayload(slot, slot.payload, slotLabel, maxSequencePayloadBases, violations);
      return;
    }
    annotationGlyphs += annotationPayloadGlyphCount(slot.payload);
    validateAnnotationGlyphPayload(slot, slot.payload, slotLabel, violations);
  });

  return {
    ok: violations.length === 0,
    violations,
    currentTileSlots,
    retainedTileSlots,
    sequencePayloadBases,
    annotationGlyphs,
    staleEpochSlotsDropped,
    maxSequencePayloadBases,
    maxAnnotationTileBytes,
    maxAnnotationSummaryTileBytes,
  };
}

function normalizeViewport(viewport: IndexedGenomeSceneViewport): IndexedGenomeSceneViewport {
  const start = Math.max(0, Math.floor(viewport.startBp));
  const end = Math.max(start + 1, Math.ceil(viewport.endBp));
  const widthPx = Math.max(1, Math.floor(viewport.widthPx));
  const heightPx = Math.max(1, Math.floor(viewport.heightPx));
  return {
    chrom: viewport.chrom,
    startBp: start,
    endBp: end,
    widthPx,
    heightPx,
    pixelsPerBp:
      Number.isFinite(viewport.pixelsPerBp) && viewport.pixelsPerBp > 0
        ? viewport.pixelsPerBp
        : widthPx / Math.max(1, end - start),
    generation: Math.max(0, Math.trunc(viewport.generation)),
  };
}

function buildTileSlot(input: {
  tile: GenomeTrackTile;
  viewport: IndexedGenomeSceneViewport | null;
  kind: GenomeTrackDescriptor['kind'];
}): IndexedGenomeSceneTileSlot {
  const payload = payloadForTile(input.tile);
  return {
    trackId: input.tile.trackId,
    kind: input.kind,
    chrom: input.tile.chrom,
    startBp: input.tile.start,
    endBp: input.tile.end,
    generation: input.tile.generation,
    state: input.tile.state,
    fidelity: input.tile.fidelity,
    validationState: input.tile.validationState,
    cacheState: input.tile.cacheState ?? 'none',
    byteCount: input.tile.byteCount,
    recordCount: input.tile.recordCount,
    ...(input.tile.layerTypes ? { layerTypes: [...input.tile.layerTypes] } : {}),
    currentForViewport: tileMatchesViewport(input.tile, input.viewport),
    ...(input.tile.laneEpoch !== undefined ? { laneEpoch: input.tile.laneEpoch } : {}),
    ...(payload ? { payload } : {}),
  };
}

function payloadForTile(tile: GenomeTrackTile): GenomeTileRendererSlotPayload | null {
  if (tile.payload?.type === 'sequence') {
    const startBp = Math.max(tile.start, Math.floor(tile.payload.startBp));
    const endBp = Math.min(tile.end, Math.ceil(tile.payload.endBp));
    if (endBp <= startBp || tile.payload.bases.length === 0) return null;
    return {
      type: 'sequence',
      startBp,
      endBp,
      bases: tile.payload.bases,
    };
  }
  if (tile.payload?.type === 'annotation-glyphs') {
    return {
      type: 'annotation-glyphs',
      featureModel: tile.payload.featureModel,
      glyphs: tile.payload.glyphs.map((glyph) => ({ ...glyph })),
      ...(tile.payload.compactGlyphs
        ? { compactGlyphs: tile.payload.compactGlyphs.map((glyph) => [...glyph]) }
        : {}),
      ...(tile.payload.compactGeometry
        ? { compactGeometry: tile.payload.compactGeometry.map((geometry) => [...geometry]) }
        : {}),
      ...(tile.payload.styleByType
        ? {
            styleByType: Object.fromEntries(
              Object.entries(tile.payload.styleByType).map(([type, style]) => [type, { ...style }])
            ),
          }
        : {}),
      ...(tile.payload.laneBounds ? { laneBounds: { ...tile.payload.laneBounds } } : {}),
      droppedCount: tile.payload.droppedCount,
      typeFilteredCount: tile.payload.typeFilteredCount,
    };
  }
  return null;
}

function tileMatchesViewport(
  tile: GenomeTrackTile,
  viewport: IndexedGenomeSceneViewport | null
): boolean {
  if (!viewport) return false;
  if (tile.chrom !== viewport.chrom) return false;
  if (tile.start >= viewport.endBp || tile.end <= viewport.startBp) return false;
  if (isUsableRetainedTileState(tile.state)) return true;
  return tile.generation === viewport.generation;
}

function kindForTrackId(
  tracks: IndexedGenomeSceneTrack[],
  trackId: string
): GenomeTrackDescriptor['kind'] {
  return tracks.find((track) => track.id === trackId)?.kind ?? 'annotation';
}

function defaultLaneEpoch(shell: GenomeSessionShell): string {
  return `${shell.sourceFingerprint}:${shell.chrom}:lane-v0`;
}

function positiveInteger(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function validateCurrentSlot(
  slot: IndexedGenomeSceneTileSlot,
  viewport: IndexedGenomeSceneViewport | null,
  slotLabel: string,
  violations: string[]
): void {
  if (!viewport) {
    violations.push(`${slotLabel} is current without a viewport`);
    return;
  }
  if (slot.chrom !== viewport.chrom) {
    violations.push(`${slotLabel} is current for a different chromosome`);
  }
  if (!isUsableRetainedTileState(slot.state) && slot.generation !== viewport.generation) {
    violations.push(`${slotLabel} is current for a stale pending generation`);
  }
  if (slot.startBp >= viewport.endBp || slot.endBp <= viewport.startBp) {
    violations.push(`${slotLabel} is current outside the viewport`);
  }
}

function isUsableRetainedTileState(state: GenomeTileState): boolean {
  return state === 'ready' || state === 'empty' || state === 'retained';
}

function validateSequencePayload(
  slot: IndexedGenomeSceneTileSlot,
  payload: Extract<GenomeTileRendererSlotPayload, { type: 'sequence' }>,
  slotLabel: string,
  maxSequencePayloadBases: number,
  violations: string[]
): void {
  if (slot.kind !== 'sequence') {
    violations.push(`${slotLabel} carries sequence payload on a non-sequence row`);
  }
  if (
    payload.startBp < slot.startBp ||
    payload.endBp > slot.endBp ||
    payload.endBp <= payload.startBp
  ) {
    violations.push(`${slotLabel} has a sequence payload outside its tile range`);
  }
  if (
    payload.bases.length > maxSequencePayloadBases ||
    payload.endBp - payload.startBp > maxSequencePayloadBases
  ) {
    violations.push(`${slotLabel} exceeds the sequence payload budget`);
  }
  if (slot.recordCount > maxSequencePayloadBases || slot.byteCount > maxSequencePayloadBases) {
    violations.push(`${slotLabel} exceeds the sequence tile budget`);
  }
}

function validateAnnotationGlyphPayload(
  slot: IndexedGenomeSceneTileSlot,
  payload: Extract<GenomeTileRendererSlotPayload, { type: 'annotation-glyphs' }>,
  slotLabel: string,
  violations: string[]
): void {
  if (slot.kind !== 'annotation') {
    violations.push(`${slotLabel} carries annotation glyphs on a non-annotation row`);
  }
  payload.glyphs.forEach((glyph, glyphIndex) => {
    const glyphRecord = glyph as unknown as Record<string, unknown>;
    for (const key of Object.keys(glyphRecord)) {
      if (RAW_FEATURE_GLYPH_KEYS.has(key)) {
        violations.push(`${slotLabel}.glyphs[${glyphIndex}] contains raw feature key "${key}"`);
        break;
      }
    }
    if (
      !Number.isFinite(glyph.startBp) ||
      !Number.isFinite(glyph.endBp) ||
      glyph.endBp <= glyph.startBp
    ) {
      violations.push(`${slotLabel}.glyphs[${glyphIndex}] has an invalid bp range`);
    }
  });
  (payload.compactGlyphs ?? []).forEach((glyph, glyphIndex) => {
    const [, , , startBp, endBp] = glyph;
    if (!Number.isFinite(startBp) || !Number.isFinite(endBp) || endBp <= startBp) {
      violations.push(`${slotLabel}.compactGlyphs[${glyphIndex}] has an invalid bp range`);
    }
  });
  (payload.compactGeometry ?? []).forEach((geometry, geometryIndex) => {
    const [, exonRanges, cdsRanges] = geometry;
    validateFlatBpRanges(
      exonRanges,
      `${slotLabel}.compactGeometry[${geometryIndex}].exonRanges`,
      violations
    );
    if (cdsRanges) {
      validateFlatBpRanges(
        cdsRanges,
        `${slotLabel}.compactGeometry[${geometryIndex}].cdsRanges`,
        violations
      );
    }
  });
}

function validateFlatBpRanges(labelRanges: number[], label: string, violations: string[]): void {
  if (labelRanges.length % 2 !== 0) {
    violations.push(`${label} has an odd number of coordinates`);
    return;
  }
  for (let i = 0; i + 1 < labelRanges.length; i += 2) {
    const start = labelRanges[i];
    const end = labelRanges[i + 1];
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      violations.push(`${label}[${i / 2}] has an invalid bp range`);
    }
  }
}

function annotationPayloadGlyphCount(
  payload: Extract<GenomeTileRendererSlotPayload, { type: 'annotation-glyphs' }>
): number {
  return payload.glyphs.length + (payload.compactGlyphs?.length ?? 0);
}

function containsFeatureArray(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => isGenomeFeatureShape(entry) || containsFeatureArray(entry));
  }
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some(containsFeatureArray);
}

function isGenomeFeatureShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.chrom === 'string' &&
    typeof record.type === 'string' &&
    typeof record.start === 'number' &&
    typeof record.end === 'number' &&
    typeof record.raw === 'string'
  );
}
