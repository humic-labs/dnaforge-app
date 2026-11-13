import type { GenomeFeature } from '@waypoint/genome-data';
import { uniqueAnnotationLayerTypes } from '../features/sequence/annotation-layer-identity';
import {
  GENOME_ANNOTATION_EXACT_OWNER_MAX_BP,
  GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP,
  GENOME_ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET,
  type GenomeSessionShell,
  type GenomeTileRequest,
  type GenomeTrackTile,
} from './indexed-genome';
import {
  createExactAnnotationOwnerPayload,
  createBudgetedBestAvailableAnnotationPayload,
  estimateFeatureBytes,
} from './genome-annotation-payload';

export function validateAnnotationViewportTileRequest(
  session: GenomeSessionShell,
  request: GenomeTileRequest
): void {
  if (!request || typeof request.chrom !== 'string' || request.chrom.trim().length === 0) {
    throw new Error('[genome] Annotation tile chrom is required.');
  }
  if (
    !Number.isFinite(request.start) ||
    !Number.isFinite(request.end) ||
    !Number.isFinite(request.lod) ||
    !Number.isFinite(request.generation)
  ) {
    throw new Error('[genome] Annotation tile start/end/lod/generation must be finite.');
  }
  if (request.start < 0 || request.end < request.start) {
    throw new Error(`[genome] Invalid annotation tile range: ${request.start}-${request.end}`);
  }
  if (request.end - request.start > GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP) {
    throw new Error(
      `[genome] Annotation viewport tile exceeds ${GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP} bp: ${request.start}-${request.end}`
    );
  }
  if (
    typeof request.byteBudget !== 'number' ||
    request.byteBudget <= 0 ||
    request.byteBudget > GENOME_ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET
  ) {
    throw new Error(
      `[genome] Annotation viewport tile byte budget must be 1-${GENOME_ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET} bytes.`
    );
  }
  if (request.annotationOwner) {
    const { start, end } = request.annotationOwner;
    if (
      request.fidelity !== 'exact' ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < request.start ||
      end <= start ||
      end > request.end ||
      end - start > GENOME_ANNOTATION_EXACT_OWNER_MAX_BP
    ) {
      throw new Error(
        `[genome] Exact annotation owner must be an integer subrange of the source query with span 1-${GENOME_ANNOTATION_EXACT_OWNER_MAX_BP} bp.`
      );
    }
  }
  const length = session.length ?? session.manifest?.length;
  if (typeof length === 'number' && Number.isFinite(length) && request.end > length) {
    throw new Error(
      `[genome] Annotation tile exceeds chromosome length ${length}: ${request.start}-${request.end}`
    );
  }
  if (request.chrom !== session.chrom && request.chrom !== session.manifest?.chrom) {
    throw new Error(
      `[genome] Annotation tile chrom mismatch: request=${request.chrom} session=${session.chrom}`
    );
  }
}

export function createAnnotationBudgetExceededTile(input: {
  session: GenomeSessionShell;
  request: GenomeTileRequest;
  requestId: string;
  estimatedByteCount: number;
  recordCount: number;
}): GenomeTrackTile {
  return {
    sessionId: input.session.sessionId,
    requestId: input.requestId,
    trackId: input.request.trackId,
    chrom: input.request.chrom,
    start: input.request.start,
    end: input.request.end,
    generation: input.request.generation,
    state: 'error',
    fidelity: input.request.fidelity,
    validationState: input.session.validationState,
    byteCount: input.estimatedByteCount,
    recordCount: input.recordCount,
    cacheState: 'none',
    ...(input.request.laneEpoch !== undefined ? { laneEpoch: input.request.laneEpoch } : {}),
    degradedReason: 'density',
    sourceRepresentationComplete: false,
    message: `Annotation viewport tile exceeded byte budget ${input.request.byteBudget}.`,
  };
}

export function createBudgetedBestAvailableAnnotationTile(input: {
  session: GenomeSessionShell;
  request: GenomeTileRequest;
  requestId: string;
  rawFeatures: GenomeFeature[];
  estimatedByteCount: number;
}): GenomeTrackTile {
  const budget = input.request.byteBudget ?? GENOME_ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET;
  const payload = createBudgetedBestAvailableAnnotationPayload({
    rawFeatures: input.rawFeatures,
    byteBudget: budget,
  });
  if (payload.features.length === 0 && input.rawFeatures.length > 0) {
    return createAnnotationBudgetExceededTile({
      session: input.session,
      request: input.request,
      requestId: input.requestId,
      estimatedByteCount: input.estimatedByteCount,
      recordCount: input.rawFeatures.length,
    });
  }
  return {
    ...createFeatureTrackTile({
      session: input.session,
      request: input.request,
      requestId: input.requestId,
      features: payload.features,
      featureModel: payload.featureModel,
      cacheState: 'none',
      sourceRecordCount: payload.sourceRecordCount,
      layerTypes: payload.layerTypes,
    }),
    sourceRepresentationComplete: payload.sourceRepresentationComplete,
    fidelity: 'best_available',
    degradedReason: 'density',
    byteCount: payload.byteCount,
    message: payload.message,
  };
}

export function createFeatureTrackTile(input: {
  session: GenomeSessionShell;
  request: GenomeTileRequest;
  requestId: string;
  features: GenomeFeature[];
  featureModel?: GenomeTrackTile['featureModel'];
  cacheState?: GenomeTrackTile['cacheState'];
  sourceRecordCount?: number;
  sourceRepresentationComplete?: boolean;
  layerTypes?: string[];
}): GenomeTrackTile {
  return {
    sessionId: input.session.sessionId,
    requestId: input.requestId,
    trackId: input.request.trackId,
    chrom: input.request.chrom,
    start: input.request.start,
    end: input.request.end,
    generation: input.request.generation,
    state: input.features.length > 0 ? 'ready' : 'empty',
    fidelity: input.request.fidelity,
    validationState: input.session.validationState,
    byteCount: estimateFeatureBytes(input.features),
    recordCount: input.features.length,
    ...(input.sourceRecordCount !== undefined
      ? { sourceRecordCount: input.sourceRecordCount }
      : {}),
    ...(input.sourceRepresentationComplete !== undefined
      ? { sourceRepresentationComplete: input.sourceRepresentationComplete }
      : {}),
    ...(input.layerTypes !== undefined ? { layerTypes: input.layerTypes } : {}),
    ...(input.featureModel ? { featureModel: input.featureModel } : {}),
    ...(input.cacheState ? { cacheState: input.cacheState } : {}),
    ...(input.request.laneEpoch !== undefined ? { laneEpoch: input.request.laneEpoch } : {}),
    features: input.features,
  };
}

export function createAnnotationViewportTile(input: {
  session: GenomeSessionShell;
  request: GenomeTileRequest;
  requestId: string;
  features: GenomeFeature[];
  onMilestone?: (name: string) => void;
}): GenomeTrackTile {
  const features = input.features;
  const estimatedByteCount = estimateFeatureBytes(features);
  input.onMilestone?.('after-estimate-bytes');
  if (input.request.annotationOwner) {
    const payload = createExactAnnotationOwnerPayload({
      rawFeatures: features,
      ownerStart: input.request.annotationOwner.start,
      ownerEnd: input.request.annotationOwner.end,
    });
    const byteBudget = input.request.byteBudget ?? GENOME_ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET;
    if (payload.byteCount > byteBudget) {
      return createAnnotationBudgetExceededTile({
        session: input.session,
        request: input.request,
        requestId: input.requestId,
        estimatedByteCount: payload.byteCount,
        recordCount: payload.features.length,
      });
    }
    return createFeatureTrackTile({
      session: input.session,
      request: input.request,
      requestId: input.requestId,
      features: payload.features,
      featureModel: payload.featureModel,
      cacheState: 'none',
      sourceRecordCount: payload.sourceRecordCount,
      sourceRepresentationComplete: payload.sourceRepresentationComplete,
      layerTypes: payload.layerTypes,
    });
  }
  if (
    typeof input.request.byteBudget === 'number' &&
    estimatedByteCount > input.request.byteBudget
  ) {
    return createBudgetedBestAvailableAnnotationTile({
      session: input.session,
      request: input.request,
      requestId: input.requestId,
      rawFeatures: features,
      estimatedByteCount,
    });
  }
  return createFeatureTrackTile({
    session: input.session,
    request: input.request,
    requestId: input.requestId,
    features,
    featureModel: 'raw-gff3',
    cacheState: 'none',
    layerTypes: uniqueAnnotationLayerTypes(features),
  });
}
