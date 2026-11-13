import { RULER_HEIGHT, type OverlaySlot, type UnifiedLayout } from './track-layout';
import {
  ANNOTATION_BAR_HEIGHT as CANVAS_ANNOTATION_BAR_HEIGHT,
  ANNOTATION_LANE_TOTAL as CANVAS_ANNOTATION_LANE_TOTAL,
} from './theme';

export const BASE_SEQUENCE_FONT_SIZE = 11;
export const PRIMER_OVERVIEW_LANE_HEIGHT = 5.5;
export const PRIMER_OVERVIEW_BAR_HEIGHT = 3;
export const PRIMER_OVERVIEW_ARROW_WIDTH = 3.75;
export const PRIMER_OVERVIEW_MIN_ARROW_WIDTH = 6;
export const PRIMER_OVERVIEW_MIN_VISIBLE_WIDTH = 6;
export const CANVAS_PRIMER_TRACK_HEIGHT = 17;
export const CANVAS_PRIMER_ARROW_PADDING = 10;
export const CANVAS_PRIMER_ARROW_WIDTH = 16;
export const CANVAS_PRIMER_ARROW_HEIGHT = 8;
export const PRIMER_MARGIN = 3;
export const ANNOTATION_BAR_HEIGHT = CANVAS_ANNOTATION_BAR_HEIGHT;
export const ANNOTATION_LANE_TOTAL = CANVAS_ANNOTATION_LANE_TOTAL;

export type LaneContractLod = 'hidden' | 'hairline' | 'overview' | 'shape' | 'sequence';
export type LaneContractSide = 'above' | 'below' | 'on' | 'overlay';
export type LaneRole =
  | 'primer-overview'
  | 'primer-forward'
  | 'primer-reverse'
  | 'orf-forward'
  | 'orf-reverse'
  | 'annotation'
  | 'cds-label'
  | 'fwd-sequence-row'
  | 'rev-sequence-row'
  | 'ruler-line'
  | 'ruler-label-band'
  | 'cut-top'
  | 'cut-connector'
  | 'cut-bottom'
  | 'cut-label'
  | 'selection-band'
  | 'cursor-line'
  | 'viewport-range';

export interface PrimerScreenMetrics {
  barHeight: number;
  laneHeight: number;
  margin: number;
  arrowWidth: number;
  arrowHeight: number;
}

export interface LaneEnvelope {
  laneIndex: number;
  contractLaneIndex: number;
  overviewLaneIndex?: number;
  role: LaneRole;
  centerOffset: number;
  halfHeight: number;
  minOffset: number;
  maxOffset: number;
}

export interface TrackContract {
  trackId: 'primers' | 'annotations' | 'orfs' | 'sequence' | 'ruler' | 'cut-sites' | 'interactions';
  lod: LaneContractLod;
  side: LaneContractSide;
  lanes: LaneEnvelope[];
  allowedOverlap: string[];
  zIndex: number;
  opacity: number;
  transitionProgress: number;
}

export interface LaneContractBounds {
  id: string;
  minOffset: number;
  maxOffset: number;
}

export interface LaneContractViolation {
  code: 'outside-container' | 'protected-overlap';
  message: string;
  lane: LaneEnvelope;
  bounds: LaneContractBounds;
}

export interface LaneStackBounds extends LaneContractBounds {
  outwardExtent: number;
  inwardExtent: number;
}

export interface PrimerTrackHeightInputs {
  sequenceVisible: boolean;
  sequenceRevealProgress?: number;
  compactScale: number;
  sequenceFontSize: number;
  primerFeatureLaneScale?: number;
  maxOverviewLane: number;
  maxForwardLane: number;
  maxReverseLane: number;
}

export interface PrimerTrackContractInputs extends PrimerTrackHeightInputs {
  layout: UnifiedLayout;
  yOffset?: number;
}

export interface AnnotationTrackContractInputs {
  layout: UnifiedLayout;
  maxAnnotationLane: number;
  maxCdsLane: number;
}

export interface OrfTrackContractInputs {
  layout: UnifiedLayout;
  forwardLaneCount: number;
  reverseLaneCount: number;
}

export interface InteractionOverlayContractInputs {
  layout: UnifiedLayout;
  mode: 'linear' | 'stadium';
}

export interface BaseTrackContractInputs {
  layout: UnifiedLayout;
}

export type LaneContractMode = 'linear' | 'stadium';

export interface LaneContractSetInputs {
  layout: UnifiedLayout;
  mode: LaneContractMode;
  maxAnnotationLane: number;
  maxCdsLane: number;
  maxPrimerLane: number;
  maxForwardPrimerLane: number;
  maxReversePrimerLane: number;
  orfForwardLaneCount: number;
  orfReverseLaneCount: number;
  includeInteractions?: boolean;
}

export interface LaneContractGap {
  id: string;
  fromTrackId: TrackContract['trackId'];
  fromRole: LaneRole;
  toTrackId: TrackContract['trackId'];
  toRole: LaneRole;
  gap: number;
}

export interface LaneContractSnapshot {
  mode: LaneContractMode;
  layout: {
    sequenceVisible: boolean;
    sequenceOpacity: number;
    sequenceRevealProgress: number;
    primerFeatureLaneScale: number;
    compactScale: number;
    overviewLaneScale: number;
    laneGeometryScale: number;
    rowHeight: number;
    sequenceFontSize: number;
    totalHeight: number;
    rulerOffset: number;
  };
  contracts: TrackContract[];
  physicalContracts: TrackContract[];
  interactionContract: TrackContract | null;
  physicalStackBounds: LaneStackBounds;
  fullStackBounds: LaneStackBounds;
  regions: {
    sequenceBackbone: LaneContractBounds;
    ruler: LaneContractBounds;
    annotationSlot: LaneContractBounds | null;
    primerSlot: LaneContractBounds | null;
  };
  gaps: LaneContractGap[];
  violations: LaneContractViolation[];
}

export function primerScreenMetrics(
  sequenceVisible: boolean,
  compactScale: number,
  sequenceFontSize: number
): PrimerScreenMetrics {
  if (sequenceVisible) {
    const scale = sequenceFontSize / BASE_SEQUENCE_FONT_SIZE;
    const barHeight = CANVAS_PRIMER_TRACK_HEIGHT * scale;
    const arrowHeight = CANVAS_PRIMER_ARROW_HEIGHT * scale;
    const arrowWidth = CANVAS_PRIMER_ARROW_WIDTH * scale;
    return {
      barHeight,
      laneHeight: (CANVAS_PRIMER_TRACK_HEIGHT + CANVAS_PRIMER_ARROW_PADDING) * scale,
      margin: PRIMER_MARGIN * compactScale,
      arrowWidth,
      arrowHeight,
    };
  }

  const barHeight = PRIMER_OVERVIEW_BAR_HEIGHT * compactScale;
  const laneHeight = PRIMER_OVERVIEW_LANE_HEIGHT * compactScale;
  return {
    barHeight,
    laneHeight,
    margin: PRIMER_MARGIN * compactScale,
    arrowWidth: PRIMER_OVERVIEW_ARROW_WIDTH * compactScale,
    arrowHeight: PRIMER_OVERVIEW_BAR_HEIGHT * 0.5 * compactScale,
  };
}

function scaleCompactPrimerMetrics(
  metrics: PrimerScreenMetrics,
  primerFeatureLaneScale: number
): PrimerScreenMetrics {
  const scale = Math.max(0.01, Math.min(1, primerFeatureLaneScale));
  return {
    barHeight: metrics.barHeight * scale,
    laneHeight: metrics.laneHeight * scale,
    margin: metrics.margin * scale,
    arrowWidth: metrics.arrowWidth * scale,
    arrowHeight: metrics.arrowHeight * scale,
  };
}

export function primerScreenMetricsForReveal(
  sequenceRevealProgress: number,
  compactScale: number,
  sequenceFontSize: number,
  primerFeatureLaneScale = 1
): PrimerScreenMetrics {
  const t = Math.max(0, Math.min(1, sequenceRevealProgress));
  const overview = scaleCompactPrimerMetrics(
    primerScreenMetrics(false, compactScale, sequenceFontSize),
    primerFeatureLaneScale
  );
  const detail = primerScreenMetrics(true, compactScale, sequenceFontSize);
  return {
    barHeight: lerp(overview.barHeight, detail.barHeight, t),
    laneHeight: lerp(overview.laneHeight, detail.laneHeight, t),
    margin: lerp(overview.margin, detail.margin, t),
    arrowWidth: lerp(overview.arrowWidth, detail.arrowWidth, t),
    arrowHeight: lerp(overview.arrowHeight, detail.arrowHeight, t),
  };
}

export function computePrimerTrackHeightForLayout(inputs: PrimerTrackHeightInputs): number {
  const laneCount = inputs.sequenceVisible
    ? laneCountFromMax(inputs.maxForwardLane) + laneCountFromMax(inputs.maxReverseLane)
    : laneCountFromMax(inputs.maxOverviewLane);

  if (laneCount <= 0) return 0;

  const metrics =
    inputs.sequenceRevealProgress === undefined
      ? primerScreenMetrics(inputs.sequenceVisible, inputs.compactScale, inputs.sequenceFontSize)
      : primerScreenMetricsForReveal(
          inputs.sequenceRevealProgress,
          inputs.compactScale,
          inputs.sequenceFontSize,
          inputs.primerFeatureLaneScale ?? 1
        );
  const screenHeight = metrics.margin + laneCount * metrics.laneHeight;
  return screenHeight / Math.max(inputs.compactScale, 0.0001);
}

export function resolvePrimerTrackContract(inputs: PrimerTrackContractInputs): TrackContract {
  const lanes: LaneEnvelope[] = [];
  const useSplitPrimerLanes = inputs.layout.primerLayoutMode === 'split';

  if (useSplitPrimerLanes) {
    const t = Math.max(0, Math.min(1, inputs.layout.sequenceRevealProgress));
    const metrics = primerScreenMetricsForReveal(
      inputs.layout.sequenceRevealProgress,
      inputs.compactScale,
      inputs.sequenceFontSize,
      inputs.layout.primerFeatureLaneScale
    );
    const collapsedMetrics = primerScreenMetricsForReveal(
      0,
      inputs.compactScale,
      inputs.sequenceFontSize,
      inputs.layout.primerFeatureLaneScale
    );
    const forwardOverviewLaneCount = Math.max(laneCountFromMax(inputs.maxForwardLane), 1);
    const reverseOverviewLaneCount = Math.max(laneCountFromMax(inputs.maxReverseLane), 1);

    for (let lane = 0; lane <= inputs.maxForwardLane; lane++) {
      const expanded = laneEnvelopeAbove({
        laneIndex: lane,
        contractLaneIndex: lane,
        role: 'primer-forward',
        anchorOffset: inputs.layout.cutLineTopOffset,
        metrics,
      });
      const overviewLaneIndexes =
        t >= 1
          ? [undefined]
          : Array.from({ length: forwardOverviewLaneCount }, (_, index) => index);
      for (const overviewLaneIndex of overviewLaneIndexes) {
        const collapsed = laneEnvelopeAbove({
          laneIndex: overviewLaneIndex ?? lane,
          contractLaneIndex: overviewLaneIndex ?? lane,
          role: 'primer-forward',
          anchorOffset: inputs.layout.cutLineTopOffset,
          metrics: collapsedMetrics,
        });
        lanes.push(
          interpolateLaneEnvelope({
            from: collapsed,
            to: expanded,
            role: 'primer-forward',
            t,
            overviewLaneIndex,
          })
        );
      }
    }

    for (let lane = 0; lane <= inputs.maxReverseLane; lane++) {
      const expanded = laneEnvelope({
        laneIndex: lane,
        contractLaneIndex: lane,
        role: 'primer-reverse',
        trackTopOffset: inputs.layout.cutLineBottomOffset,
        metrics,
      });
      const overviewLaneIndexes =
        t >= 1
          ? [undefined]
          : Array.from({ length: reverseOverviewLaneCount }, (_, index) => index);
      for (const overviewLaneIndex of overviewLaneIndexes) {
        const collapsed = laneEnvelope({
          laneIndex: overviewLaneIndex ?? lane,
          contractLaneIndex: overviewLaneIndex ?? lane,
          role: 'primer-reverse',
          trackTopOffset: inputs.layout.cutLineBottomOffset,
          metrics: collapsedMetrics,
        });
        lanes.push(
          interpolateLaneEnvelope({
            from: collapsed,
            to: expanded,
            role: 'primer-reverse',
            t,
            overviewLaneIndex,
          })
        );
      }
    }
  } else {
    const laneCount = laneCountFromMax(inputs.maxOverviewLane);
    const metrics = collapsedPrimerScreenMetrics(inputs.layout, inputs.compactScale, laneCount);
    for (let lane = 0; lane <= inputs.maxOverviewLane; lane++) {
      lanes.push(
        laneEnvelope({
          laneIndex: lane,
          contractLaneIndex: lane,
          role: 'primer-overview',
          trackTopOffset: inputs.layout.cutLineTopOffset,
          metrics,
        })
      );
    }
  }

  return {
    trackId: 'primers',
    lod: inputs.sequenceVisible ? 'sequence' : useSplitPrimerLanes ? 'shape' : 'overview',
    side: useSplitPrimerLanes ? 'overlay' : 'on',
    lanes,
    allowedOverlap: [],
    zIndex: 40,
    opacity: inputs.sequenceVisible ? inputs.layout.sequenceOpacity : 1,
    transitionProgress: inputs.layout.sequenceRevealProgress,
  };
}

export function getPrimerLaneEnvelope(
  contract: TrackContract,
  direction: 'forward' | 'reverse',
  laneIndex: number,
  overviewLaneIndex?: number
): LaneEnvelope | null {
  if (contract.trackId !== 'primers') return null;
  const directionalRole = direction === 'forward' ? 'primer-forward' : 'primer-reverse';
  const directionalMatches = contract.lanes.filter(
    (lane) => lane.role === directionalRole && lane.laneIndex === laneIndex
  );
  if (overviewLaneIndex !== undefined) {
    const exactTransitionLane = directionalMatches.find(
      (lane) => lane.overviewLaneIndex === overviewLaneIndex
    );
    if (exactTransitionLane) return exactTransitionLane;
  }
  return (
    directionalMatches.find((lane) => lane.overviewLaneIndex === undefined) ??
    directionalMatches[0] ??
    contract.lanes.find(
      (lane) => lane.role === 'primer-overview' && lane.laneIndex === laneIndex
    ) ??
    null
  );
}

export function resolveAnnotationTrackContract(
  inputs: AnnotationTrackContractInputs
): TrackContract {
  const halfHeight = ANNOTATION_BAR_HEIGHT / 2;
  const lanes: LaneEnvelope[] = [];

  for (let lane = 0; lane <= inputs.maxAnnotationLane; lane++) {
    const centerOffset = inputs.layout.annotationOffset - lane * inputs.layout.annotationStep;
    lanes.push(staticLaneEnvelope(lane, lane, 'annotation', centerOffset, halfHeight));
  }

  for (let lane = 0; lane <= inputs.maxCdsLane; lane++) {
    const centerOffset = inputs.layout.cdsBarOffset - lane * inputs.layout.cdsLaneStep;
    lanes.push(staticLaneEnvelope(lane, lane, 'cds-label', centerOffset, halfHeight));
  }

  return {
    trackId: 'annotations',
    lod: 'shape',
    side: 'above',
    lanes,
    allowedOverlap: [],
    zIndex: 30,
    opacity: 1,
    transitionProgress: inputs.layout.sequenceRevealProgress,
  };
}

export function getAnnotationLaneEnvelope(
  contract: TrackContract,
  featureType: string,
  laneIndex: number
): LaneEnvelope | null {
  if (contract.trackId !== 'annotations') return null;
  const hasCdsLabelLanes = contract.lanes.some((lane) => lane.role === 'cds-label');
  const role: LaneRole = featureType === 'CDS' && hasCdsLabelLanes ? 'cds-label' : 'annotation';
  return contract.lanes.find((lane) => lane.role === role && lane.laneIndex === laneIndex) ?? null;
}

export function resolveOrfTrackContract(inputs: OrfTrackContractInputs): TrackContract {
  const halfHeight = inputs.layout.orfLaneHeight / 2;
  const lanes: LaneEnvelope[] = [];
  for (let lane = 0; lane < inputs.forwardLaneCount; lane++) {
    lanes.push(
      staticLaneEnvelope(
        lane,
        lane,
        'orf-forward',
        inputs.layout.orfForwardOffset + lane * inputs.layout.orfLaneStep,
        halfHeight
      )
    );
  }
  for (let lane = 0; lane < inputs.reverseLaneCount; lane++) {
    lanes.push(
      staticLaneEnvelope(
        lane,
        lane,
        'orf-reverse',
        inputs.layout.orfReverseOffset + lane * inputs.layout.orfLaneStep,
        halfHeight
      )
    );
  }

  return {
    trackId: 'orfs',
    lod: inputs.layout.sequenceVisible ? 'sequence' : 'hairline',
    side: 'above',
    lanes,
    allowedOverlap: [],
    zIndex: 25,
    opacity: inputs.layout.sequenceVisible ? inputs.layout.sequenceOpacity : 1,
    transitionProgress: inputs.layout.sequenceRevealProgress,
  };
}

export function resolveSequenceTrackContract(inputs: BaseTrackContractInputs): TrackContract {
  const fwdHeight = inputs.layout.fwdStrandBottom - inputs.layout.fwdStrandTop;
  const revHeight = inputs.layout.revStrandBottom - inputs.layout.revStrandTop;
  const fwdCenter = inputs.layout.fwdStrandCenter - inputs.layout.fwdStrandTop;
  const revCenter = inputs.layout.revStrandCenter - inputs.layout.fwdStrandTop;

  return {
    trackId: 'sequence',
    lod: inputs.layout.sequenceVisible ? 'sequence' : 'hidden',
    side: 'on',
    lanes: [
      staticLaneEnvelope(0, 0, 'fwd-sequence-row', fwdCenter, fwdHeight / 2),
      staticLaneEnvelope(1, 1, 'rev-sequence-row', revCenter, revHeight / 2),
    ],
    allowedOverlap: [],
    zIndex: 10,
    opacity: inputs.layout.sequenceOpacity,
    transitionProgress: inputs.layout.sequenceRevealProgress,
  };
}

export function resolveRulerTrackContract(inputs: BaseTrackContractInputs): TrackContract {
  return {
    trackId: 'ruler',
    lod: 'shape',
    side: 'below',
    lanes: [
      staticLaneEnvelope(0, 0, 'ruler-line', inputs.layout.rulerOffset, 0),
      staticLaneEnvelope(
        1,
        1,
        'ruler-label-band',
        inputs.layout.rulerOffset + RULER_HEIGHT / 2,
        RULER_HEIGHT / 2
      ),
    ],
    allowedOverlap: [],
    zIndex: 20,
    opacity: 1,
    transitionProgress: inputs.layout.sequenceRevealProgress,
  };
}

export function resolveCutSiteTrackContract(inputs: BaseTrackContractInputs): TrackContract {
  return {
    trackId: 'cut-sites',
    lod: 'shape',
    side: 'overlay',
    lanes: [
      staticLaneEnvelope(0, 0, 'cut-top', inputs.layout.cutLineTopOffset, 0),
      staticLaneEnvelope(1, 1, 'cut-connector', inputs.layout.cutLineConnectorOffset, 0),
      staticLaneEnvelope(2, 2, 'cut-bottom', inputs.layout.cutLineBottomOffset, 0),
      staticLaneEnvelope(3, 3, 'cut-label', inputs.layout.cutLabelOffset + 8, 8),
    ],
    allowedOverlap: ['sequence-backbone-region'],
    zIndex: 35,
    opacity: 1,
    transitionProgress: inputs.layout.sequenceRevealProgress,
  };
}

export function getTrackLaneEnvelope(contract: TrackContract, role: LaneRole): LaneEnvelope | null {
  return contract.lanes.find((lane) => lane.role === role) ?? null;
}

export function requireTrackLaneEnvelope(contract: TrackContract, role: LaneRole): LaneEnvelope {
  const lane = getTrackLaneEnvelope(contract, role);
  if (!lane) {
    throw new Error(`Track contract "${contract.trackId}" is missing required "${role}" lane`);
  }
  return lane;
}

export function resolveInteractionOverlayContract(
  inputs: InteractionOverlayContractInputs
): TrackContract {
  const compactScale = inputs.layout.compactScale ?? 1;
  const annotationTopOffset =
    annotationSlotBounds(inputs.layout)?.minOffset ??
    inputs.layout.annotationTop - inputs.layout.fwdStrandTop;
  const topPad = inputs.mode === 'stadium' ? 6 * compactScale : 0;
  const bottomPad = inputs.mode === 'stadium' ? 4 : 0;
  const rulerHeight = RULER_HEIGHT;
  const minOffset = annotationTopOffset - topPad;
  const primerMaxOffset = primerSlotBounds(inputs.layout)?.maxOffset ?? Number.NEGATIVE_INFINITY;
  const maxOffset = Math.max(inputs.layout.rulerOffset + rulerHeight, primerMaxOffset) + bottomPad;
  const centerOffset = (minOffset + maxOffset) / 2;
  const halfHeight = (maxOffset - minOffset) / 2;

  return {
    trackId: 'interactions',
    lod: 'shape',
    side: 'overlay',
    lanes: [
      staticLaneEnvelope(0, 0, 'selection-band', centerOffset, halfHeight),
      staticLaneEnvelope(0, 0, 'cursor-line', centerOffset, halfHeight),
      staticLaneEnvelope(0, 0, 'viewport-range', 0, 6),
    ],
    allowedOverlap: [
      'sequence-backbone-region',
      'annotation-slot',
      'primer-slot',
      'ruler-region',
      'cut-label-region',
    ],
    zIndex: 100,
    opacity: 1,
    transitionProgress: inputs.layout.sequenceRevealProgress,
  };
}

export function getInteractionLaneEnvelope(
  contract: TrackContract,
  role: 'selection-band' | 'cursor-line' | 'viewport-range'
): LaneEnvelope | null {
  if (contract.trackId !== 'interactions') return null;
  return contract.lanes.find((lane) => lane.role === role) ?? null;
}

export function laneContractStackBounds(
  contracts: readonly TrackContract[],
  id = 'lane-stack'
): LaneStackBounds {
  const lanes = contracts.flatMap((contract) => contract.lanes);
  if (lanes.length === 0) {
    return {
      id,
      minOffset: 0,
      maxOffset: 0,
      outwardExtent: 0,
      inwardExtent: 0,
    };
  }

  const minOffset = Math.min(0, ...lanes.map((lane) => lane.minOffset));
  const maxOffset = Math.max(0, ...lanes.map((lane) => lane.maxOffset));
  return {
    id,
    minOffset,
    maxOffset,
    outwardExtent: Math.max(0, -minOffset),
    inwardExtent: Math.max(0, maxOffset),
  };
}

export function resolvePhysicalTrackContracts(inputs: LaneContractSetInputs): TrackContract[] {
  const { layout } = inputs;
  return [
    resolveAnnotationTrackContract({
      layout,
      maxAnnotationLane: inputs.maxAnnotationLane,
      maxCdsLane: inputs.maxCdsLane,
    }),
    resolveOrfTrackContract({
      layout,
      forwardLaneCount: inputs.orfForwardLaneCount,
      reverseLaneCount: inputs.orfReverseLaneCount,
    }),
    resolvePrimerTrackContract({
      layout,
      sequenceVisible: layout.sequenceVisible,
      compactScale: layout.compactScale,
      sequenceFontSize: layout.sequenceFontSize,
      maxOverviewLane: inputs.maxPrimerLane,
      maxForwardLane: inputs.maxForwardPrimerLane,
      maxReverseLane: inputs.maxReversePrimerLane,
    }),
    resolveSequenceTrackContract({ layout }),
    resolveRulerTrackContract({ layout }),
    resolveCutSiteTrackContract({ layout }),
  ];
}

export function resolveLaneContractSnapshot(inputs: LaneContractSetInputs): LaneContractSnapshot {
  const physicalContracts = resolvePhysicalTrackContracts(inputs);
  const interactionContract = inputs.includeInteractions
    ? resolveInteractionOverlayContract({ layout: inputs.layout, mode: inputs.mode })
    : null;
  const contracts = interactionContract
    ? [...physicalContracts, interactionContract]
    : physicalContracts;
  const sequenceBackbone = sequenceProtectedBounds(inputs.layout);
  const ruler = rulerBounds(inputs.layout, inputs.mode);
  const physicalStackBounds = laneContractStackBounds(physicalContracts, 'physical-lane-stack');
  const fullStackBounds = laneContractStackBounds(contracts, 'all-lane-stack');

  return {
    mode: inputs.mode,
    layout: {
      sequenceVisible: inputs.layout.sequenceVisible,
      sequenceOpacity: inputs.layout.sequenceOpacity,
      sequenceRevealProgress: inputs.layout.sequenceRevealProgress,
      primerFeatureLaneScale: inputs.layout.primerFeatureLaneScale,
      compactScale: inputs.layout.compactScale,
      overviewLaneScale: inputs.layout.overviewLaneScale,
      laneGeometryScale: inputs.layout.laneGeometryScale,
      rowHeight: inputs.layout.rowHeight,
      sequenceFontSize: inputs.layout.sequenceFontSize,
      totalHeight: inputs.layout.totalHeight,
      rulerOffset: inputs.layout.rulerOffset,
    },
    contracts,
    physicalContracts,
    interactionContract,
    physicalStackBounds,
    fullStackBounds,
    regions: {
      sequenceBackbone,
      ruler,
      annotationSlot: annotationSlotBounds(inputs.layout),
      primerSlot: primerSlotBounds(inputs.layout),
    },
    gaps: computeLaneContractGaps(physicalContracts, ruler),
    violations: computeContractViolations(contracts, [sequenceBackbone, ruler]),
  };
}

function computeLaneContractGaps(
  contracts: readonly TrackContract[],
  ruler: LaneContractBounds
): LaneContractGap[] {
  const rulerLane = contracts
    .find((contract) => contract.trackId === 'ruler')
    ?.lanes.find((lane) => lane.role === 'ruler-line');
  if (!rulerLane) return [];

  const candidate = contracts
    .filter((contract) => contract.trackId !== 'ruler')
    .flatMap((contract) =>
      contract.lanes.map((lane) => ({
        trackId: contract.trackId,
        lane,
      }))
    )
    .filter((entry) => entry.lane.maxOffset <= ruler.minOffset + 0.0001)
    .sort((a, b) => b.lane.maxOffset - a.lane.maxOffset)[0];

  if (!candidate) return [];

  return [
    {
      id: 'nearest-track-to-ruler',
      fromTrackId: candidate.trackId,
      fromRole: candidate.lane.role,
      toTrackId: 'ruler',
      toRole: rulerLane.role,
      gap: ruler.minOffset - candidate.lane.maxOffset,
    },
  ];
}

function computeContractViolations(
  contracts: readonly TrackContract[],
  protectedRegions: readonly (LaneContractBounds | null)[]
): LaneContractViolation[] {
  const regions = protectedRegions.filter(
    (region): region is LaneContractBounds => region !== null
  );
  return contracts.flatMap((contract) =>
    validateLaneContract(contract, { protectedRegions: regionsForContract(contract, regions) })
  );
}

function regionsForContract(
  contract: TrackContract,
  regions: readonly LaneContractBounds[]
): LaneContractBounds[] {
  return regions.filter((region) => {
    if (contract.trackId === 'sequence' && region.id === 'sequence-backbone-region') return false;
    if (contract.trackId === 'ruler' && region.id === 'ruler-region') return false;
    if (contract.trackId === 'annotations' && region.id === 'annotation-slot') return false;
    if (contract.trackId === 'primers' && region.id === 'primer-slot') return false;
    return true;
  });
}

export function validateLaneContract(
  contract: TrackContract,
  constraints: {
    container?: LaneContractBounds;
    protectedRegions?: readonly LaneContractBounds[];
  }
): LaneContractViolation[] {
  const violations: LaneContractViolation[] = [];

  for (const lane of contract.lanes) {
    const container = constraints.container;
    if (
      container &&
      (lane.minOffset < container.minOffset - 0.0001 ||
        lane.maxOffset > container.maxOffset + 0.0001)
    ) {
      violations.push({
        code: 'outside-container',
        message: `${lane.role} lane ${lane.laneIndex} is outside ${container.id}`,
        lane,
        bounds: container,
      });
    }

    for (const protectedRegion of constraints.protectedRegions ?? []) {
      if (contract.allowedOverlap.includes(protectedRegion.id)) continue;
      if (
        rangesOverlap(
          lane.minOffset,
          lane.maxOffset,
          protectedRegion.minOffset,
          protectedRegion.maxOffset
        )
      ) {
        violations.push({
          code: 'protected-overlap',
          message: `${lane.role} lane ${lane.laneIndex} overlaps ${protectedRegion.id}`,
          lane,
          bounds: protectedRegion,
        });
      }
    }
  }

  return violations;
}

export function primerSlotBounds(layout: UnifiedLayout): LaneContractBounds | null {
  const slot = findPrimerSlot(layout);
  if (!slot) {
    if (layout.primerLayoutMode === 'none') return null;
    const candidates: Array<{ top: number; height: number }> = [];
    if (layout.primerLayoutMode === 'collapsed') {
      candidates.push({ top: layout.primerOverviewTop, height: layout.primerOverviewHeight });
    }
    if (layout.primerForwardHeight > 0) {
      candidates.push({ top: layout.primerForwardTop, height: layout.primerForwardHeight });
    }
    if (layout.primerReverseHeight > 0) {
      candidates.push({ top: layout.primerReverseTop, height: layout.primerReverseHeight });
    }
    if (candidates.length === 0) return null;
    const minOffset = Math.min(
      ...candidates.map((candidate) => candidate.top - layout.fwdStrandTop)
    );
    const maxOffset = Math.max(
      ...candidates.map((candidate) => candidate.top + candidate.height - layout.fwdStrandTop)
    );
    return {
      id: 'primer-slot',
      minOffset,
      maxOffset,
    };
  }
  const minOffset = slot.yOffset - layout.fwdStrandTop;
  return {
    id: 'primer-slot',
    minOffset,
    maxOffset: minOffset + slot.height,
  };
}

export function annotationSlotBounds(layout: UnifiedLayout): LaneContractBounds | null {
  const slot = findAnnotationSlot(layout);
  if (!slot) return null;
  const minOffset = slot.yOffset - layout.fwdStrandTop;
  return {
    id: 'annotation-slot',
    minOffset,
    maxOffset: minOffset + slot.height,
  };
}

export function sequenceProtectedBounds(layout: UnifiedLayout): LaneContractBounds {
  return {
    id: 'sequence-backbone-region',
    minOffset: layout.cutLineTopOffset,
    maxOffset: layout.cutLineBottomOffset,
  };
}

export function rulerBounds(
  layout: UnifiedLayout,
  _mode: 'linear' | 'stadium'
): LaneContractBounds {
  return {
    id: 'ruler-region',
    minOffset: layout.rulerOffset,
    maxOffset: layout.rulerOffset + RULER_HEIGHT,
  };
}

function findPrimerSlot(layout: UnifiedLayout): OverlaySlot | undefined {
  return layout.below.find((slot) => slot.overlay.id === 'primers');
}

function findAnnotationSlot(layout: UnifiedLayout): OverlaySlot | undefined {
  return layout.above.find((slot) => slot.overlay.id === 'annotations');
}

function laneCountFromMax(maxLane: number): number {
  return maxLane >= 0 ? maxLane + 1 : 0;
}

function laneEnvelope(inputs: {
  laneIndex: number;
  contractLaneIndex: number;
  role: LaneRole;
  trackTopOffset: number;
  metrics: PrimerScreenMetrics;
}): LaneEnvelope {
  const halfHeight = inputs.metrics.barHeight / 2;
  const overflowAbove = inputs.role === 'primer-forward' ? inputs.metrics.arrowHeight : 0;
  const overflowBelow = inputs.role === 'primer-reverse' ? inputs.metrics.arrowHeight : 0;
  const visualHeight = overflowAbove + inputs.metrics.barHeight + overflowBelow;
  const laneSlack = Math.max(0, inputs.metrics.laneHeight - visualHeight);
  const laneTopOffset =
    inputs.trackTopOffset +
    inputs.metrics.margin +
    inputs.contractLaneIndex * inputs.metrics.laneHeight +
    laneSlack / 2;
  const centerOffset = laneTopOffset + overflowAbove + halfHeight;

  return {
    laneIndex: inputs.laneIndex,
    contractLaneIndex: inputs.contractLaneIndex,
    role: inputs.role,
    centerOffset,
    halfHeight,
    minOffset: centerOffset - halfHeight - overflowAbove,
    maxOffset: centerOffset + halfHeight + overflowBelow,
  };
}

function laneEnvelopeAbove(inputs: {
  laneIndex: number;
  contractLaneIndex: number;
  role: LaneRole;
  anchorOffset: number;
  metrics: PrimerScreenMetrics;
}): LaneEnvelope {
  const halfHeight = inputs.metrics.barHeight / 2;
  const overflowAbove = inputs.role === 'primer-forward' ? inputs.metrics.arrowHeight : 0;
  const visualHeight = overflowAbove + inputs.metrics.barHeight;
  const laneSlack = Math.max(0, inputs.metrics.laneHeight - visualHeight);
  const laneBottomOffset =
    inputs.anchorOffset -
    inputs.metrics.margin -
    inputs.contractLaneIndex * inputs.metrics.laneHeight -
    laneSlack / 2;
  const centerOffset = laneBottomOffset - halfHeight;

  return {
    laneIndex: inputs.laneIndex,
    contractLaneIndex: inputs.contractLaneIndex,
    role: inputs.role,
    centerOffset,
    halfHeight,
    minOffset: centerOffset - halfHeight - overflowAbove,
    maxOffset: centerOffset + halfHeight,
  };
}

function staticLaneEnvelope(
  laneIndex: number,
  contractLaneIndex: number,
  role: LaneRole,
  centerOffset: number,
  halfHeight: number
): LaneEnvelope {
  return {
    laneIndex,
    contractLaneIndex,
    role,
    centerOffset,
    halfHeight,
    minOffset: centerOffset - halfHeight,
    maxOffset: centerOffset + halfHeight,
  };
}

function interpolateLaneEnvelope(inputs: {
  from: LaneEnvelope;
  to: LaneEnvelope;
  role: LaneRole;
  t: number;
  overviewLaneIndex?: number;
}): LaneEnvelope {
  return {
    laneIndex: inputs.to.laneIndex,
    contractLaneIndex: inputs.to.contractLaneIndex,
    overviewLaneIndex: inputs.overviewLaneIndex,
    role: inputs.role,
    centerOffset: lerp(inputs.from.centerOffset, inputs.to.centerOffset, inputs.t),
    halfHeight: lerp(inputs.from.halfHeight, inputs.to.halfHeight, inputs.t),
    minOffset: lerp(inputs.from.minOffset, inputs.to.minOffset, inputs.t),
    maxOffset: lerp(inputs.from.maxOffset, inputs.to.maxOffset, inputs.t),
  };
}

function rangesOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin < bMax && aMax > bMin;
}

export function collapsedPrimerScreenMetrics(
  layout: UnifiedLayout,
  compactScale: number,
  laneCount: number
): PrimerScreenMetrics {
  const base = primerScreenMetrics(false, compactScale, layout.sequenceFontSize);
  const availableHeight = Math.max(1, layout.cutLineBottomOffset - layout.cutLineTopOffset);
  if (laneCount <= 0) return base;
  const laneHeight = availableHeight / laneCount;
  const arrowHeightRatio = CANVAS_PRIMER_ARROW_HEIGHT / CANVAS_PRIMER_TRACK_HEIGHT;
  const arrowWidthRatio = CANVAS_PRIMER_ARROW_WIDTH / CANVAS_PRIMER_TRACK_HEIGHT;
  const maxCenteredBarHeight = laneHeight / (1 + 2 * arrowHeightRatio);
  const barHeight = Math.min(base.barHeight, maxCenteredBarHeight);
  return {
    ...base,
    laneHeight,
    barHeight,
    margin: 0,
    arrowWidth: barHeight * arrowWidthRatio,
    arrowHeight: barHeight * arrowHeightRatio,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
