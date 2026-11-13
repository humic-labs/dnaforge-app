import type { Graphics, Text } from 'pixi.js';
import type { Feature } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import {
  PILL_LABEL_FONT_SIZE,
  PILL_LABEL_PADDING,
  drawLanePillLabelText,
  pillLabelTextColor,
} from '../shared/label-pill';
import { renderCurvedLabelOnPath, type CurvedLabelRenderer } from '../shared/curved-label';
import {
  advanceBpByScreenWidth,
  drawLanePill,
  laneRoundedPillShellPolygons,
  normalizeBp,
} from '../shared/lane-path';
import { computeBBox, featureHitPayload } from './hit-testing';

export type PillDrawHost = {
  genomeLength: number;
  acquireLabel(): Text;
  curvedLabels: CurvedLabelRenderer;
};

export function drawLanePillShell(
  host: PillDrawHost,
  g: Graphics,
  path: PathMapper,
  pillStartBp: number,
  widthPx: number,
  offset: number,
  pillHalfHeight: number,
  centerCutoutHalfHeight: number,
  color: number,
  alpha: number
): void {
  if (widthPx <= 0) return;
  const cutoutHalfHeight = Math.max(0, Math.min(pillHalfHeight - 1e-3, centerCutoutHalfHeight));
  if (cutoutHalfHeight <= 0) {
    drawLanePill(
      g,
      path,
      pillStartBp,
      widthPx,
      offset,
      pillHalfHeight,
      color,
      alpha,
      host.genomeLength
    );
    return;
  }

  const shellPolygons = laneRoundedPillShellPolygons(
    path,
    pillStartBp,
    widthPx,
    offset,
    pillHalfHeight,
    cutoutHalfHeight
  );
  for (const pts of shellPolygons) {
    g.poly(pts);
    g.fill({ color, alpha });
  }
}

export function drawCdsDirectionGlyphInPill(
  host: PillDrawHost,
  feature: Feature,
  glyph: string,
  pillStartBp: number,
  pillWidthPx: number,
  glyphWidthPx: number,
  offset: number,
  color: number,
  path: PathMapper,
  alpha = 1,
  textColor?: number
): void {
  if (pillWidthPx <= 0) return;
  const sideOffset =
    feature.direction === 'reverse'
      ? Math.min(pillWidthPx / 2, PILL_LABEL_PADDING + glyphWidthPx / 2)
      : Math.max(pillWidthPx / 2, pillWidthPx - PILL_LABEL_PADDING - glyphWidthPx / 2);
  const centerBp = advanceBpByScreenWidth(path, pillStartBp, sideOffset, offset);
  const startOffset = Math.max(0, sideOffset - glyphWidthPx / 2);
  const endOffset = Math.min(pillWidthPx, sideOffset + glyphWidthPx / 2);
  drawLanePillLabelText({
    text: glyph,
    path,
    startBp: advanceBpByScreenWidth(path, pillStartBp, startOffset, offset),
    widthPx: Math.max(1, endOffset - startOffset),
    offsetPx: offset,
    color,
    maxTextWidth: glyphWidthPx,
    acquireText: () => host.acquireLabel(),
    curvedLabels: host.curvedLabels,
    alpha,
    fontSize: PILL_LABEL_FONT_SIZE,
    textColor,
    centerBpOverride: centerBp,
    curvedRangeStartBp: advanceBpByScreenWidth(path, pillStartBp, startOffset, offset),
    curvedRangeEndBp: advanceBpByScreenWidth(path, pillStartBp, endOffset, offset),
  });
}

export function drawLabelTextInPill(
  host: PillDrawHost,
  feature: Feature,
  text: string,
  startBp: number,
  widthPx: number,
  offset: number,
  color: number,
  path: PathMapper,
  maxTextWidth: number,
  alpha = 1,
  centerBpOverride: number | null = null,
  curvedRangeStartBp: number | null = null,
  curvedRangeEndBp: number | null = null,
  textColor?: number
): void {
  void feature;
  drawLanePillLabelText({
    text,
    path,
    startBp,
    widthPx,
    offsetPx: offset,
    color,
    maxTextWidth,
    acquireText: () => host.acquireLabel(),
    curvedLabels: host.curvedLabels,
    alpha,
    textColor,
    centerBpOverride,
    curvedRangeStartBp,
    curvedRangeEndBp,
  });
}

export function renderCurvedLabel(
  host: PillDrawHost,
  labelText: string,
  centerBp: number,
  textWidth: number,
  feature: Feature,
  endBp: number,
  color: number,
  offset: number,
  path: PathMapper,
  alpha = 1,
  rangeStartBp = feature.start,
  rangeEndBp = endBp,
  textColor?: number
): void {
  renderCurvedLabelOnPath(
    host.curvedLabels,
    labelText,
    path,
    centerBp,
    textWidth,
    offset,
    rangeStartBp,
    rangeEndBp,
    PILL_LABEL_FONT_SIZE,
    textColor ?? pillLabelTextColor(color),
    1,
    alpha
  );
}

export function drawPillSeparator(
  g: Graphics,
  path: PathMapper,
  pillStartBp: number,
  offsetPxFromPillStart: number,
  offset: number,
  height: number,
  alpha = 1
): void {
  const bp = advanceBpByScreenWidth(path, pillStartBp, offsetPxFromPillStart, offset);
  const center = path.featureLabelPosAt(bp, offset);
  const nx = -Math.sin(center.angle);
  const ny = Math.cos(center.angle);
  const half = Math.max(1, height / 2 - 2);
  g.setStrokeStyle({ width: 1, color: 0xffffff, alpha: 0.3 * alpha });
  g.moveTo(center.x - nx * half, center.y - ny * half);
  g.lineTo(center.x + nx * half, center.y + ny * half);
  g.stroke();
}

export function pushPillHit(
  host: {
    genomeLength: number;
    hitCache: { push(record: object): unknown };
  },
  feature: Feature,
  startBp: number,
  widthPx: number,
  offset: number,
  halfHeight: number,
  rangeStart: number,
  rangeEnd: number,
  path: PathMapper
): void {
  const endBp = advanceBpByScreenWidth(path, startBp, widthPx, offset);
  const pts = path.featurePolygonAt(startBp, endBp, offset, halfHeight);
  const bbox = computeBBox(pts);
  host.hitCache.push({
    ...featureHitPayload(
      feature,
      normalizeBp(rangeStart, host.genomeLength),
      normalizeBp(rangeEnd, host.genomeLength)
    ),
    pts,
    ...bbox,
  });
}
