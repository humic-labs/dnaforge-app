import type { StadiumDimensions } from '../../../geometry/stadium';
import type { StadiumCameraDebug } from './stadium-camera';
import type { LaneStackBounds, TrackContract } from './lane-contracts';
import type { UnifiedLayout } from './track-layout';

export type FrameRenderMode = 'linear' | 'stadium';

export type SemanticLodPhase = 'overview' | 'sequence-transition' | 'nucleotide';

export interface FrameEnvelope {
  id: string;
  width: number;
  height: number;
  laneStackBounds: LaneStackBounds;
}

export interface FrameCameraContract {
  stagePosX: number;
  stagePosY: number;
  backboneTargetY: number;
  debug: StadiumCameraDebug;
}

export interface FrameContractDiagnostics {
  laneGeometryScale: number;
  overviewLaneScale: number;
  laneScaleMismatch: boolean;
  fitEnvelopeMatchesCamera: boolean;
}

export interface FrameLayoutContract {
  mode: FrameRenderMode;
  semanticLod: SemanticLodPhase;
  viewport: {
    width: number;
    height: number;
    geometryHeight: number;
  };
  topology: {
    morph: number;
    zoom: number;
    dims: StadiumDimensions;
  };
  tracks: readonly TrackContract[];
  fitEnvelope: FrameEnvelope;
  visualEnvelope: FrameEnvelope;
  layout: Pick<
    UnifiedLayout,
    | 'sequenceVisible'
    | 'sequenceOpacity'
    | 'sequenceRevealProgress'
    | 'compactScale'
    | 'overviewLaneScale'
    | 'laneGeometryScale'
    | 'rowHeight'
    | 'sequenceFontSize'
    | 'rulerOffset'
  >;
  camera: FrameCameraContract;
  diagnostics: FrameContractDiagnostics;
}

export interface BuildStadiumFrameLayoutContractInputs {
  viewportWidth: number;
  viewportHeight: number;
  geometryHeight: number;
  morph: number;
  zoom: number;
  dims: StadiumDimensions;
  stagePosX: number;
  stagePosY: number;
  layout: UnifiedLayout;
  physicalTrackContracts: readonly TrackContract[];
  fitLaneStackBounds: LaneStackBounds;
  visualLaneStackBounds: LaneStackBounds;
  cameraDebug: StadiumCameraDebug;
}

function semanticLodForLayout(layout: UnifiedLayout): SemanticLodPhase {
  if (layout.sequenceVisible && layout.sequenceOpacity >= 0.999) return 'nucleotide';
  if (layout.sequenceRevealProgress > 0) return 'sequence-transition';
  return 'overview';
}

function stadiumEnvelope(
  id: string,
  dims: StadiumDimensions,
  zoom: number,
  laneStackBounds: LaneStackBounds
): FrameEnvelope {
  const outward = laneStackBounds.outwardExtent;
  return {
    id,
    width: dims.width * zoom + 2 * outward,
    height: dims.height * zoom + 2 * outward,
    laneStackBounds,
  };
}

export function buildStadiumFrameLayoutContract(
  inputs: BuildStadiumFrameLayoutContractInputs
): FrameLayoutContract {
  const fitEnvelope = stadiumEnvelope(
    'camera-fit-envelope',
    inputs.dims,
    inputs.zoom,
    inputs.fitLaneStackBounds
  );
  const visualEnvelope = stadiumEnvelope(
    'render-visual-envelope',
    inputs.dims,
    inputs.zoom,
    inputs.visualLaneStackBounds
  );
  const floatingLabelTopReservePx = inputs.cameraDebug.floatingLabelTopReservePx;
  fitEnvelope.height += floatingLabelTopReservePx;
  visualEnvelope.height += floatingLabelTopReservePx;
  const expectedCameraHeight = inputs.cameraDebug.fullShapeVisualHeight;

  return {
    mode: 'stadium',
    semanticLod: semanticLodForLayout(inputs.layout),
    viewport: {
      width: inputs.viewportWidth,
      height: inputs.viewportHeight,
      geometryHeight: inputs.geometryHeight,
    },
    topology: {
      morph: inputs.morph,
      zoom: inputs.zoom,
      dims: inputs.dims,
    },
    tracks: inputs.physicalTrackContracts,
    fitEnvelope,
    visualEnvelope,
    layout: {
      sequenceVisible: inputs.layout.sequenceVisible,
      sequenceOpacity: inputs.layout.sequenceOpacity,
      sequenceRevealProgress: inputs.layout.sequenceRevealProgress,
      compactScale: inputs.layout.compactScale,
      overviewLaneScale: inputs.layout.overviewLaneScale,
      laneGeometryScale: inputs.layout.laneGeometryScale,
      rowHeight: inputs.layout.rowHeight,
      sequenceFontSize: inputs.layout.sequenceFontSize,
      rulerOffset: inputs.layout.rulerOffset,
    },
    camera: {
      stagePosX: inputs.stagePosX,
      stagePosY: inputs.stagePosY,
      backboneTargetY: inputs.cameraDebug.backboneTargetY,
      debug: inputs.cameraDebug,
    },
    diagnostics: {
      laneGeometryScale: inputs.layout.laneGeometryScale,
      overviewLaneScale: inputs.layout.overviewLaneScale,
      laneScaleMismatch:
        Math.abs(inputs.layout.laneGeometryScale - inputs.layout.overviewLaneScale) > 0.0001,
      fitEnvelopeMatchesCamera: Math.abs(fitEnvelope.height - expectedCameraHeight) <= 0.0001,
    },
  };
}
