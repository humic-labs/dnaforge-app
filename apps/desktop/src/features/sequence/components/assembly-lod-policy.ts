import { ANNOTATION_VIEWPORT_TILE_MAX_BP } from './indexed-annotation-tile-policy';
import { compiledBroadSurfaceOwnsViewportV2 } from '@waypoint/genome-renderer/pure';
import {
  SEQUENCE_RENDER_MIN_PIXELS_PER_BP,
  SEQUENCE_STREAM_MIN_PIXELS_PER_BP,
} from './indexed-sequence-window-policy';

export type LodTier = 'overview' | 'detail';
export type AnnotationLodRepresentation =
  | 'compiled-broad'
  | 'compiled-transition-hold'
  | 'compiled-resident-scene'
  | 'legacy-summary'
  | 'resident-exact';

export interface CompiledBroadSurfaceLodInput {
  readonly broadCorridorFinestSpanBp: number;
  readonly viewportCssWidthPx: number;
  readonly devicePixelRatio: number;
  readonly residentSceneCoversViewport: boolean;
}

export interface LodDecision {
  tier: LodTier;
  annotationRepresentation: AnnotationLodRepresentation;
  fetchAnnotationTile: boolean;
  fetchCodonCarrierPages: boolean;
  prefetchCodonCarrierPages: boolean;
  streamNucleotides: boolean;
  renderNucleotides: boolean;
}

export interface LodViewportInput {
  visibleBp: number;
  pixelsPerBp: number | null;
  compiledBroadSurface?: CompiledBroadSurfaceLodInput | null;
}

export function annotationRoutingRedriveGeneration(input: {
  readonly routingEnabled: boolean;
  readonly sourceScopeKey: string | null;
  readonly routerStreamKey: string | null;
  readonly viewportPublicationKey: string | null;
  readonly residentSceneCoversViewport: boolean;
}): string | null {
  if (
    !input.routingEnabled ||
    !input.sourceScopeKey ||
    !input.routerStreamKey ||
    !input.viewportPublicationKey
  ) {
    return null;
  }
  return JSON.stringify([
    'annotation-routing-redrive.v1',
    input.sourceScopeKey,
    input.routerStreamKey,
    input.viewportPublicationKey,
    input.residentSceneCoversViewport ? 'resident-ready' : 'resident-pending',
  ]);
}

export function compiledViewportDetailRosterCoversViewportV1(input: {
  readonly selectedSetPrepared: boolean;
  readonly viewport: Readonly<{ start: number; end: number }> | null;
  readonly tracks: readonly Readonly<{
    status: string;
    coverageStartBp: number | null;
    coverageEndBp: number | null;
  }>[];
}): boolean {
  const { viewport } = input;
  if (
    !input.selectedSetPrepared ||
    !viewport ||
    !Number.isFinite(viewport.start) ||
    !Number.isFinite(viewport.end) ||
    viewport.end <= viewport.start ||
    input.tracks.length === 0
  ) {
    return false;
  }
  return input.tracks.every(
    (track) =>
      track.status === 'loaded' &&
      typeof track.coverageStartBp === 'number' &&
      Number.isFinite(track.coverageStartBp) &&
      typeof track.coverageEndBp === 'number' &&
      Number.isFinite(track.coverageEndBp) &&
      track.coverageStartBp <= viewport.start &&
      track.coverageEndBp >= viewport.end
  );
}

export function lodTierForViewport(input: LodViewportInput): LodDecision {
  const visibleBp = Number.isFinite(input.visibleBp) ? input.visibleBp : Infinity;
  const compiledBroadOwnsViewport = Boolean(
    input.compiledBroadSurface &&
    compiledBroadSurfaceOwnsViewportV2({
      broadCorridorFinestSpanBp: input.compiledBroadSurface.broadCorridorFinestSpanBp,
      viewportSpanBp: visibleBp,
      viewportCssWidthPx: input.compiledBroadSurface.viewportCssWidthPx,
      devicePixelRatio: input.compiledBroadSurface.devicePixelRatio,
    })
  );
  const hasCompiledAnnotationBody = Boolean(input.compiledBroadSurface);
  const annotationRepresentation: AnnotationLodRepresentation = compiledBroadOwnsViewport
    ? 'compiled-broad'
    : input.compiledBroadSurface?.residentSceneCoversViewport
      ? 'compiled-resident-scene'
      : hasCompiledAnnotationBody
        ? 'compiled-transition-hold'
        : visibleBp <= ANNOTATION_VIEWPORT_TILE_MAX_BP
          ? 'resident-exact'
          : 'legacy-summary';
  const tier: LodTier = annotationRepresentation === 'resident-exact' ? 'detail' : 'overview';
  const ppb = input.pixelsPerBp;
  const hasPpb = typeof ppb === 'number' && Number.isFinite(ppb);
  const streamNucleotides = hasPpb && (ppb as number) >= SEQUENCE_STREAM_MIN_PIXELS_PER_BP;
  const prefetchCodonCarrierPages =
    hasCompiledAnnotationBody &&
    hasPpb &&
    (ppb as number) >= SEQUENCE_STREAM_MIN_PIXELS_PER_BP / 16;
  return {
    tier,
    annotationRepresentation,
    fetchAnnotationTile: annotationRepresentation === 'resident-exact',
    fetchCodonCarrierPages: hasCompiledAnnotationBody && streamNucleotides,
    prefetchCodonCarrierPages,
    streamNucleotides,
    renderNucleotides: hasPpb && (ppb as number) >= SEQUENCE_RENDER_MIN_PIXELS_PER_BP,
  };
}
