import {
  Container,
  Buffer as PixiBuffer,
  BufferUsage,
  Geometry,
  GlProgram,
  Mesh,
  Shader,
  State,
  type Renderer,
} from 'pixi.js';

import type {
  PileupHistogramLoadingAnimation,
  PileupRecord,
  PileupTrackData,
} from '@waypoint/genome-data';
import type { ReadHitPayload } from '../shared/hit-targets';
import type { PathMapper } from '../shared/path-types';

import {
  bpCoordinateChunk,
  bpCoordinateDelta,
  writePackedBpCoordinate,
} from '../overview/bp-coordinate-packing';
import {
  retainedSubpixelOpacityPolicy,
  type RetainedSubpixelSurfaceKind,
} from '../overview/retained-subpixel-aa';
import { ANNOTATION_FRAGMENT_SHADER, ANNOTATION_VERTEX_SHADER } from './annotation-track-renderer';
import {
  advanceAnnotationRecordVerticesJob,
  beginAnnotationRecordVerticesJob,
  createAnnotationRecordVerticesPool,
  ensureVerticesPoolCapacity,
  finishAnnotationRecordVerticesJob,
  isAnnotationRecordVerticesJobComplete,
  type AnnotationRecordVerticesJob,
  type AnnotationRecordVerticesPool,
} from './annotation-record-vertices';
import { webglAnnotationColorForMode, type WebGLThemeMode } from '../shared/theme';
import { prepareSharedPixiGpuPrograms } from '../shared/pixi-gpu-program-preparation';
import {
  buildCollapsedPileupFieldFromExact,
  buildEmptyCollapsedPileupField,
  buildPileupVerticalScaleContract,
  collapsedFieldOverlapsViewport,
  collapsedVisibleRowsHeightPx,
  overflowBaseYForMorph,
  overflowFillForHiddenCount,
  sampleUint16FieldMax,
  type CollapsedPileupField,
} from './pileup-collapsed-field';
import {
  PileupReadHitIndex,
  PersistentRowLayout,
  pileupReadPlacementKey,
  type PileupRowAssignmentJob,
  type PileupRowRetainJob,
} from './pileup-row-layout';
import { PILEUP_MAX_COLUMN_BARS, pileupDensitySampleColumnCount } from './pileup-density-sampling';
import {
  coverageAggregateMeshKey,
  coverageDepthFillFraction,
  coverageExactFieldKey,
  coverageHeightFieldKey,
  fillExperimentalHybridOverflowCounts,
  fillExperimentalHybridPileupSegmentHeights,
  fillCoverageSegmentHeights,
  forcedCoveragePresentationBinSize,
  isResidentCoverageGeometry,
  resolveCoverageContrastPolicy,
  sampleCoverageAggregateColumnDepths,
  shouldUseExactFieldBase,
} from './pileup-coverage-aggregate';
import {
  overflowExactSourceDomain,
  overflowGeometryWindow,
  overflowMeshKey,
  overflowRowsHavePaintableSource,
} from './pileup-overflow-geometry';
import {
  PILEUP_COVERAGE_ALPHA,
  PILEUP_COVERAGE_SMOOTH_KERNEL,
  smoothCoverageColumnsInPlace,
} from './pileup-coverage-resample';
import {
  coverageGpuAtlasHeightCutoffFill,
  coverageGpuAtlasLogColorFill,
} from './coverage-gpu-atlas';
import { CoverageGpuAtlasLayer } from './coverage-gpu-atlas-layer';
import { CoverageSignalInstancedLayer } from './coverage-signal-instanced-layer';
import {
  ASSUMED_READ_LENGTH_BP,
  pileupExactReadPreparationEligible,
  pileupExactReadZoomAlpha,
} from './pileup-exact-read-zoom';
import { PileupGlobalGuideLayer } from './pileup-global-guide-layer';
import {
  PENDING_INTERVAL_BAND_HEIGHT_PX,
  PENDING_SIGNAL_RAIL_HEIGHT_PX,
  PileupPendingIntervalLayer,
  uncoveredPendingReferenceIntervals,
  type PendingIntervalAppearance,
} from './pileup-pending-interval-layer';
import {
  PileupReadDifferenceLayer,
  pileupReadBodyVerticalGeometry,
} from './pileup-read-glyph-layer';
import { PILEUP_READ_BODY_COLOR_BY_THEME } from './pileup-read-quality-palette';
import { normalizeTrackColor } from './track-presentation';
import type {
  PixiLinearTrackRenderer,
  TrackCoverageDepthSnapshot,
  TrackReadPresentationSnapshot,
  TrackMountArgs,
  TrackPaintArgs,
} from './types';
import { binBp } from '../../../engine/constants';
import { READ_ALIGNMENT_BIN_BP_MAX } from '../../../engine/sources/tile-sources';

const DEFAULT_ROW_HEIGHT_PX = 3;
const DEFAULT_MAX_ROWS = 60;
const DEFAULT_OVERFLOW_BAND_HEIGHT_PX = 0;
const DEFAULT_READ_COLOR: number = PILEUP_READ_BODY_COLOR_BY_THEME.light;
export const DEFAULT_PILEUP_PAIRED_READ_COLOR = DEFAULT_READ_COLOR;
export const DEFAULT_PILEUP_FORWARD_READ_COLOR = DEFAULT_READ_COLOR;
export const DEFAULT_PILEUP_REVERSE_READ_COLOR = DEFAULT_READ_COLOR;
export const DARK_PILEUP_PAIRED_READ_COLOR = PILEUP_READ_BODY_COLOR_BY_THEME.dark;
export const DARK_PILEUP_FORWARD_READ_COLOR = DARK_PILEUP_PAIRED_READ_COLOR;
export const DARK_PILEUP_REVERSE_READ_COLOR = DARK_PILEUP_PAIRED_READ_COLOR;
const FORMER_DEFAULT_PILEUP_READ_COLOR = 0x4a90d9;
const FORMER_LIGHT_ROYAL_PILEUP_READ_COLOR = 0x426de6;
const FORMER_LIGHT_PILEUP_READ_COLOR = 0x3970fc;
const BUILT_IN_PAIRED_READ_BLUE_COLORS = new Set([
  DEFAULT_PILEUP_PAIRED_READ_COLOR,
  DARK_PILEUP_PAIRED_READ_COLOR,
  FORMER_DEFAULT_PILEUP_READ_COLOR,
  FORMER_LIGHT_ROYAL_PILEUP_READ_COLOR,
  FORMER_LIGHT_PILEUP_READ_COLOR,
  0x2f80ed,
]);
const READ_LOD_MESH_VISIBLE_ALPHA_EPSILON = 0.001;

export {
  pileupExactReadPreparationEligible,
  pileupExactReadZoomAlpha,
} from './pileup-exact-read-zoom';
const READ_DENSITY_MIN_FILL_FRACTION = 0.04;
const READ_DENSITY_MAX_FILL_FRACTION = 0.98;
const READ_ROWS_MESH_COLOR_KEY = 'uniform-read-body-v1';
const READ_DENSITY_BAR_ALPHA = PILEUP_COVERAGE_ALPHA;
const READ_DENSITY_DRAWN_EDGE_THRESHOLD_FILL = 0.03;
const EXPERIMENTAL_HYBRID_LOADING_MOTION_PERIOD_MS = 800;
const DEFAULT_HISTOGRAM_LOADING_ANIMATION: PileupHistogramLoadingAnimation = 'diagonal-scan';

function pileupExactReadLoadingEligible(pixelsPerBp: number): boolean {
  return (
    pileupExactReadPreparationEligible(pixelsPerBp) && 1 / pixelsPerBp <= READ_ALIGNMENT_BIN_BP_MAX
  );
}

export function pileupHistogramLoadingAnimationIndex(
  _animation: PileupHistogramLoadingAnimation | undefined
): number {
  return 4;
}

function pileupBarGlProgram(): GlProgram {
  return GlProgram.from({
    name: 'pileup-bar-mesh',
    vertex: ANNOTATION_VERTEX_SHADER,
    fragment: ANNOTATION_FRAGMENT_SHADER,
  });
}

const COVERAGE_SMOOTH_KERNEL = PILEUP_COVERAGE_SMOOTH_KERNEL;

type CoverageScaleMode = 'fixmax' | 'logcolor' | 'combo';
interface CoverageDepthPercentiles {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}
function readCoverageScaleMode(): CoverageScaleMode {
  return 'logcolor';
}
type CoverageStatistic = 'max' | 'mean';
function readCoverageStatistic(): CoverageStatistic {
  return 'mean';
}
export function resolveCoverageCutoffDepth(
  configuredDepth: number | null | undefined,
  defaultDepth: number
): number {
  return typeof configuredDepth === 'number' &&
    Number.isFinite(configuredDepth) &&
    configuredDepth > 0
    ? configuredDepth
    : defaultDepth;
}
function coverageFill(
  d: number,
  pct: CoverageDepthPercentiles,
  mode: CoverageScaleMode,
  collapsedMaxFill: number,
  cutoffDepth: number
): number {
  if (d <= 0 || collapsedMaxFill <= 0) return 0;
  const max = Math.max(1, pct.max);
  if (mode === 'logcolor') {
    if (cutoffDepth > 0) {
      return coverageGpuAtlasHeightCutoffFill(d, cutoffDepth, collapsedMaxFill);
    }
    const knee = Math.max(1, pct.p99);
    return coverageGpuAtlasLogColorFill(d, knee, max, collapsedMaxFill);
  }
  if (mode === 'combo') {
    const p99 = Math.max(1, pct.p99);
    if (d <= p99) {
      return collapsedMaxFill * 0.85 * clamp01(d / p99);
    }
    const logSpan = Math.log(Math.max(max, p99 + 1) / p99);
    const t = logSpan > 0 ? Math.log(d / p99) / logSpan : 1;
    return collapsedMaxFill * clamp01(0.85 + 0.15 * clamp01(t));
  }
  const p99 = Math.max(1, pct.p99);
  return Math.min(collapsedMaxFill, (d / p99) * collapsedMaxFill);
}
const READ_ROWS_ASSIGN_RECORDS_PER_FRAME = 512;
const READ_ROWS_ASSIGN_WORK_BUDGET_MS = 0.75;
const READ_ROWS_URGENT_ASSIGN_WORK_BUDGET_MS = 2;
const READ_ROWS_RETAIN_RECORDS_PER_FRAME = 512;
const READ_ROWS_BUILD_RECORDS_PER_FRAME = 512;
const READ_ROWS_URGENT_RECORDS_PER_FRAME = 4_096;
const READ_ROWS_HANDOFF_RUNWAY_VIEWPORTS = 1;
const READ_ROW_HEIGHT_FIELD_TARGET_BIN_BP = 16;
const READ_ROW_HEIGHT_FIELD_MAX_BINS = 32768;
const READ_OVERFLOW_MIN_FILL_FRACTION = 0.08;
const READ_OVERFLOW_MIN_DENOMINATOR_READS = 8;
const READ_OVERFLOW_BAR_ALPHA = 0.76;
const COLLAPSED_FIELD_TARGET_BIN_BP = ASSUMED_READ_LENGTH_BP;
const COLLAPSED_FIELD_MAX_BINS = 32768;

export type PileupReadAggregateSource = 'collapsed-pileup' | 'none';
export type PileupAggregateDepthSource =
  | 'tile-engine-coverage'
  | 'coverage-signal'
  | 'exact-collapsed'
  | 'none';

function bumpReadRowsBufferAlloc(): void {
  const g = globalThis as typeof globalThis & { __webglPileupReadRowsBufferAllocCount?: number };
  g.__webglPileupReadRowsBufferAllocCount = (g.__webglPileupReadRowsBufferAllocCount ?? 0) + 1;
}

const MAX_COLUMN_BARS = PILEUP_MAX_COLUMN_BARS;
const BAR_COLUMN_VERTS = 6;
export const DENSITY_COLUMN_VERTS = 6;
type BarSurfaceKind = RetainedSubpixelSurfaceKind;

const MAX_COVERAGE_COLUMNS = Math.floor(
  (MAX_COLUMN_BARS * BAR_COLUMN_VERTS) / DENSITY_COLUMN_VERTS
);
const MAX_RESIDENT_COVERAGE_COLUMNS = 32_768;

type BarUniforms = {
  uXScale: number;
  uXOrigin: number;
  uBpOriginChunk: number;
  uBpOriginDelta: number;
  uY0: number;
  uViewportSize: Float32Array;
  uSubpixelMinWidthPx: number;
  uSubpixelAlphaGamma: number;
  uSubpixelMinAlphaScale: number;
  uLoadingMotionActive: number;
  uLoadingMotionPhase: number;
  uLoadingMotionStyle: number;
  uHorizontalExcludeActive: number;
  uHorizontalExcludePx: Float32Array;
  uYFlip: number;
  uTrackColor: Float32Array;
  uUseTrackColor: number;
};

interface BarVertexBuffers {
  bpStartChunk: Float32Array;
  bpStartDelta: Float32Array;
  bpEndChunk: Float32Array;
  bpEndDelta: Float32Array;
  offsetCenter: Float32Array;
  halfH: Float32Array;
  xSide: Float32Array;
  ySide: Float32Array;
  color: Float32Array;
}

interface BarMesh {
  mesh: Mesh<Geometry, Shader>;
  geometry: Geometry;
  shader: Shader;
  buffers: PixiBuffer[];
  viewportUniform: Float32Array;
  vertexCount: number;
  surfaceKind: BarSurfaceKind;
}

interface ReadRowsMeshBuildJob {
  meshStart: number;
  meshEnd: number;
  colorKey: string;
  recordCount: number;
  recordsKey: string;
  records: ReadonlyArray<PileupRecord>;
  rows: Int32Array;
  hiddenReadCount: number;
  collapsedPileupField: CollapsedPileupField | null;
  readHitIndex: PileupReadHitIndex;
  sourceGenerationKey: string;
  job: AnnotationRecordVerticesJob;
}

interface ReadRowsAssignmentBuildJob {
  input: ExactReadCommitInput;
  records: ReadonlyArray<PileupRecord>;
  recordsKey: string;
  maxRows: number;
  layout: PersistentRowLayout;
  job: PileupRowAssignmentJob;
}

interface ReadRowsRetainBuildJob {
  recordsKey: string;
  job: PileupRowRetainJob;
}

interface RecordsCommitTiming {
  recordCount: number;
  totalMs: number;
  assignMs: number;
  assignRecordsProcessed: number;
  assignmentPending: boolean;
  finishAssignmentMs: number;
  beginRetainMs: number;
  extentMs: number;
  occupancyMs: number;
  rowHeightFieldMs: number;
  collapsedFieldMs: number;
  rowAssignmentMapMs: number;
  retainScheduled: boolean;
  exactDerivedBuilt: boolean;
  metadataOnly: boolean;
}

interface PaintTiming {
  totalMs: number;
  coverageMs: number;
  recordsMs: number;
  retainMs: number;
  readRowsMeshMs: number;
  densityMs: number;
  overflowMs: number;
}

interface ReadRowBudget {
  readRowsTopPx: number;
  effectiveRowHeightPx: number;
  effectiveMaxRows: number;
  effectiveReadRowsHeightPx: number;
  rowBudgetChanged: boolean;
}

interface ExactReadCommitInput {
  records: ReadonlyArray<PileupRecord> | null;
  recordsKey: string;
  recordsSampleKey: string;
  readSourceTruncated: boolean;
  sourceWindowStartBp: number | null;
  sourceWindowEndBp: number | null;
  sourceGenerationKey: string;
  exactRowsMayRender: boolean;
  experimentalHybridHeightMorph: boolean;
  needsExactCollapsedAggregate: boolean;
  shouldBuildExactDerivedRecords: boolean;
  tileEngineCoverageOwnsDensity: boolean;
  urgentReadRowsWork: boolean;
  tileEngineAuthority: boolean;
}

interface RecordsCommitWork {
  assignMs: number;
  assignRecordsProcessed: number;
  assignmentPending: boolean;
  finishAssignmentMs: number;
  beginRetainMs: number;
  extentMs: number;
  occupancyMs: number;
  rowHeightFieldMs: number;
  collapsedFieldMs: number;
  rowAssignmentMapMs: number;
  retainScheduled: boolean;
  exactDerivedBuilt: boolean;
  metadataOnly: boolean;
}

function emptyRecordsCommitWork(): RecordsCommitWork {
  return {
    assignMs: 0,
    assignRecordsProcessed: 0,
    assignmentPending: false,
    finishAssignmentMs: 0,
    beginRetainMs: 0,
    extentMs: 0,
    occupancyMs: 0,
    rowHeightFieldMs: 0,
    collapsedFieldMs: 0,
    rowAssignmentMapMs: 0,
    retainScheduled: false,
    exactDerivedBuilt: false,
    metadataOnly: false,
  };
}

interface ReadLodPresentation {
  densityHeightPx: number;
  legacyExactRowsAlpha: number;
  desiredDensityAlpha: number;
  exactCollapsedFieldAvailable: boolean;
  allowExactCollapsedFallback: boolean;
}

interface DensityPaintResult {
  coverageGpuAtlasActive: boolean;
  coverageSignalInstancedActive: boolean;
}

type ExperimentalHybridPhase = 'inactive' | 'histogram' | 'morph' | 'reads';

interface ExperimentalHybridCompletedInterval {
  readonly startBp: number;
  readonly endBp: number;
}

interface ExperimentalHybridPresentation {
  readonly active: boolean;
  readonly exactFrontAvailable: boolean;
  readonly spatialContinuityFallback: boolean;
  readonly morphProgress: number;
  readonly surfaceColor: number;
  readonly generationKey: string;
}

interface ReadRowsDoubleBuffer {
  mesh: BarMesh | null;
  pool: AnnotationRecordVerticesPool;
  bufferCapacity: number;
  meshStartBp: number;
  meshEndBp: number;
  recordCount: number;
  colorKey: string;
}

interface ContainerState {
  container: Container;
  rows: BarMesh | null;
  rowsMeshStartBp: number;
  rowsMeshEndBp: number;
  rowsMeshRecordCount: number;
  rowsMeshColorKey: string;
  rowsMeshRecordsKey: string;
  rowsMeshRecordsRef: ReadonlyArray<PileupRecord> | null;
  rowsMeshRowsRef: Int32Array | null;
  rowsMeshReadHitIndex: PileupReadHitIndex | null;
  rowsMeshSourceGenerationKey: string;
  rowsMeshHiddenReadCount: number;
  rowsMeshCollapsedPileupField: CollapsedPileupField | null;
  rowsMeshBuildJob: ReadRowsMeshBuildJob | null;
  rowsAssignmentBuildJob: ReadRowsAssignmentBuildJob | null;
  rowsAssignmentBuildChunkCount: number;
  rowsAssignmentBuildRecordsLastFrame: number;
  rowsRetainBuildJob: ReadRowsRetainBuildJob | null;
  rowsRetainBuildChunkCount: number;
  rowsRetainBuildRecordsLastFrame: number;
  rowsMeshBufferCapacity: number;
  rowsVerticesPool: AnnotationRecordVerticesPool;
  rowsBack: ReadRowsDoubleBuffer;
  themeMode: WebGLThemeMode;
  pairedReadColor: number;
  forwardReadColor: number;
  reverseReadColor: number;
  cachedCoverageRef: PileupTrackData['coverage'] | null;
  cachedCoverageRevision: string | null;
  cachedCoverageDataAuthority: PileupTrackData['dataAuthority'] | null;
  cachedRecordsRef: ReadonlyArray<PileupRecord> | null;
  cachedRecordsKey: string;
  cachedRecordsSampleKey: string;
  recordsSemanticVersion: number;
  cachedRecordsExactDerived: boolean;
  layout: PersistentRowLayout;
  lastRowAssignment: Map<string, number> | null;
  lastRecordsCommitTiming: RecordsCommitTiming | null;
  coverageSignal: PileupTrackData['coverage'] | null;
  coverageGpuAtlasLayer: CoverageGpuAtlasLayer;
  coverageSignalInstancedLayer: CoverageSignalInstancedLayer;
  histogramGuideLayer: PileupGlobalGuideLayer;
  pendingIntervalLayer: PileupPendingIntervalLayer;
  experimentalHybridPhase: ExperimentalHybridPhase;
  experimentalHybridStartedAtMs: number | null;
  experimentalHybridMorphProgress: number;
  experimentalHybridGenerationKey: string;
  experimentalHybridExactFrontAvailable: boolean;
  experimentalHybridSpatialContinuityFallback: boolean;
  experimentalHybridDensityExclusionStartBp: number | null;
  experimentalHybridDensityExclusionEndBp: number | null;
  experimentalHybridSourceGenerationKey: string;
  experimentalHybridCompletedIntervals: ExperimentalHybridCompletedInterval[];
  experimentalHybridHistogramLoadingMotion: boolean;
  experimentalHybridHistogramLoadingStartedAtMs: number | null;
  experimentalHybridHistogramLoadingPhase: number;
  experimentalHybridHistogramLoadingAnimation: PileupHistogramLoadingAnimation;
  readDifferenceLayer: PileupReadDifferenceLayer;
  coverageStartBp: number;
  coverageMaxDepth: number;
  coverageSignalNonzeroBinCount: number;
  coverageLodRole: NonNullable<PileupTrackData['coverageLod']>['role'] | null;
  coverageLodLevel: number | null;
  coverageLodTargetLevel: number | null;
  coverageLodBinSize: number | null;
  coverageLodAuthority: NonNullable<PileupTrackData['coverageLod']>['authority'] | null;
  coverageLodProvenanceExact: boolean | null;
  coverageLodProvenanceMethod: string | null;
  coverageLodProvenanceSource: string | null;
  coverageLodSourceLevel: number | null;
  coverageLodSourceBinSize: number | null;
  coverageLodResidentLevel: number | null;
  coverageLodResidentBinSize: number | null;
  coverageLodCurrentCoveredFraction: number | null;
  coverageSampledColumnCount: number;
  coverageSampledNonzeroColumnCount: number;
  coverageSampledMaxDepth: number;
  coverageSamplePassCount: number;
  coverageGeometryBuildCount: number;
  coverageBufferUploadCount: number;
  lastViewportStartBp: number;
  lastViewportEndBp: number;
  activeCoverageBinSize: number;
  densityRows: BarMesh | null;
  densityRowsArrays: BarVertexBuffers | null;
  cachedDensityRowsKey: string;
  overflowRows: BarMesh | null;
  overflowRowsArrays: BarVertexBuffers | null;
  cachedOverflowRowsKey: string;
  overflowRowsRecordsKey: string;
  overflowGeometryBuildCount: number;
  effectiveMaxRows: number;
  effectiveRowHeightPx: number;
  rowCount: number;
  hiddenReadCount: number;
  recordCount: number;
  forwardReadCount: number;
  reverseReadCount: number;
  pairedReadCount: number;
  densityRowBinCount: number;
  loadedStartBp: number;
  loadedEndBp: number;
  readSourceTruncated: boolean;
  readSourceWindowStartBp: number | null;
  readSourceWindowEndBp: number | null;
  readOccupancy: ReadOccupancy | null;
  cachedReadRows: Int32Array | null;
  cachedReadHitIndex: PileupReadHitIndex | null;
  readSourceGenerationKey: string;
  readPresentationOwnerKey: string;
  readRowHeightField: ReadRowHeightField | null;
  collapsedPileupField: CollapsedPileupField | null;
  visibleReadColumnCoverage: number | null;
  lastPaintTiming: PaintTiming | null;
  readDensityColumnCoverage: number;
  readDensityMeanFill: number;
  readDensityMaxFill: number;
  readDensityRowStackMeanFill: number;
  readDensityRowStackMaxFill: number;
  readDensityMorph: number;
  readDensityFillStdDev: number;
  readDensitySourceDepthMean: number;
  readDensitySourceDepthStdDev: number;
  readDensitySourceDepthCv: number;
  readDensitySourceDepthP10: number;
  readDensitySourceDepthP50: number;
  readDensitySourceDepthP90: number;
  readDensitySourceDepthP99: number;
  readDensitySourceDepthEdgeCount: number;
  readDensitySourceDepthLongestFlatRunColumns: number;
  readDensityDrawnFillStdDev: number;
  readDensityDrawnEdgeCount: number;
  readDensityDrawnLongestFlatRunColumns: number;
  readDensityClippedColumnFraction: number;
  collapsedPileupFieldBinCount: number;
  collapsedPileupMaxVisibleRows: number;
  collapsedPileupMaxHiddenCount: number;
  overflowRowBinCount: number;
  overflowColumnCoverage: number;
  overflowMeanFill: number;
  overflowMaxFill: number;
  overflowMaxHiddenReads: number;
  overflowMorph: number;
  overflowBaseMinPx: number;
  overflowBaseMaxPx: number;
  overflowBandTopPx: number;
  overflowBandHeightPx: number;
  readRowsAlpha: number;
  readDensityAlpha: number;
  overflowRowsAlpha: number;
  renderedReadRowsAlpha: number;
  renderedReadDensityAlpha: number;
  renderedOverflowRowsAlpha: number;
  readDisplayMode: 'reads' | 'density' | 'blend' | 'empty';
  readAggregateSource: PileupReadAggregateSource;
  aggregateDepthSource: PileupAggregateDepthSource;
  readSourceWindowCoversViewport: boolean;
  readSourceWindowCoverageFraction: number;
  rowsMeshViewportCoverageFraction: number;
  recordExtentCoversViewport: boolean;
  debugVisibleReadSamples: PileupVisibleReadSample[] | null;
}

export interface PileupVisibleReadSample {
  readId: string;
  placementKey: string;
  start: number;
  end: number;
  row: number;
  strand: '+' | '-';
  paired: boolean;
  color: number;
  x0Px: number;
  x1Px: number;
  yPx: number;
}

export interface PileupTrackDiagnostics {
  themeMode: WebGLThemeMode;
  pairedReadColor: number;
  forwardReadColor: number;
  reverseReadColor: number;
  recordCount: number;
  forwardReadCount: number;
  reverseReadCount: number;
  pairedReadCount: number;
  rowsUsed: number;
  hiddenReadCount: number;
  maxRows: number;
  effectiveMaxRows: number;
  bandBinCount: number;
  activeCoverageBinSize: number;
  renderedCoverageBinSize: number | null;
  renderedCoverageBinCount: number | null;
  coverageSignalStartBp: number | null;
  coverageSignalEndBp: number | null;
  coverageSignalMaxDepth: number;
  coverageSignalNonzeroBinCount: number;
  coverageDepthP50: number | null;
  coverageDepthP90: number | null;
  coverageDepthP95: number | null;
  coverageDepthP99: number | null;
  coverageDepthMax: number | null;
  coverageLodRole: NonNullable<PileupTrackData['coverageLod']>['role'] | null;
  coverageLodLevel: number | null;
  coverageLodTargetLevel: number | null;
  coverageLodBinSize: number | null;
  coverageLodAuthority: NonNullable<PileupTrackData['coverageLod']>['authority'] | null;
  coverageLodProvenanceExact: boolean | null;
  coverageLodProvenanceMethod: string | null;
  coverageLodProvenanceSource: string | null;
  coverageLodSourceLevel: number | null;
  coverageLodSourceBinSize: number | null;
  coverageLodResidentLevel: number | null;
  coverageLodResidentBinSize: number | null;
  coverageLodCurrentCoveredFraction: number | null;
  coverageSampledColumnCount: number;
  coverageSampledNonzeroColumnCount: number;
  coverageSampledMaxDepth: number;
  coverageSamplePassCount: number;
  coverageGeometryBuildCount: number;
  coverageBufferUploadCount: number;
  coverageGpuAtlasAuthorityKey: string | null;
  coverageGpuAtlasTextureResourceCreateCount: number;
  coverageGpuAtlasGpuTextureResourceCreateCount: number;
  coverageGpuAtlasGpuTextureUploadCount: number;
  coverageGpuAtlasGpuTextureUploadComplete: boolean;
  coverageGpuAtlasTextureResourceUid: number | null;
  coverageGpuAtlasShaderTextureResourceUid: number | null;
  coverageGpuAtlasShaderTextureResourceBound: boolean;
  coverageGpuAtlasGeometryBuildCount: number;
  coverageGpuAtlasCameraUniformUpdateCount: number;
  coverageGpuAtlasRenderOwner: string | null;
  coverageGpuAtlasShaderProgramName: string | null;
  coverageGpuAtlasShaderProgramKey: number | null;
  coverageGpuAtlasShaderProgramCompiled: boolean;
  coverageGpuAtlasActive: boolean;
  coverageGpuAtlasBaseBinSizeBp: number;
  coverageGpuAtlasDepthMax: number;
  rendererViewportStartBp: number;
  rendererViewportEndBp: number;
  collapsed: boolean;
  bandVertexCount: number;
  rowsVertexCount: number;
  rowsMeshStartBp: number;
  rowsMeshEndBp: number;
  rowsMeshRecordCount: number;
  rowsMeshGenerationKey: string;
  overflowGenerationKey: string;
  overflowGeometryBuildCount: number;
  rowsMeshBuildInProgress: boolean;
  rowsMeshBuildRecordsLastFrame: number;
  rowsMeshBuildChunkCount: number;
  rowsMeshBuildTargetMatchesRecordsKey: boolean | null;
  rowsMeshBuildRecordCursor: number;
  rowsMeshBuildRecordCount: number;
  rowsAssignmentBuildInProgress: boolean;
  rowsAssignmentBuildRecordsLastFrame: number;
  rowsAssignmentBuildChunkCount: number;
  rowsRetainBuildInProgress: boolean;
  rowsRetainBuildRecordsLastFrame: number;
  rowsRetainBuildChunkCount: number;
  rowsRetainedPlacementCount: number;
  rowsRetainedIntervalCount: number;
  rowsMeshBufferAllocCount: number;
  recordsCommitTiming: RecordsCommitTiming | null;
  paintTiming: PaintTiming | null;
  morphRowsVertexCount: number;
  densityRowsVertexCount: number;
  overflowRowsVertexCount: number;
  loadedStartBp: number;
  loadedEndBp: number;
  readSourceTruncated: boolean;
  readSourceWindowStartBp: number | null;
  readSourceWindowEndBp: number | null;
  readRowsTopPx: number;
  readRowsBottomPx: number;
  effectiveRowHeightPx: number;
  overflowBandTopPx: number;
  overflowBandBottomPx: number;
  overflowBandHeightPx: number;
  visibleReadColumnCoverage: number | null;
  readDensityColumnCoverage: number;
  readDensityMeanFill: number;
  readDensityMaxFill: number;
  readDensityRowStackMeanFill: number;
  readDensityRowStackMaxFill: number;
  readDensityMorph: number;
  readDensityFillStdDev: number;
  readDensitySourceDepthMean: number;
  readDensitySourceDepthStdDev: number;
  readDensitySourceDepthCv: number;
  readDensitySourceDepthP10: number;
  readDensitySourceDepthP50: number;
  readDensitySourceDepthP90: number;
  readDensitySourceDepthP99: number;
  readDensitySourceDepthEdgeCount: number;
  readDensitySourceDepthLongestFlatRunColumns: number;
  readDensityDrawnFillStdDev: number;
  readDensityDrawnEdgeCount: number;
  readDensityDrawnLongestFlatRunColumns: number;
  readDensityClippedColumnFraction: number;
  collapsedPileupFieldBinCount: number;
  collapsedPileupMaxVisibleRows: number;
  collapsedPileupMaxHiddenCount: number;
  overflowColumnCoverage: number;
  overflowMeanFill: number;
  overflowMaxFill: number;
  overflowMaxHiddenReads: number;
  overflowMorph: number;
  overflowBaseMinPx: number;
  overflowBaseMaxPx: number;
  readRowsAlpha: number;
  readDensityAlpha: number;
  overflowRowsAlpha: number;
  renderedReadRowsAlpha: number;
  renderedReadMorphRowsAlpha: number;
  renderedReadDensityAlpha: number;
  renderedOverflowRowsAlpha: number;
  readDisplayMode: 'reads' | 'density' | 'blend' | 'empty';
  readAggregateSource: PileupReadAggregateSource;
  aggregateDepthSource: PileupAggregateDepthSource;
  readSourceWindowCoversViewport: boolean;
  readSourceWindowCoverageFraction: number;
  rowsMeshViewportCoverageFraction: number;
  recordExtentCoversViewport: boolean;
  rowsMeshVisible: boolean;
  rowsMeshAlpha: number;
  morphRowsMeshVisible: boolean;
  morphRowsMeshAlpha: number;
  densityRowsMeshVisible: boolean;
  densityRowsMeshAlpha: number;
  overflowRowsMeshVisible: boolean;
  overflowRowsMeshAlpha: number;
  rowAssignments?: Record<string, number>;
  visibleReadSamples?: PileupVisibleReadSample[];
  readGlyphCount: number;
  readGlyphContract: 'reference-sequence-text-v1';
  readGlyphRasterSize: 16;
  readDifferenceMarkCount: number;
  readDifferenceInstanceCount: number;
  readDifferenceBufferCapacity: number;
  readDifferenceBufferGrowCount: number;
  readDifferenceBuildCount: number;
  readDifferenceHitTestCandidateCount: number;
  readDifferenceLayerVisible: boolean;
  readDifferenceLayerAlpha: number;
  readDifferenceScreenTopPx: number;
  pendingIntervalCount: number;
  pendingIntervalGeometryBuildCount: number;
  pendingIntervalBufferUploadCount: number;
  pendingIntervalCameraUniformUpdateCount: number;
  pendingIntervalBandTopPx: number;
  pendingIntervalBandHeightPx: number;
  pendingIntervalAppearance: PendingIntervalAppearance;
  pendingIntervalMotionPhase: number;
  pendingIntervalLoadingColors: { readonly base: number; readonly pulse: number };
  pendingIntervalVisible: boolean;
  pendingIntervals: ReadonlyArray<{ readonly startBp: number; readonly endBp: number }>;
  pendingIntervalProjectedIntervalsPx: ReadonlyArray<{
    readonly left: number;
    readonly right: number;
  }>;
  experimentalHybridPhase: ExperimentalHybridPhase;
  experimentalHybridMorphProgress: number;
  experimentalHybridExactFrontAvailable: boolean;
  experimentalHybridGenerationKey: string;
  experimentalHybridSpatialContinuityFallback: boolean;
  experimentalHybridDensityExclusionStartBp: number | null;
  experimentalHybridDensityExclusionEndBp: number | null;
  experimentalHybridHistogramLoadingMotion: boolean;
  experimentalHybridHistogramLoadingPhase: number;
  experimentalHybridHistogramLoadingAnimation: PileupHistogramLoadingAnimation;
}

export type PileupColdGestureDiagnostics = Pick<
  PileupTrackDiagnostics,
  | 'coverageLodRole'
  | 'coverageLodLevel'
  | 'coverageLodTargetLevel'
  | 'coverageLodBinSize'
  | 'coverageLodAuthority'
  | 'coverageLodProvenanceExact'
  | 'coverageSamplePassCount'
  | 'coverageGeometryBuildCount'
  | 'coverageBufferUploadCount'
  | 'coverageSignalNonzeroBinCount'
  | 'renderedReadDensityAlpha'
  | 'densityRowsMeshVisible'
  | 'coverageGpuAtlasAuthorityKey'
  | 'coverageGpuAtlasTextureResourceCreateCount'
  | 'coverageGpuAtlasGpuTextureResourceCreateCount'
  | 'coverageGpuAtlasGpuTextureUploadCount'
  | 'coverageGpuAtlasGpuTextureUploadComplete'
  | 'coverageGpuAtlasTextureResourceUid'
  | 'coverageGpuAtlasShaderTextureResourceUid'
  | 'coverageGpuAtlasShaderTextureResourceBound'
  | 'coverageGpuAtlasGeometryBuildCount'
  | 'coverageGpuAtlasCameraUniformUpdateCount'
  | 'coverageGpuAtlasRenderOwner'
  | 'coverageGpuAtlasShaderProgramName'
  | 'coverageGpuAtlasShaderProgramKey'
  | 'coverageGpuAtlasShaderProgramCompiled'
  | 'coverageGpuAtlasActive'
  | 'coverageGpuAtlasBaseBinSizeBp'
  | 'coverageGpuAtlasDepthMax'
  | 'rendererViewportStartBp'
  | 'rendererViewportEndBp'
>;

export interface PixiPileupTrackRendererOptions {
  type: string;
  rowHeightPx?: number;
  maxRows?: number;
  overflowBandHeightPx?: number;
  readColor?: number;
  coverageScale?: 'linear' | 'log';
  collapsed?: boolean;
  readRowsBuildRecordsPerFrame?: number;
  readRowsAssignRecordsPerFrame?: number;
  readRowsAssignWorkBudgetMs?: number;
  readRowsRetainRecordsPerFrame?: number;
}

function buildRowAssignmentMap(
  records: ReadonlyArray<PileupRecord>,
  rows: Int32Array
): Map<string, number> {
  const m = new Map<string, number>();
  const readIdCounts = new Map<string, number>();
  for (const record of records) {
    readIdCounts.set(record.readId, (readIdCounts.get(record.readId) ?? 0) + 1);
  }
  for (let i = 0; i < records.length; i++) {
    if (rows[i] < 0) continue;
    const record = records[i];
    const key =
      (readIdCounts.get(record.readId) ?? 0) > 1 ? pileupReadPlacementKey(record) : record.readId;
    m.set(key, rows[i]);
  }
  return m;
}

const READ_OCCUPANCY_BINS = 4096;

interface ReadOccupancy {
  startBp: number;
  endBp: number;
  bins: Uint8Array;
}

interface ReadRowHeightField {
  startBp: number;
  endBp: number;
  binSizeBp: number;
  bins: Uint16Array;
}

function buildReadOccupancy(
  records: ReadonlyArray<PileupRecord> | null,
  loadedStartBp: number,
  loadedEndBp: number
): ReadOccupancy | null {
  if (!records || records.length === 0 || loadedEndBp <= loadedStartBp) return null;
  const bins = new Uint8Array(READ_OCCUPANCY_BINS);
  const span = loadedEndBp - loadedStartBp;
  for (const r of records) {
    const start = Math.max(r.start, loadedStartBp);
    const end = Math.min(r.end, loadedEndBp);
    if (end <= start) continue;
    const b0 = Math.max(
      0,
      Math.min(
        READ_OCCUPANCY_BINS - 1,
        Math.floor(((start - loadedStartBp) / span) * READ_OCCUPANCY_BINS)
      )
    );
    const b1 = Math.max(
      b0 + 1,
      Math.min(READ_OCCUPANCY_BINS, Math.ceil(((end - loadedStartBp) / span) * READ_OCCUPANCY_BINS))
    );
    for (let b = b0; b < b1; b++) bins[b] = 1;
  }
  return { startBp: loadedStartBp, endBp: loadedEndBp, bins };
}

function computeVisibleReadColumnCoverage(
  occupancy: ReadOccupancy | null,
  viewStartBp: number,
  viewEndBp: number,
  viewportWidthPx: number
): number {
  if (!occupancy) return 0;
  const viewSpan = viewEndBp - viewStartBp;
  const occSpan = occupancy.endBp - occupancy.startBp;
  const width = Math.min(4096, Math.max(1, Math.round(viewportWidthPx)));
  if (viewSpan <= 0 || occSpan <= 0 || width <= 0) return 0;
  let coveredColumns = 0;
  for (let x = 0; x < width; x++) {
    const colStart = viewStartBp + (x / width) * viewSpan;
    const colEnd = viewStartBp + ((x + 1) / width) * viewSpan;
    const start = Math.max(colStart, occupancy.startBp);
    const end = Math.min(colEnd, occupancy.endBp);
    if (end <= start) continue;
    const b0 = Math.max(
      0,
      Math.min(
        occupancy.bins.length - 1,
        Math.floor(((start - occupancy.startBp) / occSpan) * occupancy.bins.length)
      )
    );
    const b1 = Math.max(
      b0 + 1,
      Math.min(
        occupancy.bins.length,
        Math.ceil(((end - occupancy.startBp) / occSpan) * occupancy.bins.length)
      )
    );
    for (let b = b0; b < b1; b++) {
      if (occupancy.bins[b]) {
        coveredColumns++;
        break;
      }
    }
  }
  return coveredColumns / width;
}

function isExactTileEngineCoverageSignal(
  coverage: PileupTrackData['coverage'] | null,
  coverageLod: PileupTrackData['coverageLod'] | null | undefined
): boolean {
  if (
    coverage == null ||
    coverage.provenance?.exact !== true ||
    coverage.provenance.source !== 'tile-engine'
  ) {
    return false;
  }
  if (!coverageLod) return true;
  return (
    coverageLod.role === 'current-lod' &&
    coverageLod.level === coverageLod.targetLevel &&
    coverageLod.binSize === coverage.binSize &&
    coverage.binSize === binBp(coverageLod.targetLevel)
  );
}

function isPresentableTileEngineCoverageSignal(
  coverage: PileupTrackData['coverage'] | null,
  coverageLod: PileupTrackData['coverageLod'] | null | undefined
): boolean {
  return isExactTileEngineCoverageSignal(coverage, coverageLod);
}

function shouldRetainLastExactCoverage(
  tileEngineAuthority: boolean,
  tileEngineCoveragePresentable: boolean,
  rawCoverage: PileupTrackData['coverage'] | null,
  cachedCoverageDataAuthority: PileupTrackData['dataAuthority'] | null,
  coverageSignal: PileupTrackData['coverage'] | null,
  coverageLodProvenanceExact: boolean | null
): boolean {
  return (
    tileEngineAuthority &&
    !tileEngineCoveragePresentable &&
    rawCoverage != null &&
    rawCoverage.bins.length > 0 &&
    cachedCoverageDataAuthority === 'tile-engine' &&
    coverageSignal != null &&
    coverageLodProvenanceExact === true
  );
}

function isDisjointReadWindow(
  previousWindowStart: number | null,
  previousWindowEnd: number | null,
  nextWindowStart: number | null,
  nextWindowEnd: number | null
): boolean {
  return (
    previousWindowStart !== null &&
    previousWindowEnd !== null &&
    nextWindowStart !== null &&
    nextWindowEnd !== null &&
    (nextWindowEnd <= previousWindowStart || nextWindowStart >= previousWindowEnd)
  );
}

function countPositiveBins(bins: ReadonlyArray<number>): number {
  let count = 0;
  for (let index = 0; index < bins.length; index++) {
    if (bins[index] > 0) count++;
  }
  return count;
}

function viewportCoverageFraction(
  windowStart: number,
  windowEnd: number,
  viewportStart: number,
  viewportEnd: number
): number {
  const span = viewportEnd - viewportStart;
  if (span <= 0 || windowEnd <= windowStart) return 0;
  const overlap = Math.min(viewportEnd, windowEnd) - Math.max(viewportStart, windowStart);
  return clamp01(overlap / span);
}

function pendingReferenceIntervalOverlapsViewport(
  intervals: PileupTrackData['referenceIntervals'],
  viewportStartBp: number,
  viewportEndBp: number
): boolean {
  return Boolean(
    intervals?.some(
      (interval) =>
        interval.state === 'pending' &&
        interval.endBp > viewportStartBp &&
        interval.startBp < viewportEndBp
    )
  );
}

const MAX_EXPERIMENTAL_HYBRID_COMPLETED_INTERVALS = 256;

function completedHybridIntervalsCover(
  intervals: ReadonlyArray<ExperimentalHybridCompletedInterval>,
  viewportStartBp: number,
  viewportEndBp: number
): boolean {
  if (viewportEndBp <= viewportStartBp) return false;
  return intervals.some(
    (interval) => interval.startBp <= viewportStartBp && interval.endBp >= viewportEndBp
  );
}

function completedHybridIntervalsOverlap(
  intervals: ReadonlyArray<ExperimentalHybridCompletedInterval>,
  startBp: number,
  endBp: number
): boolean {
  if (endBp <= startBp) return false;
  return intervals.some((interval) => interval.endBp > startBp && interval.startBp < endBp);
}

function rememberCompletedHybridInterval(
  intervals: ExperimentalHybridCompletedInterval[],
  startBp: number,
  endBp: number
): void {
  if (!Number.isFinite(startBp) || !Number.isFinite(endBp) || endBp <= startBp) return;
  const merged: ExperimentalHybridCompletedInterval[] = [];
  const candidates = [...intervals, { startBp, endBp }].sort(
    (left, right) => left.startBp - right.startBp || left.endBp - right.endBp
  );
  for (const candidate of candidates) {
    const previous = merged[merged.length - 1];
    if (!previous || candidate.startBp > previous.endBp) {
      merged.push(candidate);
      continue;
    }
    merged[merged.length - 1] = {
      startBp: previous.startBp,
      endBp: Math.max(previous.endBp, candidate.endBp),
    };
  }
  if (merged.length > MAX_EXPERIMENTAL_HYBRID_COMPLETED_INTERVALS) {
    const midpoint = (startBp + endBp) / 2;
    merged.sort((left, right) => {
      const leftDistance = Math.abs((left.startBp + left.endBp) / 2 - midpoint);
      const rightDistance = Math.abs((right.startBp + right.endBp) / 2 - midpoint);
      return leftDistance - rightDistance;
    });
    merged.length = MAX_EXPERIMENTAL_HYBRID_COMPLETED_INTERVALS;
    merged.sort((left, right) => left.startBp - right.startBp || left.endBp - right.endBp);
  }
  intervals.splice(0, intervals.length, ...merged);
}

function readRowsHandoffNeedsUrgentWork(
  residentStart: number,
  residentEnd: number,
  targetStart: number | null,
  targetEnd: number | null,
  viewportStart: number,
  viewportEnd: number
): boolean {
  if (viewportCoverageFraction(residentStart, residentEnd, viewportStart, viewportEnd) < 0.999) {
    return true;
  }
  if (
    targetStart === null ||
    targetEnd === null ||
    targetEnd <= targetStart ||
    residentEnd <= residentStart
  ) {
    return false;
  }
  const viewportSpan = viewportEnd - viewportStart;
  if (viewportSpan <= 0) return false;
  const bandAdvanceBp = Math.max(0, targetEnd - residentEnd, residentStart - targetStart);
  const runwayBp = Math.max(viewportSpan * READ_ROWS_HANDOFF_RUNWAY_VIEWPORTS, bandAdvanceBp * 2);
  if (targetEnd > residentEnd) {
    return residentEnd - viewportEnd < runwayBp;
  }
  if (targetStart < residentStart) {
    return viewportStart - residentStart < runwayBp;
  }
  return false;
}

export function pileupReadDisplayColor(
  _record: PileupRecord,
  pairedColor = DEFAULT_PILEUP_PAIRED_READ_COLOR,
  themeMode?: WebGLThemeMode
): number {
  return pileupPairedReadColorForTheme(pairedColor, themeMode);
}

function pileupPairedReadColorForTheme(pairedColor: number, themeMode?: WebGLThemeMode): number {
  if (BUILT_IN_PAIRED_READ_BLUE_COLORS.has(pairedColor)) {
    return themeMode === 'dark' ? DARK_PILEUP_PAIRED_READ_COLOR : DEFAULT_PILEUP_PAIRED_READ_COLOR;
  }
  if (themeMode !== 'dark') return pairedColor;
  return webglAnnotationColorForMode(pairedColor, themeMode);
}

function trackPresentationColorNumber(value: string | undefined): number | null {
  const normalized = normalizeTrackColor(value);
  return normalized ? Number.parseInt(normalized.slice(1), 16) : null;
}

function presentationReadColorForTheme(
  value: string | undefined,
  fallback: number,
  themeMode: WebGLThemeMode
): number {
  return themeMode === 'light' ? (trackPresentationColorNumber(value) ?? fallback) : fallback;
}

interface PileupProbeOptions {
  hideExactRows?: boolean;
  hideReadDensity?: boolean;
  densityColor?: number;
}

function pileupProbeOptions(): PileupProbeOptions {
  const g = globalThis as { __dna119PileupProbe?: PileupProbeOptions };
  return g.__dna119PileupProbe ?? {};
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

interface DensityFillStatsAccumulator {
  columns: number;
  visible: number;
  sum: number;
  sumSq: number;
  max: number;
  clipped: number;
  edgeCount: number;
  longestFlatRunColumns: number;
  currentFlatRunColumns: number;
  previousFill: number | null;
}

interface DensityFillStats {
  visible: number;
  columnCoverage: number;
  meanFill: number;
  maxFill: number;
  stdDev: number;
  clippedFraction: number;
  edgeCount: number;
  longestFlatRunColumns: number;
}

interface SourceDepthStats {
  p10: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  edgeCount: number;
  longestFlatRunColumns: number;
}

function createDensityFillStatsAccumulator(): DensityFillStatsAccumulator {
  return {
    columns: 0,
    visible: 0,
    sum: 0,
    sumSq: 0,
    max: 0,
    clipped: 0,
    edgeCount: 0,
    longestFlatRunColumns: 0,
    currentFlatRunColumns: 0,
    previousFill: null,
  };
}

function recordDensityDrawnFill(
  stats: DensityFillStatsAccumulator,
  fill: number,
  clipped: boolean
): void {
  const safeFill = Number.isFinite(fill) ? Math.max(0, fill) : 0;
  if (stats.previousFill == null) {
    stats.currentFlatRunColumns = 1;
  } else if (Math.abs(safeFill - stats.previousFill) >= READ_DENSITY_DRAWN_EDGE_THRESHOLD_FILL) {
    stats.edgeCount++;
    stats.longestFlatRunColumns = Math.max(
      stats.longestFlatRunColumns,
      stats.currentFlatRunColumns
    );
    stats.currentFlatRunColumns = 1;
  } else {
    stats.currentFlatRunColumns++;
  }
  stats.previousFill = safeFill;
  stats.columns++;
  if (safeFill > 0) {
    stats.visible++;
    stats.sum += safeFill;
    stats.sumSq += safeFill * safeFill;
    if (safeFill > stats.max) stats.max = safeFill;
    if (clipped) stats.clipped++;
  }
}

function finishDensityDrawnFillStats(stats: DensityFillStatsAccumulator): DensityFillStats {
  stats.longestFlatRunColumns = Math.max(stats.longestFlatRunColumns, stats.currentFlatRunColumns);
  const meanFill = stats.visible > 0 ? stats.sum / stats.visible : 0;
  return {
    visible: stats.visible,
    columnCoverage: stats.columns > 0 ? stats.visible / stats.columns : 0,
    meanFill,
    maxFill: stats.max,
    stdDev:
      stats.visible > 0
        ? Math.sqrt(Math.max(0, stats.sumSq / stats.visible - meanFill * meanFill))
        : 0,
    clippedFraction: stats.visible > 0 ? stats.clipped / stats.visible : 0,
    edgeCount: stats.edgeCount,
    longestFlatRunColumns: stats.longestFlatRunColumns,
  };
}

function summarizeSourceDepths(
  depths: Float32Array,
  quantileScratch: Float32Array
): SourceDepthStats {
  let nonzeroCount = 0;
  let edgeCount = 0;
  let longestFlatRunColumns = depths.length > 0 ? 1 : 0;
  let currentFlatRunColumns = depths.length > 0 ? 1 : 0;
  for (let i = 0; i < depths.length; i += 1) {
    const d = depths[i] ?? 0;
    if (d > 0) {
      quantileScratch[nonzeroCount] = d;
      nonzeroCount += 1;
    }
    if (i === 0) continue;
    const prev = depths[i - 1] ?? 0;
    if (Math.abs(d - prev) >= 1) {
      edgeCount += 1;
      longestFlatRunColumns = Math.max(longestFlatRunColumns, currentFlatRunColumns);
      currentFlatRunColumns = 1;
    } else {
      currentFlatRunColumns += 1;
    }
  }
  longestFlatRunColumns = Math.max(longestFlatRunColumns, currentFlatRunColumns);
  const nonzero = quantileScratch.subarray(0, nonzeroCount);
  nonzero.sort();
  return {
    p10: quantileSorted(nonzero, 0.1),
    p50: quantileSorted(nonzero, 0.5),
    p90: quantileSorted(nonzero, 0.9),
    p95: quantileSorted(nonzero, 0.95),
    p99: quantileSorted(nonzero, 0.99),
    edgeCount,
    longestFlatRunColumns,
  };
}

function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? 0;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function buildReadRowHeightField(
  records: ReadonlyArray<PileupRecord> | null,
  rows: Int32Array | null,
  loadedStartBp: number,
  loadedEndBp: number
): ReadRowHeightField | null {
  if (
    !records ||
    !rows ||
    records.length === 0 ||
    rows.length !== records.length ||
    loadedEndBp <= loadedStartBp
  ) {
    return null;
  }
  const span = loadedEndBp - loadedStartBp;
  const binCount = Math.min(
    READ_ROW_HEIGHT_FIELD_MAX_BINS,
    Math.max(1, Math.ceil(span / READ_ROW_HEIGHT_FIELD_TARGET_BIN_BP))
  );
  const binSizeBp = span / binCount;
  const bins = new Uint16Array(binCount);
  for (let i = 0; i < records.length; i++) {
    const row = rows[i];
    if (row < 0) continue;
    const rec = records[i];
    const start = Math.max(rec.start, loadedStartBp);
    const end = Math.min(rec.end, loadedEndBp);
    if (end <= start) continue;
    const b0 = Math.max(0, Math.min(binCount - 1, Math.floor((start - loadedStartBp) / binSizeBp)));
    const b1 = Math.max(b0 + 1, Math.min(binCount, Math.ceil((end - loadedStartBp) / binSizeBp)));
    const h = Math.min(65535, row + 1);
    for (let b = b0; b < b1; b++) if (h > bins[b]) bins[b] = h;
  }
  return { startBp: loadedStartBp, endBp: loadedEndBp, binSizeBp, bins };
}

function sampleReadRowHeightField(
  field: ReadRowHeightField | null,
  viewStart: number,
  viewEnd: number,
  columnBp: number,
  columnCount: number
): Uint16Array | null {
  if (
    !field ||
    field.bins.length === 0 ||
    columnCount <= 0 ||
    columnBp <= 0 ||
    viewEnd <= viewStart ||
    field.endBp <= field.startBp
  ) {
    return null;
  }
  const heights = new Uint16Array(columnCount);
  for (let c = 0; c < columnCount; c++) {
    const colStart = viewStart + c * columnBp;
    const colEnd = colStart + columnBp;
    const start = Math.max(colStart, field.startBp);
    const end = Math.min(colEnd, field.endBp);
    if (end <= start) continue;
    const b0 = Math.max(
      0,
      Math.min(field.bins.length - 1, Math.floor((start - field.startBp) / field.binSizeBp))
    );
    const b1 = Math.max(
      b0 + 1,
      Math.min(field.bins.length, Math.ceil((end - field.startBp) / field.binSizeBp))
    );
    let h = 0;
    for (let b = b0; b < b1; b++) if (field.bins[b] > h) h = field.bins[b];
    heights[c] = h;
  }
  return heights;
}

function buildVisibleReadSamples(
  records: ReadonlyArray<PileupRecord> | null,
  rows: Int32Array | null,
  args: TrackPaintArgs<PileupTrackData>,
  rowHeightPx: number,
  readRowsTopPx: number,
  pairedColor: number,
  themeMode?: WebGLThemeMode
): PileupVisibleReadSample[] | null {
  const expose = (globalThis as { __dna119ExposePileupRows?: boolean }).__dna119ExposePileupRows;
  if (!expose || !records || !rows || rows.length !== records.length) return null;
  const samples: PileupVisibleReadSample[] = [];
  const y0 = args.containerTopPx + readRowsTopPx;
  for (let i = 0; i < records.length; i++) {
    const row = rows[i];
    if (row < 0) continue;
    const r = records[i];
    if (r.end <= args.viewportBpRange.start || r.start >= args.viewportBpRange.end) continue;
    const x0 = args.pathMapper.bpLeftX(Math.max(r.start, args.viewportBpRange.start));
    const x1 = args.pathMapper.bpLeftX(Math.min(r.end, args.viewportBpRange.end));
    if (x1 <= 0 || x0 >= args.viewportWidthPx || x1 - x0 < 3) continue;
    samples.push({
      readId: r.readId,
      placementKey: pileupReadPlacementKey(r),
      start: r.start,
      end: r.end,
      row,
      strand: r.strand,
      paired: r.pair?.paired === true,
      color: pileupReadDisplayColor(r, pairedColor, themeMode),
      x0Px: Math.max(0, x0),
      x1Px: Math.min(args.viewportWidthPx, x1),
      yPx: y0 + row * rowHeightPx + rowHeightPx / 2,
    });
  }
  return samples;
}

function pileupRecordsKey(
  records: ReadonlyArray<PileupRecord> | null,
  sourceWindowStartBp: number | null,
  sourceWindowEndBp: number | null,
  truncated: boolean,
  sourceGenerationKey: string
): string {
  if (!records || records.length === 0) {
    return [
      'empty',
      truncated ? 1 : 0,
      sourceWindowStartBp ?? '',
      sourceWindowEndBp ?? '',
      sourceGenerationKey,
    ].join(':');
  }
  const n = records.length;
  const first = records[0];
  const mid = records[n >> 1];
  const last = records[n - 1];
  return [
    truncated ? 1 : 0,
    sourceWindowStartBp ?? '',
    sourceWindowEndBp ?? '',
    sourceGenerationKey,
    n,
    first.chrom,
    pileupReadPlacementKey(first),
    mid.chrom,
    pileupReadPlacementKey(mid),
    last.chrom,
    pileupReadPlacementKey(last),
  ].join('|');
}

function readRecordsEqual(
  left: ReadonlyArray<PileupRecord> | null,
  right: ReadonlyArray<PileupRecord> | null
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a === b) continue;
    if (
      a.chrom !== b.chrom ||
      a.start !== b.start ||
      a.end !== b.end ||
      a.alignmentStart !== b.alignmentStart ||
      a.readId !== b.readId ||
      a.flag !== b.flag ||
      a.strand !== b.strand ||
      a.mapq !== b.mapq
    )
      return false;
    const ap = a.pair;
    const bp = b.pair;
    if (ap !== bp) {
      if (
        !ap ||
        !bp ||
        ap.paired !== bp.paired ||
        ap.properPair !== bp.properPair ||
        ap.readNumber !== bp.readNumber ||
        ap.mateUnmapped !== bp.mateUnmapped ||
        ap.mateReverse !== bp.mateReverse ||
        ap.mateStart !== bp.mateStart ||
        ap.templateLength !== bp.templateLength
      )
        return false;
    }
    const am = a.mismatches;
    const bm = b.mismatches;
    if (am !== bm) {
      if (!am || !bm || am.length !== bm.length) return false;
      for (let mismatch = 0; mismatch < am.length; mismatch += 1) {
        const ae = am[mismatch]!;
        const be = bm[mismatch]!;
        if (
          ae.pos !== be.pos ||
          ae.kind !== be.kind ||
          ae.length !== be.length ||
          ae.refBase !== be.refBase ||
          ae.readBase !== be.readBase ||
          ae.baseQ !== be.baseQ
        )
          return false;
      }
    }
  }
  return true;
}

const readSubsetProofs = new WeakMap<
  ReadonlyArray<PileupRecord>,
  WeakMap<ReadonlyArray<PileupRecord>, boolean>
>();

function readRecordsContain(
  resident: ReadonlyArray<PileupRecord>,
  target: ReadonlyArray<PileupRecord>
): boolean {
  if (resident === target) return true;
  const cached = readSubsetProofs.get(resident)?.get(target);
  if (cached !== undefined) return cached;
  let contains = target.length <= resident.length;
  if (contains) {
    const counts = new Map<PileupRecord, number>();
    for (const record of resident) counts.set(record, (counts.get(record) ?? 0) + 1);
    for (const record of target) {
      const count = counts.get(record) ?? 0;
      if (count === 0) {
        contains = false;
        break;
      }
      if (count === 1) counts.delete(record);
      else counts.set(record, count - 1);
    }
  }
  let proofsForResident = readSubsetProofs.get(resident);
  if (!proofsForResident) {
    proofsForResident = new WeakMap();
    readSubsetProofs.set(resident, proofsForResident);
  }
  proofsForResident.set(target, contains);
  return contains;
}

export class PixiPileupTrackRenderer implements PixiLinearTrackRenderer<PileupTrackData> {
  readonly type: string;
  private readonly rowHeightPx: number;
  private readonly maxRows: number;
  private readonly overflowBandHeightPx: number;
  private readonly readColor: number;
  private readonly coverageScale: 'linear' | 'log';
  private collapsed: boolean;
  private containerState = new WeakMap<Container, ContainerState>();
  private lastRowsMeshBuildRecordsThisFrame = 0;
  private rowsMeshBuildChunkCount = 0;
  private lastRowsAssignmentBuildRecordsThisFrame = 0;
  private rowsAssignmentBuildChunkCount = 0;
  private lastRowsRetainBuildRecordsThisFrame = 0;
  private rowsRetainBuildChunkCount = 0;
  private rowsMeshBufferAllocCount = 0;
  private readonly readRowsBuildRecordsPerFrame: number;
  private readonly readRowsUrgentBuildRecordsPerFrame: number;
  private readonly readRowsAssignRecordsPerFrame: number;
  private readonly readRowsUrgentAssignRecordsPerFrame: number;
  private readonly readRowsAssignWorkBudgetMs: number;
  private readonly readRowsUrgentAssignWorkBudgetMs: number;
  private readonly readRowsRetainRecordsPerFrame: number;
  private coverageDepthScratch: Float32Array | null = null;
  private coverageGaussianScratch: Float32Array | null = null;
  private coverageQuantileScratch: Float32Array | null = null;
  private coverageSegmentScratch: Float32Array | null = null;
  private hybridExactMaskScratch: Uint8Array | null = null;
  private hybridOverflowCountScratch: Float32Array | null = null;

  constructor(options: PixiPileupTrackRendererOptions) {
    this.type = options.type;
    this.rowHeightPx = options.rowHeightPx ?? DEFAULT_ROW_HEIGHT_PX;
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    this.overflowBandHeightPx = options.overflowBandHeightPx ?? DEFAULT_OVERFLOW_BAND_HEIGHT_PX;
    this.readColor = options.readColor ?? DEFAULT_READ_COLOR;
    this.coverageScale = options.coverageScale ?? 'log';
    this.collapsed = options.collapsed ?? false;
    this.readRowsBuildRecordsPerFrame = Math.max(
      1,
      options.readRowsBuildRecordsPerFrame ?? READ_ROWS_BUILD_RECORDS_PER_FRAME
    );
    this.readRowsUrgentBuildRecordsPerFrame =
      options.readRowsBuildRecordsPerFrame == null
        ? Math.max(this.readRowsBuildRecordsPerFrame, READ_ROWS_URGENT_RECORDS_PER_FRAME)
        : this.readRowsBuildRecordsPerFrame;
    this.readRowsAssignRecordsPerFrame = Math.max(
      1,
      options.readRowsAssignRecordsPerFrame ?? READ_ROWS_ASSIGN_RECORDS_PER_FRAME
    );
    this.readRowsUrgentAssignRecordsPerFrame =
      options.readRowsAssignRecordsPerFrame == null
        ? Math.max(this.readRowsAssignRecordsPerFrame, READ_ROWS_URGENT_RECORDS_PER_FRAME)
        : this.readRowsAssignRecordsPerFrame;
    this.readRowsAssignWorkBudgetMs = Math.max(
      0.1,
      options.readRowsAssignWorkBudgetMs ?? READ_ROWS_ASSIGN_WORK_BUDGET_MS
    );
    this.readRowsUrgentAssignWorkBudgetMs =
      options.readRowsAssignWorkBudgetMs == null
        ? Math.max(this.readRowsAssignWorkBudgetMs, READ_ROWS_URGENT_ASSIGN_WORK_BUDGET_MS)
        : this.readRowsAssignWorkBudgetMs;
    this.readRowsRetainRecordsPerFrame = Math.max(
      1,
      options.readRowsRetainRecordsPerFrame ?? READ_ROWS_RETAIN_RECORDS_PER_FRAME
    );
  }

  prepareGpuPrograms(renderer: Renderer): void {
    prepareSharedPixiGpuPrograms(renderer as Parameters<typeof prepareSharedPixiGpuPrograms>[0], [
      CoverageGpuAtlasLayer.gpuProgram(),
      CoverageSignalInstancedLayer.gpuProgram(),
      PileupGlobalGuideLayer.gpuProgram(),
      PileupPendingIntervalLayer.gpuProgram(),
      PileupReadDifferenceLayer.gpuProgram(),
      pileupBarGlProgram(),
    ]);
  }

  hasPendingPaintWork(container: Container): boolean {
    const state = this.containerState.get(container);
    return Boolean(
      state?.rowsAssignmentBuildJob ||
      state?.rowsRetainBuildJob ||
      state?.rowsMeshBuildJob ||
      state?.experimentalHybridPhase === 'morph' ||
      state?.experimentalHybridHistogramLoadingMotion ||
      state?.pendingIntervalLayer.hasMotion()
    );
  }

  hitTestReadEvent(
    container: Container,
    args: {
      trackId: string;
      localX: number;
      localY: number;
      screenX: number;
      screenY: number;
      pathMapper: PathMapper;
      chromosomeGlobalStartBp: number | ((chrom: string) => number);
    }
  ): ReadHitPayload | null {
    const state = this.containerState.get(container);
    if (
      !state ||
      state.readSourceTruncated ||
      (state.readDisplayMode !== 'reads' && state.readDisplayMode !== 'blend') ||
      !state.rows ||
      !state.rows.mesh.visible ||
      !state.rowsMeshRecordsRef ||
      !state.rowsMeshRowsRef ||
      !state.rowsMeshReadHitIndex ||
      state.rowsMeshRowsRef.length !== state.rowsMeshRecordsRef.length ||
      args.pathMapper.pixelsPerBp <= 0
    ) {
      return null;
    }
    const readRowsTopPx = this.readRowsTopPx();
    const firstBody = pileupReadBodyVerticalGeometry(readRowsTopPx, state.effectiveRowHeightPx);
    if (args.localY < firstBody.topPx) return null;
    const row = Math.floor((args.localY - readRowsTopPx) / state.effectiveRowHeightPx);
    if (row < 0 || row >= state.effectiveMaxRows) return null;
    const bp = (args.localX - args.pathMapper.bpLeftX(0)) / args.pathMapper.pixelsPerBp;
    const recordIndex = state.rowsMeshReadHitIndex.hitRecordIndex(
      state.rowsMeshRecordsRef,
      row,
      bp
    );
    if (recordIndex === null) return null;
    const mark = state.readDifferenceLayer.hitTest({
      localX: args.localX,
      localY: args.localY,
      pathMapper: args.pathMapper,
    });
    const record = state.rowsMeshRecordsRef[recordIndex];
    if (!record) return null;
    return this.readHitPayload(
      state,
      record,
      row,
      args,
      mark?.recordIndex === recordIndex ? mark.event : undefined
    );
  }

  locateRead(
    container: Container,
    read: ReadHitPayload,
    args: {
      trackId: string;
      pathMapper: PathMapper;
      containerTopPx: number;
      chromosomeGlobalStartBp: number | ((chrom: string) => number);
    }
  ): ReadHitPayload | null {
    const state = this.containerState.get(container);
    if (
      !state?.rows ||
      !state.rows.mesh.visible ||
      state.readSourceTruncated ||
      (state.readDisplayMode !== 'reads' && state.readDisplayMode !== 'blend') ||
      state.rowsMeshSourceGenerationKey !== read.sourceGenerationKey ||
      this.readHitPresentationOwnerKey(state) !==
        (read.presentationOwnerKey ?? read.sourceGenerationKey) ||
      !state.rowsMeshRecordsRef ||
      !state.rowsMeshRowsRef ||
      !state.rowsMeshReadHitIndex
    ) {
      return null;
    }
    const recordIndex = state.rowsMeshReadHitIndex.recordIndexFor(read);
    if (recordIndex === null) return null;
    const record = state.rowsMeshRecordsRef[recordIndex];
    const row = state.rowsMeshRowsRef[recordIndex];
    if (!record || row === undefined || row < 0) return null;
    const bodyRect = this.readBodyRect(record, row, state, args.pathMapper, args.containerTopPx);
    return this.readHitPayload(state, record, row, {
      ...args,
      localX: bodyRect.left + bodyRect.width / 2,
      localY: bodyRect.top + bodyRect.height / 2 - args.containerTopPx,
      screenX: bodyRect.left + bodyRect.width / 2,
      screenY: bodyRect.top + bodyRect.height / 2,
    });
  }

  private readHitPresentationOwnerKey(state: ContainerState): string {
    return state.readPresentationOwnerKey === state.readSourceGenerationKey
      ? state.rowsMeshSourceGenerationKey
      : state.readPresentationOwnerKey;
  }

  private readHitPayload(
    state: ContainerState,
    record: PileupRecord,
    row: number,
    args: {
      trackId: string;
      localX: number;
      localY: number;
      screenX: number;
      screenY: number;
      pathMapper: PathMapper;
      chromosomeGlobalStartBp: number | ((chrom: string) => number);
    },
    event?: NonNullable<ReadHitPayload['event']>
  ): ReadHitPayload {
    const presentationOwnerKey = this.readHitPresentationOwnerKey(state);
    const chromosomeGlobalStartBp =
      typeof args.chromosomeGlobalStartBp === 'function'
        ? args.chromosomeGlobalStartBp(record.chrom)
        : args.chromosomeGlobalStartBp;
    const containerTopPx = args.screenY - args.localY;
    const bodyRect = this.readBodyRect(record, row, state, args.pathMapper, containerTopPx);
    const blockReferenceStart = record.start - chromosomeGlobalStartBp;
    const alignmentReferenceStart =
      (record.alignmentStart ?? record.start) - chromosomeGlobalStartBp;
    return {
      trackId: args.trackId,
      sourceGenerationKey: state.rowsMeshSourceGenerationKey,
      ...(presentationOwnerKey === state.rowsMeshSourceGenerationKey
        ? {}
        : { presentationOwnerKey }),
      readId: record.readId,
      chrom: record.chrom,
      referenceStart: alignmentReferenceStart,
      ...(blockReferenceStart === alignmentReferenceStart
        ? {}
        : { referenceBlockStart: blockReferenceStart }),
      start: record.start,
      end: record.end,
      flag: record.flag,
      strand: record.strand,
      mapq: record.mapq,
      pair: record.pair,
      ...(event ? { event } : {}),
      bodyRect,
      hitRect: {
        left: bodyRect.left,
        top: containerTopPx + this.readRowsTopPx() + row * state.effectiveRowHeightPx,
        width: bodyRect.width,
        height: state.effectiveRowHeightPx,
      },
      screenX: args.screenX,
      screenY: args.screenY,
    };
  }

  private readBodyRect(
    record: PileupRecord,
    row: number,
    state: ContainerState,
    pathMapper: PathMapper,
    containerTopPx: number
  ): ReadHitPayload['bodyRect'] {
    const rowHeight = state.effectiveRowHeightPx;
    const left = pathMapper.bpLeftX(record.start);
    const right = pathMapper.bpLeftX(record.end);
    const body = pileupReadBodyVerticalGeometry(this.readRowsTopPx() + row * rowHeight, rowHeight);
    return {
      left,
      top: containerTopPx + body.topPx,
      width: Math.max(0, right - left),
      height: body.heightPx,
    };
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  mount(args: TrackMountArgs): Container {
    const container = new Container();
    container.eventMode = 'none';
    const histogramGuideLayer = new PileupGlobalGuideLayer('pileup-histogram-alternate-guides');
    container.addChild(histogramGuideLayer.container);
    const pendingIntervalLayer = new PileupPendingIntervalLayer(container);
    this.containerState.set(container, {
      container,
      rows: null,
      rowsMeshStartBp: 0,
      rowsMeshEndBp: 0,
      rowsMeshRecordCount: 0,
      rowsMeshColorKey: '',
      rowsMeshRecordsKey: '',
      rowsMeshRecordsRef: null,
      rowsMeshRowsRef: null,
      rowsMeshReadHitIndex: null,
      rowsMeshSourceGenerationKey: '',
      rowsMeshHiddenReadCount: 0,
      rowsMeshCollapsedPileupField: null,
      rowsMeshBuildJob: null,
      rowsAssignmentBuildJob: null,
      rowsAssignmentBuildChunkCount: 0,
      rowsAssignmentBuildRecordsLastFrame: 0,
      rowsRetainBuildJob: null,
      rowsRetainBuildChunkCount: 0,
      rowsRetainBuildRecordsLastFrame: 0,
      rowsMeshBufferCapacity: 0,
      rowsVerticesPool: createAnnotationRecordVerticesPool(),
      rowsBack: {
        mesh: null,
        pool: createAnnotationRecordVerticesPool(),
        bufferCapacity: 0,
        meshStartBp: 0,
        meshEndBp: 0,
        recordCount: 0,
        colorKey: '',
      },
      themeMode: args.theme.mode,
      pairedReadColor: pileupPairedReadColorForTheme(this.readColor, args.theme.mode),
      forwardReadColor: pileupReadDisplayColor(
        { chrom: '', start: 0, end: 1, readId: 'diagnostic-forward', strand: '+', mapq: 0 },
        this.readColor,
        args.theme.mode
      ),
      reverseReadColor: pileupReadDisplayColor(
        { chrom: '', start: 0, end: 1, readId: 'diagnostic-reverse', strand: '-', mapq: 0 },
        this.readColor,
        args.theme.mode
      ),
      cachedCoverageRef: null,
      cachedCoverageRevision: null,
      cachedCoverageDataAuthority: null,
      cachedRecordsRef: null,
      cachedRecordsKey: '',
      cachedRecordsSampleKey: '',
      recordsSemanticVersion: 0,
      cachedRecordsExactDerived: false,
      layout: new PersistentRowLayout(),
      lastRowAssignment: null,
      lastRecordsCommitTiming: null,
      coverageSignal: null,
      coverageGpuAtlasLayer: new CoverageGpuAtlasLayer(container),
      coverageSignalInstancedLayer: new CoverageSignalInstancedLayer(container),
      histogramGuideLayer,
      pendingIntervalLayer,
      experimentalHybridPhase: 'inactive',
      experimentalHybridStartedAtMs: null,
      experimentalHybridMorphProgress: 0,
      experimentalHybridGenerationKey: '',
      experimentalHybridExactFrontAvailable: false,
      experimentalHybridSpatialContinuityFallback: false,
      experimentalHybridDensityExclusionStartBp: null,
      experimentalHybridDensityExclusionEndBp: null,
      experimentalHybridSourceGenerationKey: '',
      experimentalHybridCompletedIntervals: [],
      experimentalHybridHistogramLoadingMotion: false,
      experimentalHybridHistogramLoadingStartedAtMs: null,
      experimentalHybridHistogramLoadingPhase: 0,
      experimentalHybridHistogramLoadingAnimation: DEFAULT_HISTOGRAM_LOADING_ANIMATION,
      readDifferenceLayer: new PileupReadDifferenceLayer(container),
      coverageStartBp: 0,
      coverageMaxDepth: 0,
      coverageSignalNonzeroBinCount: 0,
      coverageLodRole: null,
      coverageLodLevel: null,
      coverageLodTargetLevel: null,
      coverageLodBinSize: null,
      coverageLodAuthority: null,
      coverageLodProvenanceExact: null,
      coverageLodProvenanceMethod: null,
      coverageLodProvenanceSource: null,
      coverageLodSourceLevel: null,
      coverageLodSourceBinSize: null,
      coverageLodResidentLevel: null,
      coverageLodResidentBinSize: null,
      coverageLodCurrentCoveredFraction: null,
      coverageSampledColumnCount: 0,
      coverageSampledNonzeroColumnCount: 0,
      coverageSampledMaxDepth: 0,
      coverageSamplePassCount: 0,
      coverageGeometryBuildCount: 0,
      coverageBufferUploadCount: 0,
      lastViewportStartBp: 0,
      lastViewportEndBp: 0,
      activeCoverageBinSize: 0,
      densityRows: null,
      densityRowsArrays: null,
      cachedDensityRowsKey: '',
      overflowRows: null,
      overflowRowsArrays: null,
      cachedOverflowRowsKey: '',
      overflowRowsRecordsKey: '',
      overflowGeometryBuildCount: 0,
      effectiveMaxRows: this.maxRows,
      effectiveRowHeightPx: this.rowHeightPx,
      rowCount: 0,
      hiddenReadCount: 0,
      recordCount: 0,
      forwardReadCount: 0,
      reverseReadCount: 0,
      pairedReadCount: 0,
      densityRowBinCount: 0,
      loadedStartBp: 0,
      loadedEndBp: 0,
      readSourceTruncated: false,
      readSourceWindowStartBp: null,
      readSourceWindowEndBp: null,
      readSourceGenerationKey: '',
      readPresentationOwnerKey: '',
      readOccupancy: null,
      cachedReadRows: null,
      cachedReadHitIndex: null,
      readRowHeightField: null,
      collapsedPileupField: null,
      visibleReadColumnCoverage: null,
      lastPaintTiming: null,
      readDensityColumnCoverage: 0,
      readDensityMeanFill: 0,
      readDensityMaxFill: 0,
      readDensityRowStackMeanFill: 0,
      readDensityRowStackMaxFill: 0,
      readDensityMorph: 0,
      readDensityFillStdDev: 0,
      readDensitySourceDepthMean: 0,
      readDensitySourceDepthStdDev: 0,
      readDensitySourceDepthCv: 0,
      readDensitySourceDepthP10: 0,
      readDensitySourceDepthP50: 0,
      readDensitySourceDepthP90: 0,
      readDensitySourceDepthP99: 0,
      readDensitySourceDepthEdgeCount: 0,
      readDensitySourceDepthLongestFlatRunColumns: 0,
      readDensityDrawnFillStdDev: 0,
      readDensityDrawnEdgeCount: 0,
      readDensityDrawnLongestFlatRunColumns: 0,
      readDensityClippedColumnFraction: 0,
      collapsedPileupFieldBinCount: 0,
      collapsedPileupMaxVisibleRows: 0,
      collapsedPileupMaxHiddenCount: 0,
      overflowRowBinCount: 0,
      overflowColumnCoverage: 0,
      overflowMeanFill: 0,
      overflowMaxFill: 0,
      overflowMaxHiddenReads: 0,
      overflowMorph: 0,
      overflowBaseMinPx: 0,
      overflowBaseMaxPx: 0,
      overflowBandTopPx: 0,
      overflowBandHeightPx: 0,
      readRowsAlpha: 0,
      readDensityAlpha: 0,
      overflowRowsAlpha: 0,
      renderedReadRowsAlpha: 0,
      renderedReadDensityAlpha: 0,
      renderedOverflowRowsAlpha: 0,
      readDisplayMode: 'empty',
      readAggregateSource: 'none',
      aggregateDepthSource: 'none',
      readSourceWindowCoversViewport: false,
      readSourceWindowCoverageFraction: 0,
      rowsMeshViewportCoverageFraction: 0,
      recordExtentCoversViewport: false,
      debugVisibleReadSamples: null,
    });
    return container;
  }

  paint(args: TrackPaintArgs<PileupTrackData>): void {
    const state = this.containerState.get(args.container);
    if (!state) return;
    const paintStartedAt = nowMs();
    const data = args.data;
    this.lastRowsAssignmentBuildRecordsThisFrame = 0;
    this.lastRowsRetainBuildRecordsThisFrame = 0;
    this.lastRowsMeshBuildRecordsThisFrame = 0;
    state.lastViewportStartBp = args.viewportBpRange.start;
    state.lastViewportEndBp = args.viewportBpRange.end;
    const tileEngineAuthority = data?.dataAuthority === 'tile-engine';
    const probe = pileupProbeOptions();
    const themeMode = args.theme.mode;
    const readColor = presentationReadColorForTheme(
      args.presentation?.color,
      this.readColor,
      themeMode
    );
    const themedReadColor = pileupPairedReadColorForTheme(readColor, themeMode);
    this.applyPileupThemeColors(state, themeMode, readColor, themedReadColor);

    const coverage = this.admitCoverageSignal(state, data, tileEngineAuthority);
    const coverageStartedAt = nowMs();
    this.commitCoverageSignal(state, data, coverage);
    const coverageMs = nowMs() - coverageStartedAt;

    const rowBudget = this.applyReadRowBudget(state, args);
    const zoomReadAlpha = !this.collapsed
      ? pileupExactReadZoomAlpha(args.pathMapper.pixelsPerBp)
      : 0;

    const exactReadCommit = this.prepareExactReadCommit(
      state,
      args,
      data,
      coverage,
      tileEngineAuthority
    );
    const recordsStartedAt = nowMs();
    let deferReadRowsMeshWork = this.commitExactReadRecords(state, exactReadCommit, rowBudget);
    if (deferReadRowsMeshWork && state.rows !== null) {
      const runwayBp = (state.rowsMeshEndBp - state.rowsMeshStartBp) / 8;
      deferReadRowsMeshWork =
        args.viewportBpRange.start - state.rowsMeshStartBp >= runwayBp &&
        state.rowsMeshEndBp - args.viewportBpRange.end >= runwayBp;
    }
    const recordsMs = nowMs() - recordsStartedAt;

    const retainStartedAt = nowMs();
    this.advanceReadRowsRetain(state);
    const retainMs = nowMs() - retainStartedAt;

    const readRowsMeshStartedAt = nowMs();
    this.paintExactReadRowsMesh(
      state,
      args,
      exactReadCommit.records,
      exactReadCommit.recordsKey,
      rowBudget.readRowsTopPx,
      themedReadColor,
      deferReadRowsMeshWork
    );
    const readRowsMeshMs = nowMs() - readRowsMeshStartedAt;
    this.applyExactReadRowsCameraAndSamples(state, args, rowBudget, themeMode);

    const lod = this.resolveReadLodPresentation(
      state,
      args,
      tileEngineAuthority,
      zoomReadAlpha,
      rowBudget
    );
    const experimentalHybrid = this.prepareExperimentalHybridPresentation(
      state,
      args,
      data,
      paintStartedAt,
      themedReadColor
    );

    const densityStartedAt = nowMs();
    const densityPaint = this.paintDensityAggregate(
      state,
      args,
      data,
      tileEngineAuthority,
      probe,
      themedReadColor,
      rowBudget,
      lod,
      experimentalHybrid
    );
    const densityMs = nowMs() - densityStartedAt;

    const overflowStartedAt = nowMs();
    this.paintOverflowRows(
      state,
      args,
      state.overflowBandHeightPx,
      0,
      themedReadColor,
      experimentalHybrid
    );
    const overflowMs = nowMs() - overflowStartedAt;

    this.applyRenderedLayerPresentation(
      state,
      args,
      data,
      probe,
      rowBudget,
      lod,
      densityPaint,
      experimentalHybrid
    );
    const histogramLoadingMotion = this.applyExperimentalHybridHistogramLoadingMotion(
      state,
      args,
      data,
      paintStartedAt
    );
    const readLoadingTreatmentEligible = pileupExactReadLoadingEligible(
      args.pathMapper.pixelsPerBp
    );
    const signalPending = data?.experimentalReadHandoff !== undefined;
    const loadedRanges: Array<{ startBp: number; endBp: number }> = [];
    if (state.coverageSignal) {
      const coverageStartBp = state.coverageSignal.startBp ?? 0;
      loadedRanges.push({
        startBp: coverageStartBp,
        endBp: coverageStartBp + state.coverageSignal.bins.length * state.coverageSignal.binSize,
      });
    }
    if (
      state.rows?.mesh.visible &&
      state.renderedReadRowsAlpha > READ_LOD_MESH_VISIBLE_ALPHA_EPSILON
    ) {
      loadedRanges.push({ startBp: state.rowsMeshStartBp, endBp: state.rowsMeshEndBp });
    }
    const pendingIntervals = signalPending
      ? uncoveredPendingReferenceIntervals(
          data.experimentalReadHandoff?.histogramPendingIntervals ?? [],
          loadedRanges
        )
      : (data?.referenceIntervals ?? []);
    state.pendingIntervalLayer.paint({
      intervals: pendingIntervals,
      pathMapper: args.pathMapper,
      viewportWidthPx: args.viewportWidthPx,
      viewportHeightPx: args.viewportHeightPx,
      bandTopPx: signalPending
        ? args.containerTopPx + 6
        : args.containerTopPx +
          Math.max(0, args.layoutEntry.height - PENDING_INTERVAL_BAND_HEIGHT_PX),
      bandHeightPx: signalPending ? PENDING_SIGNAL_RAIL_HEIGHT_PX : PENDING_INTERVAL_BAND_HEIGHT_PX,
      appearance: signalPending ? 'signal-pending' : 'read-pending',
      theme: args.theme,
      nowMs: paintStartedAt,
      visible: signalPending || (readLoadingTreatmentEligible && !histogramLoadingMotion),
    });

    state.lastPaintTiming = {
      totalMs: nowMs() - paintStartedAt,
      coverageMs,
      recordsMs,
      retainMs,
      readRowsMeshMs,
      densityMs,
      overflowMs,
    };
  }

  private applyPileupThemeColors(
    state: ContainerState,
    themeMode: WebGLThemeMode,
    readColor: number,
    themedReadColor: number
  ): void {
    state.themeMode = themeMode;
    state.pairedReadColor = themedReadColor;
    state.forwardReadColor = pileupReadDisplayColor(
      { chrom: '', start: 0, end: 1, readId: 'diagnostic-forward', strand: '+', mapq: 0 },
      readColor,
      themeMode
    );
    state.reverseReadColor = pileupReadDisplayColor(
      { chrom: '', start: 0, end: 1, readId: 'diagnostic-reverse', strand: '-', mapq: 0 },
      readColor,
      themeMode
    );
  }

  private admitCoverageSignal(
    state: ContainerState,
    data: PileupTrackData | null,
    tileEngineAuthority: boolean
  ): PileupTrackData['coverage'] | null {
    const rawCoverage = data?.coverage ?? null;
    state.coverageGpuAtlasLayer.syncAtlas(data?.coverageGpuAtlas);
    const rawCoverageLod = data?.coverageLod ?? null;
    const tileEngineCoveragePresentable =
      !tileEngineAuthority || isPresentableTileEngineCoverageSignal(rawCoverage, rawCoverageLod);
    const retainLastExactCoverage = shouldRetainLastExactCoverage(
      tileEngineAuthority,
      tileEngineCoveragePresentable,
      rawCoverage,
      state.cachedCoverageDataAuthority,
      state.coverageSignal,
      state.coverageLodProvenanceExact
    );
    const coverage = retainLastExactCoverage
      ? state.coverageSignal
      : tileEngineCoveragePresentable
        ? rawCoverage
        : null;
    const coverageLod = coverage ? rawCoverageLod : null;
    if (!retainLastExactCoverage) {
      this.copyCoverageLodMetadata(state, coverageLod);
    }
    return coverage;
  }

  private copyCoverageLodMetadata(
    state: ContainerState,
    coverageLod: PileupTrackData['coverageLod'] | null
  ): void {
    state.coverageLodRole = coverageLod?.role ?? null;
    state.coverageLodLevel = coverageLod?.level ?? null;
    state.coverageLodTargetLevel = coverageLod?.targetLevel ?? null;
    state.coverageLodBinSize = coverageLod?.binSize ?? null;
    state.coverageLodAuthority = coverageLod?.authority ?? null;
    state.coverageLodProvenanceExact = coverageLod?.provenanceExact ?? null;
    state.coverageLodProvenanceMethod = coverageLod?.provenanceMethod ?? null;
    state.coverageLodProvenanceSource = coverageLod?.provenanceSource ?? null;
    state.coverageLodSourceLevel = coverageLod?.sourceLevel ?? null;
    state.coverageLodSourceBinSize = coverageLod?.sourceBinSize ?? null;
    state.coverageLodResidentLevel = coverageLod?.residentLevel ?? null;
    state.coverageLodResidentBinSize = coverageLod?.residentBinSize ?? null;
    state.coverageLodCurrentCoveredFraction = coverageLod?.currentCoveredFraction ?? null;
  }

  private commitCoverageSignal(
    state: ContainerState,
    data: PileupTrackData | null,
    coverage: PileupTrackData['coverage'] | null
  ): void {
    const coverageRevision = coverage?.coverageRevision ?? null;
    const coverageChanged =
      (coverageRevision !== null
        ? coverageRevision !== state.cachedCoverageRevision
        : coverage !== state.cachedCoverageRef) ||
      data?.dataAuthority !== state.cachedCoverageDataAuthority;
    if (!coverageChanged) return;
    if (coverage && coverage.bins.length > 0) {
      state.coverageSignal = coverage;
      state.coverageStartBp = coverage.startBp ?? 0;
      state.coverageMaxDepth = coverage.maxDepth;
      state.coverageSignalNonzeroBinCount = countPositiveBins(coverage.bins);
    } else {
      this.disposeDensityRows(state);
      state.coverageSignal = null;
      state.coverageStartBp = 0;
      state.coverageMaxDepth = 0;
      state.coverageSignalNonzeroBinCount = 0;
      state.activeCoverageBinSize = 0;
      this.resetDensityStats(state);
    }
    state.cachedDensityRowsKey = '';
    state.cachedCoverageRef = coverage;
    state.cachedCoverageRevision = coverageRevision;
    state.cachedCoverageDataAuthority = data?.dataAuthority ?? null;
  }

  private applyReadRowBudget(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>
  ): ReadRowBudget {
    const readRowsTopPx = this.readRowsTopPx();
    const trackContentHeightPx = Math.max(
      0,
      args.layoutEntry.height - readRowsTopPx - PENDING_INTERVAL_BAND_HEIGHT_PX
    );
    const overflowBandHeightPx = Math.max(
      0,
      Math.min(this.overflowBandHeightPx, trackContentHeightPx)
    );
    const availableReadRowsHeightPx = Math.max(0, trackContentHeightPx - overflowBandHeightPx);
    const effectiveRowHeightPx = this.rowHeightPx;
    const effectiveMaxRows = Math.max(
      0,
      Math.min(
        this.maxRows,
        Math.floor(availableReadRowsHeightPx / Math.max(1, effectiveRowHeightPx))
      )
    );
    const effectiveReadRowsHeightPx = effectiveMaxRows * effectiveRowHeightPx;
    const rowBudgetChanged =
      effectiveMaxRows !== state.effectiveMaxRows ||
      effectiveRowHeightPx !== state.effectiveRowHeightPx;
    if (rowBudgetChanged) {
      state.layout.reset();
      state.rowsAssignmentBuildJob = null;
      state.rowsAssignmentBuildRecordsLastFrame = 0;
      state.rowsRetainBuildJob = null;
      state.rowsRetainBuildRecordsLastFrame = 0;
      state.lastRowAssignment = null;
      state.cachedReadRows = null;
      state.cachedReadHitIndex = null;
      state.readRowHeightField = null;
      state.collapsedPileupField = null;
      this.resetCollapsedPileupStats(state);
      this.disposeBar(state, 'rows');
      state.cachedDensityRowsKey = '';
      state.cachedOverflowRowsKey = '';
    }
    state.effectiveMaxRows = effectiveMaxRows;
    state.effectiveRowHeightPx = effectiveRowHeightPx;
    state.overflowBandTopPx = readRowsTopPx + effectiveReadRowsHeightPx;
    state.overflowBandHeightPx =
      overflowBandHeightPx > 0 && effectiveMaxRows > 0 ? overflowBandHeightPx : 0;
    return {
      readRowsTopPx,
      effectiveRowHeightPx,
      effectiveMaxRows,
      effectiveReadRowsHeightPx,
      rowBudgetChanged,
    };
  }

  private prepareExactReadCommit(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    data: PileupTrackData | null,
    coverage: PileupTrackData['coverage'] | null,
    tileEngineAuthority: boolean
  ): ExactReadCommitInput {
    const records = data?.records ?? null;
    const readSourceTruncated = data?.readSource?.truncated === true;
    const sourceWindowStartBp = data?.readSource?.windowStartBp ?? null;
    const sourceWindowEndBp = data?.readSource?.windowEndBp ?? null;
    const sourceGenerationKey = data?.readSource?.sourceGenerationKey ?? '';
    const presentationOwnerKey = data?.readSource?.presentationOwnerKey ?? sourceGenerationKey;
    if (
      (tileEngineAuthority || data?.readSource?.presentationOwnerKey !== undefined) &&
      (presentationOwnerKey !== state.readPresentationOwnerKey ||
        sourceGenerationKey !== state.readSourceGenerationKey ||
        ((state.rows !== null || state.rowsMeshRecordsRef !== null) &&
          sourceGenerationKey !== state.rowsMeshSourceGenerationKey))
    ) {
      this.clearExactReadRecords(state);
      state.layout.reset();
      state.cachedRecordsExactDerived = false;
      this.disposeDensityRows(state);
      this.disposeOverflowRows(state);
    }
    state.readPresentationOwnerKey = presentationOwnerKey;
    const recordsSampleKey = pileupRecordsKey(
      records,
      sourceWindowStartBp,
      sourceWindowEndBp,
      readSourceTruncated,
      presentationOwnerKey
    );
    const recordsKey =
      recordsSampleKey === state.cachedRecordsSampleKey &&
      readRecordsEqual(records, state.cachedRecordsRef)
        ? state.cachedRecordsKey
        : `${recordsSampleKey}|semantic-${state.recordsSemanticVersion + 1}`;
    const tileEngineCoverageOwnsDensity =
      tileEngineAuthority && coverage != null && coverage.bins.length > 0;
    const exactRowsMayRender =
      !this.collapsed &&
      !readSourceTruncated &&
      pileupExactReadPreparationEligible(args.pathMapper.pixelsPerBp);
    const experimentalHybridHeightMorph =
      data?.experimentalReadHandoff?.kind === 'bigwig-height-morph-to-reads';
    const needsExactCollapsedAggregate =
      experimentalHybridHeightMorph ||
      (!tileEngineAuthority && (!coverage || coverage.bins.length === 0));
    const exactDebugProbeNeeded =
      exactRowsMayRender &&
      (((globalThis as { __dna119MeasurePileupCoverage?: boolean }).__dna119MeasurePileupCoverage ??
        false) ||
        ((globalThis as { __dna119ExposePileupRows?: boolean }).__dna119ExposePileupRows ?? false));
    const shouldBuildExactDerivedRecords =
      records !== null &&
      records.length > 0 &&
      !readSourceTruncated &&
      (exactRowsMayRender || needsExactCollapsedAggregate || exactDebugProbeNeeded);
    if (!shouldBuildExactDerivedRecords) {
      this.retireExactReadDetailPreparation(state);
    }
    const pendingInput = state.rowsAssignmentBuildJob?.input;
    if (
      shouldBuildExactDerivedRecords &&
      tileEngineAuthority &&
      pendingInput?.tileEngineAuthority &&
      pendingInput.sourceGenerationKey === sourceGenerationKey &&
      pendingInput.exactRowsMayRender === exactRowsMayRender &&
      pendingInput.experimentalHybridHeightMorph === experimentalHybridHeightMorph &&
      pendingInput.needsExactCollapsedAggregate === needsExactCollapsedAggregate &&
      pendingInput.sourceWindowStartBp !== null &&
      pendingInput.sourceWindowEndBp !== null &&
      (pendingInput.sourceWindowStartBp !== sourceWindowStartBp ||
        pendingInput.sourceWindowEndBp !== sourceWindowEndBp) &&
      viewportCoverageFraction(
        pendingInput.sourceWindowStartBp,
        pendingInput.sourceWindowEndBp,
        args.viewportBpRange.start,
        args.viewportBpRange.end
      ) >= 0.999
    ) {
      return {
        ...pendingInput,
        tileEngineCoverageOwnsDensity,
        urgentReadRowsWork:
          state.rows === null ||
          readRowsHandoffNeedsUrgentWork(
            state.rowsMeshStartBp,
            state.rowsMeshEndBp,
            pendingInput.sourceWindowStartBp,
            pendingInput.sourceWindowEndBp,
            args.viewportBpRange.start,
            args.viewportBpRange.end
          ),
      };
    }
    const urgentReadRowsWork =
      state.rows === null ||
      readRowsHandoffNeedsUrgentWork(
        state.rowsMeshStartBp,
        state.rowsMeshEndBp,
        sourceWindowStartBp,
        sourceWindowEndBp,
        args.viewportBpRange.start,
        args.viewportBpRange.end
      );
    return {
      records,
      recordsKey,
      recordsSampleKey,
      readSourceTruncated,
      sourceWindowStartBp,
      sourceWindowEndBp,
      sourceGenerationKey,
      exactRowsMayRender,
      experimentalHybridHeightMorph,
      needsExactCollapsedAggregate,
      shouldBuildExactDerivedRecords,
      tileEngineCoverageOwnsDensity,
      urgentReadRowsWork,
      tileEngineAuthority,
    };
  }

  private commitExactReadRecords(
    state: ContainerState,
    input: ExactReadCommitInput,
    rowBudget: ReadRowBudget
  ): boolean {
    const {
      records,
      recordsKey,
      recordsSampleKey,
      readSourceTruncated,
      sourceWindowStartBp,
      sourceWindowEndBp,
      sourceGenerationKey,
      shouldBuildExactDerivedRecords,
      tileEngineCoverageOwnsDensity,
    } = input;
    const { rowBudgetChanged } = rowBudget;
    if (
      recordsKey === state.cachedRecordsKey &&
      !rowBudgetChanged &&
      !(shouldBuildExactDerivedRecords && !state.cachedRecordsExactDerived) &&
      state.rowsAssignmentBuildJob === null
    ) {
      return false;
    }
    const commitStartedAt = nowMs();
    const work = emptyRecordsCommitWork();
    const previousWindowStart = state.readSourceWindowStartBp;
    const previousWindowEnd = state.readSourceWindowEndBp;
    state.recordCount = records?.length ?? 0;
    state.readSourceTruncated = readSourceTruncated;
    state.readSourceWindowStartBp = sourceWindowStartBp;
    state.readSourceWindowEndBp = sourceWindowEndBp;
    state.readSourceGenerationKey = sourceGenerationKey;
    state.forwardReadCount = 0;
    state.reverseReadCount = 0;
    state.pairedReadCount = 0;
    if (records && records.length > 0 && shouldBuildExactDerivedRecords) {
      this.buildExactReadDerivedRecords(
        state,
        records,
        input,
        rowBudget,
        previousWindowStart,
        previousWindowEnd,
        work
      );
    } else if (records && records.length > 0) {
      this.commitMetadataOnlyReadRecords(state, input, work);
    } else {
      this.clearExactReadRecords(state);
      if (
        records !== null &&
        input.experimentalHybridHeightMorph &&
        sourceWindowStartBp !== null &&
        sourceWindowEndBp !== null &&
        sourceWindowEndBp > sourceWindowStartBp
      ) {
        this.commitEmptyHybridReadFront(state, input, rowBudget, records);
        work.exactDerivedBuilt = true;
      }
    }
    state.lastRecordsCommitTiming = {
      recordCount: records?.length ?? 0,
      totalMs: nowMs() - commitStartedAt,
      assignMs: work.assignMs,
      assignRecordsProcessed: work.assignRecordsProcessed,
      assignmentPending: work.assignmentPending,
      finishAssignmentMs: work.finishAssignmentMs,
      beginRetainMs: work.beginRetainMs,
      extentMs: work.extentMs,
      occupancyMs: work.occupancyMs,
      rowHeightFieldMs: work.rowHeightFieldMs,
      collapsedFieldMs: work.collapsedFieldMs,
      rowAssignmentMapMs: work.rowAssignmentMapMs,
      retainScheduled: work.retainScheduled,
      exactDerivedBuilt: work.exactDerivedBuilt,
      metadataOnly: work.metadataOnly,
    };
    state.cachedRecordsRef = records;
    if (recordsKey !== state.cachedRecordsKey) state.recordsSemanticVersion += 1;
    state.cachedRecordsKey = recordsKey;
    state.cachedRecordsSampleKey = recordsSampleKey;
    state.cachedRecordsExactDerived = work.exactDerivedBuilt;
    if (work.exactDerivedBuilt || !records || !tileEngineCoverageOwnsDensity) {
      state.cachedDensityRowsKey = '';
    }
    if (!records) {
      state.cachedOverflowRowsKey = '';
    }
    return (
      work.exactDerivedBuilt &&
      input.tileEngineAuthority &&
      (records?.length ?? 0) > this.readRowsAssignRecordsPerFrame
    );
  }

  private commitEmptyHybridReadFront(
    state: ContainerState,
    input: ExactReadCommitInput,
    rowBudget: ReadRowBudget,
    records: ReadonlyArray<PileupRecord>
  ): void {
    const startBp = input.sourceWindowStartBp!;
    const endBp = input.sourceWindowEndBp!;
    const field = buildEmptyCollapsedPileupField(startBp, endBp, {
      targetBinBp: 1,
      maxBins: COLLAPSED_FIELD_MAX_BINS,
    });
    if (!field) return;

    state.loadedStartBp = startBp;
    state.loadedEndBp = endBp;
    state.collapsedPileupField = field;
    this.setCollapsedPileupStats(state, field);
    state.rowsMeshStartBp = startBp;
    state.rowsMeshEndBp = endBp;
    state.rowsMeshRecordCount = 0;
    state.rowsMeshColorKey = READ_ROWS_MESH_COLOR_KEY;
    state.rowsMeshRecordsKey = input.recordsKey;
    state.rowsMeshRecordsRef = records;
    state.rowsMeshRowsRef = new Int32Array(0);
    state.rowsMeshReadHitIndex = null;
    state.rowsMeshSourceGenerationKey = input.sourceGenerationKey;
    state.rowsMeshHiddenReadCount = 0;
    state.rowsMeshCollapsedPileupField = field;
    state.effectiveRowHeightPx = rowBudget.effectiveRowHeightPx;
    state.cachedOverflowRowsKey = '';
  }

  private buildExactReadDerivedRecords(
    state: ContainerState,
    records: ReadonlyArray<PileupRecord>,
    input: ExactReadCommitInput,
    rowBudget: ReadRowBudget,
    previousWindowStart: number | null,
    previousWindowEnd: number | null,
    work: RecordsCommitWork
  ): void {
    const {
      recordsKey,
      sourceWindowStartBp,
      sourceWindowEndBp,
      urgentReadRowsWork,
      tileEngineAuthority,
    } = input;
    const { effectiveMaxRows } = rowBudget;
    const nextWindowStart = sourceWindowStartBp;
    const nextWindowEnd = sourceWindowEndBp;
    const disjointReadWindow = isDisjointReadWindow(
      previousWindowStart,
      previousWindowEnd,
      nextWindowStart,
      nextWindowEnd
    );
    const activeAssignment = state.rowsAssignmentBuildJob;
    if (
      activeAssignment === null ||
      activeAssignment.recordsKey !== recordsKey ||
      !readRecordsEqual(activeAssignment.records, records) ||
      activeAssignment.maxRows !== effectiveMaxRows
    ) {
      state.rowsRetainBuildJob = null;
      state.rowsRetainBuildRecordsLastFrame = 0;
      if (disjointReadWindow) {
        state.cachedReadRows = null;
        state.cachedReadHitIndex = null;
        state.lastRowAssignment = null;
      }
      const workingLayout = disjointReadWindow
        ? new PersistentRowLayout()
        : state.layout.forkForAssignment();
      state.rowsAssignmentBuildJob = {
        input,
        records,
        recordsKey,
        maxRows: effectiveMaxRows,
        layout: workingLayout,
        job: workingLayout.beginAssignment(records, effectiveMaxRows, {
          coordinateOrdered: tileEngineAuthority,
        }),
      };
      state.cachedRecordsExactDerived = false;
    }
    const assignStartedAt = nowMs();
    const assignmentJob = state.rowsAssignmentBuildJob;
    work.assignRecordsProcessed = assignmentJob
      ? assignmentJob.layout.advanceAssignmentWithinBudget(
          assignmentJob.job,
          urgentReadRowsWork
            ? this.readRowsUrgentAssignRecordsPerFrame
            : this.readRowsAssignRecordsPerFrame,
          urgentReadRowsWork
            ? this.readRowsUrgentAssignWorkBudgetMs
            : this.readRowsAssignWorkBudgetMs
        )
      : 0;
    work.assignMs = nowMs() - assignStartedAt;
    this.lastRowsAssignmentBuildRecordsThisFrame = work.assignRecordsProcessed;
    state.rowsAssignmentBuildRecordsLastFrame = work.assignRecordsProcessed;
    if (work.assignRecordsProcessed > 0) {
      this.rowsAssignmentBuildChunkCount += 1;
      state.rowsAssignmentBuildChunkCount += 1;
    }
    work.assignmentPending = state.rowsAssignmentBuildJob?.job.complete !== true;
    if (work.assignmentPending) {
      if (
        sourceWindowStartBp !== null &&
        sourceWindowEndBp !== null &&
        sourceWindowEndBp > sourceWindowStartBp
      ) {
        state.loadedStartBp = sourceWindowStartBp;
        state.loadedEndBp = sourceWindowEndBp;
      } else if (!state.rows) {
        state.loadedStartBp = 0;
        state.loadedEndBp = 0;
      }
      if (!state.rows) {
        state.rowCount = 0;
        state.hiddenReadCount = 0;
      }
      state.readOccupancy = null;
      state.readRowHeightField = null;
      state.collapsedPileupField = null;
      this.resetCollapsedPileupStats(state);
      return;
    }
    this.finishExactReadDerivedAssignment(state, records, input, rowBudget, work);
  }

  private finishExactReadDerivedAssignment(
    state: ContainerState,
    records: ReadonlyArray<PileupRecord>,
    input: ExactReadCommitInput,
    rowBudget: ReadRowBudget,
    work: RecordsCommitWork
  ): void {
    const {
      recordsKey,
      sourceWindowStartBp,
      sourceWindowEndBp,
      exactRowsMayRender,
      experimentalHybridHeightMorph,
      needsExactCollapsedAggregate,
    } = input;
    const { effectiveMaxRows } = rowBudget;
    const finishedAssignmentJob = state.rowsAssignmentBuildJob;
    if (!finishedAssignmentJob) return;
    work.exactDerivedBuilt = true;
    const finishAssignmentStartedAt = nowMs();
    const assignment = finishedAssignmentJob.layout.finishAssignment(finishedAssignmentJob.job);
    work.finishAssignmentMs = nowMs() - finishAssignmentStartedAt;
    state.layout = finishedAssignmentJob.layout;
    const beginRetainStartedAt = nowMs();
    state.rowsRetainBuildJob = {
      recordsKey,
      job: state.layout.beginRetain(records),
    };
    work.beginRetainMs = nowMs() - beginRetainStartedAt;
    work.retainScheduled = true;
    state.rowsAssignmentBuildJob = null;
    state.cachedReadRows = assignment.rows;
    state.cachedReadHitIndex = assignment.readHitIndex;
    const { recordStats } = finishedAssignmentJob.job;
    const loadedLo = recordStats.startBp;
    const loadedHi = recordStats.endBp;
    state.reverseReadCount = recordStats.reverseReadCount;
    state.forwardReadCount = recordStats.forwardReadCount;
    state.pairedReadCount = recordStats.pairedReadCount;
    state.loadedStartBp = loadedLo;
    state.loadedEndBp = loadedHi;
    const occupancyStartedAt = nowMs();
    state.readOccupancy = (globalThis as { __dna119MeasurePileupCoverage?: boolean })
      .__dna119MeasurePileupCoverage
      ? buildReadOccupancy(records, loadedLo, loadedHi)
      : null;
    work.occupancyMs = nowMs() - occupancyStartedAt;
    if (exactRowsMayRender) {
      const rowHeightFieldStartedAt = nowMs();
      state.readRowHeightField = buildReadRowHeightField(
        records,
        assignment.rows,
        loadedLo,
        loadedHi
      );
      work.rowHeightFieldMs = nowMs() - rowHeightFieldStartedAt;
    } else {
      state.readRowHeightField = null;
    }
    if (needsExactCollapsedAggregate) {
      const exactFieldStart = sourceWindowStartBp ?? loadedLo;
      const exactFieldEnd = sourceWindowEndBp ?? loadedHi;
      const collapsedFieldStartedAt = nowMs();
      state.collapsedPileupField = buildCollapsedPileupFieldFromExact(
        records,
        assignment.rows,
        exactFieldStart,
        exactFieldEnd,
        effectiveMaxRows,
        {
          targetBinBp: experimentalHybridHeightMorph ? 1 : COLLAPSED_FIELD_TARGET_BIN_BP,
          maxBins: COLLAPSED_FIELD_MAX_BINS,
        }
      );
      work.collapsedFieldMs = nowMs() - collapsedFieldStartedAt;
    } else {
      state.collapsedPileupField = null;
    }
    this.setCollapsedPileupStats(state, state.collapsedPileupField);
    state.rowCount = assignment.rowCount;
    state.hiddenReadCount = assignment.hiddenReadCount;
    const rowAssignmentMapStartedAt = nowMs();
    state.lastRowAssignment = (globalThis as { __dna119ExposePileupRows?: boolean })
      .__dna119ExposePileupRows
      ? buildRowAssignmentMap(records, assignment.rows)
      : null;
    work.rowAssignmentMapMs = nowMs() - rowAssignmentMapStartedAt;
  }

  private commitMetadataOnlyReadRecords(
    state: ContainerState,
    input: ExactReadCommitInput,
    work: RecordsCommitWork
  ): void {
    const { sourceWindowStartBp, sourceWindowEndBp } = input;
    work.metadataOnly = true;
    state.rowsAssignmentBuildJob = null;
    state.rowsAssignmentBuildRecordsLastFrame = 0;
    state.rowsRetainBuildJob = null;
    state.rowsRetainBuildRecordsLastFrame = 0;
    state.rowCount = 0;
    state.hiddenReadCount = 0;
    if (
      sourceWindowStartBp !== null &&
      sourceWindowEndBp !== null &&
      sourceWindowEndBp > sourceWindowStartBp
    ) {
      state.loadedStartBp = sourceWindowStartBp;
      state.loadedEndBp = sourceWindowEndBp;
    } else {
      state.loadedStartBp = 0;
      state.loadedEndBp = 0;
    }
    state.readOccupancy = null;
    state.readRowHeightField = null;
    state.collapsedPileupField = null;
    this.resetCollapsedPileupStats(state);
    state.lastRowAssignment = null;
    state.cachedReadRows = null;
    state.cachedReadHitIndex = null;
  }

  private clearExactReadRecords(state: ContainerState): void {
    state.rowsAssignmentBuildJob = null;
    state.rowsAssignmentBuildRecordsLastFrame = 0;
    state.rowsRetainBuildJob = null;
    state.rowsRetainBuildRecordsLastFrame = 0;
    state.rowCount = 0;
    state.hiddenReadCount = 0;
    state.loadedStartBp = 0;
    state.loadedEndBp = 0;
    state.readOccupancy = null;
    state.readRowHeightField = null;
    state.collapsedPileupField = null;
    this.resetCollapsedPileupStats(state);
    this.disposeBar(state, 'rows');
    state.lastRowAssignment = null;
    state.cachedReadRows = null;
    state.cachedReadHitIndex = null;
  }

  private advanceReadRowsRetain(state: ContainerState): void {
    if (state.rowsRetainBuildJob === null) return;
    const retained = state.layout.advanceRetain(
      state.rowsRetainBuildJob.job,
      this.readRowsRetainRecordsPerFrame
    );
    this.lastRowsRetainBuildRecordsThisFrame = retained;
    state.rowsRetainBuildRecordsLastFrame = retained;
    if (retained > 0) {
      this.rowsRetainBuildChunkCount += 1;
      state.rowsRetainBuildChunkCount += 1;
    }
    if (state.rowsRetainBuildJob.job.complete) {
      state.rowsRetainBuildJob = null;
    }
  }

  private paintExactReadRowsMesh(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    records: ReadonlyArray<PileupRecord> | null,
    recordsKey: string,
    readRowsTopPx: number,
    themedReadColor: number,
    deferBuildWork: boolean
  ): void {
    const exactRowsReadyForCurrentRecords =
      records !== null &&
      records.length > 0 &&
      state.cachedRecordsKey === recordsKey &&
      state.cachedRecordsExactDerived;
    if (exactRowsReadyForCurrentRecords) {
      this.ensureReadRowsMesh(
        state,
        state.cachedRecordsRef,
        state.cachedReadRows,
        state.cachedReadHitIndex,
        recordsKey,
        args,
        readRowsTopPx,
        themedReadColor,
        deferBuildWork
      );
    } else if (state.rowsMeshBuildJob !== null) {
      this.advanceReadRowsMeshBuild(state, args, args.containerTopPx + readRowsTopPx);
    }
  }

  private applyExactReadRowsCameraAndSamples(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    rowBudget: ReadRowBudget,
    themeMode: WebGLThemeMode
  ): void {
    const { readRowsTopPx, effectiveRowHeightPx } = rowBudget;
    if (state.rows) {
      const rowsY = args.containerTopPx + readRowsTopPx;
      this.applyBarTrackColor(state.rows, state.pairedReadColor);
      this.applyCamera(state.rows, args, rowsY);
    }
    state.debugVisibleReadSamples = buildVisibleReadSamples(
      state.rows ? state.rowsMeshRecordsRef : null,
      state.rows ? state.rowsMeshRowsRef : null,
      args,
      effectiveRowHeightPx,
      readRowsTopPx,
      presentationReadColorForTheme(args.presentation?.color, this.readColor, themeMode),
      themeMode
    );

    state.visibleReadColumnCoverage = (globalThis as { __dna119MeasurePileupCoverage?: boolean })
      .__dna119MeasurePileupCoverage
      ? computeVisibleReadColumnCoverage(
          state.readOccupancy,
          args.viewportBpRange.start,
          args.viewportBpRange.end,
          args.viewportWidthPx
        )
      : null;
  }

  private resolveReadLodPresentation(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    tileEngineAuthority: boolean,
    zoomReadAlpha: number,
    rowBudget: ReadRowBudget
  ): ReadLodPresentation {
    const densityHeightPx = rowBudget.effectiveReadRowsHeightPx;
    const recordExtentCoversViewport =
      state.recordCount > 0 &&
      state.loadedEndBp > state.loadedStartBp &&
      args.viewportBpRange.start >= state.loadedStartBp - 1 &&
      args.viewportBpRange.end <= state.loadedEndBp + 1;
    state.recordExtentCoversViewport = recordExtentCoversViewport;
    const readSourceWindowCoverageFraction =
      state.readSourceWindowStartBp !== null && state.readSourceWindowEndBp !== null
        ? viewportCoverageFraction(
            state.readSourceWindowStartBp,
            state.readSourceWindowEndBp,
            args.viewportBpRange.start,
            args.viewportBpRange.end
          )
        : 0;
    state.readSourceWindowCoverageFraction = readSourceWindowCoverageFraction;
    const readSourceWindowCoversViewport =
      state.readSourceWindowStartBp !== null &&
      state.readSourceWindowEndBp !== null &&
      readSourceWindowCoverageFraction >= 0.999;
    state.readSourceWindowCoversViewport = readSourceWindowCoversViewport;
    const rowsMeshViewportCoverageFraction =
      state.rows !== null
        ? viewportCoverageFraction(
            state.rowsMeshStartBp,
            state.rowsMeshEndBp,
            args.viewportBpRange.start,
            args.viewportBpRange.end
          )
        : 0;
    state.rowsMeshViewportCoverageFraction = rowsMeshViewportCoverageFraction;
    const exactRowsAvailabilityAlpha = this.exactRowsAvailabilityAlpha(
      state,
      args,
      recordExtentCoversViewport,
      readSourceWindowCoversViewport,
      rowsMeshViewportCoverageFraction
    );
    const legacyExactRowsAlpha =
      state.readSourceTruncated === true ? 0 : zoomReadAlpha * exactRowsAvailabilityAlpha;
    const densityLodAlpha = !this.collapsed ? 1 - zoomReadAlpha : 1;
    const exactCollapsedFieldAvailable = collapsedFieldOverlapsViewport(
      state.collapsedPileupField,
      args.viewportBpRange.start,
      args.viewportBpRange.end
    );
    const allowExactCollapsedFallback = exactCollapsedFieldAvailable && !tileEngineAuthority;
    const exactRowsTransitionActive =
      state.rows !== null ||
      state.rowsMeshBuildJob !== null ||
      state.rowsAssignmentBuildJob !== null;
    const densityBridgeAlpha =
      exactRowsTransitionActive && !this.collapsed
        ? zoomReadAlpha * (1 - exactRowsAvailabilityAlpha)
        : 0;
    const exactRowsPaintAlpha = state.rows ? legacyExactRowsAlpha : 0;
    const isStreamingReadSource =
      state.readSourceWindowStartBp !== null || state.readSourceWindowEndBp !== null;
    const densityContinuityAlpha = !this.collapsed
      ? Math.max(
          isStreamingReadSource ? 1 - rowsMeshViewportCoverageFraction : 0,
          1 - exactRowsPaintAlpha
        )
      : 1;
    const desiredDensityAlpha = clamp01(
      Math.max(densityLodAlpha + densityBridgeAlpha, densityContinuityAlpha)
    );
    return {
      densityHeightPx,
      legacyExactRowsAlpha,
      desiredDensityAlpha,
      exactCollapsedFieldAvailable,
      allowExactCollapsedFallback,
    };
  }

  private paintDensityAggregate(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    data: PileupTrackData | null,
    tileEngineAuthority: boolean,
    probe: PileupProbeOptions,
    themedReadColor: number,
    rowBudget: ReadRowBudget,
    lod: ReadLodPresentation,
    experimentalHybrid: ExperimentalHybridPresentation
  ): DensityPaintResult {
    const {
      densityHeightPx,
      desiredDensityAlpha,
      legacyExactRowsAlpha,
      allowExactCollapsedFallback,
    } = lod;
    const { readRowsTopPx, effectiveRowHeightPx } = rowBudget;
    let coverageGpuAtlasActive = false;
    let coverageSignalInstancedActive = false;
    const gpuAtlas = data?.coverageGpuAtlas;
    const gpuAtlasPresentation = data?.coverageGpuAtlasPresentation;
    if (gpuAtlas && gpuAtlasPresentation !== 'standby') {
      const atlasContract = buildPileupVerticalScaleContract({
        rowHeightPx: effectiveRowHeightPx,
        effectiveMaxRows: state.effectiveMaxRows,
        maxHiddenCount: state.collapsedPileupField?.maxHiddenCount ?? state.overflowMaxHiddenReads,
        overflowMinFillFraction: READ_OVERFLOW_MIN_FILL_FRACTION,
        overflowMaxFillFraction: READ_DENSITY_MAX_FILL_FRACTION,
        overflowMinDenominatorReads: READ_OVERFLOW_MIN_DENOMINATOR_READS,
      });
      const atlasMaxFill =
        densityHeightPx > 0
          ? clamp01(
              collapsedVisibleRowsHeightPx(atlasContract, state.effectiveMaxRows) / densityHeightPx
            )
          : 0;
      coverageGpuAtlasActive = state.coverageGpuAtlasLayer.paint({
        viewportStartBp: args.viewportBpRange.start,
        viewportEndBp: args.viewportBpRange.end,
        viewportWidthPx: args.viewportWidthPx,
        viewportHeightPx: args.viewportHeightPx,
        bandTopPx: args.containerTopPx + readRowsTopPx,
        bandHeightPx: densityHeightPx,
        maxFill: atlasMaxFill,
        cutoffDepth: resolveCoverageCutoffDepth(data?.coverageCutoffDepth, 0),
        color: probe.densityColor ?? themedReadColor,
        renderer: args.renderer,
        allowHandoffHold: gpuAtlasPresentation != null,
      });
    } else {
      state.coverageGpuAtlasLayer.setVisible(false);
    }
    if (coverageGpuAtlasActive) {
      if (state.densityRows) state.densityRows.mesh.visible = false;
      state.coverageSignalInstancedLayer.setVisible(false);
      state.activeCoverageBinSize = gpuAtlas!.baseBinSizeBp;
      state.densityRowBinCount = Math.max(1, Math.round(args.viewportWidthPx));
      state.aggregateDepthSource = 'tile-engine-coverage';
    } else if (state.coverageSignal && state.coverageSignal.bins.length > 0) {
      if (
        experimentalHybrid.active ||
        desiredDensityAlpha > READ_LOD_MESH_VISIBLE_ALPHA_EPSILON ||
        !tileEngineAuthority ||
        (state.densityRows === null &&
          state.coverageSignalInstancedLayer.diagnostics().instanceCount === 0)
      ) {
        coverageSignalInstancedActive = this.updateCoverageAggregateRows(
          state,
          args,
          densityHeightPx,
          experimentalHybrid.active
            ? experimentalHybrid.morphProgress
            : tileEngineAuthority
              ? 0
              : legacyExactRowsAlpha,
          probe.densityColor,
          themedReadColor,
          !tileEngineAuthority && !experimentalHybrid.active,
          tileEngineAuthority,
          experimentalHybrid
        );
      } else {
        if (state.densityRows) state.densityRows.mesh.visible = false;
        state.coverageSignalInstancedLayer.setVisible(false);
      }
      state.aggregateDepthSource =
        state.densityRowBinCount > 0
          ? tileEngineAuthority
            ? 'tile-engine-coverage'
            : 'coverage-signal'
          : 'none';
    } else if (allowExactCollapsedFallback) {
      state.coverageSignalInstancedLayer.setVisible(false);
      this.updateCollapsedDensityRows(
        state,
        args,
        densityHeightPx,
        probe.densityColor,
        themedReadColor
      );
      state.aggregateDepthSource = state.densityRowBinCount > 0 ? 'exact-collapsed' : 'none';
    } else {
      state.coverageSignalInstancedLayer.setVisible(false);
      this.disposeDensityRows(state);
      this.resetDensityStats(state);
      state.aggregateDepthSource = 'none';
    }
    return { coverageGpuAtlasActive, coverageSignalInstancedActive };
  }

  private densitySurfaceIsBacked(
    state: ContainerState,
    densityHeightPx: number,
    coverageGpuAtlasActive: boolean,
    coverageSignalInstancedActive: boolean,
    exactCollapsedFieldAvailable: boolean
  ): boolean {
    return (
      densityHeightPx > 0 &&
      (coverageGpuAtlasActive ||
        coverageSignalInstancedActive ||
        (state.densityRows !== null &&
          ((state.coverageSignal && state.densityRowBinCount > 0) || exactCollapsedFieldAvailable)))
    );
  }

  private prepareExperimentalHybridPresentation(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    data: PileupTrackData | null,
    frameNowMs: number,
    themedReadColor: number
  ): ExperimentalHybridPresentation {
    const config = data?.experimentalReadHandoff;
    if (config?.kind !== 'bigwig-height-morph-to-reads') {
      state.experimentalHybridPhase = 'inactive';
      state.experimentalHybridStartedAtMs = null;
      state.experimentalHybridMorphProgress = 0;
      state.experimentalHybridGenerationKey = '';
      state.experimentalHybridExactFrontAvailable = false;
      state.experimentalHybridSourceGenerationKey = '';
      state.experimentalHybridCompletedIntervals.length = 0;
      return {
        active: false,
        exactFrontAvailable: false,
        spatialContinuityFallback: false,
        morphProgress: 1,
        surfaceColor: themedReadColor,
        generationKey: '',
      };
    }

    const requestedGenerationKey = data?.readSource?.sourceGenerationKey ?? '';
    const requestedOwnerKey = data?.readSource?.presentationOwnerKey ?? requestedGenerationKey;
    if (requestedOwnerKey !== state.experimentalHybridSourceGenerationKey) {
      state.experimentalHybridSourceGenerationKey = requestedOwnerKey;
      state.experimentalHybridCompletedIntervals.length = 0;
    }
    const completedViewport = completedHybridIntervalsCover(
      state.experimentalHybridCompletedIntervals,
      args.viewportBpRange.start,
      args.viewportBpRange.end
    );
    const generationMatches =
      requestedGenerationKey.length === 0 ||
      state.rowsMeshSourceGenerationKey === requestedGenerationKey;
    const rowsCoverViewport =
      viewportCoverageFraction(
        state.rowsMeshStartBp,
        state.rowsMeshEndBp,
        args.viewportBpRange.start,
        args.viewportBpRange.end
      ) >= 0.999;
    const visibleFrontStartBp = Math.max(state.rowsMeshStartBp, args.viewportBpRange.start);
    const visibleFrontEndBp = Math.min(state.rowsMeshEndBp, args.viewportBpRange.end);
    const visibleReadTilesPending = pendingReferenceIntervalOverlapsViewport(
      data?.referenceIntervals,
      args.viewportBpRange.start,
      args.viewportBpRange.end
    );
    const populatedExactFrontReady =
      state.rows !== null &&
      state.rowsMeshRecordCount > 0 &&
      state.rowsMeshRecordsRef !== null &&
      state.rowsMeshRowsRef !== null &&
      state.rowsMeshRowsRef.length === state.rowsMeshRecordsRef.length &&
      state.rowsMeshCollapsedPileupField !== null;
    const currentRecords = state.cachedRecordsRef;
    const currentReadWindowContained =
      state.readSourceWindowStartBp !== null &&
      state.readSourceWindowEndBp !== null &&
      state.rowsMeshStartBp <= state.readSourceWindowStartBp &&
      state.rowsMeshEndBp >= state.readSourceWindowEndBp;
    const frontContainsCurrentRecords =
      currentRecords !== null &&
      state.rowsMeshRecordsRef !== null &&
      (state.rowsMeshRecordsRef === currentRecords ||
        (currentReadWindowContained &&
          readRecordsContain(state.rowsMeshRecordsRef, currentRecords)));
    const emptyExactFrontReady =
      data?.readSource !== undefined &&
      !state.readSourceTruncated &&
      state.recordCount === 0 &&
      state.rows === null &&
      state.rowsMeshRecordCount === 0 &&
      state.rowsMeshRecordsRef !== null &&
      state.rowsMeshRowsRef !== null &&
      state.rowsMeshRowsRef.length === 0 &&
      state.rowsMeshCollapsedPileupField !== null;
    const exactFrontReady =
      !visibleReadTilesPending &&
      generationMatches &&
      rowsCoverViewport &&
      frontContainsCurrentRecords &&
      (populatedExactFrontReady || emptyExactFrontReady) &&
      state.rowsMeshEndBp > state.rowsMeshStartBp;
    if (!exactFrontReady) {
      const completedResidentFrontOverlap =
        generationMatches &&
        !state.readSourceTruncated &&
        populatedExactFrontReady &&
        visibleFrontEndBp > visibleFrontStartBp &&
        completedHybridIntervalsCover(
          state.experimentalHybridCompletedIntervals,
          visibleFrontStartBp,
          visibleFrontEndBp
        );
      if (completedViewport || completedResidentFrontOverlap) {
        state.experimentalHybridPhase = 'reads';
        state.experimentalHybridStartedAtMs = null;
        state.experimentalHybridMorphProgress = 1;
        state.experimentalHybridExactFrontAvailable = false;
        return {
          active: true,
          exactFrontAvailable: false,
          spatialContinuityFallback: true,
          morphProgress: 1,
          surfaceColor: themedReadColor,
          generationKey: state.experimentalHybridGenerationKey,
        };
      }
      state.experimentalHybridPhase = 'histogram';
      state.experimentalHybridStartedAtMs = null;
      state.experimentalHybridMorphProgress = 0;
      state.experimentalHybridGenerationKey = '';
      state.experimentalHybridExactFrontAvailable = false;
      return {
        active: true,
        exactFrontAvailable: false,
        spatialContinuityFallback: false,
        morphProgress: 0,
        surfaceColor: themedReadColor,
        generationKey: '',
      };
    }

    const generationKey = [
      state.rowsMeshSourceGenerationKey,
      state.rowsMeshRecordsKey,
      state.rowsMeshStartBp,
      state.rowsMeshEndBp,
      state.effectiveRowHeightPx,
      state.effectiveMaxRows,
    ].join('|');
    if (completedViewport) {
      state.experimentalHybridGenerationKey = generationKey;
      state.experimentalHybridStartedAtMs = null;
      state.experimentalHybridMorphProgress = 1;
      state.experimentalHybridExactFrontAvailable = true;
      state.experimentalHybridPhase = 'reads';
      rememberCompletedHybridInterval(
        state.experimentalHybridCompletedIntervals,
        state.rowsMeshStartBp,
        state.rowsMeshEndBp
      );
      return {
        active: true,
        exactFrontAvailable: true,
        spatialContinuityFallback: false,
        morphProgress: 1,
        surfaceColor: themedReadColor,
        generationKey,
      };
    }
    const generationChanged = generationKey !== state.experimentalHybridGenerationKey;
    const preservesContinuousExactOwnership =
      (generationChanged &&
        state.experimentalHybridPhase === 'reads' &&
        state.experimentalHybridExactFrontAvailable) ||
      completedHybridIntervalsOverlap(
        state.experimentalHybridCompletedIntervals,
        visibleFrontStartBp,
        visibleFrontEndBp
      );
    if (generationChanged) {
      state.experimentalHybridGenerationKey = generationKey;
      if (!preservesContinuousExactOwnership && state.experimentalHybridPhase !== 'morph') {
        state.experimentalHybridStartedAtMs = frameNowMs;
      }
    }
    if (preservesContinuousExactOwnership) {
      state.experimentalHybridStartedAtMs = null;
      state.experimentalHybridMorphProgress = 1;
      state.experimentalHybridExactFrontAvailable = true;
      state.experimentalHybridPhase = 'reads';
      rememberCompletedHybridInterval(
        state.experimentalHybridCompletedIntervals,
        state.rowsMeshStartBp,
        state.rowsMeshEndBp
      );
      return {
        active: true,
        exactFrontAvailable: true,
        spatialContinuityFallback: false,
        morphProgress: 1,
        surfaceColor: themedReadColor,
        generationKey,
      };
    }
    if (
      !generationChanged &&
      state.experimentalHybridPhase === 'reads' &&
      state.experimentalHybridExactFrontAvailable
    ) {
      rememberCompletedHybridInterval(
        state.experimentalHybridCompletedIntervals,
        state.rowsMeshStartBp,
        state.rowsMeshEndBp
      );
      return {
        active: true,
        exactFrontAvailable: true,
        spatialContinuityFallback: false,
        morphProgress: 1,
        surfaceColor: themedReadColor,
        generationKey,
      };
    }
    if (state.experimentalHybridStartedAtMs === null) {
      state.experimentalHybridStartedAtMs = frameNowMs;
    }

    const elapsedMs = Math.max(0, frameNowMs - state.experimentalHybridStartedAtMs);
    const linearProgress = clamp01(elapsedMs / Math.max(1, config.morphDurationMs));
    const morphProgress = linearProgress * linearProgress * (3 - 2 * linearProgress);
    state.experimentalHybridMorphProgress = morphProgress;
    state.experimentalHybridExactFrontAvailable = true;
    state.experimentalHybridPhase = morphProgress < 1 ? 'morph' : 'reads';
    if (morphProgress >= 1) {
      rememberCompletedHybridInterval(
        state.experimentalHybridCompletedIntervals,
        state.rowsMeshStartBp,
        state.rowsMeshEndBp
      );
    }
    return {
      active: true,
      exactFrontAvailable: true,
      spatialContinuityFallback: false,
      morphProgress,
      surfaceColor: themedReadColor,
      generationKey,
    };
  }

  private renderedReadLayerAlphas(args: {
    probe: PileupProbeOptions;
    state: ContainerState;
    hasAggregate: boolean;
    densityHeightPx: number;
    densityAlpha: number;
    exactAlpha: number;
    overflowAlpha: number;
  }): { exact: number; density: number; overflow: number } {
    return {
      exact: args.probe.hideExactRows === true ? 0 : args.state.rows ? args.exactAlpha : 0,
      density:
        args.probe.hideReadDensity === true
          ? 0
          : args.hasAggregate && args.densityHeightPx > 0
            ? args.densityAlpha
            : 0,
      overflow:
        args.probe.hideExactRows === true
          ? 0
          : args.state.overflowRows && args.state.overflowRowBinCount > 0
            ? args.overflowAlpha
            : 0,
    };
  }

  private resolveReadDisplayMode(
    renderedReadAlpha: number,
    renderedDensityAlpha: number
  ): ContainerState['readDisplayMode'] {
    if (renderedReadAlpha > 0.95 && renderedDensityAlpha <= 0.25) return 'reads';
    if (renderedReadAlpha > 0.02 && renderedDensityAlpha > 0.02) return 'blend';
    if (renderedReadAlpha > 0.02) return 'reads';
    if (renderedDensityAlpha > 0.02) return 'density';
    return 'empty';
  }

  private applyReadLayerMeshAlphas(
    state: ContainerState,
    alphas: { exact: number; density: number; overflow: number },
    coverageGpuAtlasActive: boolean,
    coverageSignalInstancedActive: boolean
  ): void {
    if (state.rows) {
      state.rows.mesh.alpha = alphas.exact;
      state.rows.mesh.visible = alphas.exact > READ_LOD_MESH_VISIBLE_ALPHA_EPSILON;
    }
    if (state.densityRows) {
      const active =
        state.readAggregateSource === 'collapsed-pileup' &&
        !coverageGpuAtlasActive &&
        !coverageSignalInstancedActive;
      state.densityRows.mesh.alpha = active ? alphas.density : 0;
      state.densityRows.mesh.visible =
        active && alphas.density > READ_LOD_MESH_VISIBLE_ALPHA_EPSILON;
    }
    state.coverageGpuAtlasLayer.setAlpha(alphas.density);
    state.coverageGpuAtlasLayer.setVisible(
      coverageGpuAtlasActive && alphas.density > READ_LOD_MESH_VISIBLE_ALPHA_EPSILON
    );
    state.coverageSignalInstancedLayer.setAlpha(alphas.density);
    state.coverageSignalInstancedLayer.setVisible(
      coverageSignalInstancedActive && alphas.density > READ_LOD_MESH_VISIBLE_ALPHA_EPSILON
    );
    if (state.overflowRows) {
      state.overflowRows.mesh.alpha = alphas.overflow;
      state.overflowRows.mesh.visible = alphas.overflow > READ_LOD_MESH_VISIBLE_ALPHA_EPSILON;
    }
    if (
      state.rows &&
      state.recordCount === 0 &&
      alphas.exact <= READ_LOD_MESH_VISIBLE_ALPHA_EPSILON
    ) {
      this.disposeBar(state, 'rows');
      state.renderedReadRowsAlpha = 0;
    }
  }

  private applyBarHorizontalExclusion(
    bar: BarMesh | null,
    rangePx: readonly [number, number] | null
  ): void {
    if (!bar) return;
    const uniforms = (bar.shader.resources.annotationUniforms as { uniforms: BarUniforms })
      .uniforms;
    uniforms.uHorizontalExcludeActive = rangePx ? 1 : 0;
    uniforms.uHorizontalExcludePx[0] = rangePx?.[0] ?? 0;
    uniforms.uHorizontalExcludePx[1] = rangePx?.[1] ?? 0;
  }

  private applyExperimentalHybridSpatialOwnership(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    presentation: ExperimentalHybridPresentation
  ): void {
    let exclusionBp: readonly [number, number] | null = null;
    let exclusionPx: readonly [number, number] | null = null;
    if (presentation.spatialContinuityFallback && state.rows) {
      const startBp = Math.max(args.viewportBpRange.start, state.rowsMeshStartBp);
      const endBp = Math.min(args.viewportBpRange.end, state.rowsMeshEndBp);
      if (endBp > startBp) {
        const xOrigin = args.pathMapper.bpLeftX(args.viewportBpRange.start);
        const leftPx =
          xOrigin + (startBp - args.viewportBpRange.start) * args.pathMapper.pixelsPerBp;
        const rightPx =
          xOrigin + (endBp - args.viewportBpRange.start) * args.pathMapper.pixelsPerBp;
        if (rightPx > leftPx) {
          exclusionBp = [startBp, endBp];
          exclusionPx = [leftPx, rightPx];
        }
      }
    }

    state.experimentalHybridSpatialContinuityFallback = presentation.spatialContinuityFallback;
    state.experimentalHybridDensityExclusionStartBp = exclusionBp?.[0] ?? null;
    state.experimentalHybridDensityExclusionEndBp = exclusionBp?.[1] ?? null;
    this.applyBarHorizontalExclusion(state.densityRows, exclusionPx);
    state.coverageSignalInstancedLayer.setHorizontalExclusion(exclusionPx);
    state.coverageGpuAtlasLayer.setHorizontalExclusion(exclusionPx);
  }

  private applyRenderedLayerPresentation(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    data: PileupTrackData | null,
    probe: PileupProbeOptions,
    rowBudget: ReadRowBudget,
    lod: ReadLodPresentation,
    densityPaint: DensityPaintResult,
    experimentalHybrid: ExperimentalHybridPresentation
  ): void {
    const {
      densityHeightPx,
      legacyExactRowsAlpha,
      desiredDensityAlpha,
      exactCollapsedFieldAvailable,
    } = lod;
    const { coverageGpuAtlasActive, coverageSignalInstancedActive } = densityPaint;
    const { readRowsTopPx, effectiveRowHeightPx } = rowBudget;
    const densitySurfaceBacked = this.densitySurfaceIsBacked(
      state,
      densityHeightPx,
      coverageGpuAtlasActive,
      coverageSignalInstancedActive,
      exactCollapsedFieldAvailable
    );
    state.readAggregateSource = densitySurfaceBacked ? 'collapsed-pileup' : 'none';

    const exactAlpha =
      legacyExactRowsAlpha * (experimentalHybrid.active ? experimentalHybrid.morphProgress : 1);
    const hasAggregate =
      state.readAggregateSource === 'collapsed-pileup' &&
      (coverageGpuAtlasActive || coverageSignalInstancedActive || state.densityRows !== null);
    const densityAlpha =
      hasAggregate && densityHeightPx > 0
        ? experimentalHybrid.active
          ? experimentalHybrid.spatialContinuityFallback
            ? 1
            : 1 - experimentalHybrid.morphProgress
          : desiredDensityAlpha
        : 0;
    const overflowAlpha = experimentalHybrid.active ? 1 : exactAlpha;
    state.readRowsAlpha = exactAlpha;
    state.readDensityAlpha = densityAlpha;
    state.overflowRowsAlpha = overflowAlpha;
    this.applyExperimentalHybridSpatialOwnership(state, args, experimentalHybrid);

    const {
      exact: renderedExactAlpha,
      density: renderedDensityAlpha,
      overflow: renderedOverflowAlpha,
    } = this.renderedReadLayerAlphas({
      probe,
      state,
      hasAggregate,
      densityHeightPx,
      densityAlpha,
      exactAlpha,
      overflowAlpha,
    });
    state.renderedReadRowsAlpha = renderedExactAlpha;
    state.renderedReadDensityAlpha = renderedDensityAlpha;
    state.renderedOverflowRowsAlpha = renderedOverflowAlpha;
    this.applyReadLayerMeshAlphas(
      state,
      {
        exact: renderedExactAlpha,
        density: renderedDensityAlpha,
        overflow: renderedOverflowAlpha,
      },
      coverageGpuAtlasActive,
      coverageSignalInstancedActive
    );
    this.ensureReadBlendOrder(state);
    const histogramGuideColumns =
      data?.readSource == null && state.recordCount === 0 ? (data?.alternateColumns ?? []) : [];
    state.histogramGuideLayer.paint({
      columns: histogramGuideColumns,
      pathMapper: args.pathMapper,
      viewportStartBp: args.viewportBpRange.start,
      viewportWidthPx: args.viewportWidthPx,
      viewportHeightPx: args.viewportHeightPx,
      guideTopPx: args.containerTopPx,
      guideHeightPx: args.layoutEntry.height,
    });
    if (state.histogramGuideLayer.container.parent === state.container) {
      state.container.addChild(state.histogramGuideLayer.container);
    }
    const renderedReadAlpha = renderedExactAlpha;
    const renderedAggregateAlpha = renderedDensityAlpha;
    state.readDisplayMode = this.resolveReadDisplayMode(renderedReadAlpha, renderedAggregateAlpha);
    state.readDifferenceLayer.paint({
      records: state.rows ? state.rowsMeshRecordsRef : null,
      rows: state.rows ? state.rowsMeshRowsRef : null,
      rowHeightPx: effectiveRowHeightPx,
      readRowsTopPx,
      exactRowsVisible:
        (state.readDisplayMode === 'reads' || state.readDisplayMode === 'blend') &&
        renderedExactAlpha > READ_LOD_MESH_VISIBLE_ALPHA_EPSILON,
      layerAlpha: renderedExactAlpha,
      args,
    });
  }

  private applyExperimentalHybridHistogramLoadingMotion(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    data: PileupTrackData | null,
    frameNowMs: number
  ): boolean {
    const loadingAnimation =
      data?.experimentalReadHandoff?.loadingAnimation ?? DEFAULT_HISTOGRAM_LOADING_ANIMATION;
    state.experimentalHybridHistogramLoadingAnimation = loadingAnimation;
    const visiblePendingInterval = pendingReferenceIntervalOverlapsViewport(
      data?.referenceIntervals,
      state.lastViewportStartBp,
      state.lastViewportEndBp
    );
    const readLoadingTreatmentEligible = pileupExactReadLoadingEligible(
      args.pathMapper.pixelsPerBp
    );
    const exactReadHandoffOutstanding =
      state.experimentalHybridPhase === 'histogram' && readLoadingTreatmentEligible;
    const readsStillPreparing =
      data?.experimentalReadHandoff?.readsLoading === true ||
      visiblePendingInterval ||
      state.rowsAssignmentBuildJob !== null ||
      state.rowsRetainBuildJob !== null ||
      state.rowsMeshBuildJob !== null ||
      exactReadHandoffOutstanding;
    const actualBigWigShapeVisible =
      state.experimentalHybridPhase === 'histogram' &&
      state.aggregateDepthSource === 'coverage-signal' &&
      state.coverageSignalNonzeroBinCount > 0 &&
      state.renderedReadDensityAlpha > READ_LOD_MESH_VISIBLE_ALPHA_EPSILON &&
      state.densityRows?.mesh.visible === true;
    const active = readLoadingTreatmentEligible && readsStillPreparing && actualBigWigShapeVisible;

    if (active) {
      if (state.experimentalHybridHistogramLoadingStartedAtMs === null) {
        state.experimentalHybridHistogramLoadingStartedAtMs = frameNowMs;
      }
      const elapsedMs = Math.max(
        0,
        frameNowMs - state.experimentalHybridHistogramLoadingStartedAtMs
      );
      state.experimentalHybridHistogramLoadingPhase =
        (elapsedMs % EXPERIMENTAL_HYBRID_LOADING_MOTION_PERIOD_MS) /
        EXPERIMENTAL_HYBRID_LOADING_MOTION_PERIOD_MS;
    } else {
      state.experimentalHybridHistogramLoadingStartedAtMs = null;
      state.experimentalHybridHistogramLoadingPhase = 0;
    }
    state.experimentalHybridHistogramLoadingMotion = active;
    if (state.densityRows) {
      this.applyBarLoadingMotion(
        state.densityRows,
        active,
        state.experimentalHybridHistogramLoadingPhase,
        loadingAnimation
      );
    }
    if (state.overflowRows) {
      this.applyBarLoadingMotion(
        state.overflowRows,
        active,
        state.experimentalHybridHistogramLoadingPhase,
        loadingAnimation
      );
    }
    return active;
  }

  getDiagnostics(container: Container): PileupTrackDiagnostics | null {
    const state = this.containerState.get(container);
    if (!state) return null;
    const coverageGpuAtlas = state.coverageGpuAtlasLayer.diagnostics();
    const readDifferences = state.readDifferenceLayer.diagnostics();
    const pendingIntervals = state.pendingIntervalLayer.diagnostics();
    return {
      themeMode: state.themeMode,
      pairedReadColor: state.pairedReadColor,
      forwardReadColor: state.forwardReadColor,
      reverseReadColor: state.reverseReadColor,
      recordCount: state.recordCount,
      forwardReadCount: state.forwardReadCount,
      reverseReadCount: state.reverseReadCount,
      pairedReadCount: state.pairedReadCount,
      rowsUsed: state.rowCount,
      hiddenReadCount: state.hiddenReadCount,
      maxRows: this.maxRows,
      effectiveMaxRows: state.effectiveMaxRows,
      bandBinCount: 0,
      activeCoverageBinSize: state.activeCoverageBinSize,
      renderedCoverageBinSize: state.coverageSignal ? state.coverageSignal.binSize : null,
      renderedCoverageBinCount: state.coverageSignal ? state.coverageSignal.bins.length : null,
      coverageSignalStartBp: state.coverageSignal ? state.coverageStartBp : null,
      coverageSignalEndBp: state.coverageSignal
        ? state.coverageStartBp + state.coverageSignal.bins.length * state.coverageSignal.binSize
        : null,
      coverageSignalMaxDepth: state.coverageMaxDepth,
      coverageSignalNonzeroBinCount: state.coverageSignalNonzeroBinCount,
      coverageDepthP50: state.coverageSignal?.depthPercentiles?.p50 ?? null,
      coverageDepthP90: state.coverageSignal?.depthPercentiles?.p90 ?? null,
      coverageDepthP95: state.coverageSignal?.depthPercentiles?.p95 ?? null,
      coverageDepthP99: state.coverageSignal?.depthPercentiles?.p99 ?? null,
      coverageDepthMax: state.coverageSignal?.depthPercentiles?.max ?? null,
      coverageLodRole: state.coverageLodRole,
      coverageLodLevel: state.coverageLodLevel,
      coverageLodTargetLevel: state.coverageLodTargetLevel,
      coverageLodBinSize: state.coverageLodBinSize,
      coverageLodAuthority: state.coverageLodAuthority,
      coverageLodProvenanceExact: state.coverageLodProvenanceExact,
      coverageLodProvenanceMethod: state.coverageLodProvenanceMethod,
      coverageLodProvenanceSource: state.coverageLodProvenanceSource,
      coverageLodSourceLevel: state.coverageLodSourceLevel,
      coverageLodSourceBinSize: state.coverageLodSourceBinSize,
      coverageLodResidentLevel: state.coverageLodResidentLevel,
      coverageLodResidentBinSize: state.coverageLodResidentBinSize,
      coverageLodCurrentCoveredFraction: state.coverageLodCurrentCoveredFraction,
      coverageSampledColumnCount: state.coverageSampledColumnCount,
      coverageSampledNonzeroColumnCount: state.coverageSampledNonzeroColumnCount,
      coverageSampledMaxDepth: state.coverageSampledMaxDepth,
      coverageSamplePassCount: state.coverageSamplePassCount,
      coverageGeometryBuildCount: state.coverageGeometryBuildCount,
      coverageBufferUploadCount: state.coverageBufferUploadCount,
      coverageGpuAtlasAuthorityKey: coverageGpuAtlas.authorityKey,
      coverageGpuAtlasTextureResourceCreateCount: coverageGpuAtlas.textureResourceCreateCount,
      coverageGpuAtlasGpuTextureResourceCreateCount: coverageGpuAtlas.gpuTextureResourceCreateCount,
      coverageGpuAtlasGpuTextureUploadCount: coverageGpuAtlas.gpuTextureUploadCount,
      coverageGpuAtlasGpuTextureUploadComplete: coverageGpuAtlas.gpuTextureUploadComplete,
      coverageGpuAtlasTextureResourceUid: coverageGpuAtlas.textureResourceUid,
      coverageGpuAtlasShaderTextureResourceUid: coverageGpuAtlas.shaderTextureResourceUid,
      coverageGpuAtlasShaderTextureResourceBound: coverageGpuAtlas.shaderTextureResourceBound,
      coverageGpuAtlasGeometryBuildCount: coverageGpuAtlas.geometryBuildCount,
      coverageGpuAtlasCameraUniformUpdateCount: coverageGpuAtlas.cameraUniformUpdateCount,
      coverageGpuAtlasRenderOwner: coverageGpuAtlas.renderOwner,
      coverageGpuAtlasShaderProgramName: coverageGpuAtlas.shaderProgramName,
      coverageGpuAtlasShaderProgramKey: coverageGpuAtlas.shaderProgramKey,
      coverageGpuAtlasShaderProgramCompiled: coverageGpuAtlas.shaderProgramCompiled,
      coverageGpuAtlasActive: coverageGpuAtlas.active,
      coverageGpuAtlasBaseBinSizeBp: coverageGpuAtlas.baseBinSizeBp,
      coverageGpuAtlasDepthMax: coverageGpuAtlas.depthMax,
      rendererViewportStartBp: state.lastViewportStartBp,
      rendererViewportEndBp: state.lastViewportEndBp,
      collapsed: this.collapsed,
      bandVertexCount: 0,
      rowsVertexCount: state.rows?.vertexCount ?? 0,
      rowsMeshStartBp: state.rowsMeshStartBp,
      rowsMeshEndBp: state.rowsMeshEndBp,
      rowsMeshRecordCount: state.rowsMeshRecordCount,
      rowsMeshGenerationKey: state.rowsMeshRecordsKey,
      overflowGenerationKey: state.overflowRowsRecordsKey,
      overflowGeometryBuildCount: state.overflowGeometryBuildCount,
      rowsMeshBuildInProgress: state.rowsMeshBuildJob !== null,
      rowsMeshBuildRecordsLastFrame: this.lastRowsMeshBuildRecordsThisFrame,
      rowsMeshBuildChunkCount: this.rowsMeshBuildChunkCount,
      rowsMeshBuildTargetMatchesRecordsKey: state.rowsMeshBuildJob
        ? state.rowsMeshBuildJob.recordsKey === state.cachedRecordsKey
        : null,
      rowsMeshBuildRecordCursor: state.rowsMeshBuildJob?.job.recordCursor ?? 0,
      rowsMeshBuildRecordCount: state.rowsMeshBuildJob?.recordCount ?? 0,
      rowsAssignmentBuildInProgress: state.rowsAssignmentBuildJob !== null,
      rowsAssignmentBuildRecordsLastFrame: this.lastRowsAssignmentBuildRecordsThisFrame,
      rowsAssignmentBuildChunkCount: this.rowsAssignmentBuildChunkCount,
      rowsRetainBuildInProgress: state.rowsRetainBuildJob !== null,
      rowsRetainBuildRecordsLastFrame: this.lastRowsRetainBuildRecordsThisFrame,
      rowsRetainBuildChunkCount: this.rowsRetainBuildChunkCount,
      rowsRetainedPlacementCount: state.layout.retainedPlacementCount(),
      rowsRetainedIntervalCount: state.layout.retainedIntervalCount(),
      rowsMeshBufferAllocCount: this.rowsMeshBufferAllocCount,
      recordsCommitTiming: state.lastRecordsCommitTiming,
      paintTiming: state.lastPaintTiming,
      morphRowsVertexCount: 0,
      densityRowsVertexCount: state.densityRowBinCount * 6,
      overflowRowsVertexCount: state.overflowRowBinCount * 6,
      loadedStartBp: state.loadedStartBp,
      loadedEndBp: state.loadedEndBp,
      readSourceTruncated: state.readSourceTruncated,
      readSourceWindowStartBp: state.readSourceWindowStartBp,
      readSourceWindowEndBp: state.readSourceWindowEndBp,
      readRowsTopPx: this.readRowsTopPx(),
      readRowsBottomPx: this.readRowsTopPx() + state.effectiveMaxRows * state.effectiveRowHeightPx,
      effectiveRowHeightPx: state.effectiveRowHeightPx,
      overflowBandTopPx: state.overflowBandTopPx,
      overflowBandBottomPx: state.overflowBandTopPx + state.overflowBandHeightPx,
      overflowBandHeightPx: state.overflowBandHeightPx,
      visibleReadColumnCoverage: state.visibleReadColumnCoverage,
      readDensityColumnCoverage: state.readDensityColumnCoverage,
      readDensityMeanFill: state.readDensityMeanFill,
      readDensityMaxFill: state.readDensityMaxFill,
      readDensityRowStackMeanFill: state.readDensityRowStackMeanFill,
      readDensityRowStackMaxFill: state.readDensityRowStackMaxFill,
      readDensityMorph: state.readDensityMorph,
      readDensityFillStdDev: state.readDensityFillStdDev,
      readDensitySourceDepthMean: state.readDensitySourceDepthMean,
      readDensitySourceDepthStdDev: state.readDensitySourceDepthStdDev,
      readDensitySourceDepthCv: state.readDensitySourceDepthCv,
      readDensitySourceDepthP10: state.readDensitySourceDepthP10,
      readDensitySourceDepthP50: state.readDensitySourceDepthP50,
      readDensitySourceDepthP90: state.readDensitySourceDepthP90,
      readDensitySourceDepthP99: state.readDensitySourceDepthP99,
      readDensitySourceDepthEdgeCount: state.readDensitySourceDepthEdgeCount,
      readDensitySourceDepthLongestFlatRunColumns:
        state.readDensitySourceDepthLongestFlatRunColumns,
      readDensityDrawnFillStdDev: state.readDensityDrawnFillStdDev,
      readDensityDrawnEdgeCount: state.readDensityDrawnEdgeCount,
      readDensityDrawnLongestFlatRunColumns: state.readDensityDrawnLongestFlatRunColumns,
      readDensityClippedColumnFraction: state.readDensityClippedColumnFraction,
      collapsedPileupFieldBinCount: state.collapsedPileupFieldBinCount,
      collapsedPileupMaxVisibleRows: state.collapsedPileupMaxVisibleRows,
      collapsedPileupMaxHiddenCount: state.collapsedPileupMaxHiddenCount,
      overflowColumnCoverage: state.overflowColumnCoverage,
      overflowMeanFill: state.overflowMeanFill,
      overflowMaxFill: state.overflowMaxFill,
      overflowMaxHiddenReads: state.overflowMaxHiddenReads,
      overflowMorph: state.overflowMorph,
      overflowBaseMinPx: state.overflowBaseMinPx,
      overflowBaseMaxPx: state.overflowBaseMaxPx,
      readRowsAlpha: state.readRowsAlpha,
      readDensityAlpha: state.readDensityAlpha,
      overflowRowsAlpha: state.overflowRowsAlpha,
      renderedReadRowsAlpha: state.renderedReadRowsAlpha,
      renderedReadMorphRowsAlpha: 0,
      renderedReadDensityAlpha: state.renderedReadDensityAlpha,
      renderedOverflowRowsAlpha: state.renderedOverflowRowsAlpha,
      readDisplayMode: state.readDisplayMode,
      readAggregateSource: state.readAggregateSource,
      aggregateDepthSource: state.aggregateDepthSource,
      readSourceWindowCoversViewport: state.readSourceWindowCoversViewport,
      readSourceWindowCoverageFraction: state.readSourceWindowCoverageFraction,
      rowsMeshViewportCoverageFraction: state.rowsMeshViewportCoverageFraction,
      recordExtentCoversViewport: state.recordExtentCoversViewport,
      rowsMeshVisible: state.rows?.mesh.visible === true,
      rowsMeshAlpha: state.rows?.mesh.alpha ?? 0,
      morphRowsMeshVisible: false,
      morphRowsMeshAlpha: 0,
      densityRowsMeshVisible:
        state.densityRows?.mesh.visible === true ||
        state.coverageSignalInstancedLayer.diagnostics().active,
      densityRowsMeshAlpha: state.densityRows?.mesh.alpha ?? 0,
      overflowRowsMeshVisible: state.overflowRows?.mesh.visible === true,
      overflowRowsMeshAlpha: state.overflowRows?.mesh.alpha ?? 0,
      rowAssignments: state.lastRowAssignment
        ? Object.fromEntries(state.lastRowAssignment)
        : undefined,
      visibleReadSamples: state.debugVisibleReadSamples ?? undefined,
      readGlyphCount: readDifferences.glyphCount,
      readGlyphContract: readDifferences.glyphContract,
      readGlyphRasterSize: readDifferences.glyphRasterSize,
      readDifferenceMarkCount: readDifferences.markCount,
      readDifferenceInstanceCount: readDifferences.instanceCount,
      readDifferenceBufferCapacity: readDifferences.bufferCapacity,
      readDifferenceBufferGrowCount: readDifferences.bufferGrowCount,
      readDifferenceBuildCount: readDifferences.buildCount,
      readDifferenceHitTestCandidateCount: readDifferences.hitTestCandidateCount,
      readDifferenceLayerVisible: readDifferences.visible,
      readDifferenceLayerAlpha: readDifferences.alpha,
      readDifferenceScreenTopPx: readDifferences.screenTopPx,
      pendingIntervalCount: pendingIntervals.pendingIntervalCount,
      pendingIntervalGeometryBuildCount: pendingIntervals.geometryBuildCount,
      pendingIntervalBufferUploadCount: pendingIntervals.bufferUploadCount,
      pendingIntervalCameraUniformUpdateCount: pendingIntervals.cameraUniformUpdateCount,
      pendingIntervalBandTopPx: pendingIntervals.bandTopPx,
      pendingIntervalBandHeightPx: pendingIntervals.bandHeightPx,
      pendingIntervalAppearance: pendingIntervals.appearance,
      pendingIntervalMotionPhase: pendingIntervals.motionPhase,
      pendingIntervalLoadingColors: pendingIntervals.loadingColors,
      pendingIntervalVisible: pendingIntervals.visible,
      pendingIntervals: pendingIntervals.intervals,
      pendingIntervalProjectedIntervalsPx: pendingIntervals.projectedIntervalsPx,
      experimentalHybridPhase: state.experimentalHybridPhase,
      experimentalHybridMorphProgress: state.experimentalHybridMorphProgress,
      experimentalHybridExactFrontAvailable: state.experimentalHybridExactFrontAvailable,
      experimentalHybridGenerationKey: state.experimentalHybridGenerationKey,
      experimentalHybridSpatialContinuityFallback:
        state.experimentalHybridSpatialContinuityFallback,
      experimentalHybridDensityExclusionStartBp: state.experimentalHybridDensityExclusionStartBp,
      experimentalHybridDensityExclusionEndBp: state.experimentalHybridDensityExclusionEndBp,
      experimentalHybridHistogramLoadingMotion: state.experimentalHybridHistogramLoadingMotion,
      experimentalHybridHistogramLoadingPhase: state.experimentalHybridHistogramLoadingPhase,
      experimentalHybridHistogramLoadingAnimation:
        state.experimentalHybridHistogramLoadingAnimation,
    };
  }

  getColdGestureDiagnostics(container: Container): PileupColdGestureDiagnostics | null {
    const state = this.containerState.get(container);
    if (!state) return null;
    const coverageGpuAtlas = state.coverageGpuAtlasLayer.diagnostics();
    return {
      coverageLodRole: state.coverageLodRole,
      coverageLodLevel: state.coverageLodLevel,
      coverageLodTargetLevel: state.coverageLodTargetLevel,
      coverageLodBinSize: state.coverageLodBinSize,
      coverageLodAuthority: state.coverageLodAuthority,
      coverageLodProvenanceExact: state.coverageLodProvenanceExact,
      coverageSamplePassCount: state.coverageSamplePassCount,
      coverageGeometryBuildCount: state.coverageGeometryBuildCount,
      coverageBufferUploadCount: state.coverageBufferUploadCount,
      coverageSignalNonzeroBinCount: state.coverageSignalNonzeroBinCount,
      renderedReadDensityAlpha: state.renderedReadDensityAlpha,
      densityRowsMeshVisible:
        state.densityRows?.mesh.visible === true ||
        state.coverageSignalInstancedLayer.diagnostics().active,
      coverageGpuAtlasAuthorityKey: coverageGpuAtlas.authorityKey,
      coverageGpuAtlasTextureResourceCreateCount: coverageGpuAtlas.textureResourceCreateCount,
      coverageGpuAtlasGpuTextureResourceCreateCount: coverageGpuAtlas.gpuTextureResourceCreateCount,
      coverageGpuAtlasGpuTextureUploadCount: coverageGpuAtlas.gpuTextureUploadCount,
      coverageGpuAtlasGpuTextureUploadComplete: coverageGpuAtlas.gpuTextureUploadComplete,
      coverageGpuAtlasTextureResourceUid: coverageGpuAtlas.textureResourceUid,
      coverageGpuAtlasShaderTextureResourceUid: coverageGpuAtlas.shaderTextureResourceUid,
      coverageGpuAtlasShaderTextureResourceBound: coverageGpuAtlas.shaderTextureResourceBound,
      coverageGpuAtlasGeometryBuildCount: coverageGpuAtlas.geometryBuildCount,
      coverageGpuAtlasCameraUniformUpdateCount: coverageGpuAtlas.cameraUniformUpdateCount,
      coverageGpuAtlasRenderOwner: coverageGpuAtlas.renderOwner,
      coverageGpuAtlasShaderProgramName: coverageGpuAtlas.shaderProgramName,
      coverageGpuAtlasShaderProgramKey: coverageGpuAtlas.shaderProgramKey,
      coverageGpuAtlasShaderProgramCompiled: coverageGpuAtlas.shaderProgramCompiled,
      coverageGpuAtlasActive: coverageGpuAtlas.active,
      coverageGpuAtlasBaseBinSizeBp: coverageGpuAtlas.baseBinSizeBp,
      coverageGpuAtlasDepthMax: coverageGpuAtlas.depthMax,
      rendererViewportStartBp: state.lastViewportStartBp,
      rendererViewportEndBp: state.lastViewportEndBp,
    };
  }

  getCoverageDepthSnapshot(container: Container): TrackCoverageDepthSnapshot | null {
    const state = this.containerState.get(container);
    if (!state) return null;
    return {
      coverageDepthP99: state.coverageSignal?.depthPercentiles?.p99 ?? null,
      coverageDepthMax: state.coverageSignal?.depthPercentiles?.max ?? null,
    };
  }

  getReadPresentationSnapshot(container: Container): TrackReadPresentationSnapshot | null {
    const state = this.containerState.get(container);
    if (!state) return null;
    const recordCount = state.rows ? state.rowsMeshRecordCount : 0;
    const visible =
      state.rows?.mesh.visible === true &&
      state.rows.vertexCount > 0 &&
      recordCount > 0 &&
      state.renderedReadRowsAlpha > READ_LOD_MESH_VISIBLE_ALPHA_EPSILON;
    const sourceCoversViewport = state.readSourceWindowCoverageFraction >= 0.999;
    const readsReady =
      visible &&
      sourceCoversViewport &&
      state.rowsMeshViewportCoverageFraction >= 0.999 &&
      !state.readSourceTruncated;
    const emptyReady =
      state.rows === null &&
      state.recordCount === 0 &&
      sourceCoversViewport &&
      !state.readSourceTruncated;
    return {
      kind: readsReady ? 'reads' : emptyReady ? 'empty' : 'pending',
      sourceGenerationKey: state.rows
        ? state.rowsMeshSourceGenerationKey
        : state.readSourceGenerationKey,
      presentationOwnerKey: state.readPresentationOwnerKey,
      viewStartBp: state.lastViewportStartBp,
      viewEndBp: state.lastViewportEndBp,
      sourceCoversViewport,
      meshCoverageFraction: state.rowsMeshViewportCoverageFraction,
      truncated: state.readSourceTruncated,
      visible,
      recordCount,
    };
  }

  unmount(container: Container): void {
    const state = this.containerState.get(container);
    if (state) {
      this.disposeBar(state, 'rows');
      this.disposeDensityRows(state);
      this.disposeOverflowRows(state);
      state.coverageGpuAtlasLayer.destroy();
      state.coverageSignalInstancedLayer.destroy();
      state.pendingIntervalLayer.destroy();
      state.readDifferenceLayer.destroy();
    }
    this.containerState.delete(container);
    container.destroy({ children: true });
  }

  private readRowsTopPx(): number {
    return 0;
  }

  private exactRowsAvailabilityAlpha(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    recordExtentCoversViewport: boolean,
    readSourceWindowCoversViewport: boolean,
    rowsMeshViewportCoverageFraction: number
  ): number {
    if (state.recordCount <= 0 || state.rows === null || state.readSourceTruncated) return 0;
    const viewStart = args.viewportBpRange.start;
    const viewEnd = args.viewportBpRange.end;
    const span = viewEnd - viewStart;
    if (span <= 0) return 0;

    const loadedStart =
      state.readSourceWindowStartBp !== null ? state.readSourceWindowStartBp : state.loadedStartBp;
    const loadedEnd =
      state.readSourceWindowEndBp !== null ? state.readSourceWindowEndBp : state.loadedEndBp;
    if (loadedEnd <= loadedStart) return recordExtentCoversViewport ? 1 : 0;
    const isStreaming =
      state.readSourceWindowStartBp !== null || state.readSourceWindowEndBp !== null;
    if (!isStreaming) return 1;
    if (readSourceWindowCoversViewport && rowsMeshViewportCoverageFraction >= 0.999) return 1;

    return rowsMeshViewportCoverageFraction > 0 ? 1 : 0;
  }

  private retireExactReadDetailPreparation(state: ContainerState): void {
    if (
      state.rowsAssignmentBuildJob === null &&
      state.rowsRetainBuildJob === null &&
      state.rowsMeshBuildJob === null &&
      !state.cachedRecordsExactDerived &&
      state.layout.retainedPlacementCount() === 0
    ) {
      return;
    }
    state.rowsAssignmentBuildJob = null;
    state.rowsAssignmentBuildRecordsLastFrame = 0;
    state.rowsRetainBuildJob = null;
    state.rowsRetainBuildRecordsLastFrame = 0;
    state.rowsMeshBuildJob = null;
    state.layout.reset();
    state.cachedReadRows = null;
    state.cachedReadHitIndex = null;
    state.cachedRecordsExactDerived = false;
    state.lastRowAssignment = null;
    state.readOccupancy = null;
    state.readRowHeightField = null;
    state.collapsedPileupField = null;
    this.resetCollapsedPileupStats(state);
  }

  private shouldDisposeReadRowsMesh(
    state: ContainerState,
    records: ReadonlyArray<PileupRecord> | null,
    rows: Int32Array | null,
    viewSpan: number,
    pixelsPerBp: number,
    meshStart: number,
    meshEnd: number,
    overlapStart: number,
    overlapEnd: number
  ): boolean {
    if (
      !records ||
      !rows ||
      records.length === 0 ||
      rows.length !== records.length ||
      state.loadedEndBp <= state.loadedStartBp ||
      state.effectiveMaxRows <= 0
    ) {
      return true;
    }
    if (viewSpan <= 0) return true;
    if (!pileupExactReadPreparationEligible(pixelsPerBp)) return true;
    if (meshEnd <= meshStart) return true;
    if (overlapEnd <= overlapStart) return true;
    return false;
  }

  private ensureReadRowsMesh(
    state: ContainerState,
    records: ReadonlyArray<PileupRecord> | null,
    rows: Int32Array | null,
    readHitIndex: PileupReadHitIndex | null,
    recordsKey: string,
    args: TrackPaintArgs<PileupTrackData>,
    readRowsTopPx: number,
    themedReadColor: number,
    deferBuildWork: boolean
  ): void {
    const viewStart = args.viewportBpRange.start;
    const viewEnd = args.viewportBpRange.end;
    const viewSpan = viewEnd - viewStart;
    const meshStart = state.readSourceWindowStartBp ?? state.loadedStartBp;
    const meshEnd = state.readSourceWindowEndBp ?? state.loadedEndBp;
    const overlapStart = Math.max(viewStart, meshStart);
    const overlapEnd = Math.min(viewEnd, meshEnd);
    const targetOverlapsViewport = overlapEnd > overlapStart;
    const frontOverlapsViewport =
      state.rows !== null &&
      state.rowsMeshRecordCount > 0 &&
      state.rows.vertexCount > 0 &&
      viewportCoverageFraction(state.rowsMeshStartBp, state.rowsMeshEndBp, viewStart, viewEnd) > 0;
    if (
      !targetOverlapsViewport &&
      frontOverlapsViewport &&
      records !== null &&
      rows !== null &&
      records.length > 0 &&
      rows.length === records.length
    ) {
      this.applyCamera(state.rows!, args, args.containerTopPx + readRowsTopPx);
      return;
    }
    if (
      this.shouldDisposeReadRowsMesh(
        state,
        records,
        rows,
        viewSpan,
        args.pathMapper.pixelsPerBp,
        meshStart,
        meshEnd,
        overlapStart,
        overlapEnd
      ) ||
      records === null ||
      rows === null ||
      readHitIndex === null
    ) {
      this.disposeBar(state, 'rows');
      return;
    }
    const rowsMeshColorKey = READ_ROWS_MESH_COLOR_KEY;
    const rowsY = args.containerTopPx + readRowsTopPx;
    const residentStrictlyContainsTarget =
      state.rows !== null &&
      state.rowsMeshRecordCount > 0 &&
      state.rowsMeshColorKey === rowsMeshColorKey &&
      state.rowsMeshSourceGenerationKey === state.readSourceGenerationKey &&
      state.rowsMeshStartBp <= meshStart &&
      state.rowsMeshEndBp >= meshEnd &&
      (state.rowsMeshStartBp < meshStart || state.rowsMeshEndBp > meshEnd) &&
      state.rowsMeshRecordsRef !== null &&
      readRecordsContain(state.rowsMeshRecordsRef, records);
    if (residentStrictlyContainsTarget) {
      state.rowsMeshBuildJob = null;
      this.applyCamera(state.rows!, args, rowsY);
      return;
    }
    if (
      state.rows &&
      state.rowsMeshBuildJob === null &&
      state.rowsMeshStartBp === meshStart &&
      state.rowsMeshEndBp === meshEnd &&
      state.rowsMeshRecordCount > 0 &&
      state.rowsMeshColorKey === rowsMeshColorKey &&
      state.rowsMeshSourceGenerationKey === state.readSourceGenerationKey &&
      state.rowsMeshRecordsKey === recordsKey &&
      state.rowsMeshRecordsRef === records
    ) {
      this.applyCamera(state.rows, args, rowsY);
      return;
    }

    const job = state.rowsMeshBuildJob;
    const jobStrictlyContainsTarget =
      job !== null &&
      job.colorKey === rowsMeshColorKey &&
      job.sourceGenerationKey === state.readSourceGenerationKey &&
      job.meshStart <= meshStart &&
      job.meshEnd >= meshEnd &&
      (job.meshStart < meshStart || job.meshEnd > meshEnd) &&
      readRecordsContain(job.records, records);
    const targetChanged =
      job !== null &&
      !jobStrictlyContainsTarget &&
      (job.meshStart !== meshStart ||
        job.meshEnd !== meshEnd ||
        job.colorKey !== rowsMeshColorKey ||
        job.sourceGenerationKey !== state.readSourceGenerationKey ||
        job.recordsKey !== recordsKey ||
        job.records !== records);

    if (
      job !== null &&
      targetChanged &&
      viewportCoverageFraction(
        job.meshStart,
        job.meshEnd,
        args.viewportBpRange.start,
        args.viewportBpRange.end
      ) >= 0.999
    ) {
      if (!deferBuildWork) this.advanceReadRowsMeshBuild(state, args, rowsY);
      return;
    }

    if (job === null || targetChanged) {
      let meshRecordCount = 0;
      for (const record of records) {
        if (record.end > meshStart && record.start < meshEnd) meshRecordCount += 1;
      }
      if (meshRecordCount === 0) {
        state.rowsMeshBuildJob = null;
        this.disposeBar(state, 'rows');
        state.rowsMeshStartBp = meshStart;
        state.rowsMeshEndBp = meshEnd;
        state.rowsMeshRecordCount = 0;
        state.rowsMeshColorKey = rowsMeshColorKey;
        return;
      }
      const backPool = state.rowsBack.pool;
      const grew = ensureVerticesPoolCapacity(backPool, meshRecordCount * 6);
      if (grew) {
        this.rowsMeshBufferAllocCount += 1;
        bumpReadRowsBufferAlloc();
      }
      state.rowsMeshBuildJob = {
        meshStart,
        meshEnd,
        colorKey: rowsMeshColorKey,
        recordCount: meshRecordCount,
        recordsKey,
        records,
        rows,
        hiddenReadCount: state.hiddenReadCount,
        collapsedPileupField: state.collapsedPileupField,
        readHitIndex,
        sourceGenerationKey: state.readSourceGenerationKey,
        job: beginAnnotationRecordVerticesJob(
          records,
          rows,
          {
            laneHeightPx: state.effectiveRowHeightPx,
            defaultColor: themedReadColor,
            includeRecord: (record) => record.end > meshStart && record.start < meshEnd,
          },
          { pool: backPool }
        ),
      };
    }

    if (!deferBuildWork) this.advanceReadRowsMeshBuild(state, args, rowsY);
  }

  private advanceReadRowsMeshBuild(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    rowsY: number
  ): void {
    const active = state.rowsMeshBuildJob;
    if (active) {
      const urgentReadRowsBuild =
        state.rows === null ||
        readRowsHandoffNeedsUrgentWork(
          state.rowsMeshStartBp,
          state.rowsMeshEndBp,
          active.meshStart,
          active.meshEnd,
          args.viewportBpRange.start,
          args.viewportBpRange.end
        );
      this.lastRowsMeshBuildRecordsThisFrame = advanceAnnotationRecordVerticesJob(
        active.job,
        urgentReadRowsBuild
          ? this.readRowsUrgentBuildRecordsPerFrame
          : this.readRowsBuildRecordsPerFrame
      );
      if (isAnnotationRecordVerticesJobComplete(active.job)) {
        const v = finishAnnotationRecordVerticesJob(active.job);
        this.commitReadRowsSwap(state, v, active, args, rowsY);
        state.rowsMeshBuildJob = null;
        this.rowsMeshBuildChunkCount += 1;
        return;
      }
      this.rowsMeshBuildChunkCount += 1;
    }

    if (state.rows) this.applyCamera(state.rows, args, rowsY);
  }

  private commitReadRowsSwap(
    state: ContainerState,
    v: ReturnType<typeof finishAnnotationRecordVerticesJob>,
    active: ReadRowsMeshBuildJob,
    args: TrackPaintArgs<PileupTrackData>,
    rowsY: number
  ): void {
    const back = state.rowsBack;
    const pool = back.pool;
    if (v.visibleRecordCount <= 0) {
      this.retireFrontToBack(state);
      state.rowsMeshStartBp = active.meshStart;
      state.rowsMeshEndBp = active.meshEnd;
      state.rowsMeshRecordCount = 0;
      state.rowsMeshColorKey = active.colorKey;
      state.rowsMeshRecordsKey = active.recordsKey;
      state.rowsMeshRecordsRef = active.records;
      state.rowsMeshRowsRef = active.rows;
      state.rowsMeshReadHitIndex = active.readHitIndex;
      state.rowsMeshSourceGenerationKey = active.sourceGenerationKey;
      state.rowsMeshHiddenReadCount = active.hiddenReadCount;
      state.rowsMeshCollapsedPileupField = active.collapsedPileupField;
      return;
    }

    this.degenerateVertexTail(pool, v.activeVertexCount);

    const needRebind = back.mesh === null || back.bufferCapacity < pool.capacityVertices;
    if (needRebind) {
      if (back.mesh) this.destroyBarMesh(back.mesh);
      back.mesh = this.buildBarMeshFromPool(state, pool, 'pileup-rows');
      back.bufferCapacity = pool.capacityVertices;
      this.rowsMeshBufferAllocCount += 1;
      bumpReadRowsBufferAlloc();
    } else {
      for (const buf of back.mesh!.buffers) buf.update();
    }
    back.mesh!.vertexCount = v.activeVertexCount;

    const newFront = back.mesh!;
    const oldFront = state.rows;
    const oldFrontPool = state.rowsVerticesPool;
    const oldFrontCapacity = state.rowsMeshBufferCapacity;

    state.rows = newFront;
    state.rowsVerticesPool = pool;
    state.rowsMeshBufferCapacity = back.bufferCapacity;

    back.mesh = oldFront;
    back.pool = oldFrontPool;
    back.bufferCapacity = oldFrontCapacity;
    back.meshStartBp = state.rowsMeshStartBp;
    back.meshEndBp = state.rowsMeshEndBp;
    back.recordCount = state.rowsMeshRecordCount;
    back.colorKey = state.rowsMeshColorKey;

    state.rowsMeshStartBp = active.meshStart;
    state.rowsMeshEndBp = active.meshEnd;
    state.rowsMeshRecordCount = active.recordCount;
    state.rowsMeshColorKey = active.colorKey;
    state.rowsMeshRecordsKey = active.recordsKey;
    state.rowsMeshRecordsRef = active.records;
    state.rowsMeshRowsRef = active.rows;
    state.rowsMeshReadHitIndex = active.readHitIndex;
    state.rowsMeshSourceGenerationKey = active.sourceGenerationKey;
    state.rowsMeshHiddenReadCount = active.hiddenReadCount;
    state.rowsMeshCollapsedPileupField = active.collapsedPileupField;

    if (back.mesh) {
      back.mesh.mesh.visible = false;
    }
    this.applyCamera(state.rows, args, rowsY);
  }

  private degenerateVertexTail(
    pool: AnnotationRecordVerticesPool,
    activeVertexCount: number
  ): void {
    const cap = pool.capacityVertices;
    if (activeVertexCount >= cap) return;
    pool.halfH.fill(0, activeVertexCount, cap);
    for (let vtx = activeVertexCount; vtx < cap; vtx++) pool.color[vtx * 4 + 3] = 0;
  }

  private retireFrontToBack(state: ContainerState): void {
    const back = state.rowsBack;
    if (back.mesh) this.destroyBarMesh(back.mesh);
    back.mesh = state.rows;
    back.pool = state.rowsVerticesPool;
    back.bufferCapacity = state.rowsMeshBufferCapacity;
    if (back.mesh) back.mesh.mesh.visible = false;
    state.rows = null;
    state.rowsVerticesPool = createAnnotationRecordVerticesPool();
    state.rowsMeshBufferCapacity = 0;
  }

  private buildColumnCapacityBuffers(columnCapacity = MAX_COLUMN_BARS): BarVertexBuffers {
    const n = Math.max(1, columnCapacity) * BAR_COLUMN_VERTS;
    return {
      bpStartChunk: new Float32Array(n),
      bpStartDelta: new Float32Array(n),
      bpEndChunk: new Float32Array(n),
      bpEndDelta: new Float32Array(n),
      offsetCenter: new Float32Array(n),
      halfH: new Float32Array(n),
      xSide: new Float32Array(n),
      ySide: new Float32Array(n),
      color: new Float32Array(n * 4),
    };
  }

  private updateCollapsedDensityRows(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    densityHeightPx: number,
    densityColor: number | undefined,
    themedReadColor: number
  ): void {
    const field = state.collapsedPileupField;
    const viewStart = args.viewportBpRange.start;
    const viewEnd = args.viewportBpRange.end;
    const span = viewEnd - viewStart;
    if (
      !collapsedFieldOverlapsViewport(field, viewStart, viewEnd) ||
      densityHeightPx <= 0 ||
      span <= 0
    ) {
      if (state.densityRows) state.densityRows.mesh.visible = false;
      this.resetDensityStats(state);
      return;
    }

    const N = pileupDensitySampleColumnCount(args.viewportWidthPx);
    const columnBp = span / N;
    const sampledVisibleRows = sampleUint16FieldMax(
      field,
      field.visibleRows,
      viewStart,
      viewEnd,
      columnBp,
      N
    );
    const color = densityColor ?? themedReadColor;
    const key = `${Math.round(viewStart)}:${Math.round(viewEnd)}:${N}:${Math.round(densityHeightPx)}:collapsed-area:${Math.round(field.startBp)}:${Math.round(field.endBp)}:${field.visibleRows.length}:${field.maxVisibleRows}:${color}`;
    const haveMesh = state.densityRows !== null && state.densityRowsArrays !== null;
    if (key === state.cachedDensityRowsKey && haveMesh) {
      const rowsY = args.containerTopPx + this.readRowsTopPx();
      this.applyCamera(state.densityRows!, args, rowsY);
      return;
    }

    if (!haveMesh) {
      const caps = this.buildColumnCapacityBuffers();
      state.densityRowsArrays = caps;
      state.densityRows = this.buildBarMesh(state, caps, 'pileup-read-density', 'continuous-fill');
    }
    const arrays = state.densityRowsArrays!;
    const cr = ((color >> 16) & 0xff) / 255;
    const cg = ((color >> 8) & 0xff) / 255;
    const cb = (color & 0xff) / 255;
    const contract = buildPileupVerticalScaleContract({
      rowHeightPx: state.effectiveRowHeightPx,
      effectiveMaxRows: state.effectiveMaxRows,
      maxHiddenCount: field.maxHiddenCount,
      overflowMinFillFraction: READ_OVERFLOW_MIN_FILL_FRACTION,
      overflowMaxFillFraction: READ_DENSITY_MAX_FILL_FRACTION,
      overflowMinDenominatorReads: READ_OVERFLOW_MIN_DENOMINATOR_READS,
    });

    const segmentHeights = new Float32Array(N);
    const pointHeights = new Float32Array(N + 1);
    for (let c = 0; c < N; c++) {
      const rows = sampledVisibleRows[c];
      segmentHeights[c] = Math.min(densityHeightPx, collapsedVisibleRowsHeightPx(contract, rows));
    }
    pointHeights[0] = segmentHeights[0] ?? 0;
    pointHeights[N] = segmentHeights[N - 1] ?? 0;
    for (let c = 1; c < N; c++) {
      pointHeights[c] = Math.max(segmentHeights[c - 1], segmentHeights[c]);
    }
    const drawnStats = createDensityFillStatsAccumulator();
    for (let c = 0; c < N; c++) {
      const startBp = viewStart + c * columnBp;
      const endBp = c === N - 1 ? viewEnd : startBp + columnBp;
      const h0 = pointHeights[c];
      const h1 = pointHeights[c + 1];
      const barH = Math.max(h0, h1);
      const fill = densityHeightPx > 0 ? barH / densityHeightPx : 0;
      recordDensityDrawnFill(
        drawnStats,
        fill,
        fill >= READ_DENSITY_MAX_FILL_FRACTION - 1e-4 || barH >= densityHeightPx - 1e-4
      );
      const base = c * 6;
      const ys = [0, h0, h1, 0, h1, 0];
      const xs = [0, 0, 1, 0, 1, 1];
      for (let k = 0; k < 6; k++) {
        const vtx = base + k;
        writePackedBpCoordinate(startBp, arrays.bpStartChunk, arrays.bpStartDelta, vtx);
        writePackedBpCoordinate(endBp, arrays.bpEndChunk, arrays.bpEndDelta, vtx);
        arrays.offsetCenter[vtx] = ys[k];
        arrays.halfH[vtx] = 0;
        arrays.xSide[vtx] = xs[k];
        arrays.ySide[vtx] = 0;
        const ci = vtx * 4;
        arrays.color[ci] = cr;
        arrays.color[ci + 1] = cg;
        arrays.color[ci + 2] = cb;
        arrays.color[ci + 3] = barH > 0 ? READ_DENSITY_BAR_ALPHA : 0;
      }
    }
    for (let vtx = N * 6; vtx < arrays.halfH.length; vtx++) {
      arrays.halfH[vtx] = 0;
      arrays.color[vtx * 4 + 3] = 0;
    }
    for (const buf of state.densityRows!.buffers) buf.update();

    const finishedDrawnStats = finishDensityDrawnFillStats(drawnStats);
    state.densityRowBinCount = finishedDrawnStats.visible;
    state.readDensityColumnCoverage = finishedDrawnStats.columnCoverage;
    state.readDensityMeanFill = finishedDrawnStats.meanFill;
    state.readDensityMaxFill = finishedDrawnStats.maxFill;
    state.readDensityRowStackMeanFill = finishedDrawnStats.meanFill;
    state.readDensityRowStackMaxFill = finishedDrawnStats.maxFill;
    state.readDensityMorph = 1;
    state.readDensityFillStdDev = finishedDrawnStats.stdDev;
    state.readDensitySourceDepthMean = 0;
    state.readDensitySourceDepthStdDev = 0;
    state.readDensitySourceDepthCv = 0;
    state.readDensitySourceDepthP10 = 0;
    state.readDensitySourceDepthP50 = 0;
    state.readDensitySourceDepthP90 = 0;
    state.readDensitySourceDepthP99 = 0;
    state.readDensitySourceDepthEdgeCount = 0;
    state.readDensitySourceDepthLongestFlatRunColumns = 0;
    state.readDensityDrawnFillStdDev = finishedDrawnStats.stdDev;
    state.readDensityDrawnEdgeCount = finishedDrawnStats.edgeCount;
    state.readDensityDrawnLongestFlatRunColumns = finishedDrawnStats.longestFlatRunColumns;
    state.readDensityClippedColumnFraction = finishedDrawnStats.clippedFraction;
    state.cachedDensityRowsKey = key;
    const rowsY = args.containerTopPx + this.readRowsTopPx();
    this.applyCamera(state.densityRows!, args, rowsY);
  }

  private publishCachedCoverageAggregateIfCurrent(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    key: string,
    tileEngineAuthority: boolean,
    haveMesh: boolean
  ): boolean | null {
    if (!(key === state.cachedDensityRowsKey && (tileEngineAuthority || haveMesh))) return null;
    const rowsY = args.containerTopPx + this.readRowsTopPx();
    if (tileEngineAuthority) {
      if (state.densityRows) state.densityRows.mesh.visible = false;
      this.applyCoverageSignalInstancedCamera(state, args, rowsY);
      return state.coverageSignalInstancedLayer.diagnostics().active;
    }
    state.coverageSignalInstancedLayer.setVisible(false);
    this.applyCamera(state.densityRows!, args, rowsY);
    return false;
  }

  private coverageAggregateClearAdmission(
    coverage: ContainerState['coverageSignal'],
    densityHeightPx: number,
    cameraSpan: number
  ): { hideDensityMesh: boolean; resetCoverageSample: boolean } | null {
    if (!coverage || coverage.bins.length === 0 || densityHeightPx <= 0) {
      return { hideDensityMesh: true, resetCoverageSample: true };
    }
    if (cameraSpan <= 0) {
      return { hideDensityMesh: false, resetCoverageSample: false };
    }
    return null;
  }

  private clearCoverageAggregateRows(
    state: ContainerState,
    options: { hideDensityMesh: boolean; resetCoverageSample: boolean }
  ): false {
    if (options.hideDensityMesh && state.densityRows) state.densityRows.mesh.visible = false;
    this.resetDensityStats(state);
    if (options.resetCoverageSample) {
      state.activeCoverageBinSize = 0;
      state.coverageSampledColumnCount = 0;
      state.coverageSampledNonzeroColumnCount = 0;
      state.coverageSampledMaxDepth = 0;
    }
    state.coverageSignalInstancedLayer.setVisible(false);
    return false;
  }

  private updateCoverageAggregateRows(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    densityHeightPx: number,
    rowStackMorph: number,
    densityColor: number | undefined,
    themedReadColor: number,
    allowExactFieldOverride: boolean,
    tileEngineAuthority: boolean,
    experimentalHybrid: ExperimentalHybridPresentation
  ): boolean {
    const morph = clamp01(rowStackMorph);
    const coverage = state.coverageSignal;
    const cameraStart = args.viewportBpRange.start;
    const cameraEnd = args.viewportBpRange.end;
    const cameraSpan = cameraEnd - cameraStart;
    const clearAdmission = this.coverageAggregateClearAdmission(
      coverage,
      densityHeightPx,
      cameraSpan
    );
    if (clearAdmission || !coverage) {
      return this.clearCoverageAggregateRows(
        state,
        clearAdmission ?? { hideDensityMesh: true, resetCoverageSample: true }
      );
    }

    const coverageStart = state.coverageStartBp;
    const coverageEnd = coverageStart + coverage.bins.length * coverage.binSize;
    const residentCoverageGeometry = isResidentCoverageGeometry({
      tileEngineAuthority,
      exact: coverage.provenance?.exact,
      cameraStart,
      cameraEnd,
      coverageStart,
      coverageEnd,
      binSize: coverage.binSize,
      viewportWidthPx: args.viewportWidthPx,
      cameraSpan,
      binCount: coverage.bins.length,
      maxResidentColumns: MAX_RESIDENT_COVERAGE_COLUMNS,
    });
    const viewStart = residentCoverageGeometry ? coverageStart : cameraStart;
    const viewEnd = residentCoverageGeometry ? coverageEnd : cameraEnd;
    const span = viewEnd - viewStart;

    const N = residentCoverageGeometry
      ? coverage.bins.length
      : Math.min(pileupDensitySampleColumnCount(args.viewportWidthPx), MAX_COVERAGE_COLUMNS);
    const columnBp = span / N;
    const morphBucket = Math.round(morph * 1000);
    const hybridField = experimentalHybrid.active ? state.rowsMeshCollapsedPileupField : null;
    const heightFieldKey = experimentalHybrid.active
      ? hybridField
        ? `hybrid:${state.rowsMeshRecordsKey}:${Math.round(hybridField.startBp)}:${Math.round(hybridField.endBp)}:${hybridField.binSizeBp}:${hybridField.sourceRows.length}`
        : 'hybrid:none'
      : coverageHeightFieldKey(state.readRowHeightField);
    const color = experimentalHybrid.active
      ? experimentalHybrid.surfaceColor
      : (densityColor ?? themedReadColor);
    const fieldKey = experimentalHybrid.active
      ? heightFieldKey
      : coverageExactFieldKey(allowExactFieldOverride, state.collapsedPileupField);
    const coverageScaleMode = readCoverageScaleMode();
    const coverageScaleKey = experimentalHybrid.active ? 'hybrid-row-linear' : coverageScaleMode;
    const coverageStatistic = experimentalHybrid.active ? 'mean' : readCoverageStatistic();
    const forcedPresentationBinSize = forcedCoveragePresentationBinSize(
      (import.meta as ImportMeta & { readonly env: { readonly DEV: boolean } }).env.DEV,
      (globalThis as { __dna708ForceCoverageLevel?: unknown }).__dna708ForceCoverageLevel
    );
    const depthPct = coverage.depthPercentiles;
    const pctKey = depthPct ? `${depthPct.p95}-${depthPct.p99}-${depthPct.max}` : 'nopct';
    const cutoffDepth = resolveCoverageCutoffDepth(args.data?.coverageCutoffDepth, 0);
    const cutoffKey = Math.round(cutoffDepth);
    const viewStartCol = Math.round(viewStart / columnBp);
    const viewEndCol = Math.round(viewEnd / columnBp);
    const key = coverageAggregateMeshKey({
      resident: residentCoverageGeometry,
      viewStartCol,
      viewEndCol,
      columnCount: N,
      densityHeightPx,
      morphBucket,
      heightFieldKey,
      fieldKey,
      color,
      coverageScaleMode: coverageScaleKey,
      coverageStatistic,
      cutoffKey,
      pctKey,
      forcedPresentationBinSize,
    });
    state.activeCoverageBinSize = coverage.binSize;
    let haveMesh = state.densityRows !== null && state.densityRowsArrays !== null;
    if (
      !tileEngineAuthority &&
      haveMesh &&
      state.densityRowsArrays!.offsetCenter.length < N * DENSITY_COLUMN_VERTS
    ) {
      this.disposeDensityRows(state);
      haveMesh = false;
    }
    const cachedCoverage = this.publishCachedCoverageAggregateIfCurrent(
      state,
      args,
      key,
      tileEngineAuthority,
      haveMesh
    );
    if (cachedCoverage !== null) return cachedCoverage;

    if (!tileEngineAuthority && !haveMesh) {
      const caps = this.buildColumnCapacityBuffers(residentCoverageGeometry ? N : MAX_COLUMN_BARS);
      state.densityRowsArrays = caps;
      state.densityRows = this.buildBarMesh(state, caps, 'pileup-read-density', 'continuous-fill');
    }
    const arrays = tileEngineAuthority ? null : state.densityRowsArrays!;
    const sbs = coverage.binSize;
    const sbins = coverage.bins;
    const coverageStartBp = state.coverageStartBp;
    const cr = ((color >> 16) & 0xff) / 255;
    const cg = ((color >> 8) & 0xff) / 255;
    const cb = (color & 0xff) / 255;
    const visibleRowCapacity = Math.max(
      1,
      densityHeightPx / Math.max(1, state.effectiveRowHeightPx)
    );
    const contract = buildPileupVerticalScaleContract({
      rowHeightPx: state.effectiveRowHeightPx,
      effectiveMaxRows: state.effectiveMaxRows,
      maxHiddenCount: state.collapsedPileupField?.maxHiddenCount ?? state.overflowMaxHiddenReads,
      overflowMinFillFraction: READ_OVERFLOW_MIN_FILL_FRACTION,
      overflowMaxFillFraction: READ_DENSITY_MAX_FILL_FRACTION,
      overflowMinDenominatorReads: READ_OVERFLOW_MIN_DENOMINATOR_READS,
    });
    const collapsedMaxFill =
      densityHeightPx > 0
        ? clamp01(collapsedVisibleRowsHeightPx(contract, state.effectiveMaxRows) / densityHeightPx)
        : 0;
    const maxDepth = Math.max(
      1,
      state.coverageMaxDepth || coverage.bins.reduce((m, d) => Math.max(m, d), 0)
    );
    const depthDenominator = this.coverageScale === 'log' ? Math.log1p(maxDepth) : maxDepth;
    const rowStackHeights = experimentalHybrid.active
      ? hybridField
        ? sampleUint16FieldMax(hybridField, hybridField.sourceRows, viewStart, viewEnd, columnBp, N)
        : null
      : morph > 0
        ? sampleReadRowHeightField(state.readRowHeightField, viewStart, viewEnd, columnBp, N)
        : null;

    const field = experimentalHybrid.active ? hybridField : state.collapsedPileupField;
    const fieldDepths = field?.peakDepthRows ?? null;
    const useFieldBase =
      !experimentalHybrid.active &&
      shouldUseExactFieldBase(allowExactFieldOverride, field, fieldDepths, sbs);

    if (!this.coverageDepthScratch || this.coverageDepthScratch.length < N) {
      this.coverageDepthScratch = new Float32Array(Math.max(MAX_COLUMN_BARS, N));
    }
    const sampledDepths = this.coverageDepthScratch.subarray(0, N);
    const useMean = experimentalHybrid.active || coverageStatistic === 'mean';
    state.coverageSamplePassCount += 1;
    const { depthVisible, depthSum, depthSumSq, sampledMaxDepth } =
      sampleCoverageAggregateColumnDepths({
        columnCount: N,
        viewStart,
        columnBp,
        forcedPresentationBinSize,
        useFieldBase,
        fieldDepths,
        field: field ?? null,
        coverageBins: sbins,
        coverageBinSize: sbs,
        coverageStartBp,
        useMean,
        sampledDepths,
      });

    if (
      !experimentalHybrid.active &&
      COVERAGE_SMOOTH_KERNEL.length > 1 &&
      N > COVERAGE_SMOOTH_KERNEL.length
    ) {
      if (!this.coverageGaussianScratch || this.coverageGaussianScratch.length < N) {
        this.coverageGaussianScratch = new Float32Array(Math.max(MAX_COLUMN_BARS, N));
      }
      smoothCoverageColumnsInPlace(sampledDepths, this.coverageGaussianScratch);
    }

    const depthMean = depthVisible > 0 ? depthSum / depthVisible : 0;
    state.coverageSampledColumnCount = N;
    state.coverageSampledNonzeroColumnCount = depthVisible;
    state.coverageSampledMaxDepth = sampledMaxDepth;
    const depthStdDev =
      depthVisible > 0
        ? Math.sqrt(Math.max(0, depthSumSq / depthVisible - depthMean * depthMean))
        : 0;
    const depthCv = depthMean > 0 ? depthStdDev / depthMean : 0;
    if (!this.coverageQuantileScratch || this.coverageQuantileScratch.length < N) {
      this.coverageQuantileScratch = new Float32Array(Math.max(MAX_COLUMN_BARS, N));
    }
    const sourceDepthStats = summarizeSourceDepths(sampledDepths, this.coverageQuantileScratch);
    const contrastPolicy = resolveCoverageContrastPolicy({
      tileEngineAuthority,
      depthVisible,
      depthCv,
      depthMean,
      depthStdDev,
      collapsedMaxFill,
      minFillFraction: READ_DENSITY_MIN_FILL_FRACTION,
      sourceP10: sourceDepthStats.p10,
      sourceP50: sourceDepthStats.p50,
      sourceP90: sourceDepthStats.p90,
    });
    if (!this.coverageSegmentScratch || this.coverageSegmentScratch.length < N) {
      this.coverageSegmentScratch = new Float32Array(Math.max(MAX_COLUMN_BARS, N));
    }
    const segmentHeights = this.coverageSegmentScratch.subarray(0, N);
    const globalPct: CoverageDepthPercentiles | null =
      depthPct !== undefined && depthPct.max > 0 && collapsedMaxFill > 0 ? depthPct : null;
    let exactColumnMask: Uint8Array | null = null;
    if (experimentalHybrid.active && hybridField) {
      if (!this.hybridExactMaskScratch || this.hybridExactMaskScratch.length < N) {
        this.hybridExactMaskScratch = new Uint8Array(Math.max(MAX_COLUMN_BARS, N));
      }
      exactColumnMask = this.hybridExactMaskScratch.subarray(0, N);
      for (let column = 0; column < N; column += 1) {
        const columnStartBp = viewStart + column * columnBp;
        const columnEndBp = columnStartBp + columnBp;
        exactColumnMask[column] =
          columnStartBp < hybridField.endBp && columnEndBp > hybridField.startBp ? 1 : 0;
      }
    }
    let rowStackVisible: number;
    let rowStackFillSum: number;
    let rowStackMaxFill: number;
    if (experimentalHybrid.active) {
      const stats = fillExperimentalHybridPileupSegmentHeights({
        columnCount: N,
        sampledDepths,
        packedSourceRows: rowStackHeights,
        exactColumnMask,
        effectiveMaxRows: state.effectiveMaxRows,
        rowPitchPx: state.effectiveRowHeightPx,
        morph,
        segmentHeights,
      });
      rowStackVisible = stats.packedVisible;
      rowStackFillSum = stats.packedFillSum;
      rowStackMaxFill = stats.packedMaxFill;
    } else {
      const stats = fillCoverageSegmentHeights({
        columnCount: N,
        sampledDepths,
        cutoffDepth,
        globalPct,
        fillCutoff: (d) => coverageGpuAtlasHeightCutoffFill(d, cutoffDepth, collapsedMaxFill),
        fillFromGlobalPercentiles: (d) => {
          if (!globalPct) return 0;
          return coverageFill(d, globalPct, coverageScaleMode, collapsedMaxFill, cutoffDepth);
        },
        fillFromContrast: (d) =>
          coverageDepthFillFraction(
            d,
            contrastPolicy,
            this.coverageScale,
            depthDenominator,
            READ_DENSITY_MIN_FILL_FRACTION
          ),
        rowStackHeights,
        visibleRowCapacity,
        morph,
        maxRowStackFillFraction: READ_DENSITY_MAX_FILL_FRACTION,
        densityHeightPx,
        segmentHeights,
      });
      rowStackVisible = stats.rowStackVisible;
      rowStackFillSum = stats.rowStackFillSum;
      rowStackMaxFill = stats.rowStackMaxFill;
    }
    return this.publishCoverageAggregateGeometry(state, args, {
      columnCount: N,
      viewStart,
      viewEnd,
      columnBp,
      segmentHeights,
      densityHeightPx,
      arrays,
      cr,
      cg,
      cb,
      color,
      rowStackVisible,
      rowStackFillSum,
      rowStackMaxFill,
      hasRowStackHeights: Boolean(rowStackHeights),
      morph,
      depthMean,
      depthStdDev,
      depthCv,
      sourceDepthStats,
      cacheKey: key,
      tileEngineAuthority,
      baselinePx: experimentalHybrid.active ? 0.5 : 0,
      stepped: experimentalHybrid.active,
    });
  }

  private publishCoverageAggregateGeometry(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    params: {
      columnCount: number;
      viewStart: number;
      viewEnd: number;
      columnBp: number;
      segmentHeights: Float32Array;
      densityHeightPx: number;
      arrays: BarVertexBuffers | null;
      cr: number;
      cg: number;
      cb: number;
      color: number;
      rowStackVisible: number;
      rowStackFillSum: number;
      rowStackMaxFill: number;
      hasRowStackHeights: boolean;
      morph: number;
      depthMean: number;
      depthStdDev: number;
      depthCv: number;
      sourceDepthStats: SourceDepthStats;
      cacheKey: string;
      tileEngineAuthority: boolean;
      baselinePx: number;
      stepped: boolean;
    }
  ): boolean {
    const {
      columnCount: N,
      viewStart,
      viewEnd,
      columnBp,
      segmentHeights,
      densityHeightPx,
      arrays,
      cr,
      cg,
      cb,
      color,
      rowStackVisible,
      rowStackFillSum,
      rowStackMaxFill,
      hasRowStackHeights,
      morph,
      depthMean,
      depthStdDev,
      depthCv,
      sourceDepthStats,
      cacheKey,
      tileEngineAuthority,
      baselinePx,
      stepped,
    } = params;
    const drawnStats = createDensityFillStatsAccumulator();
    state.coverageGeometryBuildCount += 1;
    for (let c = 0; c < N; c++) {
      const startBp = viewStart + c * columnBp;
      const endBp = c === N - 1 ? viewEnd : startBp + columnBp;
      const barH = segmentHeights[c] ?? 0;
      const fill = densityHeightPx > 0 ? barH / densityHeightPx : 0;
      recordDensityDrawnFill(
        drawnStats,
        fill,
        fill >= READ_DENSITY_MAX_FILL_FRACTION - 1e-4 || barH >= densityHeightPx - 1e-4
      );
      const hL = stepped || c === 0 ? barH : (segmentHeights[c - 1] + barH) * 0.5;
      const hR = stepped || c === N - 1 ? barH : (segmentHeights[c + 1] + barH) * 0.5;
      if (arrays) {
        this.writeBarTrapezoid(
          arrays,
          c * DENSITY_COLUMN_VERTS,
          startBp,
          endBp,
          baselinePx + hL,
          baselinePx + hR,
          cr,
          cg,
          cb,
          barH > 0 ? READ_DENSITY_BAR_ALPHA : 0,
          baselinePx
        );
      }
    }
    if (arrays) {
      for (let vtx = N * DENSITY_COLUMN_VERTS; vtx < arrays.halfH.length; vtx++) {
        arrays.halfH[vtx] = 0;
        arrays.color[vtx * 4 + 3] = 0;
      }
      for (const buf of state.densityRows!.buffers) buf.update();
      state.coverageBufferUploadCount += state.densityRows!.buffers.length;
      state.coverageSignalInstancedLayer.setVisible(false);
    } else {
      if (state.densityRows) state.densityRows.mesh.visible = false;
      state.coverageSignalInstancedLayer.update({
        viewStartBp: viewStart,
        viewEndBp: viewEnd,
        segmentHeights,
        color,
      });
      state.coverageBufferUploadCount += 1;
    }

    const finishedDrawnStats = finishDensityDrawnFillStats(drawnStats);
    state.densityRowBinCount = finishedDrawnStats.visible;
    state.readDensityColumnCoverage = finishedDrawnStats.columnCoverage;
    state.readDensityMeanFill = finishedDrawnStats.meanFill;
    state.readDensityMaxFill = finishedDrawnStats.maxFill;
    state.readDensityRowStackMeanFill = rowStackVisible > 0 ? rowStackFillSum / rowStackVisible : 0;
    state.readDensityRowStackMaxFill = rowStackMaxFill;
    state.readDensityMorph = hasRowStackHeights ? morph : 0;
    state.readDensityFillStdDev = finishedDrawnStats.stdDev;
    state.readDensitySourceDepthMean = depthMean;
    state.readDensitySourceDepthStdDev = depthStdDev;
    state.readDensitySourceDepthCv = depthCv;
    state.readDensitySourceDepthP10 = sourceDepthStats.p10;
    state.readDensitySourceDepthP50 = sourceDepthStats.p50;
    state.readDensitySourceDepthP90 = sourceDepthStats.p90;
    state.readDensitySourceDepthP99 = sourceDepthStats.p99;
    state.readDensitySourceDepthEdgeCount = sourceDepthStats.edgeCount;
    state.readDensitySourceDepthLongestFlatRunColumns = sourceDepthStats.longestFlatRunColumns;
    state.readDensityDrawnFillStdDev = finishedDrawnStats.stdDev;
    state.readDensityDrawnEdgeCount = finishedDrawnStats.edgeCount;
    state.readDensityDrawnLongestFlatRunColumns = finishedDrawnStats.longestFlatRunColumns;
    state.readDensityClippedColumnFraction = finishedDrawnStats.clippedFraction;
    state.cachedDensityRowsKey = cacheKey;
    const rowsY = args.containerTopPx + this.readRowsTopPx();
    if (tileEngineAuthority) {
      this.applyCoverageSignalInstancedCamera(state, args, rowsY);
      return state.coverageSignalInstancedLayer.diagnostics().active;
    }
    this.applyCamera(state.densityRows!, args, rowsY);
    return false;
  }

  private clearOverflowRows(state: ContainerState, hideMesh: boolean): void {
    if (hideMesh && state.overflowRows) state.overflowRows.mesh.visible = false;
    this.resetOverflowStats(state);
  }

  private overflowPaintClearMode(args: {
    field: ContainerState['rowsMeshCollapsedPileupField'];
    records: ContainerState['rowsMeshRecordsRef'];
    rows: ContainerState['rowsMeshRowsRef'];
    hiddenReadCount: number;
    overflowHeightPx: number;
    span: number;
  }): { hideMesh: boolean } | null {
    if (
      !overflowRowsHavePaintableSource({
        hasField: Boolean(args.field),
        hasRecords: Boolean(args.records),
        hasRows: Boolean(args.rows),
        recordCount: args.records?.length ?? 0,
        rowCount: args.rows?.length ?? 0,
        hiddenReadCount: args.hiddenReadCount,
        overflowHeightPx: args.overflowHeightPx,
      })
    ) {
      return { hideMesh: true };
    }
    if (args.span <= 0) return { hideMesh: false };
    return null;
  }

  private paintExperimentalHybridOverflowRows(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    overflowHeightPx: number,
    themedReadColor: number,
    experimentalHybrid: ExperimentalHybridPresentation
  ): void {
    const coverage = state.coverageSignal;
    const viewStart = args.viewportBpRange.start;
    const viewEnd = args.viewportBpRange.end;
    const viewSpan = viewEnd - viewStart;
    if (!coverage || coverage.bins.length === 0 || overflowHeightPx <= 0 || viewSpan <= 0) {
      this.clearOverflowRows(state, true);
      return;
    }

    const coverageStart = state.coverageStartBp;
    const coverageEnd = coverageStart + coverage.bins.length * coverage.binSize;
    const residentGeometry = coverage.bins.length <= MAX_COLUMN_BARS;
    const geometryStartBp = residentGeometry ? coverageStart : viewStart;
    const geometryEndBp = residentGeometry ? coverageEnd : viewEnd;
    const N = residentGeometry
      ? coverage.bins.length
      : Math.min(pileupDensitySampleColumnCount(args.viewportWidthPx), MAX_COLUMN_BARS);
    const columnBp = (geometryEndBp - geometryStartBp) / Math.max(1, N);
    if (N <= 0 || columnBp <= 0) {
      this.clearOverflowRows(state, true);
      return;
    }

    if (!this.coverageDepthScratch || this.coverageDepthScratch.length < N) {
      this.coverageDepthScratch = new Float32Array(Math.max(MAX_COLUMN_BARS, N));
    }
    const sampledDepths = this.coverageDepthScratch.subarray(0, N);
    sampleCoverageAggregateColumnDepths({
      columnCount: N,
      viewStart: geometryStartBp,
      columnBp,
      forcedPresentationBinSize: null,
      useFieldBase: false,
      fieldDepths: null,
      field: null,
      coverageBins: coverage.bins,
      coverageBinSize: coverage.binSize,
      coverageStartBp: coverageStart,
      useMean: true,
      sampledDepths,
    });

    const field = collapsedFieldOverlapsViewport(
      state.rowsMeshCollapsedPileupField,
      geometryStartBp,
      geometryEndBp
    )
      ? state.rowsMeshCollapsedPileupField
      : null;
    const exactHiddenCounts = field
      ? sampleUint16FieldMax(field, field.hiddenCounts, geometryStartBp, geometryEndBp, columnBp, N)
      : null;
    let exactColumnMask: Uint8Array | null = null;
    if (field) {
      if (!this.hybridExactMaskScratch || this.hybridExactMaskScratch.length < N) {
        this.hybridExactMaskScratch = new Uint8Array(Math.max(MAX_COLUMN_BARS, N));
      }
      exactColumnMask = this.hybridExactMaskScratch.subarray(0, N);
      for (let column = 0; column < N; column += 1) {
        const columnStartBp = geometryStartBp + column * columnBp;
        const columnEndBp = columnStartBp + columnBp;
        exactColumnMask[column] =
          columnStartBp < field.endBp && columnEndBp > field.startBp ? 1 : 0;
      }
    }
    if (!this.hybridOverflowCountScratch || this.hybridOverflowCountScratch.length < N) {
      this.hybridOverflowCountScratch = new Float32Array(Math.max(MAX_COLUMN_BARS, N));
    }
    const hiddenCounts = this.hybridOverflowCountScratch.subarray(0, N);
    const drawnMaxHidden = fillExperimentalHybridOverflowCounts({
      columnCount: N,
      sampledDepths,
      exactHiddenCounts,
      exactColumnMask,
      effectiveMaxRows: state.effectiveMaxRows,
      morph: experimentalHybrid.morphProgress,
      hiddenCounts,
    });
    const scaleMaxHidden = Math.max(
      0,
      state.coverageMaxDepth - state.effectiveMaxRows,
      field?.maxHiddenCount ?? 0
    );
    const color = experimentalHybrid.surfaceColor;
    const key = [
      'hybrid-overflow',
      state.cachedCoverageRevision ?? coverage.coverageRevision ?? 'unrevisioned',
      residentGeometry ? 'resident' : 'camera',
      Math.round(geometryStartBp / columnBp),
      Math.round(geometryEndBp / columnBp),
      N,
      Math.round(overflowHeightPx),
      Math.round(experimentalHybrid.morphProgress * 1000),
      experimentalHybrid.generationKey,
      field?.binSizeBp ?? 'none',
      color,
    ].join(':');
    const haveMesh = state.overflowRows !== null && state.overflowRowsArrays !== null;
    if (key === state.cachedOverflowRowsKey && haveMesh) {
      this.applyCamera(state.overflowRows!, args, args.containerTopPx + this.readRowsTopPx());
      return;
    }
    if (!haveMesh) {
      const caps = this.buildColumnCapacityBuffers();
      state.overflowRowsArrays = caps;
      state.overflowRows = this.buildBarMesh(
        state,
        caps,
        'pileup-read-overflow',
        'continuous-fill'
      );
    }

    const arrays = state.overflowRowsArrays!;
    const cr = ((color >> 16) & 0xff) / 255;
    const cg = ((color >> 8) & 0xff) / 255;
    const cb = (color & 0xff) / 255;
    const contract = buildPileupVerticalScaleContract({
      rowHeightPx: state.effectiveRowHeightPx,
      effectiveMaxRows: state.effectiveMaxRows,
      maxHiddenCount: scaleMaxHidden,
      overflowMinFillFraction: READ_OVERFLOW_MIN_FILL_FRACTION,
      overflowMaxFillFraction: READ_DENSITY_MAX_FILL_FRACTION,
      overflowMinDenominatorReads: READ_OVERFLOW_MIN_DENOMINATOR_READS,
    });
    const segmentTopY = new Float32Array(N);
    let visible = 0;
    let fillSum = 0;
    let maxFill = 0;
    for (let column = 0; column < N; column += 1) {
      const fill = overflowFillForHiddenCount(contract, hiddenCounts[column] ?? 0);
      segmentTopY[column] = contract.sourceRowsHeightPx + fill * overflowHeightPx;
      if (fill <= 0) continue;
      visible += 1;
      fillSum += fill;
      maxFill = Math.max(maxFill, fill);
    }
    const pointTopY = new Float32Array(N + 1);
    pointTopY[0] = segmentTopY[0] ?? contract.sourceRowsHeightPx;
    pointTopY[N] = segmentTopY[N - 1] ?? contract.sourceRowsHeightPx;
    for (let column = 1; column < N; column += 1) {
      pointTopY[column] = Math.max(segmentTopY[column - 1], segmentTopY[column]);
    }
    for (let column = 0; column < N; column += 1) {
      const startBp = geometryStartBp + column * columnBp;
      const endBp = column === N - 1 ? geometryEndBp : startBp + columnBp;
      const top0 = pointTopY[column];
      const top1 = pointTopY[column + 1];
      const hasFill = top0 > contract.sourceRowsHeightPx || top1 > contract.sourceRowsHeightPx;
      this.writeBarTrapezoid(
        arrays,
        column * BAR_COLUMN_VERTS,
        startBp,
        endBp,
        top0,
        top1,
        cr,
        cg,
        cb,
        hasFill ? READ_OVERFLOW_BAR_ALPHA : 0,
        contract.sourceRowsHeightPx
      );
    }
    for (let vertex = N * BAR_COLUMN_VERTS; vertex < arrays.halfH.length; vertex += 1) {
      arrays.halfH[vertex] = 0;
      arrays.color[vertex * 4 + 3] = 0;
    }
    for (const buffer of state.overflowRows!.buffers) buffer.update();

    state.overflowRowsRecordsKey = state.rowsMeshRecordsKey;
    state.overflowGeometryBuildCount += 1;
    state.overflowRowBinCount = visible;
    state.overflowColumnCoverage = visible / N;
    state.overflowMeanFill = visible > 0 ? fillSum / visible : 0;
    state.overflowMaxFill = maxFill;
    state.overflowMaxHiddenReads = Math.max(scaleMaxHidden, drawnMaxHidden);
    state.overflowMorph = experimentalHybrid.morphProgress;
    state.overflowBaseMinPx = visible > 0 ? contract.sourceRowsHeightPx : 0;
    state.overflowBaseMaxPx = visible > 0 ? contract.sourceRowsHeightPx : 0;
    state.cachedOverflowRowsKey = key;
    this.applyCamera(state.overflowRows!, args, args.containerTopPx + this.readRowsTopPx());
  }

  private paintOverflowRows(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    overflowHeightPx: number,
    rowStackMorph: number,
    themedReadColor: number,
    experimentalHybrid: ExperimentalHybridPresentation
  ): void {
    if (experimentalHybrid.active) {
      this.paintExperimentalHybridOverflowRows(
        state,
        args,
        overflowHeightPx,
        themedReadColor,
        experimentalHybrid
      );
      return;
    }
    const records = state.rowsMeshRecordsRef;
    const rows = state.rowsMeshRowsRef;
    const field = collapsedFieldOverlapsViewport(
      state.rowsMeshCollapsedPileupField,
      args.viewportBpRange.start,
      args.viewportBpRange.end
    )
      ? state.rowsMeshCollapsedPileupField
      : null;
    const viewStart = args.viewportBpRange.start;
    const viewEnd = args.viewportBpRange.end;
    const span = viewEnd - viewStart;
    const overflowClear = this.overflowPaintClearMode({
      field,
      records,
      rows,
      hiddenReadCount: state.rowsMeshHiddenReadCount,
      overflowHeightPx,
      span,
    });
    if (overflowClear) {
      this.clearOverflowRows(state, overflowClear.hideMesh);
      return;
    }

    const { exactSourceStartBp, exactSourceEndBp, hasExactSourceDomain } =
      overflowExactSourceDomain({
        hasField: Boolean(field),
        records,
        rows,
        readSourceWindowStartBp: state.readSourceWindowStartBp,
        readSourceWindowEndBp: state.readSourceWindowEndBp,
        loadedStartBp: state.loadedStartBp,
        loadedEndBp: state.loadedEndBp,
      });
    const {
      columnCount: N,
      geometryStartBp,
      geometryEndBp,
      columnBp,
    } = overflowGeometryWindow({
      field,
      hasExactSourceDomain,
      exactSourceStartBp,
      exactSourceEndBp,
      viewStart,
      viewEnd,
      maxColumnBars: MAX_COLUMN_BARS,
      cameraColumnCount: pileupDensitySampleColumnCount(args.viewportWidthPx),
    });
    const morph = clamp01(rowStackMorph);
    const morphBucket = Math.round(morph * 1000);
    const key = overflowMeshKey({
      field,
      hasExactSourceDomain,
      viewStart,
      viewEnd,
      columnCount: N,
      overflowHeightPx,
      recordsKey: state.rowsMeshRecordsKey,
      hiddenReadCount: state.rowsMeshHiddenReadCount,
      morphBucket,
      themedReadColor,
    });
    const haveMesh = state.overflowRows !== null && state.overflowRowsArrays !== null;
    if (key === state.cachedOverflowRowsKey && haveMesh) {
      const rowsY = args.containerTopPx + this.readRowsTopPx();
      this.applyCamera(state.overflowRows!, args, rowsY);
      return;
    }

    if (!haveMesh) {
      const caps = this.buildColumnCapacityBuffers();
      state.overflowRowsArrays = caps;
      state.overflowRows = this.buildBarMesh(
        state,
        caps,
        'pileup-read-overflow',
        'continuous-fill'
      );
    }
    const arrays = state.overflowRowsArrays!;
    const counts = field
      ? field.hiddenCounts.length === N
        ? field.hiddenCounts
        : sampleUint16FieldMax(
            field,
            field.hiddenCounts,
            geometryStartBp,
            geometryEndBp,
            columnBp,
            N
          )
      : new Uint16Array(N);
    const visibleRows = field
      ? field.visibleRows.length === N
        ? field.visibleRows
        : sampleUint16FieldMax(
            field,
            field.visibleRows,
            geometryStartBp,
            geometryEndBp,
            columnBp,
            N
          )
      : new Uint16Array(N);
    let maxHidden = field?.maxHiddenCount ?? 0;

    if (!field && records && rows) {
      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (rec.end <= geometryStartBp || rec.start >= geometryEndBp) continue;
        const c0 = Math.max(
          0,
          Math.min(N - 1, Math.floor((rec.start - geometryStartBp) / columnBp))
        );
        const c1 = Math.max(c0 + 1, Math.min(N, Math.ceil((rec.end - geometryStartBp) / columnBp)));
        if (rows[i] < 0) {
          for (let c = c0; c < c1; c++) {
            const next = Math.min(65535, counts[c] + 1);
            counts[c] = next;
            if (next > maxHidden) maxHidden = next;
          }
        } else {
          const rowHeight = Math.min(65535, rows[i] + 1);
          for (let c = c0; c < c1; c++) if (rowHeight > visibleRows[c]) visibleRows[c] = rowHeight;
        }
      }
    }

    const color = themedReadColor;
    const cr = ((color >> 16) & 0xff) / 255;
    const cg = ((color >> 8) & 0xff) / 255;
    const cb = (color & 0xff) / 255;
    const contract = buildPileupVerticalScaleContract({
      rowHeightPx: state.effectiveRowHeightPx,
      effectiveMaxRows: state.effectiveMaxRows,
      maxHiddenCount: maxHidden,
      overflowMinFillFraction: READ_OVERFLOW_MIN_FILL_FRACTION,
      overflowMaxFillFraction: READ_DENSITY_MAX_FILL_FRACTION,
      overflowMinDenominatorReads: READ_OVERFLOW_MIN_DENOMINATOR_READS,
    });
    let visible = 0;
    let fillSum = 0;
    let maxFill = 0;
    let baseMin = Infinity;
    let baseMax = -Infinity;
    const segmentBaseY = new Float32Array(N);
    const segmentTopY = new Float32Array(N);

    for (let c = 0; c < N; c++) {
      const count = counts[c];
      const fill = overflowFillForHiddenCount(contract, count);
      const barH = fill * overflowHeightPx;
      const baseY = overflowBaseYForMorph(contract, visibleRows[c], morph);
      segmentBaseY[c] = baseY;
      segmentTopY[c] = baseY + barH;
      if (fill > 0) {
        visible++;
        fillSum += fill;
        if (fill > maxFill) maxFill = fill;
        if (baseY < baseMin) baseMin = baseY;
        if (baseY > baseMax) baseMax = baseY;
      }
    }

    const pointBaseY = new Float32Array(N + 1);
    const pointTopY = new Float32Array(N + 1);
    pointBaseY[0] = segmentBaseY[0] ?? 0;
    pointTopY[0] = segmentTopY[0] ?? 0;
    pointBaseY[N] = segmentBaseY[N - 1] ?? 0;
    pointTopY[N] = segmentTopY[N - 1] ?? 0;
    for (let c = 1; c < N; c++) {
      pointBaseY[c] = Math.max(segmentBaseY[c - 1], segmentBaseY[c]);
      pointTopY[c] = Math.max(segmentTopY[c - 1], segmentTopY[c]);
    }

    for (let c = 0; c < N; c++) {
      const startBp = geometryStartBp + c * columnBp;
      const endBp = c === N - 1 ? geometryEndBp : startBp + columnBp;
      const base0 = pointBaseY[c];
      const base1 = pointBaseY[c + 1];
      const top0 = pointTopY[c];
      const top1 = pointTopY[c + 1];
      const hasFill = top0 > base0 || top1 > base1;
      const base = c * 6;
      const ys = [base0, top0, top1, base0, top1, base1];
      const xs = [0, 0, 1, 0, 1, 1];
      for (let k = 0; k < 6; k++) {
        const vtx = base + k;
        writePackedBpCoordinate(startBp, arrays.bpStartChunk, arrays.bpStartDelta, vtx);
        writePackedBpCoordinate(endBp, arrays.bpEndChunk, arrays.bpEndDelta, vtx);
        arrays.offsetCenter[vtx] = ys[k];
        arrays.halfH[vtx] = 0;
        arrays.xSide[vtx] = xs[k];
        arrays.ySide[vtx] = 0;
        const ci = vtx * 4;
        arrays.color[ci] = cr;
        arrays.color[ci + 1] = cg;
        arrays.color[ci + 2] = cb;
        arrays.color[ci + 3] = hasFill ? READ_OVERFLOW_BAR_ALPHA : 0;
      }
    }
    for (let vtx = N * 6; vtx < MAX_COLUMN_BARS * 6; vtx++) {
      arrays.halfH[vtx] = 0;
      arrays.color[vtx * 4 + 3] = 0;
    }
    for (const buf of state.overflowRows!.buffers) buf.update();

    state.overflowRowsRecordsKey = state.rowsMeshRecordsKey;
    state.overflowGeometryBuildCount += 1;
    state.overflowRowBinCount = visible;
    state.overflowColumnCoverage = visible / N;
    state.overflowMeanFill = visible > 0 ? fillSum / visible : 0;
    state.overflowMaxFill = maxFill;
    state.overflowMaxHiddenReads = maxHidden;
    state.overflowMorph = morph;
    state.overflowBaseMinPx = visible > 0 ? baseMin : 0;
    state.overflowBaseMaxPx = visible > 0 ? baseMax : 0;
    state.cachedOverflowRowsKey = key;
    const rowsY = args.containerTopPx + this.readRowsTopPx();
    this.applyCamera(state.overflowRows!, args, rowsY);
  }

  private disposeDensityRows(state: ContainerState): void {
    const bar = state.densityRows;
    if (bar) {
      if (bar.mesh.parent) bar.mesh.parent.removeChild(bar.mesh);
      bar.mesh.destroy();
      bar.geometry.destroy(true);
      bar.shader.destroy();
    }
    state.densityRows = null;
    state.densityRowsArrays = null;
    state.cachedDensityRowsKey = '';
    this.resetDensityStats(state);
  }

  private disposeOverflowRows(state: ContainerState): void {
    const bar = state.overflowRows;
    if (bar) {
      if (bar.mesh.parent) bar.mesh.parent.removeChild(bar.mesh);
      bar.mesh.destroy();
      bar.geometry.destroy(true);
      bar.shader.destroy();
    }
    state.overflowRows = null;
    state.overflowRowsArrays = null;
    state.cachedOverflowRowsKey = '';
    state.overflowRowsRecordsKey = '';
    this.resetOverflowStats(state);
  }

  private setCollapsedPileupStats(state: ContainerState, field: CollapsedPileupField | null): void {
    if (!field) {
      this.resetCollapsedPileupStats(state);
      return;
    }
    state.collapsedPileupFieldBinCount = field.visibleRows.length;
    state.collapsedPileupMaxVisibleRows = field.maxVisibleRows;
    state.collapsedPileupMaxHiddenCount = field.maxHiddenCount;
  }

  private resetCollapsedPileupStats(state: ContainerState): void {
    state.collapsedPileupFieldBinCount = 0;
    state.collapsedPileupMaxVisibleRows = 0;
    state.collapsedPileupMaxHiddenCount = 0;
  }

  private resetDensityStats(state: ContainerState): void {
    state.densityRowBinCount = 0;
    state.readDensityColumnCoverage = 0;
    state.readDensityMeanFill = 0;
    state.readDensityMaxFill = 0;
    state.readDensityRowStackMeanFill = 0;
    state.readDensityRowStackMaxFill = 0;
    state.readDensityMorph = 0;
    state.readDensityFillStdDev = 0;
    state.readDensitySourceDepthMean = 0;
    state.readDensitySourceDepthStdDev = 0;
    state.readDensitySourceDepthCv = 0;
    state.readDensitySourceDepthP10 = 0;
    state.readDensitySourceDepthP50 = 0;
    state.readDensitySourceDepthP90 = 0;
    state.readDensitySourceDepthP99 = 0;
    state.readDensitySourceDepthEdgeCount = 0;
    state.readDensitySourceDepthLongestFlatRunColumns = 0;
    state.readDensityDrawnFillStdDev = 0;
    state.readDensityDrawnEdgeCount = 0;
    state.readDensityDrawnLongestFlatRunColumns = 0;
    state.readDensityClippedColumnFraction = 0;
    state.coverageSampledColumnCount = 0;
    state.coverageSampledNonzeroColumnCount = 0;
    state.coverageSampledMaxDepth = 0;
  }

  private resetOverflowStats(state: ContainerState): void {
    state.overflowRowBinCount = 0;
    state.overflowColumnCoverage = 0;
    state.overflowMeanFill = 0;
    state.overflowMaxFill = 0;
    state.overflowMaxHiddenReads = 0;
    state.overflowMorph = 0;
    state.overflowBaseMinPx = 0;
    state.overflowBaseMaxPx = 0;
  }

  private ensureReadBlendOrder(state: ContainerState): void {
    const density = state.densityRows?.mesh;
    const rows = state.rows?.mesh;
    const overflow = state.overflowRows?.mesh;
    if (density?.parent === state.container) state.container.addChild(density);
    if (rows?.parent === state.container) state.container.addChild(rows);
    if (overflow?.parent === state.container) state.container.addChild(overflow);
  }

  private writeBarQuad(
    arrays: BarVertexBuffers,
    vtxBase: number,
    startBp: number,
    endBp: number,
    yLo: number,
    yHi: number,
    rLo: number,
    gLo: number,
    bLo: number,
    rHi: number,
    gHi: number,
    bHi: number,
    alpha: number
  ): void {
    for (let k = 0; k < 6; k++) {
      const vtx = vtxBase + k;
      const top = k === 1 || k === 2 || k === 4;
      const right = k === 2 || k === 4 || k === 5;
      writePackedBpCoordinate(startBp, arrays.bpStartChunk, arrays.bpStartDelta, vtx);
      writePackedBpCoordinate(endBp, arrays.bpEndChunk, arrays.bpEndDelta, vtx);
      arrays.offsetCenter[vtx] = top ? yHi : yLo;
      arrays.halfH[vtx] = 0;
      arrays.xSide[vtx] = right ? 1 : 0;
      arrays.ySide[vtx] = 0;
      const ci = vtx * 4;
      arrays.color[ci] = top ? rHi : rLo;
      arrays.color[ci + 1] = top ? gHi : gLo;
      arrays.color[ci + 2] = top ? bHi : bLo;
      arrays.color[ci + 3] = alpha;
    }
  }

  private writeBarTrapezoid(
    arrays: BarVertexBuffers,
    vtxBase: number,
    startBp: number,
    endBp: number,
    hL: number,
    hR: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
    baselinePx = 0
  ): void {
    for (let k = 0; k < 6; k++) {
      const vtx = vtxBase + k;
      const top = k === 1 || k === 2 || k === 4;
      const right = k === 2 || k === 4 || k === 5;
      writePackedBpCoordinate(startBp, arrays.bpStartChunk, arrays.bpStartDelta, vtx);
      writePackedBpCoordinate(endBp, arrays.bpEndChunk, arrays.bpEndDelta, vtx);
      arrays.offsetCenter[vtx] = top ? (right ? hR : hL) : baselinePx;
      arrays.halfH[vtx] = 0;
      arrays.xSide[vtx] = right ? 1 : 0;
      arrays.ySide[vtx] = 0;
      const ci = vtx * 4;
      arrays.color[ci] = r;
      arrays.color[ci + 1] = g;
      arrays.color[ci + 2] = b;
      arrays.color[ci + 3] = alpha;
    }
  }

  private buildBarMesh(
    state: ContainerState,
    v: BarVertexBuffers,
    label: string,
    surfaceKind: BarSurfaceKind
  ): BarMesh {
    const mk = (data: Float32Array, l: string): PixiBuffer =>
      new PixiBuffer({
        data,
        usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        label: l,
        shrinkToFit: false,
      });
    const bpStartChunk = mk(v.bpStartChunk, `${label}-bp-start-chunk`);
    const bpStartDelta = mk(v.bpStartDelta, `${label}-bp-start-delta`);
    const bpEndChunk = mk(v.bpEndChunk, `${label}-bp-end-chunk`);
    const bpEndDelta = mk(v.bpEndDelta, `${label}-bp-end-delta`);
    const offsetBuf = mk(v.offsetCenter, `${label}-offset`);
    const halfHBuf = mk(v.halfH, `${label}-halfh`);
    const xSideBuf = mk(v.xSide, `${label}-x-side`);
    const ySideBuf = mk(v.ySide, `${label}-y-side`);
    const colorBuf = mk(v.color, `${label}-color`);

    const geometry = new Geometry({
      attributes: {
        aBpStartChunk: { buffer: bpStartChunk, format: 'float32' },
        aBpStartDelta: { buffer: bpStartDelta, format: 'float32' },
        aBpEndChunk: { buffer: bpEndChunk, format: 'float32' },
        aBpEndDelta: { buffer: bpEndDelta, format: 'float32' },
        aOffsetCenter: { buffer: offsetBuf, format: 'float32' },
        aHalfH: { buffer: halfHBuf, format: 'float32' },
        aXSide: { buffer: xSideBuf, format: 'float32' },
        aYSide: { buffer: ySideBuf, format: 'float32' },
        aColor: { buffer: colorBuf, format: 'float32x4' },
      },
      topology: 'triangle-list',
    });

    const viewportUniform = new Float32Array([1, 1]);
    const horizontalExcludeUniform = new Float32Array([0, 0]);
    const subpixel = retainedSubpixelOpacityPolicy(surfaceKind);
    const shader = new Shader({
      glProgram: pileupBarGlProgram(),
      resources: {
        annotationUniforms: {
          uXScale: { value: 1, type: 'f32' },
          uXOrigin: { value: 0, type: 'f32' },
          uBpOriginChunk: { value: 0, type: 'f32' },
          uBpOriginDelta: { value: 0, type: 'f32' },
          uY0: { value: 0, type: 'f32' },
          uViewportSize: { value: viewportUniform, type: 'vec2<f32>' },
          uSubpixelMinWidthPx: { value: subpixel.minWidthPx, type: 'f32' },
          uSubpixelAlphaGamma: { value: subpixel.alphaGamma, type: 'f32' },
          uSubpixelMinAlphaScale: { value: subpixel.minAlphaScale, type: 'f32' },
          uLoadingMotionActive: { value: 0, type: 'f32' },
          uLoadingMotionPhase: { value: 0, type: 'f32' },
          uLoadingMotionStyle: { value: 0, type: 'f32' },
          uHorizontalExcludeActive: { value: 0, type: 'f32' },
          uHorizontalExcludePx: { value: horizontalExcludeUniform, type: 'vec2<f32>' },
          uYFlip: { value: 1, type: 'f32' },
          uTrackColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uUseTrackColor: { value: 0, type: 'f32' },
        },
      },
    });

    const mesh = new Mesh<Geometry, Shader>({ geometry, shader, state: State.for2d() });
    mesh.label = label;
    mesh.eventMode = 'none';
    mesh.visible = false;
    state.container.addChildAt(mesh, 0);

    const vertexCount = v.offsetCenter.length;

    return {
      mesh,
      geometry,
      shader,
      buffers: [
        bpStartChunk,
        bpStartDelta,
        bpEndChunk,
        bpEndDelta,
        offsetBuf,
        halfHBuf,
        xSideBuf,
        ySideBuf,
        colorBuf,
      ],
      viewportUniform,
      vertexCount,
      surfaceKind,
    };
  }

  private buildBarMeshFromPool(
    state: ContainerState,
    pool: AnnotationRecordVerticesPool,
    label: string
  ): BarMesh {
    return this.buildBarMesh(state, pool, label, 'discrete-mark');
  }

  private destroyBarMesh(bar: BarMesh): void {
    if (bar.mesh.parent) bar.mesh.parent.removeChild(bar.mesh);
    bar.mesh.destroy();
    bar.geometry.destroy(true);
    bar.shader.destroy();
  }

  private applyCamera(bar: BarMesh, args: TrackPaintArgs<PileupTrackData>, uY0: number): void {
    const viewStartBp = args.viewportBpRange.start;
    const pixelsPerBp = args.pathMapper.pixelsPerBp;
    const xOrigin = args.pathMapper.bpLeftX(viewStartBp);
    const u = (bar.shader.resources.annotationUniforms as { uniforms: BarUniforms }).uniforms;
    u.uXScale = pixelsPerBp;
    u.uXOrigin = xOrigin;
    u.uBpOriginChunk = bpCoordinateChunk(viewStartBp);
    u.uBpOriginDelta = bpCoordinateDelta(viewStartBp);
    u.uY0 = uY0;
    const subpixel = retainedSubpixelOpacityPolicy(bar.surfaceKind);
    u.uSubpixelMinWidthPx = subpixel.minWidthPx;
    u.uSubpixelAlphaGamma = subpixel.alphaGamma;
    u.uSubpixelMinAlphaScale = subpixel.minAlphaScale;
    u.uYFlip = 1;
    bar.viewportUniform[0] = args.viewportWidthPx;
    bar.viewportUniform[1] = args.viewportHeightPx;
  }

  private applyBarTrackColor(bar: BarMesh, color: number): void {
    const u = (bar.shader.resources.annotationUniforms as { uniforms: BarUniforms }).uniforms;
    u.uTrackColor[0] = ((color >> 16) & 0xff) / 255;
    u.uTrackColor[1] = ((color >> 8) & 0xff) / 255;
    u.uTrackColor[2] = (color & 0xff) / 255;
    u.uUseTrackColor = 1;
  }

  private applyBarLoadingMotion(
    bar: BarMesh,
    active: boolean,
    phase: number,
    animation: PileupHistogramLoadingAnimation
  ): void {
    const u = (bar.shader.resources.annotationUniforms as { uniforms: BarUniforms }).uniforms;
    u.uLoadingMotionActive = active ? 1 : 0;
    u.uLoadingMotionPhase = phase;
    u.uLoadingMotionStyle = pileupHistogramLoadingAnimationIndex(animation);
  }

  private applyCoverageSignalInstancedCamera(
    state: ContainerState,
    args: TrackPaintArgs<PileupTrackData>,
    y0: number
  ): void {
    const viewStartBp = args.viewportBpRange.start;
    state.coverageSignalInstancedLayer.applyCamera({
      viewStartBp,
      pixelsPerBp: args.pathMapper.pixelsPerBp,
      xOrigin: args.pathMapper.bpLeftX(viewStartBp),
      y0,
      viewportWidthPx: args.viewportWidthPx,
      viewportHeightPx: args.viewportHeightPx,
    });
  }

  private disposeBar(state: ContainerState, which: 'rows'): void {
    const bar = state.rows;
    if (bar) this.destroyBarMesh(bar);
    if (which === 'rows') {
      state.rows = null;
      state.rowsMeshStartBp = 0;
      state.rowsMeshEndBp = 0;
      state.rowsMeshRecordCount = 0;
      state.rowsMeshColorKey = '';
      state.rowsMeshRecordsKey = '';
      state.rowsMeshRecordsRef = null;
      state.rowsMeshRowsRef = null;
      state.rowsMeshReadHitIndex = null;
      state.rowsMeshSourceGenerationKey = '';
      state.rowsMeshHiddenReadCount = 0;
      state.rowsMeshCollapsedPileupField = null;
      state.rowsMeshBufferCapacity = 0;
      if (state.rowsBack.mesh) {
        this.destroyBarMesh(state.rowsBack.mesh);
        state.rowsBack.mesh = null;
        state.rowsBack.bufferCapacity = 0;
        state.rowsBack.meshStartBp = 0;
        state.rowsBack.meshEndBp = 0;
        state.rowsBack.recordCount = 0;
        state.rowsBack.colorKey = '';
      }
      state.rowsMeshBuildJob = null;
    }
  }
}
