import type { IndexedGenomeManifest } from '@waypoint/genome-data';

import type {
  GenomeSessionShell,
  GenomeAnnotationGlyphPayload,
  GenomeTileCacheState,
  GenomeTileFidelity,
  GenomeTileState,
  GenomeTrackState,
  GenomeTrackTile,
  GenomeValidationState,
} from '../../../shared/indexed-genome';
import {
  trackStateForGenomeTileState,
  userStateForGenomeTrackState,
} from '../../../shared/indexed-genome';
import { buildIndexedGenomeScene, type IndexedGenomeScene } from './indexed-genome-scene';
import type { AnnotationTilePending } from './indexed-annotation-tile-policy';
import { type LaneLimit, computeLaneEpoch } from './stable-lane-assignment';
import {
  normalizeSequenceViewportRange,
  type SequenceWindowPending,
} from './indexed-sequence-window-policy';

export interface IndexedGenomeViewerSequenceWindowState {
  startBp: number;
  endBp: number;
  generation: number;
  byteCount: number;
  bases: string;
}

export interface IndexedGenomeViewerAnnotationOverviewTileState {
  state: GenomeTileState;
  fidelity: GenomeTileFidelity;
  generation: number;
  laneEpoch?: string;
  byteCount: number;
  validationState: GenomeValidationState;
  cacheState: GenomeTileCacheState;
  recordCount: number;
  sourceRecordCount?: number;
  message?: string;
  layerTypes?: string[];
  payload?: GenomeAnnotationGlyphPayload;
}

export interface IndexedGenomeViewerAnnotationViewportTileState {
  startBp: number;
  endBp: number;
  generation: number;
  state: GenomeTileState;
  fidelity: GenomeTileFidelity;
  laneEpoch?: string;
  cacheState: GenomeTileCacheState;
  recordCount: number;
  byteCount: number;
  layerTypes?: string[];
  payload?: GenomeAnnotationGlyphPayload;
}

export interface IndexedGenomeViewerSceneInput {
  manifest: IndexedGenomeManifest;
  sessionId: string;
  length: number;
  height: number;
  containerWidth: number;
  viewportRange?: { start: number; end: number } | null;
  sequenceWindow?: IndexedGenomeViewerSequenceWindowState | null;
  pendingSequenceWindow?: SequenceWindowPending | null;
  annotationOverviewTile: IndexedGenomeViewerAnnotationOverviewTileState;
  annotationViewportTile?: IndexedGenomeViewerAnnotationViewportTileState | null;
  annotationViewportTiles?: ReadonlyArray<IndexedGenomeViewerAnnotationViewportTileState>;
  pendingAnnotationViewportTile?: AnnotationTilePending | null;
  visibleTypes: ReadonlySet<string>;
  laneLimit: LaneLimit;
}

export function buildIndexedGenomeViewerScene(
  input: IndexedGenomeViewerSceneInput
): IndexedGenomeScene {
  const range = normalizeSequenceViewportRange(input.viewportRange, input.length) ?? {
    start: input.annotationViewportTile?.startBp ?? 0,
    end: input.annotationViewportTile?.endBp ?? input.length,
  };
  const generation =
    input.pendingAnnotationViewportTile?.token ??
    input.annotationViewportTile?.generation ??
    input.pendingSequenceWindow?.token ??
    input.sequenceWindow?.generation ??
    input.annotationOverviewTile.generation;
  const sequenceTrackState: GenomeTrackState = sequenceWindowCoversRange(
    input.sequenceWindow,
    range
  )
    ? 'ready'
    : input.pendingSequenceWindow
      ? 'building_cache'
      : 'coordinate_ready';
  const annotationTrackState = input.pendingAnnotationViewportTile
    ? 'building_cache'
    : trackStateForGenomeTileState(input.annotationOverviewTile.state);
  const sessionId = input.sessionId;
  const annotationTrackId = `${input.manifest.chrom}:annotations`;
  const shell: GenomeSessionShell = {
    sessionId,
    sourcePath: input.manifest.fastaPath,
    sourceFingerprint: sourceFingerprintForManifest(input.manifest),
    chrom: input.manifest.chrom,
    openReady: true,
    coordinateReady: true,
    length: input.length,
    manifest: input.manifest,
    validationState: input.annotationOverviewTile.validationState,
    openedAt: 0,
    tracks: [
      {
        id: `${input.manifest.chrom}:sequence`,
        kind: 'sequence' as const,
        label: 'Sequence',
        state: sequenceTrackState,
        userState: userStateForGenomeTrackState(sequenceTrackState),
      },
      {
        id: annotationTrackId,
        kind: 'annotation' as const,
        label: 'Annotations',
        state: annotationTrackState,
        userState: userStateForGenomeTrackState(annotationTrackState),
        ...(input.annotationOverviewTile.message
          ? { message: input.annotationOverviewTile.message }
          : {}),
      },
    ],
  };
  const viewportWidth = Math.max(1, input.containerWidth || 1);
  const visibleBp = Math.max(1, range.end - range.start);

  const computedLaneEpoch = computeLaneEpoch({
    sourceFingerprint: shell.sourceFingerprint,
    chrom: input.manifest.chrom,
    visibleTypes: input.visibleTypes,
    laneLimit: input.laneLimit,
  });

  return buildIndexedGenomeScene({
    shell,
    laneEpoch: computedLaneEpoch,
    viewport: {
      chrom: input.manifest.chrom,
      startBp: range.start,
      endBp: range.end,
      widthPx: viewportWidth,
      heightPx: input.height,
      pixelsPerBp: viewportWidth / visibleBp,
      generation,
    },
    tiles: buildViewerSceneTiles({
      sessionId,
      chrom: input.manifest.chrom,
      length: input.length,
      sequenceTrackId: `${input.manifest.chrom}:sequence`,
      sequenceWindow: input.sequenceWindow ?? null,
      pendingSequenceWindow: input.pendingSequenceWindow ?? null,
      sceneGeneration: generation,
      annotationTrackId,
      overviewTile: input.annotationOverviewTile,
      computedLaneEpoch,
      viewportTile: input.annotationViewportTile ?? null,
      viewportTiles: input.annotationViewportTiles ?? [],
      pendingAnnotationViewportTile: input.pendingAnnotationViewportTile ?? null,
    }),
  });
}

function buildViewerSceneTiles(input: {
  sessionId: string;
  chrom: string;
  length: number;
  sequenceTrackId: string;
  sequenceWindow: IndexedGenomeViewerSequenceWindowState | null;
  pendingSequenceWindow: SequenceWindowPending | null;
  sceneGeneration: number;
  annotationTrackId: string;
  overviewTile: IndexedGenomeViewerAnnotationOverviewTileState;
  computedLaneEpoch: string;
  viewportTile: IndexedGenomeViewerAnnotationViewportTileState | null;
  viewportTiles: ReadonlyArray<IndexedGenomeViewerAnnotationViewportTileState>;
  pendingAnnotationViewportTile: AnnotationTilePending | null;
}): GenomeTrackTile[] {
  const viewportTiles =
    input.viewportTiles.length > 0
      ? input.viewportTiles
      : input.viewportTile
        ? [input.viewportTile]
        : [];
  return [
    {
      sessionId: input.sessionId,
      requestId: `overview:${input.overviewTile.generation}`,
      trackId: input.annotationTrackId,
      chrom: input.chrom,
      start: 0,
      end: input.length,
      generation: input.overviewTile.generation,
      state: input.overviewTile.state,
      fidelity: input.overviewTile.fidelity,
      validationState: input.overviewTile.validationState,
      cacheState: input.overviewTile.cacheState,
      byteCount: input.overviewTile.byteCount,
      recordCount: input.overviewTile.recordCount,
      sourceRecordCount: input.overviewTile.sourceRecordCount,
      laneEpoch: input.computedLaneEpoch,
      ...(input.overviewTile.layerTypes ? { layerTypes: input.overviewTile.layerTypes } : {}),
      ...(input.overviewTile.payload ? { payload: input.overviewTile.payload } : {}),
    },
    ...(input.sequenceWindow
      ? [
          {
            sessionId: input.sessionId,
            requestId: `sequence:${input.sequenceWindow.generation}`,
            trackId: input.sequenceTrackId,
            chrom: input.chrom,
            start: input.sequenceWindow.startBp,
            end: input.sequenceWindow.endBp,
            generation: input.sceneGeneration,
            state: 'ready',
            fidelity: 'exact',
            validationState: input.overviewTile.validationState,
            cacheState: 'none',
            byteCount: input.sequenceWindow.byteCount,
            recordCount: input.sequenceWindow.bases.length,
            payload: {
              type: 'sequence',
              startBp: input.sequenceWindow.startBp,
              endBp: input.sequenceWindow.endBp,
              bases: input.sequenceWindow.bases,
            },
          } satisfies GenomeTrackTile,
        ]
      : []),
    ...(input.pendingSequenceWindow
      ? [
          {
            sessionId: input.sessionId,
            requestId:
              input.pendingSequenceWindow.requestId ??
              `sequence:${input.pendingSequenceWindow.token}`,
            trackId: input.sequenceTrackId,
            chrom: input.chrom,
            start: input.pendingSequenceWindow.startBp,
            end: input.pendingSequenceWindow.endBp,
            generation: input.sceneGeneration,
            state: 'loading',
            fidelity: 'exact',
            validationState: input.overviewTile.validationState,
            cacheState: 'none',
            byteCount: 0,
            recordCount: 0,
          } satisfies GenomeTrackTile,
        ]
      : []),
    ...viewportTiles.map(
      (viewportTile) =>
        ({
          sessionId: input.sessionId,
          requestId: `viewport:${viewportTile.generation}`,
          trackId: input.annotationTrackId,
          chrom: input.chrom,
          start: viewportTile.startBp,
          end: viewportTile.endBp,
          generation: viewportTile.generation,
          state: viewportTile.state,
          fidelity: viewportTile.fidelity,
          validationState: input.overviewTile.validationState,
          cacheState: viewportTile.cacheState,
          byteCount: viewportTile.byteCount,
          recordCount: viewportTile.recordCount,
          ...(viewportTile.laneEpoch !== undefined ? { laneEpoch: viewportTile.laneEpoch } : {}),
          ...(viewportTile.layerTypes ? { layerTypes: viewportTile.layerTypes } : {}),
          ...(viewportTile.payload ? { payload: viewportTile.payload } : {}),
        }) satisfies GenomeTrackTile
    ),
    ...(input.pendingAnnotationViewportTile
      ? [
          {
            sessionId: input.sessionId,
            requestId:
              input.pendingAnnotationViewportTile.requestId ??
              `viewport:${input.pendingAnnotationViewportTile.token}`,
            trackId: input.annotationTrackId,
            chrom: input.chrom,
            start: input.pendingAnnotationViewportTile.startBp,
            end: input.pendingAnnotationViewportTile.endBp,
            generation: input.sceneGeneration,
            state: 'loading',
            fidelity: 'best_available',
            validationState: input.overviewTile.validationState,
            cacheState: 'miss',
            byteCount: 0,
            recordCount: 0,
          } satisfies GenomeTrackTile,
        ]
      : []),
  ];
}

export function sourceFingerprintForManifest(manifest: IndexedGenomeManifest): string {
  return [
    manifest.fastaPath,
    manifest.faiPath,
    manifest.gffPath ?? '',
    manifest.tbiPath ?? '',
  ].join('|');
}

function sequenceWindowCoversRange(
  sequenceWindow: IndexedGenomeViewerSequenceWindowState | null | undefined,
  range: { start: number; end: number }
): boolean {
  return (
    !!sequenceWindow && sequenceWindow.startBp <= range.start && sequenceWindow.endBp >= range.end
  );
}
