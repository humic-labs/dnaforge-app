import {
  comparisonPlot,
  hitTestComparison,
  panComparisonCamera,
  resolveComparisonCamera,
  zoomComparisonCamera,
  type ComparisonCamera,
  type ComparisonHit,
} from '../../comparison-projection';
import { ComparisonProjectionPainter } from './comparison-projection-painter';
import {
  PixiSequenceReadTrackRenderer,
  type SequenceReadPaintReceipt,
  type SequenceReadTrackData,
} from './linear-tracks/sequence-read-track-renderer';
import { cdsZoomBandCenterOffset, dataColor } from '@waypoint/platform';
import {
  contactCellRect,
  contactPlotRect,
  hitTestContactCell,
  panContactCamera,
  resolveContactCamera,
  zoomContactCamera,
  type ContactCamera,
  type ContactHit,
} from '../../contact-projection';
import { Application, Graphics, Container, Rectangle, Text, TextStyle } from 'pixi.js';
import { compareProjectedCodons } from '../../biology/codon-mutations';
import { TRACK_STACK_ABOVE_ZONE_PAD_PX } from '../../track-stack-layout-contract';
import { assemblyScaffoldRulerTicks } from '@waypoint/sequence-utils';
import { SEQUENCE_EDIT_MARKUP } from '@waypoint/sequence-utils/sequence-edit-markup';
import type { PileupAlternateColumn, PileupTrackData } from '@waypoint/genome-data';
import {
  genomeFeatures,
  type Feature,
  type Genome,
  type Primer,
  type RenderState,
} from '../../types';
import { SequenceTrack } from './tracks/sequence-track';
import { genomeSequenceAvailable } from './shared/genome-sequence-availability';
import { CodonTrack, isAnnotationSearchFocusTarget } from './tracks/codon-track';
import { OrfTrack } from './tracks/orf-track';
import { RestrictionTrack } from './tracks/restriction-track';
import {
  codonCarrierRange,
  codonCarrierIntersectsViewport,
  translateCodonCarrier,
} from './shared/codon-carrier-translation';
import { projectCodonColumns, projectIntronColumns } from './shared/project-codon-columns';
import { createBaseReader } from './shared/base-reader';
import type { CutSite } from '../../biology/restriction-sites';
import {
  KeyedTextPool,
  TextPool,
  formatRulerLabel,
  computeTickStep,
  LABEL_FONT_FAMILY,
  RULER_FONT_SIZE,
  RULER_COLOR,
  webglThemeForMode,
  type WebGLThemeMode,
} from './shared';
import { emptyTimings, type SubsystemTimings } from './shared/timing';
import { LinearPathMapper, type PathMapper } from './shared/path-mapper';
import { markTrackHitConsumed } from './shared/track-hit-consumption';
import { OverlayRegistry } from './overlays/overlay-registry';
import {
  IndexedAnnotationOverlay,
  type AnnotationOverlayPolicyReadinessSnapshotV1,
  type AnnotationOverlayColdGestureSnapshot,
  type AnnotationSearchFocusPresentationSnapshot,
} from './overlays/annotation-overlay';
import { SequenceAnnotationOverlay } from './overlays/sequence-annotation-overlay';
import { PrimerOverlay } from './overlays/primer-overlay';
import type { PrimerOverlayRenderStats } from './overlays/primer-overlay';
import {
  capMaxZoomForStabilityMode,
  computeUnifiedLayout,
  MAX_INDEXED_LINEAR_SEQUENCE_PIXELS_PER_BP,
  maxZoomForSequencePixelsPerBp,
  unifiedLayoutCoreCameraKey,
  type UnifiedLayout,
} from './shared/track-layout';
import {
  requireTrackLaneEnvelope,
  resolveInteractionOverlayContract,
} from './shared/lane-contracts';
import { drawDashedLine } from './shared/dashed-line';
import type { ReadHitPayload, WebGLHitTarget } from './shared/hit-targets';
import { clampLinearViewOffset, linearGenomeXOffset } from './shared/linear-viewport';
import { prepareLinearSequenceGlyphTextures } from './shared/linear-sequence-glyph';
import { resetLabelOccupancy } from './shared/label-occupancy';
import {
  normalizeBackboneSegmentRanges,
  type BackboneSegmentRange,
} from './shared/backbone-segments';
import { digestFocusMaskSegments } from './shared/digest-focus-mask';
import { ViewportRangeBrackets } from './shared/viewport-range-brackets';
import { annotationCodonCarrierSignature } from '../../annotation-codon-carrier';

import type { Chromosome } from '../../chromosome';
import type { Assembly } from '../../assembly';
import { buildAssembly } from '../../assembly-layout';
import {
  computeTracksLayout,
  type Track,
  type TrackLayout,
  type TrackLayoutEntry,
  type TrackPresentationDrag,
  type TrackType,
} from '../../tracks';
import {
  TrackDataStore,
  type BpRange,
  type PixiLinearTrackRenderer,
  type TrackCoverageDepthSnapshot,
  type TrackReadPresentationSnapshot,
  type TrackHoverArgs,
  type TrackHitResult,
} from './linear-tracks';
import { PileupGlobalGuideLayer } from './linear-tracks/pileup-global-guide-layer';

export interface GenomeWideTextureExtractResult {
  dataUrl: string;
  widthPx: number;
  heightPx: number;
  resolution: number;
  spineOffsetPx: number;
  genomeLength: number;

  maxAnnotationLane: number;
  maxCdsLane: number;
  layerTypes: string[];
}

export const PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1 =
  'pixi-linear-renderer-operation-snapshot.v1' as const;

export type PixiLinearRendererContentOperation =
  | 'loadGenome'
  | 'annotationSnapshotAttempt'
  | 'annotationSnapshotApply'
  | 'prepackedLoad'
  | 'prepackedPrepare'
  | 'prepackedActivate'
  | 'prepackedPolicyUpdate'
  | 'prepackedRetire';

export interface PixiLinearRendererOperationSnapshot {
  readonly contract: typeof PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1;

  readonly rendererGeneration: number;

  readonly operationEpoch: number;

  readonly contentOperationEpoch: number;

  readonly completedFrameEpoch: number;

  readonly presentedFrameEpoch: number;

  readonly presentedContentOperationEpoch: number;

  readonly forensicDebugSnapshotCount: number;
  readonly counts: Readonly<{
    loadGenome: number;
    annotationSnapshotAttempt: number;
    annotationSnapshotApply: number;
    prepackedLoad: number;
    prepackedPrepare: number;
    prepackedActivate: number;
    prepackedPolicyUpdate: number;
    prepackedRetire: number;
    contentChangedFrame: number;
    cameraOnlyFrame: number;
  }>;

  readonly lastEpochs: Readonly<{
    loadGenome: number;
    annotationSnapshotAttempt: number;
    annotationSnapshotApply: number;
    prepackedLoad: number;
    prepackedPrepare: number;
    prepackedActivate: number;
    prepackedPolicyUpdate: number;
    prepackedRetire: number;
    contentChangedFrame: number;
    cameraOnlyFrame: number;
  }>;
}

export const PIXI_LINEAR_RENDERER_COLD_GESTURE_SNAPSHOT_V1 =
  'pixi-linear-renderer-cold-gesture-snapshot.v1' as const;

export const PIXI_LINEAR_RENDERER_ANNOTATION_POLICY_READINESS_SNAPSHOT_V1 =
  'pixi-linear-renderer-annotation-policy-readiness-snapshot.v1' as const;

export interface PixiLinearRendererAnnotationPolicyReadinessSnapshotV1 {
  readonly contract: typeof PIXI_LINEAR_RENDERER_ANNOTATION_POLICY_READINESS_SNAPSHOT_V1;
  readonly supported: boolean;
  readonly genomeIdentity: string;
  readonly genomeLengthBp: number;
  readonly viewportStartBp: number;
  readonly viewportEndBp: number;
  readonly annotation: AnnotationOverlayPolicyReadinessSnapshotV1;
}

export interface PixiLinearTrackColdGestureSnapshot {
  readonly requestedTrackId: string;
  readonly trackFound: boolean;
  readonly diagnosticsSupported: boolean;
  readonly trackType: string | null;
  readonly coverageLodRole: string | null;
  readonly coverageLodLevel: number | null;
  readonly coverageLodTargetLevel: number | null;
  readonly coverageLodBinSize: number | null;
  readonly coverageLodAuthority: string | null;
  readonly coverageLodProvenanceExact: boolean | null;
  readonly coverageSamplePassCount: number;
  readonly coverageGeometryBuildCount: number;
  readonly coverageBufferUploadCount: number;
  readonly coverageSignalNonzeroBinCount: number;
  readonly renderedReadDensityAlpha: number;
  readonly densityRowsMeshVisible: boolean;
  readonly coverageGpuAtlasAuthorityKey: string | null;
  readonly coverageGpuAtlasTextureResourceCreateCount: number;
  readonly coverageGpuAtlasGpuTextureResourceCreateCount: number;
  readonly coverageGpuAtlasGpuTextureUploadCount: number;
  readonly coverageGpuAtlasGpuTextureUploadComplete: boolean;
  readonly coverageGpuAtlasTextureResourceUid: number | null;
  readonly coverageGpuAtlasShaderTextureResourceUid: number | null;
  readonly coverageGpuAtlasShaderTextureResourceBound: boolean;
  readonly coverageGpuAtlasGeometryBuildCount: number;
  readonly coverageGpuAtlasCameraUniformUpdateCount: number;
  readonly coverageGpuAtlasRenderOwner: string | null;
  readonly coverageGpuAtlasShaderProgramName: string | null;
  readonly coverageGpuAtlasShaderProgramKey: number | null;
  readonly coverageGpuAtlasShaderProgramCompiled: boolean;
  readonly coverageGpuAtlasActive: boolean;
  readonly coverageGpuAtlasBaseBinSizeBp: number;
  readonly rendererViewportStartBp: number;
  readonly rendererViewportEndBp: number;
}

export interface PixiLinearRendererColdGestureSnapshot {
  readonly contract: typeof PIXI_LINEAR_RENDERER_COLD_GESTURE_SNAPSHOT_V1;
  readonly supported: boolean;
  readonly genomeIdentity: string;
  readonly genomeLengthBp: number;
  readonly viewportStartBp: number;
  readonly viewportEndBp: number;
  readonly viewportWidthPx: number;
  readonly viewportHeightPx: number;
  readonly operation: PixiLinearRendererOperationSnapshot;
  readonly track: PixiLinearTrackColdGestureSnapshot;
  readonly annotation: AnnotationOverlayColdGestureSnapshot;
}

export interface PixiLinearRendererLaneScreenSnapshot {
  readonly canvasContentHeightPx: number | null;
  readonly overlayLayout: Readonly<{
    totalHeight: number;
    offset: number;
    annotationHeight: number;
    strandEnvelopeTop: number;
    strandEnvelopeBottom: number;
    fwdStrandTop: number;
    revStrandBottom: number;
    trackScrollTop: number;
  }> | null;
  readonly trackScreenBounds: Readonly<
    Record<
      string,
      Readonly<{
        topPx: number;
        heightPx: number;
        bottomPx: number;
        scrollsVertically: boolean;
      }>
    >
  >;
  readonly annotationOverlay: AnnotationSearchFocusPresentationSnapshot;
}

const PIXI_LINEAR_RENDERER_GENERATION_COUNTER = Symbol.for(
  '@waypoint/genome-renderer/PixiLinearRenderer/generation'
);

function allocatePixiLinearRendererGeneration(): number {
  const processState = globalThis as typeof globalThis & Record<symbol, unknown>;
  const previous = processState[PIXI_LINEAR_RENDERER_GENERATION_COUNTER];
  const next = typeof previous === 'number' && Number.isSafeInteger(previous) ? previous + 1 : 1;
  processState[PIXI_LINEAR_RENDERER_GENERATION_COUNTER] = next;
  return next;
}

type RendererOperationCounts = {
  [K in PixiLinearRendererContentOperation]: number;
} & {
  contentChangedFrame: number;
  cameraOnlyFrame: number;
};

function emptyRendererOperationCounts(): RendererOperationCounts {
  return {
    loadGenome: 0,
    annotationSnapshotAttempt: 0,
    annotationSnapshotApply: 0,
    prepackedLoad: 0,
    prepackedPrepare: 0,
    prepackedActivate: 0,
    prepackedPolicyUpdate: 0,
    prepackedRetire: 0,
    contentChangedFrame: 0,
    cameraOnlyFrame: 0,
  };
}

type ScalarDiagnosticRecord = Readonly<Record<string, unknown>> | null;

function diagnosticNumber(diagnostics: ScalarDiagnosticRecord, key: string, fallback = 0): number {
  const value = diagnostics?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function diagnosticNullableNumber(diagnostics: ScalarDiagnosticRecord, key: string): number | null {
  const value = diagnostics?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function diagnosticNullableString(diagnostics: ScalarDiagnosticRecord, key: string): string | null {
  const value = diagnostics?.[key];
  return typeof value === 'string' ? value : null;
}

function diagnosticNullableBoolean(
  diagnostics: ScalarDiagnosticRecord,
  key: string
): boolean | null {
  const value = diagnostics?.[key];
  return typeof value === 'boolean' ? value : null;
}

function diagnosticBoolean(diagnostics: ScalarDiagnosticRecord, key: string): boolean {
  return diagnostics?.[key] === true;
}

function diagnosticHasNumber(diagnostics: Readonly<Record<string, unknown>>, key: string): boolean {
  return typeof diagnostics[key] === 'number' && Number.isFinite(diagnostics[key]);
}

function diagnosticHasBoolean(
  diagnostics: Readonly<Record<string, unknown>>,
  key: string
): boolean {
  return typeof diagnostics[key] === 'boolean';
}

function diagnosticHasNullableNumber(
  diagnostics: Readonly<Record<string, unknown>>,
  key: string
): boolean {
  return diagnostics[key] === null || diagnosticHasNumber(diagnostics, key);
}

function diagnosticHasNullableString(
  diagnostics: Readonly<Record<string, unknown>>,
  key: string
): boolean {
  return diagnostics[key] === null || typeof diagnostics[key] === 'string';
}

function coldTrackDiagnosticsSupported(diagnostics: ScalarDiagnosticRecord): boolean {
  if (diagnostics === null) return false;
  return (
    diagnosticHasNullableString(diagnostics, 'coverageLodRole') &&
    diagnosticHasNullableNumber(diagnostics, 'coverageLodLevel') &&
    diagnosticHasNullableNumber(diagnostics, 'coverageLodTargetLevel') &&
    diagnosticHasNullableNumber(diagnostics, 'coverageLodBinSize') &&
    diagnosticHasNullableString(diagnostics, 'coverageLodAuthority') &&
    (diagnostics.coverageLodProvenanceExact === null ||
      typeof diagnostics.coverageLodProvenanceExact === 'boolean') &&
    diagnosticHasNumber(diagnostics, 'coverageSamplePassCount') &&
    diagnosticHasNumber(diagnostics, 'coverageGeometryBuildCount') &&
    diagnosticHasNumber(diagnostics, 'coverageBufferUploadCount') &&
    diagnosticHasNumber(diagnostics, 'coverageSignalNonzeroBinCount') &&
    diagnosticHasNumber(diagnostics, 'renderedReadDensityAlpha') &&
    diagnosticHasBoolean(diagnostics, 'densityRowsMeshVisible') &&
    diagnosticHasNullableString(diagnostics, 'coverageGpuAtlasAuthorityKey') &&
    diagnosticHasNumber(diagnostics, 'coverageGpuAtlasTextureResourceCreateCount') &&
    diagnosticHasNumber(diagnostics, 'coverageGpuAtlasGpuTextureResourceCreateCount') &&
    diagnosticHasNumber(diagnostics, 'coverageGpuAtlasGpuTextureUploadCount') &&
    diagnosticHasBoolean(diagnostics, 'coverageGpuAtlasGpuTextureUploadComplete') &&
    diagnosticHasNullableNumber(diagnostics, 'coverageGpuAtlasTextureResourceUid') &&
    diagnosticHasNullableNumber(diagnostics, 'coverageGpuAtlasShaderTextureResourceUid') &&
    diagnosticHasBoolean(diagnostics, 'coverageGpuAtlasShaderTextureResourceBound') &&
    diagnosticHasNumber(diagnostics, 'coverageGpuAtlasGeometryBuildCount') &&
    diagnosticHasNumber(diagnostics, 'coverageGpuAtlasCameraUniformUpdateCount') &&
    diagnosticHasNullableString(diagnostics, 'coverageGpuAtlasRenderOwner') &&
    diagnosticHasNullableString(diagnostics, 'coverageGpuAtlasShaderProgramName') &&
    diagnosticHasNullableNumber(diagnostics, 'coverageGpuAtlasShaderProgramKey') &&
    diagnosticHasBoolean(diagnostics, 'coverageGpuAtlasShaderProgramCompiled') &&
    diagnosticHasBoolean(diagnostics, 'coverageGpuAtlasActive') &&
    diagnosticHasNumber(diagnostics, 'coverageGpuAtlasBaseBinSizeBp') &&
    diagnosticHasNumber(diagnostics, 'rendererViewportStartBp') &&
    diagnosticHasNumber(diagnostics, 'rendererViewportEndBp')
  );
}

export function annotationCodonCarrierSignatures(
  features: ReadonlyArray<Feature>
): Map<number, string> {
  const signatures = new Map<number, string>();
  for (const feature of features) {
    const signature = annotationCodonCarrierSignature(feature);
    if (signature !== null) signatures.set(feature.id, signature);
  }
  return signatures;
}

function validatedAnnotationSearchFocusFeature(state: RenderState): Feature | null {
  const focus = state.annotationSearchFocus;
  const feature = state.annotationSearchFocusFeature;
  if (
    !focus ||
    !feature ||
    focus.trackId.length === 0 ||
    focus.canonicalIdentity.length === 0 ||
    !isAnnotationSearchFocusTarget(feature, focus)
  ) {
    return null;
  }
  return feature;
}

interface FlatAnnotationSearchFocusPresentation {
  feature: Feature;
  effectiveMaxAnnotationLane: number;
  effectiveMaxCdsLane: number;
}

function usesTemporaryAdditionalAnnotationLane(
  focus: RenderState['annotationSearchFocus']
): boolean {
  return focus?.presentation === 'temporary-additional-lane';
}

function flatAnnotationSearchFocusPresentation(input: {
  feature: Feature;
  focus: NonNullable<RenderState['annotationSearchFocus']>;
  durableLayerTypes: ReadonlyArray<string> | undefined;
  durableFeatures: ReadonlyArray<Feature>;
  durableMaxAnnotationLane: number;
  durableMaxCdsLane: number;
  retainedPolicyVisibility: 'visible' | 'filtered' | 'unavailable';
}): FlatAnnotationSearchFocusPresentation {
  const durableExactFeature =
    input.durableFeatures.find((feature) => isAnnotationSearchFocusTarget(feature, input.focus)) ??
    null;
  if (usesTemporaryAdditionalAnnotationLane(input.focus)) {
    if (input.retainedPolicyVisibility !== 'filtered') {
      return {
        feature: durableExactFeature ?? input.feature,
        effectiveMaxAnnotationLane: input.durableMaxAnnotationLane,
        effectiveMaxCdsLane: input.durableMaxCdsLane,
      };
    }
    if (input.feature.type === 'CDS') {
      const lane = input.durableMaxCdsLane + 1;
      return {
        feature: {
          ...input.feature,
          lane,
          cdsLane: lane,
          annotationTrackLane: 0,
          annotationTrackLaneCapacity: 1,
        },
        effectiveMaxAnnotationLane: input.durableMaxAnnotationLane,
        effectiveMaxCdsLane: lane,
      };
    }

    const lane = input.durableMaxAnnotationLane + 1;
    return {
      feature: {
        ...input.feature,
        lane,
        annotationTrackLane: 0,
        annotationTrackLaneCapacity: 1,
      },
      effectiveMaxAnnotationLane: lane,
      effectiveMaxCdsLane: input.durableMaxCdsLane,
    };
  }

  const focusTrackIsDurable =
    input.durableLayerTypes?.includes(input.focus.trackId) === true ||
    input.durableFeatures.some(
      (feature) => (feature.annotationTrackId ?? feature.type) === input.focus.trackId
    );
  if (focusTrackIsDurable) {
    return {
      feature: input.feature,
      effectiveMaxAnnotationLane: input.durableMaxAnnotationLane,
      effectiveMaxCdsLane: input.durableMaxCdsLane,
    };
  }

  if (input.feature.type === 'CDS') {
    const lane = input.durableMaxCdsLane + 1;
    return {
      feature: {
        ...input.feature,
        lane,
        cdsLane: lane,
        annotationTrackLane: 0,
        annotationTrackLaneCapacity: 1,
      },
      effectiveMaxAnnotationLane: input.durableMaxAnnotationLane,
      effectiveMaxCdsLane: lane,
    };
  }

  const lane = input.durableMaxAnnotationLane < 0 ? 0 : input.durableMaxAnnotationLane + 2;
  return {
    feature: {
      ...input.feature,
      lane,
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 1,
    },
    effectiveMaxAnnotationLane: lane,
    effectiveMaxCdsLane: input.durableMaxCdsLane,
  };
}

interface CodonTranslationCacheEntry {
  codons: import('../../biology/translation').CodonInfo[];
  introns: import('../../biology/translation').IntronInfo[];
  lo: number;
  hi: number;
}

interface TransientAnnotationSearchCodonCache {
  trackId: string;
  canonicalIdentity: string;
  carrierSignature: string;
  entry: CodonTranslationCacheEntry;
}

interface ResidentAnnotationSearchFocusResolution {
  annotationFeatures: ReadonlyArray<Feature>;
  trackId: string;
  canonicalIdentity: string;
  target: Feature | null;
}

interface RegisteredTrackZoneLayout {
  readonly trackLayoutRevision: number;
  readonly availableHeight: number;
  readonly aboveLayout: TrackLayout;
  readonly belowLayout: TrackLayout;
  readonly aboveZoneHeight: number;

  readonly aboveZoneTopPadPx: number;
  readonly hasCompanionGutter: boolean;
  readonly belowZoneHeight: number;
}

interface UnifiedLayoutCache {
  readonly genome: Genome;
  readonly overlayLayoutRevision: number;
  readonly overlayLayoutKeys: readonly (string | number | boolean | null)[];
  readonly coreCameraKey: number;
  readonly width: number;
  readonly height: number;
  readonly hasSequence: boolean;
  readonly sequenceAvailable: boolean;
  readonly reserveSequenceLayoutEnvelope: boolean;
  readonly showSecondarySequenceRow: boolean;
  readonly showResidueNumbers: boolean;
  readonly cdsSizing: 'canvas' | 'indexed' | 'cohesive' | undefined;
  readonly translationLanes: number;
  readonly annotationLanes: number;
  readonly cdsLanes: number;
  readonly orfForwardLanes: number;
  readonly orfReverseLanes: number;
  readonly aboveZoneHeight: number;
  readonly belowZoneHeight: number;
  readonly annotationTopReservePx: number;
  readonly trackScrollTop: number | null;
  readonly trackStackEndReservePx: number | undefined;
  readonly layout: UnifiedLayout;
}

function unifiedLayoutCacheMatches(
  cached: UnifiedLayoutCache | null,
  input: {
    genome: Genome;
    overlayLayoutRevision: number;
    coreCameraKey: number;
    width: number;
    height: number;
    hasSequence: boolean;
    sequenceAvailable: boolean;
    reserveSequenceLayoutEnvelope: boolean;
    showSecondarySequenceRow: boolean;
    showResidueNumbers: boolean;
    cdsSizing: 'canvas' | 'indexed' | 'cohesive' | undefined;
    translationLanes: number;
    annotationLanes: number;
    cdsLanes: number;
    orfForwardLanes: number;
    orfReverseLanes: number;
    aboveZoneHeight: number;
    belowZoneHeight: number;
    annotationTopReservePx: number;
    requestedTrackScrollTop: number | null;
    trackStackEndReservePx: number | undefined;
    overlayRegistry: OverlayRegistry;
    state: RenderState;
    pixelsPerBp: number;
  }
): cached is UnifiedLayoutCache {
  return (
    cached !== null &&
    cached.genome === input.genome &&
    cached.cdsSizing === input.cdsSizing &&
    cached.overlayLayoutRevision === input.overlayLayoutRevision &&
    Object.is(cached.coreCameraKey, input.coreCameraKey) &&
    cached.width === input.width &&
    cached.height === input.height &&
    cached.hasSequence === input.hasSequence &&
    cached.sequenceAvailable === input.sequenceAvailable &&
    cached.reserveSequenceLayoutEnvelope === input.reserveSequenceLayoutEnvelope &&
    cached.showSecondarySequenceRow === input.showSecondarySequenceRow &&
    cached.showResidueNumbers === input.showResidueNumbers &&
    cached.translationLanes === input.translationLanes &&
    cached.annotationLanes === input.annotationLanes &&
    cached.cdsLanes === input.cdsLanes &&
    cached.orfForwardLanes === input.orfForwardLanes &&
    cached.orfReverseLanes === input.orfReverseLanes &&
    cached.aboveZoneHeight === input.aboveZoneHeight &&
    cached.belowZoneHeight === input.belowZoneHeight &&
    cached.annotationTopReservePx === input.annotationTopReservePx &&
    Object.is(cached.trackScrollTop, input.requestedTrackScrollTop) &&
    Object.is(cached.trackStackEndReservePx, input.trackStackEndReservePx) &&
    input.overlayRegistry.layoutCacheKeysMatch(
      cached.overlayLayoutKeys,
      input.genome,
      input.state,
      input.pixelsPerBp
    )
  );
}

interface RetainedRulerTickTopology {
  readonly genome: Genome;
  readonly formatter: Genome['formatRulerLabel'];
  readonly step: number;
  readonly firstBp: number;
  readonly lastBp: number;
  readonly tickBps: readonly number[];
  readonly labels: readonly Text[];
}

const TRACK_CLICK_SLOP_PX = 4;

export class PixiLinearRenderer {
  private readonly rendererGeneration = allocatePixiLinearRendererGeneration();
  private rendererOperationEpoch = 0;
  private rendererContentOperationEpoch = 0;
  private rendererCompletedFrameEpoch = 0;
  private rendererPresentedFrameEpoch = 0;
  private rendererPresentedContentOperationEpoch = 0;
  private forensicDebugSnapshotCount = 0;
  private lastCompletedFrameContentOperationEpoch = 0;
  private readonly rendererOperationCounts = emptyRendererOperationCounts();
  private readonly rendererOperationLastEpochs = emptyRendererOperationCounts();

  private app!: Application;
  protected genome!: Genome;
  protected getState!: () => RenderState;

  private scrollingLayer = new Container();
  private comparisonPainter = new ComparisonProjectionPainter();
  private contactLayer = new Container();
  private contactGraphics = new Graphics();
  private contactTextPool!: TextPool;
  private contactPaintedCells = 0;
  private contactThemeMode: WebGLThemeMode | null = null;
  private scrollingMask = new Graphics();
  private scrollingBounds = new Rectangle();
  private rulerLayer = new Container();
  private rulerSegmentLayer = new Container();
  private rulerTickLayer = new Container();
  private selectionLayer = new Container();
  private interactionLayer = new Container();

  private rulerGraphics = new Graphics();
  private rulerTickGraphics: Graphics[] = [];
  private rulerTickColors: Array<number | null> = [];
  private rulerSegmentGraphics: Graphics[] = [];
  private rulerSegmentStyles: Array<Readonly<{
    color: number;
    strokeWidth: number;
    alpha: number;
  }> | null> = [];
  private rulerBaseColor: number | null = null;
  private rulerPrimitiveBuildCount = 0;
  private rulerTickTopology: RetainedRulerTickTopology | null = null;

  private rulerTickTopologyBuildCount = 0;
  private presentedSecondarySequenceRow = true;
  private backboneSegmentRangeCache: Readonly<{
    source: RenderState['backboneSegments'];
    genomeLength: number;
    themeMode: RenderState['themeMode'];
    ranges: readonly BackboneSegmentRange[];
  }> | null = null;
  private selectionGraphics = new Graphics();
  private interactionGraphics = new Graphics();

  private rulerTextPool!: KeyedTextPool;
  private appliedThemeMode: WebGLThemeMode | null = null;

  private _maxAnnotationLane = -1;
  private _maxCdsLane = -1;

  protected annotationFeatures: ReadonlyArray<Feature> = [];

  protected annotationCodonCarrierSignatures = new Map<number, string>();

  protected annotationResidentFeatureSelectionKey: string | null = null;

  protected annotationHasDirectionalCds = false;

  private lastTranslationLaneCount = 0;

  private requestedTrackScrollTop: number | null = null;

  private trackStackEndReservePx: number | undefined;
  private trackScrollScopeKey: string | null = null;

  sequenceTrack!: SequenceTrack;

  _timings: SubsystemTimings = emptyTimings();

  _layout: PathMapper | null = null;

  _overlayLayout: UnifiedLayout | null = null;

  private unifiedLayoutCache: UnifiedLayoutCache | null = null;

  private unifiedLayoutComputeCount = 0;
  private codonTrack!: CodonTrack;
  private orfTrack!: OrfTrack;
  private restrictionTrack!: RestrictionTrack;
  private cutSites: CutSite[] = [];
  protected codonCache = new Map<number, CodonTranslationCacheEntry>();
  private codonBiologicalGenome: Genome | null = null;
  private codonBioToColumn: ((base: number) => number | null) | null = null;
  private codonBiologicalFeatures = new Map<number, Feature>();
  private codonReferenceGenome: Genome | null = null;
  private codonPreparedFeatures: NonNullable<RenderState['sequencePresentation']>['codingFeatures'];
  private codonReferenceFeatures = new Map<number, Feature>();

  private transientAnnotationSearchCodonCache: TransientAnnotationSearchCodonCache | null = null;

  private residentAnnotationSearchFocusResolution: ResidentAnnotationSearchFocusResolution | null =
    null;
  private backbonePathSegmentsDrawn = 0;

  private overlayRegistry = new OverlayRegistry();
  protected annotationOverlay: SequenceAnnotationOverlay | IndexedAnnotationOverlay;
  protected readonly defaultCdsSizing?: 'cohesive';
  private primerOverlay = new PrimerOverlay();

  constructor(options?: { overlay?: SequenceAnnotationOverlay | IndexedAnnotationOverlay }) {
    this.annotationOverlay = options?.overlay ?? new SequenceAnnotationOverlay();
  }

  private trackRenderers = new Map<TrackType, PixiLinearTrackRenderer>();
  private trackInstances: ReadonlyArray<Track> = [];

  private trackInstancesById = new Map<string, Track>();
  private trackContainers = new Map<string, Container>();
  private trackMasks = new Map<string, { mask: Graphics; width: number; height: number }>();
  private trackPresentationDrag: TrackPresentationDrag | null = null;
  private trackDragBackground = new Graphics();
  private trackDataStore = new TrackDataStore();

  private trackLayoutRevision = 0;
  private registeredTrackZoneLayout: RegisteredTrackZoneLayout | null = null;

  private registeredTrackLayoutComputeCount = 0;
  private readonly pileupGlobalGuideLayer = new PileupGlobalGuideLayer();
  private readonly pileupAlternateColumnsByTrack = new Map<
    string,
    ReadonlyArray<PileupAlternateColumn>
  >();
  private pileupGlobalGuideColumns: ReadonlyArray<PileupAlternateColumn> = [];
  private laneContractRevision = 0;
  private chromosome: Chromosome | null = null;

  private assembly: Assembly | null = null;

  private trackHitHandler: ((result: TrackHitResult) => void) | null = null;
  private lastTrackLayoutEntries = new Map<string, TrackLayoutEntry>();

  private lastTrackContainerTops = new Map<string, number>();
  private lastRegisteredTrackLayoutDebug: {
    aboveZoneHeight: number;
    legacyBottomY: number;
    legacyLayoutTotalHeight: number;
  } | null = null;

  private lastCanvasHeight = 0;
  private lastViewportBpRange: BpRange = { start: 0, end: 0 };
  private lastViewportWidthPx = 0;
  private viewportBrackets = new ViewportRangeBrackets();

  getViewportDebugSnapshot() {
    return this.viewportBrackets.snapshot;
  }

  getOverlayRegistry() {
    return this.overlayRegistry;
  }

  getCurrentPathMapper(): PathMapper | null {
    return this._layout;
  }

  getPrimerDebugSnapshot(): PrimerOverlayRenderStats {
    return this.primerOverlay.lastRenderStats;
  }

  getRendererOperationSnapshot(): PixiLinearRendererOperationSnapshot {
    return {
      contract: PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1,
      rendererGeneration: this.rendererGeneration,
      operationEpoch: this.rendererOperationEpoch,
      contentOperationEpoch: this.rendererContentOperationEpoch,
      completedFrameEpoch: this.rendererCompletedFrameEpoch,
      presentedFrameEpoch: this.rendererPresentedFrameEpoch,
      presentedContentOperationEpoch: this.rendererPresentedContentOperationEpoch,
      forensicDebugSnapshotCount: this.forensicDebugSnapshotCount,
      counts: { ...this.rendererOperationCounts },
      lastEpochs: { ...this.rendererOperationLastEpochs },
    };
  }

  getPresentedTrackScrollReceipt(): {
    completedFrameEpoch: number;
    trackScrollTop: number;
    contentClipTopPx: number;
  } | null {
    if (!this._overlayLayout) return null;
    return {
      completedFrameEpoch: this.rendererCompletedFrameEpoch,
      trackScrollTop: this._overlayLayout.trackScrollTop,
      contentClipTopPx: this.scrollingBounds.y,
    };
  }

  protected recordRendererContentOperation(operation: PixiLinearRendererContentOperation): void {
    this.rendererOperationEpoch += 1;
    this.rendererContentOperationEpoch += 1;
    this.rendererOperationCounts[operation] += 1;
    this.rendererOperationLastEpochs[operation] = this.rendererOperationEpoch;
  }

  private recordRendererCompletedFrame(): void {
    this.rendererOperationEpoch += 1;
    this.rendererCompletedFrameEpoch += 1;
    const kind =
      this.rendererContentOperationEpoch === this.lastCompletedFrameContentOperationEpoch
        ? 'cameraOnlyFrame'
        : 'contentChangedFrame';
    this.rendererOperationCounts[kind] += 1;
    this.rendererOperationLastEpochs[kind] = this.rendererOperationEpoch;
    this.lastCompletedFrameContentOperationEpoch = this.rendererContentOperationEpoch;
  }

  getTrackDiagnostics(trackId: string): object | null {
    const track = this.trackInstancesById.get(trackId);
    if (!track) return null;
    return this.collectTrackDiagnostics(track);
  }

  getSequencePaintSnapshot() {
    return this.sequenceTrack?.getLinearPaintSnapshot() ?? null;
  }

  getTrackCoverageDepthSnapshot(trackId: string): TrackCoverageDepthSnapshot | null {
    const track = this.trackInstancesById.get(trackId);
    if (!track) return null;
    const container = this.trackContainers.get(track.id);
    const renderer = this.trackRenderers.get(track.type);
    if (!container || !renderer?.getCoverageDepthSnapshot) return null;
    return renderer.getCoverageDepthSnapshot(container);
  }

  getReadPresentationSnapshot(trackId: string): TrackReadPresentationSnapshot | null {
    const track = this.trackInstancesById.get(trackId);
    if (!track) return null;
    const container = this.trackContainers.get(track.id);
    const renderer = this.trackRenderers.get(track.type);
    if (!container || !renderer?.getReadPresentationSnapshot) return null;
    return renderer.getReadPresentationSnapshot(container);
  }

  getSequenceReadPaintReceipt(
    trackId: string,
    expectedData: SequenceReadTrackData
  ): SequenceReadPaintReceipt | null {
    const track = this.trackInstancesById.get(trackId);
    if (!track?.visible || this.trackDataStore.get(trackId) !== expectedData) return null;
    const container = this.trackContainers.get(trackId);
    const renderer = this.trackRenderers.get(track.type);
    if (!container || container.destroyed || !(renderer instanceof PixiSequenceReadTrackRenderer)) {
      return null;
    }
    return renderer.getPaintReceipt(container, expectedData);
  }

  getColdGestureSnapshot(trackId: string): PixiLinearRendererColdGestureSnapshot {
    const track = this.trackInstancesById.get(trackId) ?? null;
    const diagnostics = track ? this.collectColdTrackDiagnostics(track) : null;
    const d = diagnostics as ScalarDiagnosticRecord;
    const diagnosticsSupported = coldTrackDiagnosticsSupported(d);
    const trackSnapshot: PixiLinearTrackColdGestureSnapshot = {
      requestedTrackId: trackId,
      trackFound: track !== null,
      diagnosticsSupported,
      trackType: track?.type ?? null,
      coverageLodRole: diagnosticNullableString(d, 'coverageLodRole'),
      coverageLodLevel: diagnosticNullableNumber(d, 'coverageLodLevel'),
      coverageLodTargetLevel: diagnosticNullableNumber(d, 'coverageLodTargetLevel'),
      coverageLodBinSize: diagnosticNullableNumber(d, 'coverageLodBinSize'),
      coverageLodAuthority: diagnosticNullableString(d, 'coverageLodAuthority'),
      coverageLodProvenanceExact: diagnosticNullableBoolean(d, 'coverageLodProvenanceExact'),
      coverageSamplePassCount: diagnosticNumber(d, 'coverageSamplePassCount'),
      coverageGeometryBuildCount: diagnosticNumber(d, 'coverageGeometryBuildCount'),
      coverageBufferUploadCount: diagnosticNumber(d, 'coverageBufferUploadCount'),
      coverageSignalNonzeroBinCount: diagnosticNumber(d, 'coverageSignalNonzeroBinCount'),
      renderedReadDensityAlpha: diagnosticNumber(d, 'renderedReadDensityAlpha'),
      densityRowsMeshVisible: diagnosticBoolean(d, 'densityRowsMeshVisible'),
      coverageGpuAtlasAuthorityKey: diagnosticNullableString(d, 'coverageGpuAtlasAuthorityKey'),
      coverageGpuAtlasTextureResourceCreateCount: diagnosticNumber(
        d,
        'coverageGpuAtlasTextureResourceCreateCount'
      ),
      coverageGpuAtlasGpuTextureResourceCreateCount: diagnosticNumber(
        d,
        'coverageGpuAtlasGpuTextureResourceCreateCount'
      ),
      coverageGpuAtlasGpuTextureUploadCount: diagnosticNumber(
        d,
        'coverageGpuAtlasGpuTextureUploadCount'
      ),
      coverageGpuAtlasGpuTextureUploadComplete: diagnosticBoolean(
        d,
        'coverageGpuAtlasGpuTextureUploadComplete'
      ),
      coverageGpuAtlasTextureResourceUid: diagnosticNullableNumber(
        d,
        'coverageGpuAtlasTextureResourceUid'
      ),
      coverageGpuAtlasShaderTextureResourceUid: diagnosticNullableNumber(
        d,
        'coverageGpuAtlasShaderTextureResourceUid'
      ),
      coverageGpuAtlasShaderTextureResourceBound: diagnosticBoolean(
        d,
        'coverageGpuAtlasShaderTextureResourceBound'
      ),
      coverageGpuAtlasGeometryBuildCount: diagnosticNumber(d, 'coverageGpuAtlasGeometryBuildCount'),
      coverageGpuAtlasCameraUniformUpdateCount: diagnosticNumber(
        d,
        'coverageGpuAtlasCameraUniformUpdateCount'
      ),
      coverageGpuAtlasRenderOwner: diagnosticNullableString(d, 'coverageGpuAtlasRenderOwner'),
      coverageGpuAtlasShaderProgramName: diagnosticNullableString(
        d,
        'coverageGpuAtlasShaderProgramName'
      ),
      coverageGpuAtlasShaderProgramKey: diagnosticNullableNumber(
        d,
        'coverageGpuAtlasShaderProgramKey'
      ),
      coverageGpuAtlasShaderProgramCompiled: diagnosticBoolean(
        d,
        'coverageGpuAtlasShaderProgramCompiled'
      ),
      coverageGpuAtlasActive: diagnosticBoolean(d, 'coverageGpuAtlasActive'),
      coverageGpuAtlasBaseBinSizeBp: diagnosticNumber(d, 'coverageGpuAtlasBaseBinSizeBp'),
      rendererViewportStartBp: diagnosticNumber(d, 'rendererViewportStartBp'),
      rendererViewportEndBp: diagnosticNumber(d, 'rendererViewportEndBp'),
    };
    const genomeIdentity = this.genome?.sourceIdentity ?? this.genome?.name ?? '';
    return {
      contract: PIXI_LINEAR_RENDERER_COLD_GESTURE_SNAPSHOT_V1,
      supported: Boolean(this.genome && track && diagnosticsSupported),
      genomeIdentity,
      genomeLengthBp: this.genome?.length ?? 0,
      viewportStartBp: this.lastViewportBpRange.start,
      viewportEndBp: this.lastViewportBpRange.end,
      viewportWidthPx: this.lastViewportWidthPx,
      viewportHeightPx: this.lastCanvasHeight,
      operation: this.getRendererOperationSnapshot(),
      track: trackSnapshot,
      annotation: this.annotationOverlay.getColdGestureSnapshot(),
    };
  }

  getAnnotationPolicyReadinessSnapshot(): PixiLinearRendererAnnotationPolicyReadinessSnapshotV1 {
    const genomeIdentity = this.genome?.sourceIdentity ?? this.genome?.name ?? '';
    return Object.freeze({
      contract: PIXI_LINEAR_RENDERER_ANNOTATION_POLICY_READINESS_SNAPSHOT_V1,
      supported: Boolean(this.genome),
      genomeIdentity,
      genomeLengthBp: this.genome?.length ?? 0,
      viewportStartBp: this.lastViewportBpRange.start,
      viewportEndBp: this.lastViewportBpRange.end,
      annotation: this.annotationOverlay.getAnnotationPolicyReadinessSnapshot(),
    });
  }

  private collectTrackDiagnostics(track: Track): object | null {
    const container = this.trackContainers.get(track.id);
    const renderer = this.trackRenderers.get(track.type);
    if (!container || !renderer) return null;
    const getDiagnostics = (renderer as { getDiagnostics?: unknown }).getDiagnostics;
    if (typeof getDiagnostics !== 'function') return null;
    const diag = (getDiagnostics as (c: Container) => object | null).call(renderer, container);
    return diag ?? null;
  }

  private collectColdTrackDiagnostics(track: Track): object | null {
    const container = this.trackContainers.get(track.id);
    const renderer = this.trackRenderers.get(track.type);
    if (!container || !renderer) return null;
    const getDiagnostics = renderer.getColdGestureDiagnostics ?? renderer.getDiagnostics;
    if (typeof getDiagnostics !== 'function') return null;
    return getDiagnostics.call(renderer, container) ?? null;
  }

  protected syncAnnotationLaneEnvelopeFromOverlay(): void {
    this._maxAnnotationLane = this.annotationOverlay.maxAnnotationLane;
    this._maxCdsLane = this.annotationOverlay.maxCdsLane;
  }

  setAnnotationsVisible(visible: boolean): void {
    this.annotationOverlay.setPresentationVisible(visible);
  }

  private reconcileResidentAnnotationFeaturesForViewport(
    viewStartBp: number,
    viewEndBp: number,
    annotationSearchFocus: RenderState['annotationSearchFocus']
  ): readonly Feature[] | null {
    const selection = this.annotationOverlay.selectResidentAnnotationFeaturesForViewport(
      viewStartBp,
      viewEndBp,
      annotationSearchFocus
    );
    if (selection.status === 'unavailable') {
      this.annotationResidentFeatureSelectionKey = null;
      return null;
    }

    if (selection.status === 'incomplete') return null;
    if (selection.key === this.annotationResidentFeatureSelectionKey) return selection.features;

    const nextSignatures = annotationCodonCarrierSignatures(selection.features);
    for (const [featureId, previousSignature] of this.annotationCodonCarrierSignatures) {
      if (nextSignatures.get(featureId) !== previousSignature) this.codonCache.delete(featureId);
    }
    this.annotationFeatures = selection.features;
    this.annotationCodonCarrierSignatures = nextSignatures;
    this.annotationHasDirectionalCds = nextSignatures.size > 0;
    this.annotationResidentFeatureSelectionKey = selection.key;
    return selection.features;
  }

  getLaneScreenSnapshot(): PixiLinearRendererLaneScreenSnapshot {
    const layout = this._overlayLayout;
    const zones = this.registeredTrackZoneLayout;
    const topAnchored =
      this.trackStackEndReservePx !== undefined ||
      (zones?.aboveZoneHeight ?? 0) > 0 ||
      (zones?.belowZoneHeight ?? 0) > 0;
    const canvasContentHeightPx =
      layout && topAnchored
        ? Math.ceil(layout.trackContentHeight + Math.max(16, this.trackStackEndReservePx ?? 0))
        : null;
    const overlayLayout = this._overlayLayout
      ? {
          totalHeight: this._overlayLayout.totalHeight,
          offset: this._overlayLayout.offset,
          annotationHeight: this._overlayLayout.annotationHeight,
          strandEnvelopeTop: this._overlayLayout.strandEnvelopeTop,
          strandEnvelopeBottom: this._overlayLayout.strandEnvelopeBottom,
          fwdStrandTop: this._overlayLayout.fwdStrandTop,
          revStrandBottom: this._overlayLayout.revStrandBottom,
          trackScrollTop: this._overlayLayout.trackScrollTop,
        }
      : null;
    const trackScreenBounds: Record<
      string,
      {
        topPx: number;
        heightPx: number;
        bottomPx: number;
        scrollsVertically: boolean;
      }
    > = {};
    for (const track of this.trackInstances) {
      const entry = this.lastTrackLayoutEntries.get(track.id);
      const topPx = this.lastTrackContainerTops.get(track.id);
      if (entry === undefined || topPx === undefined) continue;
      trackScreenBounds[track.id] = {
        topPx,
        heightPx: entry.height,
        bottomPx: topPx + entry.height,
        scrollsVertically: track.zone !== 'above-legacy',
      };
    }
    return {
      canvasContentHeightPx,
      overlayLayout,
      trackScreenBounds,
      annotationOverlay: this.annotationOverlay.getAnnotationSearchFocusPresentationSnapshot(),
    };
  }

  hasDrawnOrfs(): boolean {
    return this.orfTrack.hasDrawnOrfs();
  }

  getRendererDebugSnapshot(): unknown {
    this.forensicDebugSnapshotCount += 1;
    return {
      operationOracle: this.getRendererOperationSnapshot(),
      camera: {
        viewStartBp: this.lastViewportBpRange.start,
        viewEndBp: this.lastViewportBpRange.end,
        viewportWidthPx: this.lastViewportWidthPx,
      },
      sequenceTrack: this.sequenceTrack?.getDebugSnapshot?.() ?? null,
      codonTrack: this.codonTrack?.getDebugSnapshot?.() ?? null,
      annotationOverlay: this.annotationOverlay.getDebugSnapshot(),
      annotationCodonCarrierCount: this.annotationCodonCarrierSignatures.size,
      translationLaneCount: this.lastTranslationLaneCount,
      orfTrack: this.orfTrack.getDebugSnapshot(),
      retainedOverlays: this.overlayRegistry.getRetainedDebugSnapshots(),
      backboneSegmentCount: this.getState?.().backboneSegments?.length ?? 0,
      backbonePathSegmentsDrawn: this.backbonePathSegmentsDrawn,
      timings: { ...this._timings },

      laneContract: {
        chromosomeId: this.chromosome?.id ?? null,
        chromosomeLength: this.chromosome?.length ?? null,
        overlayLayout: this._overlayLayout
          ? {
              totalHeight: this._overlayLayout.totalHeight,
              offset: this._overlayLayout.offset,
              annotationTop: this._overlayLayout.annotationTop,
              annotationHeight: this._overlayLayout.annotationHeight,
              translationHeight: this._overlayLayout.translationHeight,
              strandEnvelopeTop: this._overlayLayout.strandEnvelopeTop,
              strandEnvelopeBottom: this._overlayLayout.strandEnvelopeBottom,
              fwdStrandTop: this._overlayLayout.fwdStrandTop,
              fwdStrandCenter: this._overlayLayout.fwdStrandCenter,
              fwdStrandBottom: this._overlayLayout.fwdStrandBottom,
              revStrandTop: this._overlayLayout.revStrandTop,
              revStrandCenter: this._overlayLayout.revStrandCenter,
              revStrandBottom: this._overlayLayout.revStrandBottom,
              rulerY: this._overlayLayout.rulerY,
              sequenceVisible: this._overlayLayout.sequenceVisible,
              sequenceRevealProgress: this._overlayLayout.sequenceRevealProgress,
              rowHeight: this._overlayLayout.rowHeight,
              trackScrollTop: this._overlayLayout.trackScrollTop,
              maxTrackScrollTop: this._overlayLayout.maxTrackScrollTop,
              trackContentHeight: this._overlayLayout.trackContentHeight,
            }
          : null,
        maxAnnotationLane: this._maxAnnotationLane,
        maxCdsLane: this._maxCdsLane,
        registeredTrackLayout: this.lastRegisteredTrackLayoutDebug,
        registeredTypes: Array.from(this.trackRenderers.keys()),
        trackInstanceIds: this.trackInstances.map((t) => t.id),
        mountedContainerIds: Array.from(this.trackContainers.keys()),
        trackDataIds: this.trackInstances
          .map((t) => t.id)
          .filter((id) => this.trackDataStore.has(id)),
        trackDataRecordCounts: Object.fromEntries(
          this.trackInstances
            .map((t) => {
              const data = this.trackDataStore.get<{ records?: ReadonlyArray<unknown> }>(t.id);
              if (!data || !Array.isArray(data.records)) return null;
              return [t.id, data.records.length] as const;
            })
            .filter((entry): entry is readonly [string, number] => entry !== null)
        ),

        trackScreenBounds: Object.fromEntries(
          this.trackInstances
            .map((t) => {
              const entry = this.lastTrackLayoutEntries.get(t.id);
              const topPx = this.lastTrackContainerTops.get(t.id);
              if (entry === undefined || topPx === undefined) return null;
              return [
                t.id,
                {
                  topPx,
                  heightPx: entry.height,
                  bottomPx: topPx + entry.height,
                  scrollsVertically: t.zone !== 'above-legacy',
                },
              ] as const;
            })
            .filter(
              (
                e
              ): e is readonly [
                string,
                {
                  topPx: number;
                  heightPx: number;
                  bottomPx: number;
                  scrollsVertically: boolean;
                },
              ] => e !== null
            )
        ),
        canvasWidthPx: this.lastViewportWidthPx,
        canvasHeightPx: this.lastCanvasHeight,

        trackDiagnostics: Object.fromEntries(
          this.trackInstances
            .map((t): readonly [string, object] | null => {
              const diag = this.collectTrackDiagnostics(t);
              if (diag === null) return null;
              return [t.id, diag] as const;
            })
            .filter((e): e is readonly [string, object] => e !== null)
        ),
      },
    };
  }

  registerTrack(renderer: PixiLinearTrackRenderer): void {
    if (this.trackRenderers.has(renderer.type)) {
      throw new Error(`PixiLinearRenderer: track type "${renderer.type}" is already registered`);
    }
    this.trackRenderers.set(renderer.type, renderer);
    if (this.app?.renderer) renderer.prepareGpuPrograms?.(this.app.renderer);
  }

  setTrackInstances(tracks: ReadonlyArray<Track>): void {
    const newIds = new Set(tracks.map((t) => t.id));
    for (const [id, container] of Array.from(this.trackContainers.entries())) {
      if (newIds.has(id)) continue;
      this.unmountTrackContainer(id, container);
    }
    this.trackInstances = tracks;
    this.trackInstancesById = new Map(tracks.map((track) => [track.id, track]));
    if (this.trackPresentationDrag && !newIds.has(this.trackPresentationDrag.trackId)) {
      this.trackPresentationDrag = null;
    }
    this.trackLayoutRevision += 1;
    this.registeredTrackZoneLayout = null;
    this.rebuildPileupGlobalGuideColumns();
    this.laneContractRevision += 1;
  }

  setTrackPresentationOrder(orderedDataTrackIds: ReadonlyArray<string>): boolean {
    const dataTracks = this.trackInstances.filter((track) => track.zone === 'below-legacy');
    if (orderedDataTrackIds.length !== dataTracks.length) return false;
    const requestedIds = new Set(orderedDataTrackIds);
    if (
      requestedIds.size !== orderedDataTrackIds.length ||
      dataTracks.some((track) => !requestedIds.has(track.id))
    ) {
      return false;
    }
    const currentOrder = [...dataTracks]
      .sort((left, right) => left.order - right.order)
      .map((track) => track.id);
    if (currentOrder.every((trackId, index) => trackId === orderedDataTrackIds[index])) {
      return false;
    }
    const orderByTrackId = new Map(orderedDataTrackIds.map((trackId, order) => [trackId, order]));
    this.trackInstances = this.trackInstances.map((track) => {
      if (track.zone !== 'below-legacy') return track;
      const order = orderByTrackId.get(track.id);
      return order === undefined ? track : { ...track, order };
    });
    this.trackInstancesById = new Map(this.trackInstances.map((track) => [track.id, track]));
    this.trackLayoutRevision += 1;
    this.registeredTrackZoneLayout = null;
    this.laneContractRevision += 1;
    return true;
  }

  setTrackPresentationDrag(preview: TrackPresentationDrag | null): boolean {
    if (preview) {
      const track = this.trackInstancesById.get(preview.trackId);
      if (!track?.visible || track.zone === 'above-legacy' || !Number.isFinite(preview.topPx)) {
        return false;
      }
    }
    if (
      this.trackPresentationDrag?.trackId === preview?.trackId &&
      this.trackPresentationDrag?.topPx === preview?.topPx
    )
      return false;
    this.trackPresentationDrag = preview;
    if (preview) {
      this.getState().hoverPosition = null;
      for (const [id, container] of this.trackContainers) {
        const track = this.trackInstancesById.get(id);
        if (track) this.trackRenderers.get(track.type)?.clearHover?.(container);
      }
    }
    return true;
  }

  isTrackPresentationDragging(): boolean {
    return this.trackPresentationDrag !== null;
  }

  setTrackColor(trackId: string, color: string | undefined): boolean {
    const current = this.trackInstancesById.get(trackId);
    if (!current || current.color === color) return false;
    const next = { ...current, color };
    this.trackInstances = this.trackInstances.map((track) => (track.id === trackId ? next : track));
    this.trackInstancesById.set(trackId, next);
    this.laneContractRevision += 1;
    return true;
  }

  setTrackData(trackId: string, data: unknown): void {
    this.trackDataStore.set(trackId, data);
    this.reconcilePileupAlternateColumns(trackId, data);
    this.invalidateMeasuredTrackLayout(trackId);
    this.laneContractRevision += 1;
  }

  updateTrackData<TData>(trackId: string, update: (current: TData) => TData): boolean {
    const current = this.trackDataStore.get<TData>(trackId);
    if (current === null) return false;
    const next = update(current);
    if (Object.is(next, current)) return false;
    this.trackDataStore.set(trackId, next);
    this.reconcilePileupAlternateColumns(trackId, next);
    this.invalidateMeasuredTrackLayout(trackId);
    this.laneContractRevision += 1;
    return true;
  }

  private invalidateMeasuredTrackLayout(trackId: string): void {
    const track = this.trackInstancesById.get(trackId);
    const trackRenderer = track ? this.trackRenderers.get(track.type) : null;
    if (track?.sizing?.kind !== 'fitContent' || !trackRenderer?.measureContentHeight) return;
    this.trackLayoutRevision += 1;
    this.registeredTrackZoneLayout = null;
  }

  getLaneContractRevision(): number {
    return this.laneContractRevision;
  }

  hasTrackInstance(trackId: string): boolean {
    return this.trackInstancesById.has(trackId);
  }

  hasTrackData(trackId: string): boolean {
    return this.trackDataStore.has(trackId);
  }

  setChromosome(chromosome: Chromosome): void {
    this.chromosome = chromosome;

    this.assembly = buildAssembly(chromosome.id, chromosome.displayName, [chromosome]);
  }

  setAssembly(assembly: Assembly): void {
    this.assembly = assembly;
    this.chromosome = assembly.chromosomes[0]?.chromosome ?? null;
  }

  setTrackHitHandler(handler: ((result: TrackHitResult) => void) | null): void {
    this.trackHitHandler = handler;
  }

  async init(app: Application, genome: Genome, getState: () => RenderState): Promise<void> {
    this.app = app;
    this.getState = getState;
    this.contactLayer.visible = false;
    this.contactLayer.eventMode = 'none';
    this.contactLayer.addChild(this.contactGraphics);
    this.contactTextPool = new TextPool(
      this.contactLayer,
      new TextStyle({ fontSize: RULER_FONT_SIZE, fill: RULER_COLOR, fontFamily: LABEL_FONT_FAMILY })
    );
    this.app.stage.addChild(this.contactLayer);
    this.app.stage.addChild(this.comparisonPainter.container);
    this.scrollingLayer.mask = this.scrollingMask;
    this.scrollingLayer.hitArea = this.scrollingBounds;
    this.scrollingMask.eventMode = 'none';
    this.app.stage.addChild(this.scrollingLayer);
    this.app.stage.addChild(this.scrollingMask);
    this.trackDragBackground.eventMode = 'none';
    this.trackDragBackground.visible = false;
    this.scrollingLayer.addChild(this.trackDragBackground);
    this.selectionLayer.addChild(this.selectionGraphics);
    this.scrollingLayer.addChild(this.selectionLayer);
    this.scrollingLayer.addChild(this.rulerLayer);
    this.rulerLayer.addChild(this.rulerGraphics);
    this.rulerLayer.addChild(this.rulerSegmentLayer);
    this.rulerLayer.addChild(this.rulerTickLayer);
    this.rulerTextPool = new KeyedTextPool(
      this.rulerLayer,
      new TextStyle({ fontSize: RULER_FONT_SIZE, fill: RULER_COLOR, fontFamily: LABEL_FONT_FAMILY })
    );

    this.annotationOverlay.setRenderer(app.renderer ?? null);
    for (const renderer of this.trackRenderers.values()) {
      renderer.prepareGpuPrograms?.(app.renderer);
    }
    this.overlayRegistry.register(this.annotationOverlay);
    this.overlayRegistry.register(this.primerOverlay);
    this.scrollingLayer.addChild(this.annotationOverlay.container);
    this.scrollingLayer.addChild(this.primerOverlay.container);
    this.sequenceTrack = new SequenceTrack(this.scrollingLayer, {
      renderer: this.app.renderer,
      prepareLegacyGlyphs: async (glyphs) => {
        prepareLinearSequenceGlyphTextures(this.app.renderer, glyphs);
      },
    });
    this.sequenceTrack.setNucleicAcid(this.genome?.nucleicAcid ?? 'dna');
    this.codonTrack = new CodonTrack(this.scrollingLayer);
    this.orfTrack = new OrfTrack(this.scrollingLayer);
    this.restrictionTrack = new RestrictionTrack(this.scrollingLayer);

    this.scrollingLayer.addChildAt(this.pileupGlobalGuideLayer.container, 0);
    this.interactionLayer.addChild(this.interactionGraphics);
    this.scrollingLayer.addChild(this.interactionLayer);
    await this.loadGenome(genome);
  }

  private applyTheme(state: RenderState): void {
    const theme = webglThemeForMode(state.themeMode);
    if (this.appliedThemeMode !== theme.mode) {
      this.appliedThemeMode = theme.mode;
      this.rulerTextPool.setStyle(
        new TextStyle({
          fontSize: RULER_FONT_SIZE,
          fill: theme.rulerText,
          fontFamily: LABEL_FONT_FAMILY,
        })
      );
      this.sequenceTrack.setTheme(theme);
    }
  }

  async loadGenome(genome: Genome): Promise<void> {
    this.recordRendererContentOperation('loadGenome');

    // global is the behavioral gate — the assembly perf probes assert the count

    if (typeof window !== 'undefined') {
      const w = window as Window & {
        __webglGenomeLoadCount?: number;
        __webglGenomeLoadLog?: Array<{ name: string; features: number; t: number }>;
      };
      w.__webglGenomeLoadCount = (w.__webglGenomeLoadCount ?? 0) + 1;
      (w.__webglGenomeLoadLog ??= []).push({
        name: genome.name ?? 'unknown',
        features: genomeFeatures(genome).length,
        t: typeof performance !== 'undefined' ? Math.round(performance.now()) : 0,
      });
      if (w.__webglGenomeLoadLog.length > 200) w.__webglGenomeLoadLog.shift();
    }
    const nextTrackScrollScopeKey = `${genome.sourceIdentity ?? genome.name}:${genome.length}`;
    if (nextTrackScrollScopeKey !== this.trackScrollScopeKey) {
      this.trackScrollScopeKey = nextTrackScrollScopeKey;
      this.requestedTrackScrollTop = null;
    }
    this.genome = genome;
    this.sequenceTrack?.setNucleicAcid(genome.nucleicAcid ?? 'dna');
    const features = genomeFeatures(genome);
    this.annotationFeatures = features;
    this.annotationCodonCarrierSignatures = annotationCodonCarrierSignatures(features);
    this._maxAnnotationLane =
      genome.annotationLayout?.maxAnnotationLane ??
      features.reduce((max, f) => (f.type === 'CDS' ? max : Math.max(max, f.lane)), -1);
    this._maxCdsLane =
      genome.annotationLayout?.maxCdsLane ??
      features.reduce((max, f) => (f.type === 'CDS' ? Math.max(max, f.lane) : max), -1);
    this.annotationHasDirectionalCds = this.annotationCodonCarrierSignatures.size > 0;
    this.overlayRegistry.loadGenome(
      features.some((feature) => feature.codingGhostOnly)
        ? { ...genome, features: features.filter((feature) => !feature.codingGhostOnly) }
        : genome
    );

    this.syncAnnotationLaneEnvelopeFromOverlay();
    this.codonTrack.reset();
    this.orfTrack.loadGenome(genome);
    this.cutSites = [];
    this.codonCache.clear();
    this.transientAnnotationSearchCodonCache = null;
    this.residentAnnotationSearchFocusResolution = null;
  }

  setSequenceWindow(window?: Genome['sequenceWindow']): void {
    if (!this.genome) return;
    const previous = this.genome.sequenceWindow;
    const changed =
      previous?.startBp !== window?.startBp ||
      previous?.bases.length !== window?.bases.length ||
      previous?.bases !== window?.bases;
    this.genome = { ...this.genome, sequenceWindow: window };
    if (changed) {
      this.codonCache.clear();
      this.transientAnnotationSearchCodonCache = null;

      // global, so reach the real global object via globalThis (always defined).
      const g = globalThis as typeof globalThis & { __webglSetSequenceWindowCount?: number };
      g.__webglSetSequenceWindowCount = (g.__webglSetSequenceWindowCount ?? 0) + 1;
    }
  }

  setCutSites(sites: CutSite[]): void {
    this.cutSites = sites;
  }

  setPrimers(primers: readonly Primer[]): void {
    this.primerOverlay.setPrimers(primers);

    this.overlayRegistry.invalidateLayout();
  }

  getMinZoom(state: RenderState): number {
    if (state.contactProjection || state.comparisonProjection) return 1;
    const pixelsPerBp = state.sequencePresentation?.minSequencePixelsPerBp;
    if (
      !this.genome ||
      pixelsPerBp === undefined ||
      !Number.isFinite(pixelsPerBp) ||
      pixelsPerBp <= 0 ||
      state.width <= 0
    )
      return 0.5;
    return Math.max(Number.EPSILON, (this.genome.length * pixelsPerBp) / state.width);
  }

  getMaxZoom(state: RenderState): number {
    if (state.comparisonProjection) return state.comparisonProjection.layout.columnLength;
    if (state.contactProjection)
      return Math.min(
        state.contactProjection.xReference.length,
        state.contactProjection.yReference.length
      );
    const hasAnySequence =
      !!this.genome?.sequence || !!this.genome?.sequenceWindow || this.genome?.sequenceAvailable;
    if (!this.genome || !hasAnySequence) return Number.POSITIVE_INFINITY;
    const requestedPixelsPerBp = state.sequencePresentation?.maxSequencePixelsPerBp;
    const maxPixelsPerBp =
      requestedPixelsPerBp !== undefined &&
      Number.isFinite(requestedPixelsPerBp) &&
      requestedPixelsPerBp > 0
        ? requestedPixelsPerBp
        : MAX_INDEXED_LINEAR_SEQUENCE_PIXELS_PER_BP;
    const readableMaxZoom = Math.max(
      0.01,
      maxZoomForSequencePixelsPerBp(this.genome.length, state.width, maxPixelsPerBp)
    );
    return capMaxZoomForStabilityMode({
      genomeLength: this.genome.length,
      screenPathLengthPx: state.width,
      sequenceViewportSpanPx: state.width,
      readableMaxZoom,
      performanceMode: state.performanceMode,
    });
  }

  private resolveResidentAnnotationSearchFocusFeature(
    focus: RenderState['annotationSearchFocus']
  ): Feature | null {
    if (!focus) {
      this.residentAnnotationSearchFocusResolution = null;
      this.transientAnnotationSearchCodonCache = null;
      return null;
    }
    if (
      this.transientAnnotationSearchCodonCache &&
      (this.transientAnnotationSearchCodonCache.trackId !== focus.trackId ||
        this.transientAnnotationSearchCodonCache.canonicalIdentity !== focus.canonicalIdentity)
    ) {
      this.transientAnnotationSearchCodonCache = null;
    }
    const cached = this.residentAnnotationSearchFocusResolution;
    if (
      cached?.annotationFeatures === this.annotationFeatures &&
      cached.trackId === focus.trackId &&
      cached.canonicalIdentity === focus.canonicalIdentity
    ) {
      return cached.target;
    }

    let target: Feature | null = null;
    for (const feature of this.annotationFeatures) {
      if (isAnnotationSearchFocusTarget(feature, focus)) {
        target = feature;
        break;
      }
    }
    this.residentAnnotationSearchFocusResolution = {
      annotationFeatures: this.annotationFeatures,
      trackId: focus.trackId,
      canonicalIdentity: focus.canonicalIdentity,
      target,
    };
    return target;
  }

  render(state: RenderState): boolean {
    if (!this.genome) return false;
    if (state.comparisonProjection) {
      this.contactLayer.visible = false;
      this.scrollingLayer.visible = false;
      this.app.stage.scale.set(1);
      this.app.stage.position.set(0, 0);
      state.comparisonCamera = this.getComparisonCamera(state)!;
      this.comparisonPainter.paint(state.comparisonProjection, state.comparisonCamera, state);
      this.recordRendererCompletedFrame();
      return false;
    }
    this.comparisonPainter.container.visible = false;
    if (state.contactProjection) return this.renderContactProjection(state);
    this.contactLayer.visible = false;
    this.scrollingLayer.visible = true;

    this.annotationOverlay.reconcileAnnotationLaneEnvelopeForFrame();
    this.syncAnnotationLaneEnvelopeFromOverlay();
    this.applyTheme(state);
    resetLabelOccupancy(state);
    this.selectionGraphics.clear();
    this.interactionGraphics.clear();
    this.backbonePathSegmentsDrawn = 0;
    let t0 = performance.now();
    const maxZoom = this.getMaxZoom(state);
    if (state.zoom > maxZoom) state.zoom = maxZoom;
    const { width, height, zoom } = state;

    state.viewOffset = clampLinearViewOffset(state.viewOffset, zoom);

    const bpPerPixel = this.genome.length / (width * zoom);
    const scrollBp = state.viewOffset * this.genome.length;
    const xOffset = linearGenomeXOffset(width, zoom);
    const viewStartBp = scrollBp - xOffset * bpPerPixel;
    const viewEndBp = scrollBp + (width - xOffset) * bpPerPixel;

    this.app.stage.scale.set(1);
    this.app.stage.position.set(0, 0);

    const hasAnySequence = !!this.genome.sequence || !!this.genome.sequenceWindow?.bases.length;
    const sequenceAvailable = genomeSequenceAvailable(this.genome);

    const residentAnnotationSearchFocus =
      state.annotationSearchFocus &&
      (this.genome.annotationLayerTypes?.includes(state.annotationSearchFocus.trackId) === true ||
        this.annotationFeatures.some(
          (feature) =>
            (feature.annotationTrackId ?? feature.type) === state.annotationSearchFocus?.trackId
        ))
        ? state.annotationSearchFocus
        : null;
    const residentFeatures =
      bpPerPixel < 5 && hasAnySequence
        ? this.reconcileResidentAnnotationFeaturesForViewport(
            viewStartBp,
            viewEndBp,
            residentAnnotationSearchFocus
          )
        : null;
    let residentMaxAnnotationLane = -1;
    let residentMaxCdsLane = -1;
    for (const feature of residentFeatures ?? []) {
      if (feature.type === 'CDS') {
        residentMaxCdsLane = Math.max(residentMaxCdsLane, feature.cdsLane ?? feature.lane);
      } else {
        residentMaxAnnotationLane = Math.max(residentMaxAnnotationLane, feature.lane);
      }
    }

    const residentAnnotationSearchFocusFeature = this.resolveResidentAnnotationSearchFocusFeature(
      residentAnnotationSearchFocus
    );
    const exactFlatFocusFeature = validatedAnnotationSearchFocusFeature(state);
    const retainedPolicyVisibility = this.annotationOverlay.annotationSearchFocusDurableVisibility(
      state.annotationSearchFocus
    );
    const flatFocusPresentation =
      exactFlatFocusFeature && state.annotationSearchFocus && !residentAnnotationSearchFocusFeature
        ? flatAnnotationSearchFocusPresentation({
            feature: exactFlatFocusFeature,
            focus: state.annotationSearchFocus,
            durableLayerTypes: this.genome.annotationLayerTypes,
            durableFeatures: this.annotationFeatures,
            durableMaxAnnotationLane: this._maxAnnotationLane,
            durableMaxCdsLane: this._maxCdsLane,
            retainedPolicyVisibility,
          })
        : null;
    const annotationSearchFocusFeature = flatFocusPresentation?.feature ?? null;
    const residentAdditionalLaneTarget =
      usesTemporaryAdditionalAnnotationLane(state.annotationSearchFocus) &&
      residentAnnotationSearchFocusFeature &&
      (residentAnnotationSearchFocusFeature.type === 'CDS'
        ? (residentAnnotationSearchFocusFeature.cdsLane ??
            residentAnnotationSearchFocusFeature.lane) > this._maxCdsLane
        : residentAnnotationSearchFocusFeature.lane > this._maxAnnotationLane)
        ? residentAnnotationSearchFocusFeature
        : null;
    const effectiveMaxAnnotationLane = Math.max(
      residentMaxAnnotationLane,
      residentAdditionalLaneTarget && residentAdditionalLaneTarget.type !== 'CDS'
        ? Math.max(
            flatFocusPresentation?.effectiveMaxAnnotationLane ?? this._maxAnnotationLane,
            residentAdditionalLaneTarget.lane
          )
        : (flatFocusPresentation?.effectiveMaxAnnotationLane ?? this._maxAnnotationLane)
    );
    const effectiveMaxCdsLane = Math.max(
      residentMaxCdsLane,
      residentAdditionalLaneTarget?.type === 'CDS'
        ? Math.max(
            flatFocusPresentation?.effectiveMaxCdsLane ?? this._maxCdsLane,
            residentAdditionalLaneTarget.cdsLane ?? residentAdditionalLaneTarget.lane
          )
        : (flatFocusPresentation?.effectiveMaxCdsLane ?? this._maxCdsLane)
    );
    const annotationSearchFocusHasDirectionalCds =
      annotationSearchFocusFeature !== null &&
      annotationCodonCarrierSignature(annotationSearchFocusFeature) !== null;

    const translationLanes =
      bpPerPixel < 5 && hasAnySequence
        ? this.annotationHasDirectionalCds || annotationSearchFocusHasDirectionalCds
          ? 1
          : 0
        : 0;
    this.lastTranslationLaneCount = translationLanes;

    const annotationLanes = effectiveMaxAnnotationLane + 1;
    const cdsLanes = effectiveMaxCdsLane + 1;

    const registeredTrackZoneLayout = this.getRegisteredTrackZoneLayout(state.height);
    const { aboveZoneHeight, belowZoneHeight } = registeredTrackZoneLayout;
    const annotationTopReservePx =
      this.annotationOverlay instanceof SequenceAnnotationOverlay &&
      this.annotationOverlay.enabled &&
      (aboveZoneHeight > 0 || belowZoneHeight > 0 || this.trackStackEndReservePx !== undefined)
        ? this.annotationOverlay.floatingLabelTopReservePx()
        : 0;
    this.updateScrollingBounds(width, height, aboveZoneHeight);

    const pixelsPerBp = 1 / bpPerPixel;
    const stableAnnotationLanes = Math.max(0, annotationLanes);
    const stableCdsLanes = Math.max(0, cdsLanes);

    const reserveSequenceLayoutEnvelope =
      sequenceAvailable &&
      (this.trackInstances.length > 0 || this.trackStackEndReservePx !== undefined);

    if (reserveSequenceLayoutEnvelope) this.primerOverlay.setVisibleRange(viewStartBp, viewEndBp);
    else this.primerOverlay.setVisibleRange(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
    const orfForwardLanes = this.orfTrack.getForwardLaneCount();
    const orfReverseLanes = this.orfTrack.getReverseLaneCount();
    const overlayLayoutRevision = this.overlayRegistry.getLayoutRevision();
    const coreCameraKey = unifiedLayoutCoreCameraKey(pixelsPerBp);
    const showSecondarySequenceRow =
      state.sequencePresentation?.alignedQuery !== undefined ||
      state.sequencePresentation?.showReverseComplement !== false;
    const cachedLayout = this.unifiedLayoutCache;
    const canReuseLayout = unifiedLayoutCacheMatches(cachedLayout, {
      genome: this.genome,
      overlayLayoutRevision,
      coreCameraKey,
      width,
      height,
      hasSequence: hasAnySequence,
      sequenceAvailable,
      reserveSequenceLayoutEnvelope,
      showSecondarySequenceRow,
      showResidueNumbers: state.showResidueNumbers === true,
      cdsSizing: state.sequencePresentation?.cdsSizing ?? this.defaultCdsSizing,
      translationLanes,
      annotationLanes: stableAnnotationLanes,
      cdsLanes: stableCdsLanes,
      orfForwardLanes,
      orfReverseLanes,
      aboveZoneHeight,
      belowZoneHeight,
      annotationTopReservePx,
      requestedTrackScrollTop: this.requestedTrackScrollTop,
      trackStackEndReservePx: this.trackStackEndReservePx,
      overlayRegistry: this.overlayRegistry,
      state,
      pixelsPerBp,
    });

    let layout: UnifiedLayout;
    if (canReuseLayout) {
      layout = cachedLayout.layout;
    } else {
      layout = computeUnifiedLayout({
        overlays: this.overlayRegistry.getAll(),
        genome: this.genome,
        state,
        pixelsPerBp,
        viewportHeight: height,
        hasSequence: hasAnySequence,
        sequenceAvailable,
        reserveSequenceLayoutEnvelope,
        showReverseComplement: showSecondarySequenceRow,
        translationLanes,
        cdsSizing: state.sequencePresentation?.cdsSizing ?? this.defaultCdsSizing,
        annotationLanes: stableAnnotationLanes,
        cdsLanes: stableCdsLanes,
        orfForwardLanes,
        orfReverseLanes,
        topOffsetMin: aboveZoneHeight,
        annotationTopReservePx,
        bottomReserve: belowZoneHeight,
        trackScrollTop: this.requestedTrackScrollTop ?? undefined,
        trackStackEndReservePx: this.trackStackEndReservePx,
      });
      this.unifiedLayoutComputeCount += 1;
      const overlayLayoutKeys = this.overlayRegistry.captureLayoutCacheKeys(
        this.genome,
        state,
        pixelsPerBp
      );
      this.unifiedLayoutCache = overlayLayoutKeys
        ? {
            genome: this.genome,
            overlayLayoutRevision,
            overlayLayoutKeys,
            coreCameraKey,
            width,
            height,
            hasSequence: hasAnySequence,
            sequenceAvailable,
            reserveSequenceLayoutEnvelope,
            showSecondarySequenceRow,
            showResidueNumbers: state.showResidueNumbers === true,
            cdsSizing: state.sequencePresentation?.cdsSizing ?? this.defaultCdsSizing,
            translationLanes,
            annotationLanes: stableAnnotationLanes,
            cdsLanes: stableCdsLanes,
            orfForwardLanes,
            orfReverseLanes,
            aboveZoneHeight,
            belowZoneHeight,
            annotationTopReservePx,
            trackScrollTop: this.requestedTrackScrollTop === null ? null : layout.trackScrollTop,
            trackStackEndReservePx: this.trackStackEndReservePx,
            layout,
          }
        : null;
    }
    if (this.requestedTrackScrollTop !== null) {
      this.requestedTrackScrollTop = layout.trackScrollTop;
    }
    this._overlayLayout = layout;

    const path = LinearPathMapper.fromUnifiedLayout(
      layout,
      width,
      bpPerPixel,
      viewStartBp,
      viewEndBp,
      annotationLanes,
      translationLanes,
      height
    );
    this._layout = path;

    this.lastViewportBpRange = { start: viewStartBp, end: viewEndBp };
    this.lastViewportWidthPx = state.width;
    this.lastCanvasHeight = state.height;

    this.annotationOverlay.setLayout(layout, {
      maxAnnotationLane: effectiveMaxAnnotationLane,
      maxCdsLane: effectiveMaxCdsLane,
    });
    this.primerOverlay.setLayout(layout);
    const annotationPresentationState =
      annotationSearchFocusFeature && annotationSearchFocusFeature !== exactFlatFocusFeature
        ? { ...state, annotationSearchFocusFeature }
        : state;

    this.renderOverlaysForLayout(path, layout, state, annotationPresentationState);

    this._timings.transform = performance.now() - t0;

    this._timings.backbone = 0;
    this._timings.features = 0;

    this._timings.highlight = 0;
    this._timings.labels = 0;

    t0 = performance.now();
    this.renderVisibleCodonCarriers({
      state,
      layout,
      path,
      viewStartBp,
      viewEndBp,
      residentAnnotationSearchFocusFeature,
      annotationSearchFocusFeature,
    });
    this._timings.codons = performance.now() - t0;

    t0 = performance.now();
    this.orfTrack.render(path, state, layout, this.genome.length, this.genome.sequence);
    this._timings.orfs = performance.now() - t0;

    t0 = performance.now();
    this.restrictionTrack.reset();
    if (bpPerPixel < 50 && this.cutSites.length > 0) {
      const showRecognition = bpPerPixel < 10;
      this.restrictionTrack.renderSites(this.cutSites, path, showRecognition, state);
    }
    this._timings.restrictions = performance.now() - t0;

    t0 = performance.now();
    const sequenceRender = this.sequenceTrack.renderLinear(
      this.genome.sequence,
      path.getModel(),
      width,
      this.genome.sequenceWindow,
      state.sequencePresentation
    );
    this.presentedSecondarySequenceRow = showSecondarySequenceRow;

    this.drawRuler(state, viewStartBp, viewEndBp, bpPerPixel, layout);
    this._timings.sequence = performance.now() - t0;

    t0 = performance.now();
    this.drawHighlightAndCursor(state, path, layout, viewStartBp, bpPerPixel);
    this._timings.highlight = performance.now() - t0;

    const registeredTrackPaintPending = this.renderRegisteredTracks(
      state,
      path,
      layout,
      viewStartBp,
      viewEndBp,
      registeredTrackZoneLayout
    );
    this.pileupGlobalGuideLayer.paint({
      columns: this.pileupGlobalGuideColumns,
      pathMapper: path,
      viewportStartBp: viewStartBp,
      viewportWidthPx: state.width,
      viewportHeightPx: state.height,
      guideTopPx: aboveZoneHeight,
      guideHeightPx: Math.max(0, state.height - aboveZoneHeight),
    });
    this.recordRendererCompletedFrame();
    return registeredTrackPaintPending || sequenceRender.preparationPending;
  }

  getComparisonCamera(state: RenderState = this.getState()): ComparisonCamera | null {
    return state.comparisonProjection
      ? resolveComparisonCamera(state.comparisonProjection, state.comparisonCamera)
      : null;
  }

  setComparisonCamera(
    camera: ComparisonCamera,
    state: RenderState = this.getState()
  ): ComparisonCamera | null {
    if (!state.comparisonProjection) return null;
    state.comparisonCamera = resolveComparisonCamera(state.comparisonProjection, camera);
    return { ...state.comparisonCamera };
  }

  panComparison(deltaPx: number, state: RenderState): ComparisonCamera | null {
    if (!state.comparisonProjection) return null;
    state.comparisonCamera = panComparisonCamera(
      state.comparisonProjection,
      state.comparisonCamera,
      deltaPx,
      comparisonPlot(state.width, state.height)
    );
    return { ...state.comparisonCamera };
  }

  zoomComparison(factor: number, x: number, state: RenderState): ComparisonCamera | null {
    if (!state.comparisonProjection) return null;
    state.comparisonCamera = zoomComparisonCamera(
      state.comparisonProjection,
      state.comparisonCamera,
      factor,
      x,
      comparisonPlot(state.width, state.height)
    );
    return { ...state.comparisonCamera };
  }

  hitTestComparison(x: number, y: number, state: RenderState): ComparisonHit | null {
    return state.comparisonProjection
      ? hitTestComparison(
          state.comparisonProjection,
          this.getComparisonCamera(state)!,
          comparisonPlot(state.width, state.height),
          x,
          y
        )
      : null;
  }

  getComparisonProjectionDiagnostics(): object | null {
    return this.comparisonPainter.getDiagnostics();
  }

  getContactCamera(state: RenderState = this.getState()): ContactCamera | null {
    const projection = state.contactProjection;
    return projection ? resolveContactCamera(projection, state.contactCamera) : null;
  }

  setContactCamera(
    camera: ContactCamera,
    state: RenderState = this.getState()
  ): ContactCamera | null {
    const projection = state.contactProjection;
    if (!projection) return null;
    state.contactCamera = resolveContactCamera(projection, camera);
    return { ...state.contactCamera };
  }

  panContact(deltaX: number, deltaY: number, state: RenderState): ContactCamera | null {
    const projection = state.contactProjection;
    if (!projection) return null;
    state.contactCamera = panContactCamera(
      projection,
      this.getContactCamera(state)!,
      deltaX,
      deltaY,
      contactPlotRect(state.width, state.height)
    );
    return { ...state.contactCamera };
  }

  zoomContact(factor: number, x: number, y: number, state: RenderState): ContactCamera | null {
    const projection = state.contactProjection;
    if (!projection) return null;
    state.contactCamera = zoomContactCamera(
      projection,
      this.getContactCamera(state)!,
      factor,
      x,
      y,
      contactPlotRect(state.width, state.height)
    );
    return { ...state.contactCamera };
  }

  hitTestContact(x: number, y: number, state: RenderState): ContactHit | null {
    const projection = state.contactProjection;
    return projection
      ? hitTestContactCell(
          projection,
          this.getContactCamera(state)!,
          contactPlotRect(state.width, state.height),
          x,
          y
        )
      : null;
  }

  getContactProjectionDiagnostics() {
    const state = this.getState?.();
    const projection = state?.contactProjection;
    if (!projection || !state) return null;
    return {
      projectionId: projection.id,
      xReference: { ...projection.xReference },
      yReference: { ...projection.yReference },
      camera: this.getContactCamera(state),
      plot: contactPlotRect(state.width, state.height),
      sourceCellCount: projection.cells.length,
      xBinCount: new Set(projection.cells.map((cell) => `${cell.start}:${cell.end}`)).size,
      yBinCount: new Set(projection.cells.map((cell) => `${cell.targetStart}:${cell.targetEnd}`))
        .size,
      paintedCellCount: this.contactPaintedCells,
      hoveredContact: state.hoveredContact ? structuredClone(state.hoveredContact) : null,
      selectedContact: state.selectedContact ? structuredClone(state.selectedContact) : null,
      visible: this.contactLayer.visible,
    };
  }

  private renderContactProjection(state: RenderState): boolean {
    const projection = state.contactProjection!;
    const camera = this.getContactCamera(state)!;
    state.contactCamera = camera;
    const plot = contactPlotRect(state.width, state.height);
    const theme = webglThemeForMode(state.themeMode);
    this.scrollingLayer.visible = false;
    this.contactLayer.visible = true;
    this.app.stage.scale.set(1);
    this.app.stage.position.set(0, 0);
    const graphics = this.contactGraphics.clear();
    this.contactTextPool.reset();
    if (this.contactThemeMode !== theme.mode) {
      this.contactThemeMode = theme.mode;
      this.contactTextPool.setStyle(
        new TextStyle({
          fontSize: RULER_FONT_SIZE,
          fill: theme.rulerText,
          fontFamily: LABEL_FONT_FAMILY,
        })
      );
    }
    this.contactPaintedCells = 0;
    for (const cell of projection.cells) {
      const rect = contactCellRect(cell, camera, plot);
      if (!rect) continue;
      const color = dataColor(cell.value, projection.colorScale);
      graphics
        .rect(rect.x, rect.y, rect.width, rect.height)
        .fill(Number.parseInt(color.slice(1), 16));
      this.contactPaintedCells += 1;
    }
    for (const hit of [state.hoveredContact, state.selectedContact]) {
      if (hit?.projectionId !== projection.id) continue;
      const cell = projection.cells.find((candidate) => candidate.id === hit.cellId);
      const rect = cell && contactCellRect(cell, camera, plot);
      if (!rect) continue;
      graphics.rect(rect.x, rect.y, rect.width, rect.height).stroke({
        color: theme.rulerText,
        width: hit === state.selectedContact ? 2 : 1,
      });
    }
    graphics
      .rect(plot.x, plot.y, plot.width, plot.height)
      .stroke({ color: theme.rulerText, width: 1 });
    const label = (value: string, x: number, y: number, anchorX = 0.5, rotation = 0) => {
      const text = this.contactTextPool.acquire();
      text.text = value;
      text.anchor.set(anchorX, 0.5);
      text.position.set(x, y);
      text.rotation = rotation;
    };
    const drawTicks = (axis: 'x' | 'y', start: number, end: number, spanPx: number) => {
      const step = computeTickStep(end - start, spanPx);
      for (let bp = Math.ceil(start / step) * step; bp <= end; bp += step) {
        const fraction = (bp - start) / (end - start);
        if (axis === 'x') {
          const x = plot.x + fraction * plot.width;
          graphics
            .moveTo(x, plot.y + plot.height)
            .lineTo(x, plot.y + plot.height + 4)
            .stroke({ color: theme.rulerText, width: 1 });
          label(formatRulerLabel(bp, step), x, plot.y + plot.height + 15);
        } else {
          const y = plot.y + fraction * plot.height;
          graphics
            .moveTo(plot.x - 4, y)
            .lineTo(plot.x, y)
            .stroke({ color: theme.rulerText, width: 1 });
          label(formatRulerLabel(bp, step), plot.x - 8, y, 1);
        }
      }
    };
    drawTicks('x', camera.xStart, camera.xEnd, plot.width);
    drawTicks('y', camera.yStart, camera.yEnd, plot.height);
    label(
      projection.xReference.label ?? projection.xReference.chrom,
      plot.x + plot.width / 2,
      state.height - 12
    );
    label(
      projection.yReference.label ?? projection.yReference.chrom,
      13,
      plot.y + plot.height / 2,
      0.5,
      -Math.PI / 2
    );
    this.recordRendererCompletedFrame();
    return false;
  }

  private renderOverlaysForLayout(
    path: PathMapper,
    layout: UnifiedLayout,
    state: RenderState,
    annotationPresentationState: RenderState
  ): void {
    const overlaySlots = [...layout.above, ...layout.on, ...layout.below];
    const renderedOverlays = new Set<object>();
    for (const slot of overlaySlots) {
      renderedOverlays.add(slot.overlay);
      this.overlayRegistry.renderOverlay(
        slot.overlay,
        path,
        slot.overlay === this.annotationOverlay ? annotationPresentationState : state,
        slot.yOffset,
        slot.height
      );
    }
    for (const overlay of this.overlayRegistry.getAll()) {
      if (renderedOverlays.has(overlay)) continue;
      this.overlayRegistry.renderOverlay(
        overlay,
        path,
        overlay === this.annotationOverlay ? annotationPresentationState : state,
        0,
        0
      );
    }
  }

  private renderVisibleCodonCarriers(input: {
    state: RenderState;
    layout: UnifiedLayout;
    path: PathMapper;
    viewStartBp: number;
    viewEndBp: number;
    residentAnnotationSearchFocusFeature: Feature | null;
    annotationSearchFocusFeature: Feature | null;
  }): void {
    if (!this.genome) return;
    const {
      state,
      layout,
      path,
      viewStartBp,
      viewEndBp,
      residentAnnotationSearchFocusFeature,
      annotationSearchFocusFeature,
    } = input;
    this.codonTrack.reset();
    const presentation = state.sequencePresentation;
    if (presentation?.showTranslation === false) return;
    const biologicalGenome = presentation?.biologicalGenome;
    const bioToColumn = presentation?.bioToColumn;
    const columnToBio = presentation?.columnToBio;
    const projected = !!(biologicalGenome && bioToColumn && columnToBio);
    const referenceCoding = presentation?.referenceCoding;
    const referenceGenome = referenceCoding?.genome;

    if (presentation?.alignedQuery !== undefined && !projected) return;
    const codingGenome = projected ? biologicalGenome : this.genome;
    if (
      this.codonBiologicalGenome !== (projected ? biologicalGenome : null) ||
      this.codonBioToColumn !== (projected ? bioToColumn : null) ||
      this.codonReferenceGenome !== (referenceGenome ?? null) ||
      this.codonPreparedFeatures !== presentation?.codingFeatures
    ) {
      this.codonCache.clear();
      this.transientAnnotationSearchCodonCache = null;
      this.codonBiologicalGenome = projected ? biologicalGenome : null;
      this.codonBioToColumn = projected ? bioToColumn : null;
      this.codonReferenceGenome = referenceGenome ?? null;
      this.codonPreparedFeatures = presentation?.codingFeatures;
      this.codonReferenceFeatures = new Map(
        (referenceGenome?.features ?? []).map((feature) => [feature.id, feature])
      );
      this.codonBiologicalFeatures = new Map(
        (projected ? (biologicalGenome.features ?? []) : []).map((feature) => [feature.id, feature])
      );
    }

    const baseReader = createBaseReader(
      codingGenome.sequence,
      codingGenome.sequenceWindow,
      codingGenome.circular
    );
    const compoundCdsOverlay =
      this.annotationOverlay instanceof SequenceAnnotationOverlay ||
      path.cdsZoomPresentation !== undefined ||
      presentation?.cdsComparisonLayout !== undefined
        ? this.annotationOverlay
        : null;
    if (
      !baseReader ||
      (!layout.sequenceVisible &&
        (!compoundCdsOverlay || (state.selectedIds.size === 0 && state.hoveredId === null)))
    )
      return;
    const cdsInteractionContours = new Map<number, number[][]>();

    const annotationSearchFocusTargetFeature =
      residentAnnotationSearchFocusFeature ?? annotationSearchFocusFeature;
    for (let carrierIndex = 0; carrierIndex <= this.annotationFeatures.length; carrierIndex += 1) {
      const isFinalFocusTarget = carrierIndex === this.annotationFeatures.length;
      const feature = isFinalFocusTarget
        ? annotationSearchFocusTargetFeature
        : this.annotationFeatures[carrierIndex];
      const isTransientFocusFeature =
        isFinalFocusTarget &&
        annotationSearchFocusFeature !== null &&
        feature === annotationSearchFocusFeature;
      if (!isFinalFocusTarget && feature === residentAnnotationSearchFocusFeature) {
        continue;
      }
      if (!feature) continue;

      if (state.annotationChangeDecorations?.get(feature.id)?.kind === 'removed') continue;
      const activeCds =
        compoundCdsOverlay &&
        feature.type === 'CDS' &&
        (state.selectedIds.has(feature.id) || state.hoveredId === feature.id);
      if (!layout.sequenceVisible && !activeCds) continue;

      const codingRange = codonCarrierRange(feature);
      if (!codingRange) continue;
      const preparedCoding = presentation?.codingFeatures?.get(feature.id);
      const biologicalFeature = projected ? this.codonBiologicalFeatures.get(feature.id) : feature;
      const referenceFeature = this.codonReferenceFeatures.get(feature.id);
      if (!preparedCoding && !biologicalFeature && !referenceFeature) continue;
      const biologicalRange = biologicalFeature
        ? projected
          ? codonCarrierRange(biologicalFeature)
          : codingRange
        : null;
      if (!preparedCoding && !biologicalRange && !referenceFeature) continue;

      const featureEnd =
        feature.start +
        (feature.end > feature.start
          ? feature.end - feature.start
          : this.genome.length - feature.start + feature.end);
      if (featureEnd < viewStartBp || feature.start > viewEndBp) continue;

      if (!codonCarrierIntersectsViewport(codingRange, viewStartBp, viewEndBp)) continue;

      const w = codingGenome.sequenceWindow;
      const covLo = codingGenome.sequence
        ? Number.NEGATIVE_INFINITY
        : w && w.bases.length > 0
          ? projected
            ? (bioToColumn(w.startBp) ?? Number.POSITIVE_INFINITY)
            : w.startBp
          : Number.POSITIVE_INFINITY;
      const covHi = codingGenome.sequence
        ? Number.POSITIVE_INFINITY
        : w && w.bases.length > 0
          ? projected
            ? (bioToColumn(w.startBp + w.bases.length - 1) ?? Number.NEGATIVE_INFINITY) + 1
            : w.startBp + w.bases.length
          : Number.NEGATIVE_INFINITY;
      const transientCarrierSignature = isTransientFocusFeature
        ? annotationCodonCarrierSignature(feature)
        : null;
      const transientFocus = isTransientFocusFeature ? state.annotationSearchFocus : null;
      const transientCache =
        transientFocus &&
        transientCarrierSignature &&
        this.transientAnnotationSearchCodonCache?.trackId === transientFocus.trackId &&
        this.transientAnnotationSearchCodonCache.canonicalIdentity ===
          transientFocus.canonicalIdentity &&
        this.transientAnnotationSearchCodonCache.carrierSignature === transientCarrierSignature
          ? this.transientAnnotationSearchCodonCache.entry
          : undefined;
      let entry = isTransientFocusFeature ? transientCache : this.codonCache.get(feature.id);
      if (preparedCoding && !entry) {
        entry = {
          codons: [...preparedCoding.codons],
          introns: [...preparedCoding.introns],
          lo: Number.NEGATIVE_INFINITY,
          hi: Number.POSITIVE_INFINITY,
        };
        this.codonCache.set(feature.id, entry);
      }
      if (!entry || viewStartBp < entry.lo || viewEndBp > entry.hi) {
        const biologicalTranslation =
          biologicalFeature && biologicalRange
            ? translateCodonCarrier(biologicalFeature, biologicalRange, baseReader, codingGenome)
            : { codons: [], introns: [] };
        const referenceRange = referenceFeature ? codonCarrierRange(referenceFeature) : null;
        const referenceReader = referenceGenome
          ? createBaseReader(
              referenceGenome.sequence,
              referenceGenome.sequenceWindow,
              referenceGenome.circular
            )
          : null;
        const comparedCodons =
          projected &&
          referenceCoding &&
          referenceGenome &&
          referenceFeature &&
          referenceRange &&
          referenceReader
            ? compareProjectedCodons({
                reference: translateCodonCarrier(
                  referenceFeature,
                  referenceRange,
                  referenceReader,
                  referenceGenome
                ).codons,
                referenceAxis: {
                  biologicalLength: referenceGenome.length,
                  bioToColumn: referenceCoding.bioToColumn,
                  columnToBio: referenceCoding.columnToBio,
                },
                query: biologicalTranslation.codons,
                queryAxis: { biologicalLength: biologicalGenome.length, bioToColumn, columnToBio },
                columnLength: this.genome.length,
                direction: feature.direction === 'reverse' ? 'reverse' : 'forward',
              })
            : null;
        const translated = projected
          ? {
              codons:
                comparedCodons ??
                projectCodonColumns(
                  biologicalTranslation.codons,
                  biologicalGenome.length,
                  bioToColumn
                ),
              introns: projectIntronColumns(
                biologicalTranslation.introns,
                biologicalGenome.length,
                bioToColumn
              ),
            }
          : biologicalTranslation;
        entry = { ...translated, lo: covLo, hi: covHi };
        if (covHi > covLo) {
          if (isTransientFocusFeature && transientFocus && transientCarrierSignature) {
            this.transientAnnotationSearchCodonCache = {
              trackId: transientFocus.trackId,
              canonicalIdentity: transientFocus.canonicalIdentity,
              carrierSignature: transientCarrierSignature,
              entry,
            };
          } else {
            this.codonCache.set(feature.id, entry);
          }
        }
      }
      const codons = entry.codons;
      const introns = entry.introns;
      if (codons.length === 0 && introns.length === 0) continue;

      const isV2Carrier = feature.type !== 'CDS' && !!(feature.cds && feature.cds.length > 0);
      const transcriptOffset = isV2Carrier
        ? this.annotationOverlay.getFeatureRenderOffset(feature)
        : null;
      const pose = path.cdsZoomPresentation;
      const perTranscriptOffset =
        transcriptOffset !== null && pose
          ? transcriptOffset + cdsZoomBandCenterOffset(pose)
          : transcriptOffset;
      const cdsLane = feature.cdsLane ?? 0;
      const chevronOffset =
        perTranscriptOffset ?? layout.cdsChevronOffset - cdsLane * layout.cdsLaneStep;

      const residueRowOffset =
        layout.cdsResidueRowOffset !== 0
          ? layout.cdsResidueRowOffset - cdsLane * layout.cdsLaneStep
          : 0;
      this.codonTrack.renderCodons(
        feature,
        codons,
        path,
        chevronOffset,
        this.genome.length,
        state,
        path.cdsZoomPresentation?.colorAlpha ?? layout.sequenceOpacity,
        residueRowOffset,
        Number.POSITIVE_INFINITY,
        activeCds
          ? (points) => {
              const contours = cdsInteractionContours.get(feature.id);
              if (contours) contours.push(points);
              else cdsInteractionContours.set(feature.id, [points]);
            }
          : undefined
      );

      if (feature.type === 'CDS') {
        this.codonTrack.renderIntrons(
          feature,
          introns,
          path,
          chevronOffset,
          this.genome.length,
          state,
          path.cdsZoomPresentation?.colorAlpha ?? layout.sequenceOpacity
        );
      }
    }
    compoundCdsOverlay?.renderCompoundCdsInteractionOutlines(path, state, cdsInteractionContours);
  }

  private renderRegisteredTracks(
    state: RenderState,
    path: PathMapper,
    layout: UnifiedLayout,
    _viewStartBp: number,
    _viewEndBp: number,
    zoneLayout: RegisteredTrackZoneLayout
  ): boolean {
    this.trackDragBackground.visible = false;
    if (this.trackInstances.length === 0) return false;
    if (!this.chromosome) return false;
    if (this.trackRenderers.size === 0) return false;
    if (state.height <= 0) return false;

    const { aboveLayout, belowLayout, aboveZoneHeight, aboveZoneTopPadPx } = zoneLayout;
    const trackScrollTop = layout.trackScrollTop;
    const legacyBottomY = aboveZoneHeight + layout.totalHeight - trackScrollTop;
    this.lastRegisteredTrackLayoutDebug = {
      aboveZoneHeight,
      legacyBottomY,
      legacyLayoutTotalHeight: layout.totalHeight,
    };

    const theme = webglThemeForMode(state.themeMode);
    const viewportBpRange = this.lastViewportBpRange;

    this.lastTrackLayoutEntries.clear();
    this.lastTrackContainerTops.clear();
    let pendingPaintWork = false;

    const paintGroup = (
      tracksLayout: ReturnType<typeof computeTracksLayout>,
      baseY: number
    ): void => {
      for (let i = 0; i < tracksLayout.length; i++) {
        const entry = tracksLayout[i];
        if (entry.hidden) continue;
        const track = this.trackInstancesById.get(entry.id);
        if (!track) continue;
        const renderer = this.trackRenderers.get(track.type);
        if (!renderer) continue;
        this.lastTrackLayoutEntries.set(track.id, entry);

        let container = this.trackContainers.get(track.id);
        if (!container) {
          container = renderer.mount({
            chromosome: this.chromosome!,
            assembly: this.assembly ?? undefined,
            theme,
          });
          this.trackContainers.set(track.id, container);
          this.attachTrackPointerHandler(track, container, renderer);
        }
        const parent = track.zone === 'above-legacy' ? this.app.stage : this.scrollingLayer;
        if (container.parent !== parent) {
          const interactionIndex = parent.children.indexOf(this.interactionLayer);
          if (interactionIndex >= 0) parent.addChildAt(container, interactionIndex);
          else parent.addChild(container);
        }
        this.updateTrackMask(track, container, state.width, entry.height);
        const containerTopPx =
          this.trackPresentationDrag?.trackId === track.id
            ? this.trackPresentationDrag.topPx
            : baseY + entry.top;
        if (container.position.x !== 0 || container.position.y !== containerTopPx) {
          container.position.set(0, containerTopPx);
        }

        if (renderer.hitTest || renderer.updateHover) {
          const area = container.hitArea;
          const width = this.lastViewportWidthPx;
          if (
            !(area instanceof Rectangle) ||
            area.width !== width ||
            area.height !== entry.height
          ) {
            container.hitArea = new Rectangle(0, 0, width, entry.height);
          }
        }
        this.lastTrackContainerTops.set(track.id, containerTopPx);

        renderer.paint({
          container,
          pathMapper: path,
          viewportBpRange,
          viewportWidthPx: state.width,
          viewportHeightPx: state.height,
          contentClipTopPx: track.zone === 'above-legacy' ? 0 : this.scrollingBounds.y,
          layoutEntry: entry,
          containerTopPx,
          data: this.trackDataStore.get(track.id),
          presentation: track,
          chromosome: this.chromosome!,
          assembly: this.assembly ?? undefined,
          theme,
          renderer: this.app.renderer,
          cdsRendering: this.genome
            ? {
                genome: this.genome,
                state,
                detailProgress: layout.sequenceRevealProgress,
              }
            : undefined,
        });
        if (renderer.hasPendingPaintWork?.(container) === true) pendingPaintWork = true;
      }
    };

    paintGroup(aboveLayout, aboveZoneTopPadPx);
    paintGroup(belowLayout, legacyBottomY);
    const drag = this.trackPresentationDrag;
    const draggedContainer = drag ? this.trackContainers.get(drag.trackId) : null;
    const draggedEntry = drag ? this.lastTrackLayoutEntries.get(drag.trackId) : null;
    this.trackDragBackground.visible = Boolean(drag && draggedContainer && draggedEntry);
    if (drag && draggedContainer && draggedEntry) {
      this.trackDragBackground
        .clear()
        .rect(0, drag.topPx, state.width, draggedEntry.height)
        .fill(theme.background)
        .stroke({ color: theme.rulerLine, width: 1 });
      const foregroundIndex = this.scrollingLayer.children.indexOf(this.interactionLayer);
      this.scrollingLayer.setChildIndex(this.trackDragBackground, foregroundIndex - 1);
      this.scrollingLayer.setChildIndex(draggedContainer, foregroundIndex - 1);
    }
    return pendingPaintWork;
  }

  private getRegisteredTrackZoneLayout(availableHeight: number): RegisteredTrackZoneLayout {
    const normalizedHeight = Math.max(0, availableHeight);
    const cached = this.registeredTrackZoneLayout;
    const hasCompanionGutter = this.trackStackEndReservePx !== undefined;
    if (
      cached?.trackLayoutRevision === this.trackLayoutRevision &&
      cached.availableHeight === normalizedHeight &&
      cached.hasCompanionGutter === hasCompanionGutter
    ) {
      return cached;
    }

    const aboveTracks: Track[] = [];
    const belowTracks: Track[] = [];
    for (const track of this.trackInstances) {
      if (track.zone === 'above-legacy') aboveTracks.push(track);
      else belowTracks.push(track);
    }
    const contentHeightFor = (track: Track): number => {
      const trackRenderer = this.trackRenderers.get(track.type);
      return (
        trackRenderer?.measureContentHeight?.({
          data: this.trackDataStore.get(track.id),
          presentation: track,
          chromosome: this.chromosome!,
          assembly: this.assembly ?? undefined,
        }) ?? 0
      );
    };
    const aboveLayout = computeTracksLayout(aboveTracks, contentHeightFor, {
      availableHeight: normalizedHeight,
    });
    const belowLayout = computeTracksLayout(belowTracks, contentHeightFor, {
      availableHeight: normalizedHeight,
      overflow: 'scroll',
    });
    const aboveTracksHeight = aboveLayout.reduce(
      (sum, entry) => sum + (entry.hidden ? 0 : entry.height),
      0
    );

    const aboveZoneTopPadPx =
      hasCompanionGutter && aboveTracksHeight > 0 ? TRACK_STACK_ABOVE_ZONE_PAD_PX : 0;
    const aboveZoneHeight = aboveTracksHeight + 2 * aboveZoneTopPadPx;
    const belowZoneHeight = belowLayout.reduce(
      (sum, entry) => sum + (entry.hidden ? 0 : entry.height),
      0
    );
    const next: RegisteredTrackZoneLayout = {
      trackLayoutRevision: this.trackLayoutRevision,
      availableHeight: normalizedHeight,
      aboveLayout,
      belowLayout,
      aboveZoneHeight,
      aboveZoneTopPadPx,
      hasCompanionGutter,
      belowZoneHeight,
    };
    this.registeredTrackZoneLayout = next;
    this.registeredTrackLayoutComputeCount += 1;
    return next;
  }

  private updateScrollingBounds(width: number, height: number, top: number): void {
    const y = Math.min(height, top);
    const clipHeight = Math.max(0, height - y);
    const bounds = this.scrollingBounds;
    if (bounds.y === y && bounds.width === width && bounds.height === clipHeight) return;
    bounds.y = y;
    bounds.width = width;
    bounds.height = clipHeight;
    this.scrollingMask.clear().rect(0, y, width, clipHeight).fill(0xffffff);
  }

  private updateTrackMask(track: Track, container: Container, width: number, height: number): void {
    let current = this.trackMasks.get(track.id);
    if (track.zone === 'above-legacy') {
      if (current) {
        container.mask = null;
        current.mask.destroy();
        this.trackMasks.delete(track.id);
      }
      return;
    }
    if (!current) {
      const mask = new Graphics();
      mask.eventMode = 'none';
      container.addChild(mask);
      container.mask = mask;
      current = { mask, width: -1, height: -1 };
      this.trackMasks.set(track.id, current);
    }
    if (current.width === width && current.height === height) return;
    current.mask.clear().rect(0, 0, width, height).fill(0xffffff);
    current.width = width;
    current.height = height;
  }

  hitTestContentSurface(screenX: number, screenY: number): boolean {
    return this.scrollingBounds.contains(screenX, screenY);
  }

  canScrollTracksVertically(): boolean {
    return (this._overlayLayout?.maxTrackScrollTop ?? 0) > 0;
  }

  getSequenceRowAt(screenY: number): 'forward' | 'secondary' | null {
    if (!this.hitTestContentSurface(0, screenY)) return null;
    const layout = this._overlayLayout;
    if (!layout?.sequenceVisible || !Number.isFinite(screenY)) return null;
    const rows = this.sequenceTrack?.getLinearComparisonRowBounds();
    if (
      screenY >= (rows?.forward.top ?? layout.fwdStrandTop) &&
      screenY < (rows?.forward.bottom ?? layout.fwdStrandBottom)
    )
      return 'forward';
    if (
      this.presentedSecondarySequenceRow &&
      screenY >= (rows?.secondary.top ?? layout.revStrandTop) &&
      screenY < (rows?.secondary.bottom ?? layout.revStrandBottom)
    )
      return 'secondary';
    return null;
  }

  setTrackStackEndReservePx(value?: number): boolean {
    const next = value === undefined ? undefined : Math.max(0, Number.isFinite(value) ? value : 0);
    if (Object.is(next, this.trackStackEndReservePx)) return false;
    this.trackStackEndReservePx = next;
    return true;
  }

  scrollTracksBy(deltaY: number): boolean {
    const layout = this._overlayLayout;
    if (!layout || layout.maxTrackScrollTop <= 0 || !Number.isFinite(deltaY)) return false;
    const current = this.requestedTrackScrollTop ?? layout.trackScrollTop;
    const next = Math.max(0, Math.min(layout.maxTrackScrollTop, current + deltaY));
    if (next === current) return false;
    this.requestedTrackScrollTop = next;
    return true;
  }

  private attachTrackPointerHandler(
    track: Track,
    container: Container,
    renderer: PixiLinearTrackRenderer
  ): void {
    if (!renderer.hitTest && !renderer.updateHover) return;
    container.eventMode = 'static';
    container.cursor = 'pointer';
    const pointerArgs = (event: { global: { x: number; y: number } }): TrackHoverArgs | null => {
      if (this.trackPresentationDrag) return null;
      if (!this.chromosome) return null;
      if (!this._layout) return null;
      const currentTrack = this.trackInstancesById.get(track.id);
      if (!currentTrack?.visible) return null;
      if (
        currentTrack.zone !== 'above-legacy' &&
        !this.hitTestContentSurface(event.global.x, event.global.y)
      )
        return null;
      const layoutEntry = this.lastTrackLayoutEntries.get(track.id);
      if (!layoutEntry) return null;
      const local = container.toLocal(event.global);
      if (
        local.x < 0 ||
        local.x >= this.lastViewportWidthPx ||
        local.y < 0 ||
        local.y >= layoutEntry.height
      )
        return null;
      return {
        container,
        localX: local.x,
        localY: local.y,
        viewportWidthPx: this.lastViewportWidthPx,
        layoutEntry,
        pathMapper: this._layout,
        viewportBpRange: this.lastViewportBpRange,
        chromosome: this.chromosome,
        assembly: this.assembly ?? undefined,
      };
    };
    if (renderer.hitTest) {
      let pressedAt: { x: number; y: number } | null = null;
      container.on('pointerdown', (event) => {
        if (this.trackPresentationDrag) return;
        pressedAt = { x: event.global.x, y: event.global.y };
      });
      const forgetPress = () => {
        pressedAt = null;
      };
      container.on('pointerupoutside', forgetPress);
      container.on('pointercancel', forgetPress);
      container.on('pointerup', (event) => {
        const pressed = pressedAt;
        pressedAt = null;
        const handler = this.trackHitHandler;
        if (!handler) return;
        if (pressed) {
          const moved = Math.hypot(event.global.x - pressed.x, event.global.y - pressed.y);
          if (moved > TRACK_CLICK_SLOP_PX) return;
        }
        const args = pointerArgs(event);
        if (!args) return;
        const hit = renderer.hitTest?.(args);
        if (hit) {
          markTrackHitConsumed(event.nativeEvent);
          handler(hit);
        }
      });
    }
    if (renderer.updateHover) {
      container.on('pointermove', (event) => {
        const args = pointerArgs(event);
        if (args) renderer.updateHover?.(args);
        else renderer.clearHover?.(container);
      });
      const clearHover = () => renderer.clearHover?.(container);
      container.on('pointerout', clearHover);
      container.on('pointercancel', clearHover);
    }
  }

  private drawHighlightAndCursor(
    state: RenderState,
    path: PathMapper,
    layout: UnifiedLayout,
    viewStartBp: number,
    bpPerPixel: number
  ): void {
    const interactionContract = resolveInteractionOverlayContract({ layout, mode: 'linear' });
    const theme = webglThemeForMode(state.themeMode);
    const band = requireTrackLaneEnvelope(interactionContract, 'selection-band');
    const hlTop = layout.fwdStrandTop + band.minOffset;
    const hlBot = layout.fwdStrandTop + band.maxOffset;
    const guideTop = this.getRegisteredTrackZoneLayout(state.height).aboveZoneHeight;
    const guideBottom = state.height;
    const g = this.interactionGraphics;

    this.viewportBrackets.render(g, path, state, this.genome);

    this.drawHoveredCodonBackground(state, layout, viewStartBp, bpPerPixel);

    const hits = state.sequencePresentation?.searchRanges;
    if (hits?.length) {
      const endBp = viewStartBp + state.width * bpPerPixel;
      let low = 0;
      let high = hits.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (hits[mid].end <= viewStartBp) low = mid + 1;
        else high = mid;
      }
      for (let i = low; i < hits.length && hits[i].start < endBp; i++) {
        const left = Math.max(0, (hits[i].start - viewStartBp) / bpPerPixel);
        const right = Math.min(state.width, (hits[i].end - viewStartBp) / bpPerPixel);
        this.selectionGraphics.rect(left, hlTop, Math.max(1, right - left), hlBot - hlTop);
        this.selectionGraphics.fill({ color: theme.selectionStroke, alpha: 0.18 });
      }
    }

    if (state.digestFocusRange) {
      for (const segment of digestFocusMaskSegments(state.digestFocusRange, this.genome.length)) {
        const x1 = (segment.start - viewStartBp) / bpPerPixel;
        const x2 = (segment.end - viewStartBp) / bpPerPixel;
        if (x2 < -50 || x1 > state.width + 50) continue;
        g.rect(x1, hlTop, Math.max(1, x2 - x1), hlBot - hlTop);
        g.fill({ color: theme.digestFocusMask, alpha: theme.digestFocusMaskAlpha });
      }
    }

    if (state.highlightRange) {
      const [rawStart, rawEnd] = state.highlightRange;
      const segments =
        rawEnd < rawStart
          ? [
              [rawStart, this.genome.length],
              [0, rawEnd + 1],
            ]
          : [[rawStart, Math.min(rawEnd + 1, this.genome.length)]];
      const edgeBoundaries = [rawStart, Math.min(rawEnd + 1, this.genome.length)];

      for (const [start, endBoundary] of segments) {
        const hlX1 = (start - viewStartBp) / bpPerPixel;
        const hlX2 = (endBoundary - viewStartBp) / bpPerPixel;
        if (hlX2 < -50 || hlX1 > state.width + 50) continue;
        this.selectionGraphics.rect(hlX1, hlTop, Math.max(1, hlX2 - hlX1), hlBot - hlTop);
        this.selectionGraphics.fill({
          color: theme.selectionFill,
          alpha: theme.selectionFillAlpha,
        });
      }

      g.setStrokeStyle({ width: 2, color: theme.selectionStroke, alpha: 1.0 });
      for (const boundary of edgeBoundaries) {
        const x = (boundary - viewStartBp) / bpPerPixel;
        if (x < -50 || x > state.width + 50) continue;
        g.moveTo(x, guideTop);
        g.lineTo(x, guideBottom);
        g.stroke();
      }
    }

    if (state.proteinSearchHighlightRanges?.length) {
      for (const [rawStart, rawEnd] of state.proteinSearchHighlightRanges) {
        const start = Math.max(0, Math.min(rawStart, rawEnd));
        const endBoundary = Math.min(this.genome.length, Math.max(rawStart, rawEnd));
        if (endBoundary <= start) continue;
        const hlX1 = (start - viewStartBp) / bpPerPixel;
        const hlX2 = (endBoundary - viewStartBp) / bpPerPixel;
        if (hlX2 < -50 || hlX1 > state.width + 50) continue;
        this.selectionGraphics.rect(hlX1, hlTop, Math.max(1, hlX2 - hlX1), hlBot - hlTop);
        this.selectionGraphics.fill({
          color: theme.selectionFill,
          alpha: theme.selectionFillAlpha,
        });
        g.setStrokeStyle({ width: 2, color: theme.selectionStroke, alpha: 1.0 });
        g.moveTo(hlX1, guideTop);
        g.lineTo(hlX1, guideBottom);
        g.stroke();
        g.moveTo(hlX2, guideTop);
        g.lineTo(hlX2, guideBottom);
        g.stroke();
      }
    }

    if (!state.highlightRange && state.cursorPosition != null) {
      this.drawVerticalGuide(
        state.cursorPosition,
        viewStartBp,
        bpPerPixel,
        guideTop,
        guideBottom,
        0,
        { width: 2, alpha: 1.0, dashed: false }
      );
    }

    if (state.hoverPosition != null) {
      this.drawVerticalGuide(
        state.hoverPosition,
        viewStartBp,
        bpPerPixel,
        guideTop,
        guideBottom,
        0,
        { width: 1.5, alpha: 0.55, dashed: true }
      );
    }
  }

  private drawHoveredCodonBackground(
    state: RenderState,
    layout: UnifiedLayout,
    viewStartBp: number,
    bpPerPixel: number
  ): void {
    const codon = state.hoveredCodon;
    if (!codon || !layout.sequenceVisible) return;

    const top = codon.strand === -1 ? layout.revStrandTop : layout.fwdStrandTop;
    const bottom = codon.strand === -1 ? layout.revStrandBottom : layout.fwdStrandBottom;
    const drawSegment = (start: number, endExclusive: number) => {
      const x1 = (start - viewStartBp) / bpPerPixel;
      const x2 = (endExclusive - viewStartBp) / bpPerPixel;
      if (x2 < -2 || x1 > state.width + 2) return;
      this.interactionGraphics.rect(x1, top, Math.max(1, x2 - x1), bottom - top);
      this.interactionGraphics.fill({ color: 0x8c8c8c, alpha: 0.25 });
    };

    if (this.genome.circular && codon.end < codon.start) {
      drawSegment(codon.start, this.genome.length);
      drawSegment(0, codon.end + 1);
    } else {
      drawSegment(codon.start, Math.min(codon.end + 1, this.genome.length));
    }
  }

  private drawVerticalGuide(
    bp: number,
    viewStartBp: number,
    bpPerPixel: number,
    hlTop: number,
    hlBot: number,
    barExtend: number,
    opts: { width: number; alpha: number; dashed: boolean }
  ): void {
    const x = (bp - viewStartBp) / bpPerPixel;
    if (x < -50 || x > this.getState().width + 50) return;
    const theme = webglThemeForMode(this.getState().themeMode);
    const y1 = hlTop - barExtend;
    const y2 = hlBot + barExtend;
    this.interactionGraphics.setStrokeStyle({
      width: opts.width,
      color: theme.selectionStroke,
      alpha: opts.alpha,
    });
    if (!opts.dashed) {
      this.interactionGraphics.moveTo(x, y1);
      this.interactionGraphics.lineTo(x, y2);
      this.interactionGraphics.stroke();
      return;
    }
    drawDashedLine(this.interactionGraphics, x, y1, x, y2, 5, 4);
  }

  adjustViewOffsetForZoom(
    oldZoom: number,
    newZoom: number,
    state: RenderState,
    cursorX = state.width / 2
  ): void {
    const { width } = state;
    const oldBpPerPixel = this.genome.length / (width * oldZoom);
    const newBpPerPixel = this.genome.length / (width * newZoom);
    const oldXOffset = linearGenomeXOffset(width, oldZoom);
    const newXOffset = linearGenomeXOffset(width, newZoom);

    const scrollBp = state.viewOffset * this.genome.length;
    const sequenceStartX = oldXOffset - scrollBp / oldBpPerPixel;
    const sequenceEndX = oldXOffset + (this.genome.length - scrollBp) / oldBpPerPixel;
    const biologicalCursorX = Math.max(sequenceStartX, Math.min(sequenceEndX, cursorX));
    const rawCursorBp = scrollBp + (biologicalCursorX - oldXOffset) * oldBpPerPixel;
    const cursorBp = Math.max(0, Math.min(this.genome.length, rawCursorBp));
    const newViewStartBp = cursorBp - (biologicalCursorX - newXOffset) * newBpPerPixel;
    state.viewOffset = clampLinearViewOffset(newViewStartBp / this.genome.length, newZoom);
  }

  private drawRuler(
    state: RenderState,
    viewStartBp: number,
    viewEndBp: number,
    bpPerPixel: number,
    layout: UnifiedLayout
  ): void {
    const theme = webglThemeForMode(state.themeMode);

    const y = layout.fwdStrandTop + layout.rulerOffset;

    const viewBpSpan = viewEndBp - viewStartBp;
    if (viewBpSpan <= 0) return;

    const rulerStartX = Math.max(0, (0 - viewStartBp) / bpPerPixel);
    const rulerEndX = Math.min(state.width, (this.genome.length - viewStartBp) / bpPerPixel);
    if (rulerEndX <= rulerStartX) return;

    this.placeRulerBase(rulerStartX, rulerEndX, y, theme.rulerLine);
    this.drawBackboneSegments(state, viewStartBp, viewEndBp, bpPerPixel, y);
    const step = computeTickStep(viewBpSpan, state.width);
    const boundedStartBp = Math.max(0, viewStartBp);
    const boundedEndBp = Math.min(this.genome.length, viewEndBp);
    const firstBp = Math.ceil(boundedStartBp / step) * step;
    const lastBp = Math.floor(boundedEndBp / step) * step;
    const hasScaffolds = state.backboneSegments?.some((segment) => segment.scaffold);
    let topology = hasScaffolds ? null : this.rulerTickTopology;
    if (
      topology === null ||
      topology.genome !== this.genome ||
      topology.formatter !== this.genome.formatRulerLabel ||
      topology.step !== step ||
      topology.firstBp !== firstBp ||
      topology.lastBp !== lastBp
    ) {
      this.rulerTextPool.reset();
      const tickBps: number[] = [];
      const labels: Text[] = [];
      const appendTick = (bp: number, labelValue: number) => {
        const text = this.genome.formatRulerLabel
          ? this.genome.formatRulerLabel(bp, step)
          : formatRulerLabel(labelValue, step);
        if (text === null) return;
        tickBps.push(bp);
        const label = this.rulerTextPool.acquire(text);
        label.anchor.set(0.5, 0);
        labels.push(label);
      };
      if (hasScaffolds) {
        for (const tick of assemblyScaffoldRulerTicks(
          this.genome.length,
          state.backboneSegments!,
          step,
          boundedStartBp,
          boundedEndBp
        )) {
          appendTick(tick.position, tick.label);
        }
      } else {
        for (let bp = firstBp; bp <= lastBp; bp += step) appendTick(bp, bp);
      }
      this.rulerTextPool.trimInactive();
      topology = {
        genome: this.genome,
        formatter: this.genome.formatRulerLabel,
        step,
        firstBp,
        lastBp,
        tickBps,
        labels,
      };
      this.rulerTickTopology = topology;
      this.rulerTickTopologyBuildCount += 1;
    }

    for (let index = 0; index < topology.tickBps.length; index += 1) {
      const bp = topology.tickBps[index];
      const x = (bp - viewStartBp) / bpPerPixel;
      this.placeRulerTick(index, x, y, theme.rulerLine);

      const label = topology.labels[index];
      label.x = x;
      label.y = y + 8;
    }
    this.hideUnusedRulerTicks(topology.tickBps.length);
  }

  private drawBackboneSegments(
    state: RenderState,
    viewStartBp: number,
    viewEndBp: number,
    bpPerPixel: number,
    y: number
  ): void {
    this.backbonePathSegmentsDrawn = 0;
    const ranges = this.backboneSegmentRanges(state);
    for (const range of ranges) {
      const visibleStart = Math.max(range.start, viewStartBp);
      const visibleEnd = Math.min(range.end, viewEndBp);
      if (visibleEnd <= visibleStart) continue;
      const x1 = (visibleStart - viewStartBp) / bpPerPixel;
      const x2 = (visibleEnd - viewStartBp) / bpPerPixel;
      this.placeRulerSegment(this.backbonePathSegmentsDrawn, x1, x2, y, range);
      this.backbonePathSegmentsDrawn++;
    }
    for (const change of state.sequencePresentation?.nucleotideChanges ?? []) {
      const visibleStart = Math.max(change.start, viewStartBp);
      const visibleEnd = Math.min(change.end, viewEndBp);
      if (visibleEnd <= visibleStart) continue;
      const x1 = (visibleStart - viewStartBp) / bpPerPixel;
      const x2 = Math.max(x1 + 2, (visibleEnd - viewStartBp) / bpPerPixel);
      this.placeRulerSegment(this.backbonePathSegmentsDrawn, x1, x2, y, {
        start: change.start,
        end: change.end,
        color: change.style?.text.color ?? SEQUENCE_EDIT_MARKUP[change.kind].text.color,
        strokeWidth: 4,
        alpha: 1,
      });
      this.backbonePathSegmentsDrawn++;
    }
    this.hideUnusedRulerSegments(this.backbonePathSegmentsDrawn);
  }

  private backboneSegmentRanges(state: RenderState): readonly BackboneSegmentRange[] {
    const cached = this.backboneSegmentRangeCache;
    if (
      cached !== null &&
      cached.source === state.backboneSegments &&
      cached.genomeLength === this.genome.length &&
      cached.themeMode === state.themeMode
    ) {
      return cached.ranges;
    }
    const ranges = normalizeBackboneSegmentRanges(
      state.backboneSegments,
      this.genome.length,
      state
    );
    this.backboneSegmentRangeCache = {
      source: state.backboneSegments,
      genomeLength: this.genome.length,
      themeMode: state.themeMode,
      ranges,
    };
    return ranges;
  }

  private placeRulerBase(startX: number, endX: number, y: number, color: number): void {
    if (this.rulerBaseColor !== color) {
      this.rulerGraphics.clear().rect(0, -0.75, 1, 1.5).fill({ color, alpha: 0.8 });
      this.rulerBaseColor = color;
      this.rulerPrimitiveBuildCount += 1;
    }
    this.rulerGraphics.position.set(startX, y);
    this.rulerGraphics.scale.set(endX - startX, 1);
    this.rulerGraphics.visible = true;
  }

  private placeRulerTick(index: number, x: number, y: number, color: number): void {
    let graphic = this.rulerTickGraphics[index];
    if (!graphic) {
      graphic = new Graphics();
      graphic.eventMode = 'none';
      this.rulerTickLayer.addChild(graphic);
      this.rulerTickGraphics.push(graphic);
      this.rulerTickColors.push(null);
    }
    if (this.rulerTickColors[index] !== color) {
      graphic.clear().rect(-0.5, 0, 1, 6).fill({ color });
      this.rulerTickColors[index] = color;
      this.rulerPrimitiveBuildCount += 1;
    }
    graphic.position.set(x, y);
    graphic.visible = true;
  }

  private hideUnusedRulerTicks(activeCount: number): void {
    for (let index = activeCount; index < this.rulerTickGraphics.length; index += 1) {
      this.rulerTickGraphics[index].visible = false;
    }
  }

  private placeRulerSegment(
    index: number,
    startX: number,
    endX: number,
    y: number,
    range: BackboneSegmentRange
  ): void {
    let graphic = this.rulerSegmentGraphics[index];
    if (!graphic) {
      graphic = new Graphics();
      graphic.eventMode = 'none';
      this.rulerSegmentLayer.addChild(graphic);
      this.rulerSegmentGraphics.push(graphic);
      this.rulerSegmentStyles.push(null);
    }
    const prior = this.rulerSegmentStyles[index];
    if (
      prior?.color !== range.color ||
      prior.strokeWidth !== range.strokeWidth ||
      prior.alpha !== range.alpha
    ) {
      graphic
        .clear()
        .rect(0, -range.strokeWidth / 2, 1, range.strokeWidth)
        .fill({ color: range.color, alpha: range.alpha });
      this.rulerSegmentStyles[index] = {
        color: range.color,
        strokeWidth: range.strokeWidth,
        alpha: range.alpha,
      };
      this.rulerPrimitiveBuildCount += 1;
    }
    graphic.position.set(startX, y);
    graphic.scale.set(endX - startX, 1);
    graphic.visible = true;
  }

  private hideUnusedRulerSegments(activeCount: number): void {
    for (let index = activeCount; index < this.rulerSegmentGraphics.length; index += 1) {
      this.rulerSegmentGraphics[index].visible = false;
    }
  }

  screenToBp(screenX: number, _screenY: number, state: RenderState): number {
    return Math.max(
      0,
      Math.min(this.genome.length - 1, this.screenToBoundaryBp(screenX, _screenY, state))
    );
  }

  screenToBoundaryBp(screenX: number, _screenY: number, state: RenderState): number {
    const bpPerPixel = this.genome.length / (state.width * state.zoom);
    const scrollBp = state.viewOffset * this.genome.length;
    const xOffset = linearGenomeXOffset(state.width, state.zoom);
    const bp = scrollBp + (screenX - xOffset) * bpPerPixel;
    return Math.max(0, Math.min(this.genome.length, Math.round(bp)));
  }

  hitTestPositionGuideSurface(_screenX: number, screenY: number, state: RenderState): boolean {
    const guideTop = this.getRegisteredTrackZoneLayout(state.height).aboveZoneHeight;
    return screenY >= guideTop && screenY <= state.height;
  }

  getViewCenterBp(state: RenderState): number {
    const comparison = this.getComparisonCamera(state);
    if (comparison) return (comparison.startColumn + comparison.endColumn) / 2;
    const contactCamera = this.getContactCamera(state);
    if (contactCamera) return (contactCamera.xStart + contactCamera.xEnd) / 2;
    const bpPerPixel = this.genome.length / (state.width * state.zoom);
    const scrollBp = state.viewOffset * this.genome.length;
    const xOffset = linearGenomeXOffset(state.width, state.zoom);
    const centerBp = scrollBp + (state.width / 2 - xOffset) * bpPerPixel;

    return Math.max(0, Math.min(this.genome.length - 1, centerBp));
  }

  setViewCenterBp(bp: number, state: RenderState): void {
    const comparison = this.getComparisonCamera(state);
    if (comparison && Number.isFinite(bp)) {
      const span = comparison.endColumn - comparison.startColumn;
      this.setComparisonCamera(
        {
          projectionId: comparison.projectionId,
          startColumn: bp - span / 2,
          endColumn: bp + span / 2,
        },
        state
      );
      return;
    }
    const contactCamera = this.getContactCamera(state);
    if (contactCamera && Number.isFinite(bp)) {
      const span = contactCamera.xEnd - contactCamera.xStart;
      this.setContactCamera(
        { ...contactCamera, xStart: bp - span / 2, xEnd: bp + span / 2 },
        state
      );
      return;
    }
    if (!this.genome?.length || state.zoom <= 0 || state.width <= 0) return;
    const targetBp = Math.max(0, Math.min(this.genome.length - 1, bp));
    const bpPerPixel = this.genome.length / (state.width * state.zoom);
    const xOffset = linearGenomeXOffset(state.width, state.zoom);
    const targetViewStartBp = targetBp - (state.width / 2 - xOffset) * bpPerPixel;
    state.viewOffset = clampLinearViewOffset(targetViewStartBp / this.genome.length, state.zoom);
  }

  hitTestSelectionHandle(
    screenX: number,
    screenY: number,
    state: RenderState
  ): 'start' | 'end' | null {
    if (!this.hitTestContentSurface(screenX, screenY)) return null;
    const range = state.highlightRange;
    const layout = this._overlayLayout;
    if (!range || !layout) return null;

    const bpPerPixel = this.genome.length / (state.width * state.zoom);
    const scrollBp = state.viewOffset * this.genome.length;
    const xOffset = linearGenomeXOffset(state.width, state.zoom);
    const bpToX = (bp: number) => xOffset + (bp - scrollBp) / bpPerPixel;
    const startX = bpToX(range[0]);
    const endX = bpToX(Math.min(range[1] + 1, this.genome.length));
    const interactionContract = resolveInteractionOverlayContract({ layout, mode: 'linear' });
    const band = requireTrackLaneEnvelope(interactionContract, 'selection-band');
    const top = layout.fwdStrandTop + band.minOffset - 4;
    const bottom = layout.fwdStrandTop + band.maxOffset + 4;
    if (screenY < top || screenY > bottom) return null;

    const startDist = Math.abs(screenX - startX);
    const endDist = Math.abs(screenX - endX);
    const tolerancePx = 8;
    const best = startDist <= endDist ? 'start' : 'end';
    const bestDist = Math.min(startDist, endDist);
    return bestDist <= tolerancePx ? best : null;
  }

  hitTestNucleotideText(screenX: number, screenY: number, state: RenderState): boolean {
    if (!this.hitTestContentSurface(screenX, screenY)) return false;
    const layout = this._overlayLayout;
    if (!layout?.sequenceVisible || layout.sequenceOpacity <= 0) return false;
    if (screenY < layout.fwdStrandTop || screenY > layout.revStrandBottom) return false;

    const bpPerPixel = this.genome.length / (state.width * state.zoom);
    const scrollBp = state.viewOffset * this.genome.length;
    const xOffset = linearGenomeXOffset(state.width, state.zoom);
    const sequenceStartX = xOffset - scrollBp / bpPerPixel;
    const sequenceEndX = xOffset + (this.genome.length - scrollBp) / bpPerPixel;
    return screenX >= sequenceStartX && screenX <= sequenceEndX;
  }

  hitTestCodon(
    screenX: number,
    screenY: number
  ): {
    start: number;
    end: number;
    featureId: number;
    featureStart: number;
    featureEnd: number;
    strand: 1 | -1;
  } | null {
    if (!this.hitTestContentSurface(screenX, screenY)) return null;
    return this.codonTrack.hitTest(screenX, screenY);
  }

  hitTestIntron(screenX: number, screenY: number) {
    if (!this.hitTestContentSurface(screenX, screenY)) return null;
    return this.codonTrack.hitTestIntron(screenX, screenY);
  }

  hitTestOrf(screenX: number, screenY: number) {
    if (!this.hitTestContentSurface(screenX, screenY)) return null;
    return this.orfTrack.hitTest(screenX, screenY);
  }

  hitTestCutSite(screenX: number, screenY: number): WebGLHitTarget | null {
    if (!this.hitTestContentSurface(screenX, screenY)) return null;
    return this.restrictionTrack.hitTest(screenX, screenY);
  }

  hitTestReadEvent(screenX: number, screenY: number): ReadHitPayload | null {
    if (!this.hitTestContentSurface(screenX, screenY)) return null;
    const pathMapper = this._layout;
    if (!pathMapper || screenX < 0 || screenX > this.lastViewportWidthPx) return null;

    for (let index = this.trackInstances.length - 1; index >= 0; index--) {
      const track = this.trackInstances[index];
      const layoutEntry = this.lastTrackLayoutEntries.get(track.id);
      const containerTopPx = this.lastTrackContainerTops.get(track.id);
      const container = this.trackContainers.get(track.id);
      const renderer = this.trackRenderers.get(track.type) as
        | (PixiLinearTrackRenderer & {
            hitTestReadEvent?: (
              container: Container,
              args: {
                trackId: string;
                localX: number;
                localY: number;
                screenX: number;
                screenY: number;
                pathMapper: PathMapper;
                chromosomeGlobalStartBp: (chrom: string) => number;
              }
            ) => ReadHitPayload | null;
          })
        | undefined;
      if (
        !track.visible ||
        !layoutEntry ||
        containerTopPx === undefined ||
        !container ||
        !renderer?.hitTestReadEvent ||
        screenY < containerTopPx ||
        screenY >= containerTopPx + layoutEntry.height
      ) {
        continue;
      }
      const hit = renderer.hitTestReadEvent(container, {
        trackId: track.id,
        localX: screenX,
        localY: screenY - containerTopPx,
        screenX,
        screenY,
        pathMapper,
        chromosomeGlobalStartBp: (chrom) =>
          this.assembly?.chromosomes.find((placement) => placement.chromosome.id === chrom)
            ?.globalStartBp ?? 0,
      });
      if (hit) {
        return {
          ...hit,
          trackRect: {
            left: 0,
            top: containerTopPx,
            width: this.lastViewportWidthPx,
            height: layoutEntry.height,
          },
        };
      }
    }
    return null;
  }

  locateRead(read: ReadHitPayload): ReadHitPayload | null {
    const pathMapper = this._layout;
    if (!pathMapper) return null;
    const track = this.trackInstances.find((candidate) => candidate.id === read.trackId);
    if (!track) return null;
    const layoutEntry = this.lastTrackLayoutEntries.get(track.id);
    const containerTopPx = this.lastTrackContainerTops.get(track.id);
    const container = this.trackContainers.get(track.id);
    const renderer = this.trackRenderers.get(track.type) as
      | (PixiLinearTrackRenderer & {
          locateRead?: (
            container: Container,
            read: ReadHitPayload,
            args: {
              trackId: string;
              pathMapper: PathMapper;
              containerTopPx: number;
              chromosomeGlobalStartBp: (chrom: string) => number;
            }
          ) => ReadHitPayload | null;
        })
      | undefined;
    if (!layoutEntry || containerTopPx === undefined || !container || !renderer?.locateRead) {
      return null;
    }
    const located = renderer.locateRead(container, read, {
      trackId: track.id,
      pathMapper,
      containerTopPx,
      chromosomeGlobalStartBp: (chrom) =>
        this.assembly?.chromosomes.find((placement) => placement.chromosome.id === chrom)
          ?.globalStartBp ?? 0,
    });
    if (
      !located ||
      located.bodyRect.left + located.bodyRect.width <= 0 ||
      located.bodyRect.left >= this.lastViewportWidthPx ||
      located.bodyRect.top + located.bodyRect.height <=
        Math.max(containerTopPx, this.scrollingBounds.y) ||
      located.bodyRect.top >= Math.min(containerTopPx + layoutEntry.height, this.lastCanvasHeight)
    ) {
      return null;
    }
    return {
      ...located,
      trackRect: {
        left: 0,
        top: containerTopPx,
        width: this.lastViewportWidthPx,
        height: layoutEntry.height,
      },
    };
  }

  getPileupGlobalGuideDiagnostics() {
    return this.pileupGlobalGuideLayer.diagnostics();
  }

  completePresentedFrame(): void {
    this.rendererPresentedFrameEpoch = this.rendererCompletedFrameEpoch;
    this.rendererPresentedContentOperationEpoch = this.rendererContentOperationEpoch;
    this.annotationOverlay.releaseRetiredGpuResourcesAfterPresent();
  }

  destroy(): void {
    this.comparisonPainter.destroy();
    this.contactTextPool?.destroy();
    this.contactGraphics.destroy();
    this.contactLayer.destroy();
    let registeredTrackTeardownError: unknown;
    try {
      this.destroyRegisteredTracks();
    } catch (error) {
      registeredTrackTeardownError = error;
    }
    this.rulerTextPool.destroy();
    this.rulerGraphics.destroy();
    this.rulerSegmentLayer.destroy({ children: true });
    this.rulerTickLayer.destroy({ children: true });
    this.rulerLayer.destroy({ children: true });
    this.selectionGraphics.destroy();
    this.selectionLayer.destroy();
    this.interactionGraphics.destroy();
    this.interactionLayer.destroy();
    this.codonTrack.destroy();
    this.codonBiologicalGenome = null;
    this.codonBioToColumn = null;
    this.codonBiologicalFeatures.clear();
    this.codonReferenceGenome = null;
    this.codonReferenceFeatures.clear();
    this.codonCache.clear();
    this.transientAnnotationSearchCodonCache = null;
    this.orfTrack.destroy();
    this.restrictionTrack.destroy();
    this.overlayRegistry.destroyAll();
    this.sequenceTrack.destroy();
    this.pileupGlobalGuideLayer.destroy();
    this.trackDragBackground.destroy();
    this.scrollingLayer.mask = null;
    this.scrollingMask.destroy();
    this.scrollingLayer.destroy();
    if (registeredTrackTeardownError !== undefined) throw registeredTrackTeardownError;
  }

  private destroyRegisteredTracks(): void {
    const errors: unknown[] = [];
    for (const [id, container] of Array.from(this.trackContainers.entries())) {
      try {
        this.unmountTrackContainer(id, container);
      } catch (error) {
        errors.push(error);
      }
    }
    this.trackInstances = [];
    this.trackInstancesById.clear();
    this.trackRenderers.clear();
    this.trackDataStore.clear();
    this.pileupAlternateColumnsByTrack.clear();
    this.pileupGlobalGuideColumns = [];
    this.lastTrackLayoutEntries.clear();
    this.lastTrackContainerTops.clear();
    this.registeredTrackZoneLayout = null;

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw Object.assign(
        new Error('PixiLinearRenderer: multiple registered track teardowns failed'),
        { errors }
      );
    }
  }

  private unmountTrackContainer(id: string, container: Container): void {
    const track = this.trackInstancesById.get(id);
    const renderer = track ? this.trackRenderers.get(track.type) : null;
    container.parent?.removeChild(container);
    try {
      renderer?.unmount(container);
    } finally {
      if (!container.destroyed) container.destroy({ children: true });
      this.trackContainers.delete(id);
      this.trackMasks.delete(id);
      this.trackDataStore.delete(id);
      this.pileupAlternateColumnsByTrack.delete(id);
    }
  }

  private reconcilePileupAlternateColumns(trackId: string, data: unknown): void {
    const next =
      data &&
      typeof data === 'object' &&
      Array.isArray((data as Partial<PileupTrackData>).alternateColumns)
        ? (data as PileupTrackData).alternateColumns
        : undefined;
    const current = this.pileupAlternateColumnsByTrack.get(trackId);
    if (current === next) return;
    if (next) this.pileupAlternateColumnsByTrack.set(trackId, next);
    else this.pileupAlternateColumnsByTrack.delete(trackId);
    this.rebuildPileupGlobalGuideColumns();
  }

  private rebuildPileupGlobalGuideColumns(): void {
    const strongestByPosition = new Map<number, PileupAlternateColumn>();
    for (const [trackId, columns] of this.pileupAlternateColumnsByTrack) {
      if (this.trackInstancesById.get(trackId)?.visible !== true) continue;
      for (const column of columns) {
        const current = strongestByPosition.get(column.pos);
        if (!current || column.weightedFraction > current.weightedFraction) {
          strongestByPosition.set(column.pos, column);
        }
      }
    }
    this.pileupGlobalGuideColumns = [...strongestByPosition.values()].sort(
      (left, right) => left.pos - right.pos
    );
  }
}
