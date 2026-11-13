import type { CdsZoomPresentation } from '@waypoint/platform';

export interface Pos2 {
  x: number;
  y: number;
}

export interface Pos3 {
  x: number;
  y: number;
  angle: number;
}

export interface PathMapper {
  backboneAt(bp: number): Pos3;
  fwdStrandAt(bp: number): Pos3;
  revStrandAt(bp: number): Pos3;
  cutLineTopAt(bp: number): Pos2;
  cutLineConnectorAt(bp: number): Pos2;
  cutLineBottomAt(bp: number): Pos2;
  translationAt(bp: number, laneIndex: number): Pos3;
  annotationAt(bp: number, lane: number): Pos3;
  rulerAt(bp: number): Pos3;

  boundaryAt(
    bp: number,
    layer: 'backbone' | 'fwdStrand' | 'revStrand' | 'cutTop' | 'cutConnector' | 'cutBottom'
  ): Pos2;

  bpLeftX(bp: number): number;
  bpCenterX(bp: number): number;

  fwdStrandTop: number;
  fwdStrandBottom: number;
  revStrandTop: number;
  revStrandBottom: number;
  cutLineTopY: number;
  cutLineBottomY: number;
  cutLabelY: number;

  pixelsPerBp: number;
  viewStartBp: number;
  viewEndBp: number;
  sequenceVisible: boolean;
  sequenceOpacity: number;
  rowHeight: number;
  sequenceFontSize: number;
  readonly cdsChevronHeight?: number;
  readonly cdsZoomPresentation?: CdsZoomPresentation;

  scaleStroke(baseWidth: number): number;

  scaleNormalOffset?(baseOffsetPx: number): number;

  isNormalBandRenderable?(offsetPx: number, halfHeightPx: number): boolean;

  featurePolygonAt(startBp: number, endBp: number, offsetPx: number, halfHeight?: number): number[];

  featureQuadAt(startBp: number, endBp: number, offsetPx: number, halfHeight?: number): number[];

  featureLabelPosAt(bp: number, offsetPx: number): Pos3;

  readonly isArcMode: boolean;
  arcCircle?(): { readonly center: Pos2; readonly radius: number } | null;

  isFeatureVisible(
    startBp: number,
    featureLenBp: number,
    offsetPx?: number,
    halfHeightPx?: number
  ): boolean;

  cutLabelAt(bp: number): Pos2;
}
