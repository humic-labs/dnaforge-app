import type { Graphics } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { FeaturePrimitiveSink } from '../overview/feature-primitive-sink';
import type { HitRecord } from './hit-testing';
import type { OutlineCommand } from './annotation-feature-geometry';
import type { AnnotationDrawAuditDecision } from './annotation-draw-audit';

export type ImmediateDrawHost = {
  genomeLength: number;
  genomeCircular: boolean;
  graphics: Graphics;
  hitCache: HitRecord[];
  outlineCache: Map<number, OutlineCommand[]>;
  lastDrawnFeatureCount: number;
  lastImmediateDrawnLayerTypes: Set<string>;
  lastImmediateTranscriptDrawnCount: number;
  featureOffset(feature: Feature): number;
  scaledBarHeight(): number;
  setFeatureOutline(featureId: number, commands: OutlineCommand[]): void;
  strokeDraftOutlineCommands(
    g: Graphics,
    path: PathMapper,
    commands: OutlineCommand[],
    color: number,
    alpha: number
  ): void;
  drawTranscriptGlyph(
    sink: FeaturePrimitiveSink,
    feature: Feature,
    endBp: number,
    featureLen: number,
    pixelWidth: number,
    color: number,
    alpha: number,
    path: PathMapper,
    state: RenderState,
    hitPts: number[],
    labelAlphaScale: number
  ): void;
  drawStandard(
    sink: FeaturePrimitiveSink,
    feature: Feature,
    endBp: number,
    featureLen: number,
    pixelWidth: number,
    color: number,
    alpha: number,
    path: PathMapper,
    state: RenderState,
    hitPts: number[],
    renderLabel?: boolean,
    labelAlphaScale?: number
  ): void;
  cdsDetailProgress(): number;
  featureLevelLabelCenterBp(
    feature: Feature,
    featureLen: number,
    hitPts: number[],
    state: RenderState
  ): number;
  drawFeatureLevelTransitionShape(
    g: Graphics,
    feature: Feature,
    endBp: number,
    pixelWidth: number,
    color: number,
    alpha: number,
    path: PathMapper,
    hitPts: number[],
    detailProgress: number
  ): void;
  drawCDSLabelStrip(
    g: Graphics,
    feature: Feature,
    endBp: number,
    featureLen: number,
    color: number,
    alpha: number,
    path: PathMapper,
    state: RenderState,
    labelAlpha?: number,
    transitionFromCenterBp?: number | null,
    drawConnector?: boolean,
    centerCutoutHalfHeight?: number | null
  ): void;
  cdsTransitionHalfHeight(detailProgress: number): number;
};
