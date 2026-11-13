import type { Graphics } from 'pixi.js';
import { cdsConnectorCenterOffset } from '@waypoint/platform';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import {
  advanceBpByScreenWidth,
  clampedLanePillPlacement,
  drawLanePill,
  laneCdsTransitionOutlinePolygon,
} from '../shared/lane-path';
import {
  measurePillLabelTextWidth,
  PILL_LABEL_FONT_SIZE,
  PILL_LABEL_PADDING,
} from '../shared/label-pill';
import { lerpBp, type OutlineCommand } from './annotation-feature-geometry';
import { isOutlineOnlyFeature } from './annotation-feature-semantics';
import { cdsChevronEndBp, cdsChevronStartBp } from './indexed-annotation-draw-geometry';
import { bestVisibleFeatureLabelPlacement } from './annotation-label-geometry';

const LABEL_PADDING = PILL_LABEL_PADDING;
const DIRECTION_GLYPH_FONT_SIZE = PILL_LABEL_FONT_SIZE;
const DIRECTION_GLYPH_GAP = 3;

export type CdsLabelStripDrawHost = {
  genomeLength: number;
  genomeCircular: boolean;
  featureOffset(feature: Feature): number;
  scaledBarHeight(): number;
  directionalArrowWidth(pixelWidth: number, barHeight: number): number;
  cdsDirectionGlyph(feature: Feature): string | null;
  cdsExonLabelAlpha(): number;
  shouldRenderFeatureText(path: PathMapper): boolean;
  pillStartForTextCenter(
    path: PathMapper,
    centerBp: number,
    textCenterOffsetPx: number,
    offset: number
  ): number;
  scaledCdsLineHeight(): number;
  reservePillBounds(
    state: RenderState,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfHeight: number,
    record: { kind: string; featureId: number; text: string },
    force?: boolean
  ): boolean;
  drawLaneBandWithGaps(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    endBp: number,
    offset: number,
    halfHeight: number,
    color: number,
    alpha: number,
    gaps: Array<{ startBp: number; endBp: number }>
  ): void;
  setFeatureOutline(featureId: number, commands: OutlineCommand[]): void;
  strokeOutlineCommands(
    g: Graphics,
    path: PathMapper,
    commands: OutlineCommand[],
    color: number,
    alpha: number
  ): void;
  cdsLabelStripOutlineCommand(
    path: PathMapper,
    pillStartBp: number,
    combinedW: number,
    connectorEndBp: number,
    offset: number,
    barHalfH: number,
    connectorHalfH: number
  ): OutlineCommand[];
  addFeatureOutline(featureId: number, command: OutlineCommand): void;
  drawLanePillShell(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    pillHalfHeight: number,
    cutoutHalfHeight: number,
    color: number,
    alpha: number
  ): void;
  drawCdsDirectionGlyphInPill(
    feature: Feature,
    glyph: string,
    startBp: number,
    visibleNameBlockW: number,
    glyphWidth: number,
    offset: number,
    color: number,
    path: PathMapper,
    alpha: number,
    labelTextColor: number | undefined
  ): void;
  drawLabelTextInPill(
    feature: Feature,
    text: string,
    startBp: number,
    width: number,
    offset: number,
    color: number,
    path: PathMapper,
    maxTextW: number,
    alpha: number,
    a: null,
    b: null,
    c: null,
    labelTextColor: number | undefined
  ): void;
  drawPillSeparator(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    offsetPx: number,
    offset: number,
    barH: number,
    alpha: number
  ): void;
  pushPillHit(
    feature: Feature,
    startBp: number,
    width: number,
    offset: number,
    halfH: number,
    rangeStart: number,
    rangeEnd: number,
    path: PathMapper
  ): void;
  lanePillOutlineCommand(
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfH: number
  ): OutlineCommand[];
  strokeLanePill(
    g: Graphics,
    path: PathMapper,
    startBp: number,
    widthPx: number,
    offset: number,
    halfH: number,
    color: number,
    alpha: number
  ): void;
};

function cdsLabelStripRange(args: {
  host: CdsLabelStripDrawHost;
  feature: Feature;
  endBp: number;
  featureLen: number;
  path: PathMapper;
  centerCutoutHalfHeight: number | null;
}): {
  offset: number;
  barH: number;
  fullFeatureWidthPx: number;
  visualStartBp: number;
  visualEndBp: number;
  transitionArrowInsetPx: number;
  labelRangeWidthPx: number;
  labelRangeStartBp: number;
  labelRangeEndBp: number;
} {
  const offset = args.host.featureOffset(args.feature);
  const barH = args.host.scaledBarHeight();
  const fullFeatureWidthPx = args.featureLen * args.path.pixelsPerBp;
  const visualStartBp = cdsChevronStartBp(args.path, args.feature.start);
  const visualEndBp = cdsChevronEndBp(args.path, args.endBp);
  const transitionArrowInsetPx =
    args.centerCutoutHalfHeight != null && args.feature.direction !== 'none'
      ? Math.min(
          args.host.directionalArrowWidth(fullFeatureWidthPx, args.centerCutoutHalfHeight * 2),
          Math.max(0, fullFeatureWidthPx - 1)
        )
      : 0;
  const labelRangeWidthPx = Math.max(0, fullFeatureWidthPx - transitionArrowInsetPx);
  const labelRangeStartBp =
    args.centerCutoutHalfHeight != null && args.feature.direction === 'reverse'
      ? advanceBpByScreenWidth(
          args.path,
          visualStartBp,
          transitionArrowInsetPx,
          offset,
          args.featureLen
        )
      : visualStartBp;
  const labelRangeEndBp =
    args.centerCutoutHalfHeight != null && args.feature.direction === 'forward'
      ? advanceBpByScreenWidth(args.path, visualStartBp, labelRangeWidthPx, offset, args.featureLen)
      : visualEndBp;
  return {
    offset,
    barH,
    fullFeatureWidthPx,
    visualStartBp,
    visualEndBp,
    transitionArrowInsetPx,
    labelRangeWidthPx,
    labelRangeStartBp,
    labelRangeEndBp,
  };
}

export function drawCDSLabelStrip(
  host: CdsLabelStripDrawHost,
  g: Graphics,
  feature: Feature,
  endBp: number,
  featureLen: number,
  color: number,
  alpha: number,
  path: PathMapper,
  state: RenderState,
  labelAlpha = 1,
  transitionFromCenterBp: number | null = null,
  drawConnector = true,
  centerCutoutHalfHeight: number | null = null
): void {
  const {
    offset,
    barH,
    visualStartBp,
    visualEndBp,
    transitionArrowInsetPx,
    labelRangeWidthPx,
    labelRangeStartBp,
    labelRangeEndBp,
  } = cdsLabelStripRange({
    host,
    feature,
    endBp,
    featureLen,
    path,
    centerCutoutHalfHeight,
  });
  const labelPad = LABEL_PADDING;
  const primaryLabel = feature.displayName;
  const directionGlyph = host.cdsDirectionGlyph(feature);
  const directionGlyphWidth = directionGlyph
    ? measurePillLabelTextWidth(directionGlyph, DIRECTION_GLYPH_FONT_SIZE)
    : 0;
  const directionGlyphSlotWidth = directionGlyph ? directionGlyphWidth + DIRECTION_GLYPH_GAP : 0;
  const nameTextW = measurePillLabelTextWidth(primaryLabel);
  const nameBlockW = Math.min(
    nameTextW + labelPad * 2 + directionGlyphSlotWidth,
    Math.max(0, labelRangeWidthPx)
  );
  const renderText = host.shouldRenderFeatureText(path);
  const hasCodingParts = (feature.exons?.length ?? 0) > 0 || (feature.segments?.length ?? 0) > 1;
  const occupied = hasCodingParts
    ? bestVisibleFeatureLabelPlacement(
        feature,
        path,
        state.width,
        state.height,
        offset,
        host.genomeLength
      )
    : null;
  if (hasCodingParts && !occupied) return;
  const nameRangeStart = occupied
    ? cdsChevronStartBp(path, occupied.rangeStartBp)
    : labelRangeStartBp;
  const nameRangeEnd = occupied ? cdsChevronEndBp(path, occupied.rangeEndBp) : labelRangeEndBp;
  const placement = clampedLanePillPlacement(
    path,
    state.width,
    state.height,
    nameRangeStart,
    nameRangeEnd,
    nameBlockW,
    offset,
    host.genomeLength,
    nameRangeStart
  );
  const pillStartBp = placement.startBp;
  const combinedW = placement.widthPx;
  if (combinedW <= 0) return;

  const visibleNameBlockW = Math.min(nameBlockW, combinedW);
  const nameStartOffset = feature.direction === 'reverse' ? directionGlyphSlotWidth : 0;
  const nameEndOffset = feature.direction === 'forward' ? directionGlyphSlotWidth : 0;
  const nameRegionWidth = Math.max(0, visibleNameBlockW - nameStartOffset - nameEndOffset);
  const textCenterOffsetPx =
    nameRegionWidth > 0 ? nameStartOffset + nameRegionWidth / 2 : combinedW / 2;
  const animatedPillStartBp =
    transitionFromCenterBp == null
      ? pillStartBp
      : lerpBp(
          host.pillStartForTextCenter(path, transitionFromCenterBp, textCenterOffsetPx, offset),
          pillStartBp,
          labelAlpha,
          host.genomeLength,
          host.genomeCircular
        );
  const detailAlpha = alpha * labelAlpha;
  const primaryTextAlpha = transitionFromCenterBp == null ? labelAlpha : 1;
  const directionGlyphAlpha = labelAlpha;
  const connectorHalfH = host.scaledCdsLineHeight() / 2;
  const connectorShift = cdsConnectorCenterOffset(barH / 2, connectorHalfH);
  const outlineOnly = isOutlineOnlyFeature(feature);
  const labelTextColor =
    state.sequencePresentation?.annotationColors?.get(feature.id) ??
    (outlineOnly ? color : undefined);

  const visiblePillEndBp = advanceBpByScreenWidth(
    path,
    animatedPillStartBp,
    combinedW,
    offset,
    featureLen
  );
  const connectorStartBp = Math.min(
    connectorShift > 0
      ? advanceBpByScreenWidth(
          path,
          animatedPillStartBp,
          Math.max(0, combinedW - Math.min(3, barH / 2, combinedW / 2)),
          offset,
          featureLen
        )
      : visiblePillEndBp,
    visualEndBp
  );
  host.reservePillBounds(
    state,
    path,
    animatedPillStartBp,
    combinedW,
    offset,
    barH / 2,
    { kind: 'cds-label-pill', featureId: feature.id, text: primaryLabel },
    true
  );
  if (!outlineOnly && drawConnector && connectorStartBp < visualEndBp - 1e-6) {
    host.drawLaneBandWithGaps(
      g,
      path,
      connectorStartBp,
      visualEndBp,
      offset + connectorShift,
      connectorHalfH,
      color,
      detailAlpha,
      []
    );
  }

  if (centerCutoutHalfHeight != null) {
    const pts = laneCdsTransitionOutlinePolygon(
      path,
      visualStartBp,
      visualEndBp,
      animatedPillStartBp,
      combinedW,
      offset,
      barH / 2,
      centerCutoutHalfHeight,
      host.genomeLength,
      feature.direction,
      transitionArrowInsetPx
    );
    if (pts.length >= 6) {
      host.setFeatureOutline(feature.id, [{ kind: 'poly', pts }]);
      if (outlineOnly) {
        host.strokeOutlineCommands(g, path, [{ kind: 'poly', pts }], color, 1);
      }
    }
  } else {
    const outlineCommands = host.cdsLabelStripOutlineCommand(
      path,
      animatedPillStartBp,
      combinedW,
      drawConnector ? Math.max(visiblePillEndBp, visualEndBp) : visiblePillEndBp,
      offset,
      barH / 2,
      connectorHalfH
    );
    for (const command of outlineCommands) {
      host.addFeatureOutline(feature.id, command);
    }
    if (outlineOnly) {
      host.strokeOutlineCommands(g, path, outlineCommands, color, 1);
    }
  }
  if (!outlineOnly) {
    if (centerCutoutHalfHeight != null && centerCutoutHalfHeight < barH / 2 - 1e-6) {
      host.drawLanePillShell(
        g,
        path,
        animatedPillStartBp,
        combinedW,
        offset,
        barH / 2,
        centerCutoutHalfHeight,
        color,
        alpha
      );
    } else {
      drawLanePill(
        g,
        path,
        animatedPillStartBp,
        combinedW,
        offset,
        barH / 2,
        color,
        alpha,
        host.genomeLength
      );
    }
  }
  if (renderText && directionGlyph) {
    host.drawCdsDirectionGlyphInPill(
      feature,
      directionGlyph,
      animatedPillStartBp,
      visibleNameBlockW,
      directionGlyphWidth,
      offset,
      color,
      path,
      directionGlyphAlpha,
      labelTextColor
    );
  }
  if (renderText && nameRegionWidth > 0) {
    const nameStartBp = advanceBpByScreenWidth(
      path,
      animatedPillStartBp,
      nameStartOffset,
      offset,
      featureLen
    );
    host.drawLabelTextInPill(
      feature,
      primaryLabel,
      nameStartBp,
      nameRegionWidth,
      offset,
      color,
      path,
      Math.min(nameRegionWidth - labelPad, nameTextW),
      primaryTextAlpha,
      null,
      null,
      null,
      labelTextColor
    );
  }
}
