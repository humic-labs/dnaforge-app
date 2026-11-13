import {
  assignFeatureLanes,
  assignFeatureLanesByType,
  featureTypeColor,
  type AssignFeatureLanesByTypeResult,
  type Feature,
} from '@waypoint/genome-renderer/pure';
import type { GenomeFeature, ResolvedAnnotation, ResolvedTranscript } from '@waypoint/genome-data';

import type {
  GenomeAnnotationCompactGlyphGeometryPayloadItem,
  GenomeAnnotationCompactGlyphPayloadItem,
  GenomeAnnotationFeatureModel,
  GenomeAnnotationGlyphPayload,
  GenomeAnnotationGlyphPayloadItem,
} from '../../../shared/indexed-genome';
import {
  annotationLayerType,
  isLayerIdentityAttributeKey,
  uniqueAnnotationLayerTypes,
} from '../annotation-layer-identity';
import {
  joinLocationString,
  resolveSplicedFeatures,
  resolveTranscripts,
} from './spliced-feature-resolver';

export type LaneLimit = number | null;

export type FilteredRendererFeatureResult = {
  features: Feature[];
  droppedCount: number;
  typeFilteredCount: number;
  featureStats?: RendererAnnotationFeatureStats;
};

export interface RendererAnnotationFeatureStats {
  featureCount: number;
  transcriptCount: number;
  codingTranscriptCount: number;
  multiExonTranscriptCount: number;
  exonCount: number;
  cdsCount: number;
}

export type AnnotationGlyphPayloadResult = Pick<
  GenomeAnnotationGlyphPayload,
  | 'glyphs'
  | 'compactGlyphs'
  | 'compactGeometry'
  | 'styleByType'
  | 'laneBounds'
  | 'droppedCount'
  | 'typeFilteredCount'
>;

function localLanesForAssignment(result: {
  laneAssignments: Map<number, number>;
}): Map<number, number> {
  return 'localLaneAssignments' in result
    ? (result as AssignFeatureLanesByTypeResult).localLaneAssignments
    : result.laneAssignments;
}

export interface AnnotationSummaryGlyphOptions {
  chrom: string;
  viewportRange: { start: number; end: number };
  widthPx: number;
  maxGlyphs?: number;
  maxPayloadBytes?: number;
  featureModel?: GenomeAnnotationFeatureModel;
}

export interface TranscriptCarrierFeature extends GenomeFeature {
  compositeKind?: ResolvedTranscript['compositeKind'];
  _resolvedExons?: ReadonlyArray<{ start: number; end: number }>;
  _resolvedCds?: ReadonlyArray<{ start: number; end: number }>;
  _resolvedTranscriptId?: string;
  _resolvedTranslation?: string;
}

export interface RendererAnnotationIdentityProjection {
  rendererFeatureId: number;
  sourceId: string;
  transcriptId: string | null;
  annotationTrackId: string;
  type: string;
  start: number;
  end: number;
  direction: Feature['direction'];
}

export function applyDensityControls(
  sourceFeatures: GenomeFeature[],
  chrom: string,
  length: number,
  visibleTypes: ReadonlySet<string>,
  laneLimit: LaneLimit,
  laneStacking: AnnotationLaneStackingOptions = {}
): FilteredRendererFeatureResult {
  const filteredRaw = sourceFeatures.filter(
    (f) => f.chrom === chrom && visibleTypes.has(annotationLayerType(f))
  );
  const laneOptions = laneLimit === null ? undefined : { maxLanes: laneLimit };
  const laneResult = laneStacking.groupByType
    ? assignFeatureLanesByType(
        filteredRaw.map((f) => ({
          start: f.start,
          end: f.end,
          type: annotationLayerType(f),
        })),
        length,
        {
          ...(laneOptions ?? {}),
          ...(laneStacking.typeOrder ? { typeOrder: laneStacking.typeOrder } : {}),
          ...(laneStacking.spacerLanes !== undefined
            ? { spacerLanes: laneStacking.spacerLanes }
            : {}),
          ...fixedFiniteNonCdsBandOptions(visibleTypes, laneLimit),
        }
      )
    : assignFeatureLanes(
        filteredRaw.map((f) => ({ start: f.start, end: f.end })),
        length,
        laneOptions
      );
  const { laneAssignments, droppedCount } = laneResult;
  const localLaneAssignments = localLanesForAssignment(laneResult);
  const trackLaneCapacity =
    laneStacking.groupByType && laneLimit !== null && !visibleTypes.has('CDS')
      ? laneLimit
      : undefined;
  const surviving: Array<{
    feature: GenomeFeature;
    lane: number;
    trackLane: number;
    trackLaneCapacity?: number;
  }> = [];
  for (let i = 0; i < filteredRaw.length; i++) {
    const lane = laneAssignments.get(i);
    if (lane != null) {
      surviving.push({
        feature: filteredRaw[i],
        lane,
        trackLane: localLaneAssignments.get(i) ?? lane,
        ...(trackLaneCapacity === undefined ? {} : { trackLaneCapacity }),
      });
    }
  }
  const built = buildRendererFeatures(chrom, surviving);
  return {
    features: built.features,
    droppedCount,
    typeFilteredCount: filteredRaw.length,
    featureStats: built.featureStats,
  };
}

export interface AnnotationLaneStackingOptions {
  groupByType?: boolean;
  typeOrder?: ReadonlyArray<string>;
  spacerLanes?: number;
}

function fixedFiniteNonCdsBandOptions(
  visibleTypes: ReadonlySet<string>,
  laneLimit: LaneLimit
): { bandTypes?: string[]; fixedBandCapacity?: number } {
  if (laneLimit === null || visibleTypes.has('CDS')) return {};
  return {
    bandTypes: [...visibleTypes],
    fixedBandCapacity: laneLimit,
  };
}

export function buildAnnotationGlyphPayload(
  sourceFeatures: GenomeFeature[],
  chrom: string,
  length: number,
  visibleTypes: ReadonlySet<string>,
  laneLimit: LaneLimit,
  laneStacking: AnnotationLaneStackingOptions = {}
): AnnotationGlyphPayloadResult {
  const filteredRaw = sourceFeatures.filter(
    (f) => f.chrom === chrom && visibleTypes.has(annotationLayerType(f))
  );
  const laneOptions = laneLimit === null ? undefined : { maxLanes: laneLimit };
  const laneResult = laneStacking.groupByType
    ? assignFeatureLanesByType(
        filteredRaw.map((f) => ({
          start: f.start,
          end: f.end,
          type: annotationLayerType(f),
        })),
        length,
        {
          ...(laneOptions ?? {}),
          ...(laneStacking.typeOrder ? { typeOrder: laneStacking.typeOrder } : {}),
          ...(laneStacking.spacerLanes !== undefined
            ? { spacerLanes: laneStacking.spacerLanes }
            : {}),
          ...fixedFiniteNonCdsBandOptions(visibleTypes, laneLimit),
        }
      )
    : assignFeatureLanes(
        filteredRaw.map((f) => ({ start: f.start, end: f.end })),
        length,
        laneOptions
      );
  const { laneAssignments, droppedCount } = laneResult;
  const localLaneAssignments = localLanesForAssignment(laneResult);
  const glyphs: GenomeAnnotationGlyphPayloadItem[] = [];
  for (let i = 0; i < filteredRaw.length; i++) {
    const lane = laneAssignments.get(i);
    if (lane == null) continue;
    const feature = filteredRaw[i];
    glyphs.push({
      id: stableAnnotationFeatureKey(feature),
      type: feature.type,
      trackId: annotationLayerType(feature),
      trackLane: localLaneAssignments.get(i) ?? lane,
      ...(laneStacking.groupByType && laneLimit !== null && !visibleTypes.has('CDS')
        ? { trackLaneCapacity: laneLimit }
        : {}),
      label: featureDisplayName(feature),
      startBp: feature.start,
      endBp: feature.end,
      strand: feature.strand,
      lane,
      color: featureTypeColor(feature.type),
      ...annotationGlyphDetailFields(feature),
    });
  }
  return { glyphs, droppedCount, typeFilteredCount: filteredRaw.length };
}

export function buildAnnotationGlyphPayloadWithStableLanes(
  sourceFeatures: GenomeFeature[],
  chrom: string,
  length: number,
  visibleTypes: ReadonlySet<string>,
  laneLimit: LaneLimit,
  stableLaneSource: FilteredRendererFeatureResult | null,
  laneStacking: AnnotationLaneStackingOptions = {}
): AnnotationGlyphPayloadResult {
  if (!stableLaneSource) {
    return buildAnnotationGlyphPayload(
      sourceFeatures,
      chrom,
      length,
      visibleTypes,
      laneLimit,
      laneStacking
    );
  }
  const stableLaneByGlyphKey = new Map<
    string,
    Pick<
      Feature,
      'lane' | 'annotationTrackId' | 'annotationTrackLane' | 'annotationTrackLaneCapacity'
    >
  >();
  for (const feature of stableLaneSource.features) {
    for (const key of stableRendererLaneKeys(feature)) {
      if (!stableLaneByGlyphKey.has(key)) {
        stableLaneByGlyphKey.set(key, {
          lane: feature.lane,
          annotationTrackId: feature.annotationTrackId,
          annotationTrackLane: feature.annotationTrackLane,
          annotationTrackLaneCapacity: feature.annotationTrackLaneCapacity,
        });
      }
    }
  }
  const filteredRaw = sourceFeatures.filter(
    (f) => f.chrom === chrom && visibleTypes.has(annotationLayerType(f))
  );
  const laneOptions = laneLimit === null ? undefined : { maxLanes: laneLimit };
  const laneResult = laneStacking.groupByType
    ? assignFeatureLanesByType(
        filteredRaw.map((f) => ({
          start: f.start,
          end: f.end,
          type: annotationLayerType(f),
        })),
        length,
        {
          ...(laneOptions ?? {}),
          ...(laneStacking.typeOrder ? { typeOrder: laneStacking.typeOrder } : {}),
          ...(laneStacking.spacerLanes !== undefined
            ? { spacerLanes: laneStacking.spacerLanes }
            : {}),
          ...fixedFiniteNonCdsBandOptions(visibleTypes, laneLimit),
        }
      )
    : assignFeatureLanes(
        filteredRaw.map((f) => ({ start: f.start, end: f.end })),
        length,
        laneOptions
      );
  const { laneAssignments, droppedCount } = laneResult;
  const localLaneAssignments = localLanesForAssignment(laneResult);
  const glyphs: GenomeAnnotationGlyphPayloadItem[] = [];
  for (let i = 0; i < filteredRaw.length; i++) {
    const fallbackLane = laneAssignments.get(i);
    if (fallbackLane == null) continue;
    const fallbackFeature = rendererFeatureFromGenomeFeature(
      filteredRaw[i],
      fallbackLane,
      localLaneAssignments.get(i) ?? fallbackLane,
      laneStacking.groupByType && laneLimit !== null && !visibleTypes.has('CDS')
        ? laneLimit
        : undefined
    );
    const stableLane = firstDefinedLaneOwnership(
      stableRendererLaneKeys(fallbackFeature),
      stableLaneByGlyphKey
    );
    const feature = stableLane
      ? rendererFeatureFromGenomeFeature(
          filteredRaw[i],
          stableLane.lane,
          stableLane.annotationTrackLane ?? stableLane.lane,
          stableLane.annotationTrackLaneCapacity
        )
      : fallbackFeature;
    glyphs.push(fullGlyphFromRendererFeature(feature));
  }
  return {
    glyphs,
    droppedCount: droppedCount + Math.max(0, filteredRaw.length - droppedCount - glyphs.length),
    typeFilteredCount: filteredRaw.length,
  };
}

export function annotationGlyphPayloadFromRendererFeatures(
  result: FilteredRendererFeatureResult
): AnnotationGlyphPayloadResult {
  return {
    droppedCount: result.droppedCount,
    typeFilteredCount: result.typeFilteredCount,
    glyphs: result.features.map((feature) => fullGlyphFromRendererFeature(feature)),
  };
}

export function annotationSummaryGlyphPayloadFromRendererFeatures(
  result: FilteredRendererFeatureResult,
  options: AnnotationSummaryGlyphOptions
): AnnotationGlyphPayloadResult {
  const maxGlyphs = positiveInteger(options.maxGlyphs) ?? 2_048;
  const summaryGlyphs = result.features.map((feature) => summaryGlyphFromRendererFeature(feature));
  const viewportStart = Math.max(0, Math.floor(options.viewportRange.start));
  const viewportEnd = Math.max(viewportStart + 1, Math.ceil(options.viewportRange.end));
  const visibleBp = viewportEnd - viewportStart;
  const guardBp = visibleBp;
  const guardedStart = Math.max(0, viewportStart - guardBp);
  const guardedEnd = viewportEnd + guardBp;
  const candidateGlyphs = summaryGlyphs.filter(
    (glyph) => glyph.startBp < guardedEnd && glyph.endBp > guardedStart
  );
  const glyphsForViewport = candidateGlyphs.length > 0 ? candidateGlyphs : summaryGlyphs;
  const selectedRichGlyphs =
    glyphsForViewport.length <= maxGlyphs
      ? glyphsForViewport
      : selectRepresentativeSummaryGlyphs(glyphsForViewport, maxGlyphs);

  if (
    selectedRichGlyphs.length === result.features.length &&
    estimateAnnotationGlyphPayloadByteCount({
      type: 'annotation-glyphs',
      featureModel: options.featureModel ?? 'resolved-transcript-v2',
      droppedCount: result.droppedCount,
      typeFilteredCount: result.typeFilteredCount,
      glyphs: selectedRichGlyphs,
      styleByType: styleByTypeForFeatures(result.features),
      laneBounds: laneBoundsForFeatures(result.features),
    }) <= (positiveInteger(options.maxPayloadBytes) ?? Number.POSITIVE_INFINITY)
  ) {
    return {
      droppedCount: result.droppedCount,
      typeFilteredCount: result.typeFilteredCount,
      glyphs: selectedRichGlyphs,
      styleByType: styleByTypeForFeatures(result.features),
      laneBounds: laneBoundsForFeatures(result.features),
    };
  }

  const fitted = fitSummaryGlyphsByByteBudget(
    glyphsForViewport,
    result.features,
    result,
    options,
    maxGlyphs
  );
  return {
    droppedCount: result.droppedCount,
    typeFilteredCount: result.typeFilteredCount,
    glyphs: fitted.glyphs,
    ...(fitted.compactGlyphs.length > 0 ? { compactGlyphs: fitted.compactGlyphs } : {}),
    ...(fitted.compactGeometry.length > 0 ? { compactGeometry: fitted.compactGeometry } : {}),
    styleByType: styleByTypeForFeatures(result.features),
    laneBounds: laneBoundsForFeatures(result.features),
  };
}

export function estimateAnnotationGlyphPayloadByteCount(
  payload: GenomeAnnotationGlyphPayload | null
): number {
  if (!payload) return 0;
  let bytes = 96;
  if (payload.styleByType) {
    for (const key in payload.styleByType) bytes += 22 + key.length;
  }
  if (payload.laneBounds) bytes += 48;

  const glyphs = payload.glyphs;
  if (glyphs) {
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i];
      bytes += 104 + g.id.length + g.type.length + g.label.length;
      if (g.trackId) bytes += 13 + g.trackId.length;
      if (g.trackLane !== undefined) bytes += 13 + decimalIntegerByteCount(g.trackLane);
      if (g.trackLaneCapacity !== undefined) {
        bytes += 21 + decimalIntegerByteCount(g.trackLaneCapacity);
      }
      if (g.exons) bytes += 12 + g.exons.length * 34;
      if (g.cds) bytes += 10 + g.cds.length * 34;
      if (g.transcriptId) bytes += 19 + g.transcriptId.length;
    }
  }

  const compactGlyphs = payload.compactGlyphs;
  if (compactGlyphs) {
    for (let i = 0; i < compactGlyphs.length; i++) {
      const c = compactGlyphs[i];
      bytes += 42 + c[0].length + c[1].length + c[2].length;
      if (c[7] !== undefined) bytes += 3 + c[7].length;
      if (c[8] !== undefined) bytes += 1 + decimalIntegerByteCount(c[8]);
      if (c[9] !== undefined) bytes += 1 + decimalIntegerByteCount(c[9]);
    }
  }

  const compactGeometry = payload.compactGeometry;
  if (compactGeometry) {
    for (let i = 0; i < compactGeometry.length; i++) {
      const item = compactGeometry[i] as ReadonlyArray<unknown>;
      const id = item[0];
      if (typeof id === 'string') bytes += 12 + id.length;
      const exonRanges = item[1];
      if (Array.isArray(exonRanges)) bytes += exonRanges.length * 10;
      const cdsRanges = item[2];
      if (Array.isArray(cdsRanges)) bytes += cdsRanges.length * 10;
      const transcriptId = item[3];
      if (typeof transcriptId === 'string') bytes += transcriptId.length + 4;
    }
  }
  return bytes;
}

export function uniqueFeatureTypes(features: GenomeFeature[]): string[] {
  return uniqueAnnotationLayerTypes(features);
}

export function resolveAnnotationFeaturesForViewer(
  features: GenomeFeature[],
  featureModel: GenomeAnnotationFeatureModel,
  glyphV2Enabled: boolean
): TranscriptCarrierFeature[] {
  if (featureModel === 'resolved-transcript-v2') {
    return flattenResolvedAnnotations(features as ResolvedAnnotation[]);
  }
  return glyphV2Enabled
    ? flattenResolvedAnnotations(resolveTranscripts(features))
    : resolveSplicedFeatures(features);
}

export function pickSpliceDemoFeature(features: GenomeFeature[]): GenomeFeature | null {
  let best: GenomeFeature | null = null;
  let bestSpan = Infinity;
  for (const f of features) {
    if (!isSpliceDemoTranscriptType(f.type)) continue;
    const carrier = f as GenomeFeature & {
      segments?: ReadonlyArray<unknown>;
      _resolvedExons?: ReadonlyArray<unknown>;
      _resolvedCds?: ReadonlyArray<unknown>;
    };
    const exons = carrier._resolvedExons ?? carrier.segments;
    const cds = carrier._resolvedCds;
    if (!cds || cds.length === 0) continue;
    const segCount = exons?.length ?? 0;
    if (segCount < 3) continue;
    const span = f.end - f.start;
    if (span < 800) continue;
    if (span < bestSpan) {
      best = f;
      bestSpan = span;
    }
  }
  return best;
}

function flattenResolvedAnnotations(annotations: ResolvedAnnotation[]): TranscriptCarrierFeature[] {
  const out: TranscriptCarrierFeature[] = [];
  for (const a of annotations) {
    if ('transcripts' in a && Array.isArray((a as { transcripts: unknown }).transcripts)) {
      const gene = a as GenomeFeature & { transcripts: ReadonlyArray<ResolvedTranscript> };
      if (isPseudogeneRecord(gene)) {
        const { transcripts, ...locus } = gene;
        if (transcripts.length === 0) {
          out.push({ ...locus, type: PSEUDOGENE_LAYER_TYPE } as TranscriptCarrierFeature);
          continue;
        }
        for (const t of transcripts) {
          out.push({
            ...transcriptCarrierFeatureForRendererIdentity(t),
            type: PSEUDOGENE_LAYER_TYPE,
            attributes: { ...t.attributes, ...layerIdentityAttributes(gene.attributes) },
          });
        }
        continue;
      }
      for (const t of gene.transcripts) {
        out.push(transcriptCarrierFeatureForRendererIdentity(t));
      }
    } else if ('exons' in a && 'cds' in a && Array.isArray((a as { exons: unknown }).exons)) {
      out.push(transcriptCarrierFeatureForRendererIdentity(a));
    } else {
      out.push(a as TranscriptCarrierFeature);
    }
  }
  return out;
}

const PSEUDOGENE_LAYER_TYPE = 'pseudogene';

function isPseudogeneRecord(feature: GenomeFeature): boolean {
  const attributes = feature.attributes ?? {};
  return (
    feature.type === 'pseudogene' ||
    attributes.pseudo?.some((value) => value.toLowerCase() === 'true') === true ||
    attributes.gene_biotype?.some((value) => value.toLowerCase() === 'pseudogene') === true
  );
}

function layerIdentityAttributes(
  attributes: Record<string, string[]> | undefined
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(attributes ?? {}).filter(([key]) => isLayerIdentityAttributeKey(key))
  );
}

export function transcriptCarrierFeatureForRendererIdentity(
  feature: ResolvedAnnotation
): TranscriptCarrierFeature {
  if (
    !(
      'exons' in feature &&
      'cds' in feature &&
      'transcriptId' in feature &&
      Array.isArray(feature.exons)
    )
  ) {
    return feature as TranscriptCarrierFeature;
  }
  const transcript = feature as ResolvedTranscript;
  return {
    ...transcript,
    _resolvedExons: transcript.exons,
    _resolvedCds: transcript.cds,
    _resolvedTranscriptId: transcript.transcriptId,
    _resolvedTranslation: transcript.translation,
  };
}

function stableAnnotationFeatureKey(feature: GenomeFeature): string {
  const id =
    feature.attributes.ID?.[0] ??
    feature.attributes.transcript_id?.[0] ??
    feature.attributes.Name?.[0] ??
    '';
  return [feature.type, id, feature.chrom, feature.start, feature.end, feature.strand].join('|');
}

function annotationGlyphDetailFields(
  feature: GenomeFeature & {
    segments?: ReadonlyArray<{ start: number; end: number }>;
    _resolvedExons?: ReadonlyArray<{ start: number; end: number }>;
    _resolvedCds?: ReadonlyArray<{ start: number; end: number }>;
    _resolvedTranscriptId?: string;
    _resolvedTranslation?: string;
    compositeKind?: ResolvedTranscript['compositeKind'];
  }
): Partial<GenomeAnnotationGlyphPayloadItem> {
  const qualifiers = collapseFirstAttributes(feature.attributes);
  const exons = transcriptExonsForGenomeFeature(feature);
  if (feature._resolvedTranslation) {
    qualifiers.translation = feature._resolvedTranslation;
  }
  if (feature.segments && feature.segments.length > 1) {
    qualifiers._locationString = joinLocationString([...feature.segments]);
  }
  return {
    ...(exons && exons.length > 0 ? { exons } : {}),
    ...(feature._resolvedCds ? { cds: feature._resolvedCds } : {}),
    ...(feature._resolvedTranscriptId ? { transcriptId: feature._resolvedTranscriptId } : {}),
    qualifiers,
  };
}

function summaryRendererGlyphKey(feature: Feature): string {
  return feature.id.toString(36);
}

function stableRendererLaneKeys(feature: Feature): string[] {
  const span = [
    feature.annotationTrackId ?? feature.type,
    feature.type,
    feature.start,
    feature.end,
    feature.direction,
  ].join('|');
  const keys = new Set<string>();
  const id = feature.qualifiers?.ID;
  if (id) keys.add(`id|${id}|${span}`);
  if (feature.transcriptId) keys.add(`tx|${feature.transcriptId}|${span}`);
  keys.add(`label|${feature.displayName}|${span}`);
  keys.add(`span|${span}`);
  return [...keys];
}

function firstDefinedLaneOwnership<T>(
  keys: string[],
  lanes: ReadonlyMap<string, T>
): T | undefined {
  for (const key of keys) {
    const lane = lanes.get(key);
    if (lane != null) return lane;
  }
  return undefined;
}

function fullGlyphFromRendererFeature(feature: Feature): GenomeAnnotationGlyphPayloadItem {
  const exons = transcriptExonsForRendererFeature(feature);
  return {
    id: summaryRendererGlyphKey(feature),
    type: feature.type,
    ...(feature.annotationTrackId ? { trackId: feature.annotationTrackId } : {}),
    ...(feature.annotationTrackLane === undefined
      ? {}
      : { trackLane: feature.annotationTrackLane }),
    ...(feature.annotationTrackLaneCapacity === undefined
      ? {}
      : { trackLaneCapacity: feature.annotationTrackLaneCapacity }),
    label: feature.displayName,
    startBp: feature.start,
    endBp: feature.end,
    strand: strandForDirection(feature.direction),
    lane: feature.lane,
    color: feature.color,
    ...(exons && exons.length > 0 ? { exons } : {}),
    ...(feature.cds ? { cds: feature.cds } : {}),
    ...(feature.transcriptId ? { transcriptId: feature.transcriptId } : {}),
    ...(feature.qualifiers ? { qualifiers: { ...feature.qualifiers } } : {}),
  };
}

function summaryGlyphFromRendererFeature(feature: Feature): GenomeAnnotationGlyphPayloadItem {
  const exons = transcriptExonsForRendererFeature(feature);
  return {
    id: summaryRendererGlyphKey(feature),
    type: feature.type,
    ...(feature.annotationTrackId ? { trackId: feature.annotationTrackId } : {}),
    ...(feature.annotationTrackLane === undefined
      ? {}
      : { trackLane: feature.annotationTrackLane }),
    ...(feature.annotationTrackLaneCapacity === undefined
      ? {}
      : { trackLaneCapacity: feature.annotationTrackLaneCapacity }),
    label: feature.displayName,
    startBp: feature.start,
    endBp: feature.end,
    strand: strandForDirection(feature.direction),
    lane: feature.lane,
    color: feature.color,
    ...(exons && exons.length > 0 ? { exons } : {}),
    ...(feature.cds ? { cds: feature.cds } : {}),
    ...(feature.transcriptId ? { transcriptId: feature.transcriptId } : {}),
  };
}

function compactSummaryGlyphFromRendererFeature(
  feature: Feature
): GenomeAnnotationCompactGlyphPayloadItem {
  const glyph: GenomeAnnotationCompactGlyphPayloadItem = [
    summaryRendererGlyphKey(feature),
    feature.type,
    feature.displayName,
    feature.start,
    feature.end,
    strandForDirection(feature.direction),
    feature.lane,
  ];
  if (feature.annotationTrackId) {
    glyph.push(feature.annotationTrackId);
    if (feature.annotationTrackLane !== undefined) {
      glyph.push(feature.annotationTrackLane);
      if (feature.annotationTrackLaneCapacity !== undefined) {
        glyph.push(feature.annotationTrackLaneCapacity);
      }
    }
  }
  return glyph;
}

function decimalIntegerByteCount(value: number): number {
  if (!Number.isFinite(value)) return 4;
  const absolute = Math.abs(Math.trunc(value));
  const digits = absolute === 0 ? 1 : Math.floor(Math.log10(absolute)) + 1;
  return digits + (value < 0 ? 1 : 0);
}

function selectRepresentativeSummaryGlyphs(
  glyphs: GenomeAnnotationGlyphPayloadItem[],
  maxGlyphs: number
): GenomeAnnotationGlyphPayloadItem[] {
  if (maxGlyphs <= 0) return [];
  if (glyphs.length <= maxGlyphs) return glyphs;
  const sorted = [...glyphs].sort(
    (a, b) =>
      a.startBp - b.startBp ||
      a.endBp - b.endBp ||
      a.lane - b.lane ||
      a.type.localeCompare(b.type) ||
      a.id.localeCompare(b.id)
  );
  const selected: GenomeAnnotationGlyphPayloadItem[] = [];
  for (let i = 0; i < maxGlyphs; i += 1) {
    selected.push(sorted[Math.floor((i * sorted.length) / maxGlyphs)]);
  }
  return selected;
}

function fitSummaryGlyphsByByteBudget(
  richSourceGlyphs: GenomeAnnotationGlyphPayloadItem[],
  allFeatures: Feature[],
  result: FilteredRendererFeatureResult,
  options: AnnotationSummaryGlyphOptions,
  maxGlyphs: number
): {
  glyphs: GenomeAnnotationGlyphPayloadItem[];
  compactGlyphs: GenomeAnnotationCompactGlyphPayloadItem[];
  compactGeometry: GenomeAnnotationCompactGlyphGeometryPayloadItem[];
} {
  const maxPayloadBytes = positiveInteger(options.maxPayloadBytes);
  const compactById = new Map(
    allFeatures.map((feature) => [
      summaryRendererGlyphKey(feature),
      compactSummaryGlyphFromRendererFeature(feature),
    ])
  );
  const compactGeometryById = compactGeometryByGlyphId(richSourceGlyphs);
  if (richSourceGlyphs.length === 0) {
    return { glyphs: [], compactGlyphs: [...compactById.values()], compactGeometry: [] };
  }
  if (!maxPayloadBytes) {
    const glyphs = selectRepresentativeSummaryGlyphs(richSourceGlyphs, maxGlyphs);
    return {
      glyphs,
      compactGlyphs: compactFallbackGlyphs(compactById, glyphs),
      compactGeometry: compactFallbackGeometry(compactGeometryById, glyphs),
    };
  }
  let low = 1;
  let high = Math.max(1, Math.min(maxGlyphs, richSourceGlyphs.length));
  let best: {
    glyphs: GenomeAnnotationGlyphPayloadItem[];
    compactGlyphs: GenomeAnnotationCompactGlyphPayloadItem[];
    compactGeometry: GenomeAnnotationCompactGlyphGeometryPayloadItem[];
  } = {
    glyphs: [],
    compactGlyphs: [...compactById.values()],
    compactGeometry: [...compactGeometryById.values()],
  };
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const glyphs = selectRepresentativeSummaryGlyphs(richSourceGlyphs, mid);
    const compactGlyphs = compactFallbackGlyphs(compactById, glyphs);
    const compactGeometry = compactFallbackGeometry(compactGeometryById, glyphs);
    const byteCount = estimateAnnotationGlyphPayloadByteCount({
      type: 'annotation-glyphs',
      featureModel: options.featureModel ?? 'resolved-transcript-v2',
      droppedCount: result.droppedCount,
      typeFilteredCount: result.typeFilteredCount,
      glyphs,
      compactGlyphs,
      compactGeometry,
      styleByType: styleByTypeForFeatures(allFeatures),
      laneBounds: laneBoundsForFeatures(allFeatures),
    });
    if (byteCount <= maxPayloadBytes) {
      best = { glyphs, compactGlyphs, compactGeometry };
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (
    estimateAnnotationGlyphPayloadByteCount({
      type: 'annotation-glyphs',
      featureModel: options.featureModel ?? 'resolved-transcript-v2',
      droppedCount: result.droppedCount,
      typeFilteredCount: result.typeFilteredCount,
      glyphs: best.glyphs,
      compactGlyphs: best.compactGlyphs,
      compactGeometry: best.compactGeometry,
      styleByType: styleByTypeForFeatures(allFeatures),
      laneBounds: laneBoundsForFeatures(allFeatures),
    }) <= maxPayloadBytes
  ) {
    return best;
  }
  return {
    glyphs: [],
    compactGlyphs: [...compactById.values()],
    compactGeometry: [...compactGeometryById.values()],
  };
}

function compactFallbackGlyphs(
  compactById: ReadonlyMap<string, GenomeAnnotationCompactGlyphPayloadItem>,
  richGlyphs: ReadonlyArray<GenomeAnnotationGlyphPayloadItem>
): GenomeAnnotationCompactGlyphPayloadItem[] {
  if (richGlyphs.length === 0) return [...compactById.values()];
  const richIds = new Set(richGlyphs.map((glyph) => glyph.id));
  const compactGlyphs: GenomeAnnotationCompactGlyphPayloadItem[] = [];
  for (const [id, compact] of compactById) {
    if (!richIds.has(id)) compactGlyphs.push(compact);
  }
  return compactGlyphs;
}

function compactGeometryByGlyphId(
  glyphs: ReadonlyArray<GenomeAnnotationGlyphPayloadItem>
): Map<string, GenomeAnnotationCompactGlyphGeometryPayloadItem> {
  const byId = new Map<string, GenomeAnnotationCompactGlyphGeometryPayloadItem>();
  for (const glyph of glyphs) {
    const compact = compactGeometryFromGlyph(glyph);
    if (compact) byId.set(glyph.id, compact);
  }
  return byId;
}

function compactGeometryFromGlyph(
  glyph: GenomeAnnotationGlyphPayloadItem
): GenomeAnnotationCompactGlyphGeometryPayloadItem | null {
  const exonRanges = flattenRanges(glyph.exons);
  const cdsRanges = flattenRanges(glyph.cds);
  if (exonRanges.length === 0 && cdsRanges.length === 0) return null;
  if (glyph.transcriptId) return [glyph.id, exonRanges, cdsRanges, glyph.transcriptId];
  if (cdsRanges.length > 0) return [glyph.id, exonRanges, cdsRanges];
  return [glyph.id, exonRanges];
}

function compactFallbackGeometry(
  compactGeometryById: ReadonlyMap<string, GenomeAnnotationCompactGlyphGeometryPayloadItem>,
  richGlyphs: ReadonlyArray<GenomeAnnotationGlyphPayloadItem>
): GenomeAnnotationCompactGlyphGeometryPayloadItem[] {
  if (richGlyphs.length === 0) return [...compactGeometryById.values()];
  const richIds = new Set(richGlyphs.map((glyph) => glyph.id));
  const compactGeometry: GenomeAnnotationCompactGlyphGeometryPayloadItem[] = [];
  for (const [id, geometry] of compactGeometryById) {
    if (!richIds.has(id)) compactGeometry.push(geometry);
  }
  return compactGeometry;
}

function flattenRanges(
  ranges: ReadonlyArray<{ start: number; end: number }> | undefined
): number[] {
  const flattened: number[] = [];
  for (const range of ranges ?? []) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) {
      continue;
    }
    flattened.push(range.start, range.end);
  }
  return flattened;
}

function styleByTypeForFeatures(
  features: ReadonlyArray<Feature>
): Record<string, { color: number }> {
  const styles: Record<string, { color: number }> = {};
  for (const feature of features) {
    const trackId = feature.annotationTrackId ?? feature.type;
    if (!styles[trackId]) styles[trackId] = { color: feature.color };
  }
  return styles;
}

function laneBoundsForFeatures(
  features: ReadonlyArray<Feature>
): NonNullable<GenomeAnnotationGlyphPayload['laneBounds']> {
  let maxAnnotationLane = -1;
  let maxCdsLane = -1;
  for (const feature of features) {
    if (feature.type === 'CDS') maxCdsLane = Math.max(maxCdsLane, feature.lane);
    else maxAnnotationLane = Math.max(maxAnnotationLane, feature.lane);
  }
  return { maxAnnotationLane, maxCdsLane };
}

function isSpliceDemoTranscriptType(type: string): boolean {
  return type === 'mRNA' || type === 'transcript';
}

function buildRendererFeatures(
  chrom: string,
  sourceFeatures: Array<{
    feature: GenomeFeature & {
      segments?: Array<{ start: number; end: number }>;
      _resolvedExons?: ReadonlyArray<{ start: number; end: number }>;
      _resolvedCds?: ReadonlyArray<{ start: number; end: number }>;
      _resolvedTranscriptId?: string;
      _resolvedTranslation?: string;
      compositeKind?: ResolvedTranscript['compositeKind'];
    };
    lane: number;
    trackLane: number;
    trackLaneCapacity?: number;
  }>
): { features: Feature[]; featureStats: RendererAnnotationFeatureStats } {
  const featureStats: RendererAnnotationFeatureStats = {
    featureCount: 0,
    transcriptCount: 0,
    codingTranscriptCount: 0,
    multiExonTranscriptCount: 0,
    exonCount: 0,
    cdsCount: 0,
  };
  const features = sourceFeatures
    .filter(({ feature }) => feature.chrom === chrom)
    .map(({ feature, lane, trackLane, trackLaneCapacity }) => {
      const rendered = rendererFeatureFromGenomeFeature(
        feature,
        lane,
        trackLane,
        trackLaneCapacity
      );
      const exons = rendered.exons ?? [];
      const cds = rendered.cds ?? [];
      featureStats.featureCount += 1;
      if (rendered.type === 'mRNA' || rendered.type === 'transcript') {
        featureStats.transcriptCount += 1;
        if (cds.length > 0) featureStats.codingTranscriptCount += 1;
        if (exons.length > 1) featureStats.multiExonTranscriptCount += 1;
      }
      featureStats.exonCount += exons.length;
      featureStats.cdsCount += cds.length;
      return rendered;
    })
    .sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id);
  return { features, featureStats };
}

function rendererFeatureFromGenomeFeature(
  feature: GenomeFeature & {
    segments?: Array<{ start: number; end: number }>;
    _resolvedExons?: ReadonlyArray<{ start: number; end: number }>;
    _resolvedCds?: ReadonlyArray<{ start: number; end: number }>;
    _resolvedTranscriptId?: string;
    _resolvedTranslation?: string;
    compositeKind?: ResolvedTranscript['compositeKind'];
  },
  lane: number,
  trackLane: number = lane,
  trackLaneCapacity?: number
): Feature {
  const identity = rendererAnnotationIdentityProjection(feature);
  const qualifiers = collapseFirstAttributes(feature.attributes);
  const exons = transcriptExonsForGenomeFeature(feature);
  if (feature._resolvedTranslation) {
    qualifiers.translation = feature._resolvedTranslation;
  }
  if (feature.segments && feature.segments.length > 1) {
    qualifiers._locationString = joinLocationString(feature.segments);
  }
  return {
    id: identity.rendererFeatureId,
    type: feature.type,
    annotationTrackId: identity.annotationTrackId,
    start: identity.start,
    end: identity.end,
    direction: identity.direction,
    displayName: featureDisplayName(feature),
    color: featureTypeColor(feature.type),
    lane,
    annotationTrackLane: trackLane,
    ...(trackLaneCapacity === undefined ? {} : { annotationTrackLaneCapacity: trackLaneCapacity }),
    ...(feature.type === 'CDS' ? { cdsLane: lane } : {}),
    ...(feature.segments && feature.segments.length > 1 ? { segments: feature.segments } : {}),
    ...(exons && exons.length > 0 ? { exons } : {}),
    ...(feature._resolvedCds ? { cds: feature._resolvedCds } : {}),
    ...(feature.compositeKind ? { compositeKind: feature.compositeKind } : {}),
    ...(identity.transcriptId ? { transcriptId: identity.transcriptId } : {}),
    qualifiers,
  };
}

export function rendererAnnotationIdentityProjection(
  feature: TranscriptCarrierFeature
): RendererAnnotationIdentityProjection {
  const rendererFeatureId = stableRendererFeatureId(feature);
  const bounds = normalizedTranscriptBounds(feature);
  return {
    rendererFeatureId,
    sourceId: rendererFeatureId.toString(36),
    transcriptId: feature._resolvedTranscriptId ?? null,
    annotationTrackId: annotationLayerType(feature),
    type: feature.type,
    start: bounds.start,
    end: bounds.end,
    direction: directionForStrand(feature.strand),
  };
}

function normalizedTranscriptBounds(
  feature: GenomeFeature & {
    _resolvedExons?: ReadonlyArray<{ start: number; end: number }>;
    _resolvedCds?: ReadonlyArray<{ start: number; end: number }>;
  }
): { start: number; end: number } {
  const parts = [...(feature._resolvedExons ?? []), ...(feature._resolvedCds ?? [])];
  if (parts.length === 0) return { start: feature.start, end: feature.end };
  return {
    start: Math.max(0, Math.min(feature.start, ...parts.map((part) => part.start - 1))),
    end: Math.max(feature.end, ...parts.map((part) => part.end)),
  };
}

function transcriptExonsForRendererFeature(
  feature: Pick<Feature, 'type' | 'start' | 'end' | 'exons'>
): ReadonlyArray<{ start: number; end: number }> | undefined {
  if (feature.exons && feature.exons.length > 0) return feature.exons;
  if (feature.end <= feature.start) return undefined;
  return [{ start: feature.start, end: feature.end }];
}

function transcriptExonsForGenomeFeature(
  feature: GenomeFeature & {
    _resolvedExons?: ReadonlyArray<{ start: number; end: number }>;
  }
): ReadonlyArray<{ start: number; end: number }> | undefined {
  if (feature._resolvedExons && feature._resolvedExons.length > 0) return feature._resolvedExons;
  if (feature.end <= feature.start) return undefined;
  return [{ start: feature.start, end: feature.end }];
}

function directionForStrand(strand: GenomeFeature['strand']): Feature['direction'] {
  if (strand === '+') return 'forward';
  if (strand === '-') return 'reverse';
  return 'none';
}

function strandForDirection(direction: Feature['direction']): GenomeFeature['strand'] {
  if (direction === 'forward') return '+';
  if (direction === 'reverse') return '-';
  return '.';
}

function collapseFirstAttributes(attributes: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, values] of Object.entries(attributes)) {
    const first = values[0];
    if (first !== undefined) out[key] = first;
  }
  return out;
}

export function featureDisplayName(feature: GenomeFeature): string {
  return (
    feature.attributes.Name?.[0] ??
    feature.attributes.gene?.[0] ??
    feature.attributes.locus_tag?.[0] ??
    feature.attributes.product?.[0] ??
    feature.attributes.mobile_element_type?.[0] ??
    feature.attributes.ID?.[0] ??
    feature.type
  );
}

function stableRendererFeatureId(feature: GenomeFeature): number {
  return stableUint32([
    feature.chrom,
    feature.source,
    feature.type,
    stableAnnotationFeatureKey(feature),
    String(feature.fileOffset ?? ''),
  ]);
}

function stableUint32(parts: string[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 1_000_000_000;
}

function positiveInteger(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}
