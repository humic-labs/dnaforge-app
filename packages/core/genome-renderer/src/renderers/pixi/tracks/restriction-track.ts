import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import {
  INTERNAL_CUT_SITE_STYLE,
  assignEnzymeColors,
  enzymeColorAt,
  hexToEnzymeColorInt,
  type EnzymeColor,
} from '@waypoint/sequence-utils';
import type { CutSite } from '../../../biology/restriction-sites';
import type { RenderState } from '../../../types';
import type { CutSiteHitPayload, WebGLHitTarget } from '../shared/hit-targets';
import type { PathMapper } from '../shared/path-mapper';
import {
  CUT_SITE_LABEL_FONT_FAMILY,
  webglThemeForMode,
  type WebGLThemeMode,
} from '../shared/theme';
import { destroyPixiText } from '../shared/pixi-text-lifecycle';
import { CurvedLabelRenderer } from '../shared/curved-label';
import {
  labelPlacementAt,
  readableTextRotation,
  labelBoxPolygonAtPath,
  buildCutSiteLabelConnectorPolyline,
  renderCutSiteLabelText,
  resolveCutSiteLabels,
} from '../shared/cut-site-label';
export { buildCutSiteLabelConnectorPolyline } from '../shared/cut-site-label';

const RECOG_HIGHLIGHT_FILL = 0xb9b9b9;
const RECOG_HIGHLIGHT_ALPHA = 0.35;
export const PREVIEW_CUT_SITE_COLOR = 0x9ca3af;
const RECOG_HOVER_BORDER_COLOR = 0x505050;
const RECOG_HOVER_BORDER_ALPHA = 0.8;
const CUT_SITE_HIT_PAD = 6;
const LABEL_MIN_GAP = 4;
const MIN_VISIBLE_LABEL_FLOOR = 3;
const LABEL_DENSITY_OVERVIEW_LIMIT = 0.9;
const LABEL_DENSITY_DETAIL_LIMIT = 2.5;

type HitBounds = { x: number; y: number; width: number; height: number };
type CutSiteHitRecord = {
  payload: CutSiteHitPayload;
  bounds?: HitBounds;
  polygon?: number[];
};
type PendingCutSiteLabel = {
  siteId: string;
  enzymeName: string;
  payload: CutSiteHitPayload;
  isHovered: boolean;
  color: number;
  lineColor: number;
  labelBp: number;
  sortBp: number;
  labelTopX: number;
  labelTopY: number;
  labelCenterX: number;
  labelCenterY: number;
  labelW: number;
  labelH: number;
  angle: number;
  anchorX: number;
  anchorY: number;
  isInternal: boolean;
};
type PendingCutSiteLabelSeed = Pick<
  PendingCutSiteLabel,
  | 'siteId'
  | 'enzymeName'
  | 'payload'
  | 'isHovered'
  | 'color'
  | 'lineColor'
  | 'labelBp'
  | 'sortBp'
  | 'anchorX'
  | 'anchorY'
  | 'isInternal'
>;

function lightenColor(color: number, pct: number): number {
  const r = Math.min(255, ((color >> 16) & 0xff) + Math.round((255 * pct) / 100));
  const g = Math.min(255, ((color >> 8) & 0xff) + Math.round((255 * pct) / 100));
  const b = Math.min(255, (color & 0xff) + Math.round((255 * pct) / 100));
  return (r << 16) | (g << 8) | b;
}

function cutSiteLabelWidth(enzymeName: string): number {
  return enzymeName.length * 7 + 8;
}

function filterLabelSeedsByDensity(
  labels: PendingCutSiteLabelSeed[],
  path: PathMapper,
  state: RenderState
): PendingCutSiteLabelSeed[] {
  if (labels.length <= 1) return labels;

  const viewportSpanPx = Math.max(80, path.isArcMode ? state.width + state.height : state.width);
  const totalLabelWidth = labels.reduce(
    (sum, label) => sum + cutSiteLabelWidth(label.enzymeName) + LABEL_MIN_GAP,
    0
  );
  const detailT = Math.max(0, Math.min(1, (path.pixelsPerBp - 0.75) / 1.25));
  const allowedDensity =
    LABEL_DENSITY_OVERVIEW_LIMIT +
    (LABEL_DENSITY_DETAIL_LIMIT - LABEL_DENSITY_OVERVIEW_LIMIT) * detailT;
  const labelBudgetPx = viewportSpanPx * allowedDensity;

  if (totalLabelWidth <= labelBudgetPx) return labels;

  const sorted = [...labels].sort((a, b) => a.sortBp - b.sortBp);
  const avgLabelWidth = totalLabelWidth / labels.length;
  const densityMax = Math.floor(labelBudgetPx / Math.max(avgLabelWidth, 1));
  const maxLabels = Math.max(Math.min(sorted.length, MIN_VISIBLE_LABEL_FLOOR), densityMax);
  if (maxLabels >= sorted.length) return sorted;

  const keepEvery = Math.ceil(sorted.length / maxLabels);
  return sorted.filter((label, index) => label.isHovered || index % keepEvery === 0);
}

function filterLabelsByDensity(
  labels: PendingCutSiteLabel[],
  path: PathMapper,
  state: RenderState
): PendingCutSiteLabel[] {
  if (labels.length <= 1) return labels;

  const viewportSpanPx = Math.max(80, path.isArcMode ? state.width + state.height : state.width);
  const totalLabelWidth = labels.reduce((sum, label) => sum + label.labelW + LABEL_MIN_GAP, 0);
  const detailT = Math.max(0, Math.min(1, (path.pixelsPerBp - 0.75) / 1.25));
  const allowedDensity =
    LABEL_DENSITY_OVERVIEW_LIMIT +
    (LABEL_DENSITY_DETAIL_LIMIT - LABEL_DENSITY_OVERVIEW_LIMIT) * detailT;
  const labelBudgetPx = viewportSpanPx * allowedDensity;

  if (totalLabelWidth <= labelBudgetPx) return labels;

  const sorted = [...labels].sort((a, b) => a.sortBp - b.sortBp);
  const avgLabelWidth = totalLabelWidth / labels.length;
  const densityMax = Math.floor(labelBudgetPx / Math.max(avgLabelWidth, 1));
  const maxLabels = Math.max(Math.min(sorted.length, MIN_VISIBLE_LABEL_FLOOR), densityMax);
  if (maxLabels >= sorted.length) return sorted;

  const keepEvery = Math.ceil(sorted.length / maxLabels);
  return sorted.filter((label, index) => label.isHovered || index % keepEvery === 0);
}

function drawDashedPolyline(
  g: Graphics,
  points: Array<{ x: number; y: number }>,
  dashLen: number,
  gapLen: number
): void {
  if (points.length < 2) return;

  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 0.5) continue;

    const steps = Math.floor(dist / (dashLen + gapLen));
    for (let s = 0; s <= steps; s++) {
      const startPx = s * (dashLen + gapLen);
      if (startPx >= dist) break;
      const endPx = Math.min(dist, startPx + dashLen);
      const t0 = startPx / dist;
      const t1 = endPx / dist;
      g.moveTo(from.x + dx * t0, from.y + dy * t0);
      g.lineTo(from.x + dx * t1, from.y + dy * t1);
    }
  }
}

export class RestrictionTrack {
  private curvedLabels: CurvedLabelRenderer;
  private container: Container;
  private graphics = new Graphics();
  private labelPool: Text[] = [];
  private labelIndex = 0;
  private labelStyleNormal: TextStyle;
  private labelStyleBold: TextStyle;
  private badgePool: Text[] = [];
  private badgeIndex = 0;
  private badgeStyle: TextStyle;
  private appliedThemeMode: WebGLThemeMode | null = null;
  private hitRecords: CutSiteHitRecord[] = [];

  constructor(parent: Container) {
    this.container = parent;
    parent.addChild(this.graphics);
    this.curvedLabels = new CurvedLabelRenderer(parent);
    this.labelStyleNormal = new TextStyle({
      fontSize: 10,
      fill: 0xffffff,
      fontFamily: CUT_SITE_LABEL_FONT_FAMILY,
      fontWeight: '400',
    });
    this.labelStyleBold = new TextStyle({
      fontSize: 10,
      fill: 0xffffff,
      fontFamily: CUT_SITE_LABEL_FONT_FAMILY,
      fontWeight: '700',
    });
    this.badgeStyle = new TextStyle({
      fontSize: INTERNAL_CUT_SITE_STYLE.badgeFontSizePx,
      fill: INTERNAL_CUT_SITE_STYLE.badgeGlyphPixi,
      fontFamily: CUT_SITE_LABEL_FONT_FAMILY,
      fontWeight: INTERNAL_CUT_SITE_STYLE.badgeFontWeight,
    });
  }

  private applyTheme(state: RenderState) {
    const theme = webglThemeForMode(state.themeMode);
    if (this.appliedThemeMode === theme.mode) return theme;
    this.appliedThemeMode = theme.mode;
    return theme;
  }

  private resolveEnzymeColor(site: CutSite, fallback: Map<string, EnzymeColor>): number {
    if (site.color) return hexToEnzymeColorInt(site.color);
    return (fallback.get(site.enzyme.name) ?? enzymeColorAt(0)).int;
  }

  reset(): void {
    this.curvedLabels.reset();
    this.graphics.clear();
    this.hitRecords = [];
    for (let i = 0; i < this.labelIndex; i++) {
      this.labelPool[i].visible = false;
    }
    this.labelIndex = 0;
    for (let i = 0; i < this.badgeIndex; i++) {
      this.badgePool[i].visible = false;
    }
    this.badgeIndex = 0;
  }

  renderSites(
    sites: CutSite[],
    path: PathMapper,
    showRecognition: boolean,
    state: RenderState,
    genomeLength = 0
  ): void {
    const g = this.graphics;
    const theme = this.applyTheme(state);
    this.hitRecords = [];

    const fallbackNames: string[] = [];
    const seenFallbackNames = new Set<string>();
    for (const site of sites) {
      if (site.isInternalCutSite || site.isPreview || site.color) continue;
      if (!seenFallbackNames.has(site.enzyme.name)) {
        seenFallbackNames.add(site.enzyme.name);
        fallbackNames.push(site.enzyme.name);
      }
    }
    const fallbackColors = assignEnzymeColors(fallbackNames);

    const pendingLabelSeeds: PendingCutSiteLabelSeed[] = [];

    for (const site of sites) {
      const midBp = (site.position + site.recognitionEnd) / 2;
      const midPos = path.backboneAt(midBp);
      if (
        midPos.x < -100 ||
        midPos.x > state.width + 100 ||
        midPos.y < -100 ||
        midPos.y > state.height + 100
      )
        continue;

      const isInternal = site.isInternalCutSite === true;
      const isPreview = site.isPreview === true;
      const color = isInternal
        ? INTERNAL_CUT_SITE_STYLE.colorPixi
        : isPreview
          ? PREVIEW_CUT_SITE_COLOR
          : this.resolveEnzymeColor(site, fallbackColors);
      const siteId = `${site.enzyme.name}:${site.position}`;
      const isHovered = state.hoveredCutSiteId === siteId;
      const lineWidth = path.scaleStroke(
        isInternal ? INTERNAL_CUT_SITE_STYLE.lineWidth : isHovered ? 3 : 1.5
      );
      const lineColor = isHovered ? lightenColor(color, 20) : color;
      const hitPayload = this.siteHitPayload(site, siteId);

      const topCut = path.cutLineTopAt(site.cutPositionTop);
      const topConnector = path.cutLineConnectorAt(site.cutPositionTop);
      const bottomConnector = path.cutLineConnectorAt(site.cutPositionBottom);
      const bottomCut = path.cutLineBottomAt(site.cutPositionBottom);

      g.setStrokeStyle({ width: lineWidth, color: lineColor, alpha: 1 });
      g.moveTo(topCut.x, topCut.y);
      g.lineTo(topConnector.x, topConnector.y);
      if (site.overhang !== 'blunt') {
        g.lineTo(bottomConnector.x, bottomConnector.y);
      }
      g.lineTo(bottomCut.x, bottomCut.y);
      g.stroke();

      this.hitRecords.push({
        payload: hitPayload,
        bounds: paddedBounds(
          [topCut.x, topConnector.x, bottomConnector.x, bottomCut.x],
          [topCut.y, topConnector.y, bottomConnector.y, bottomCut.y],
          CUT_SITE_HIT_PAD
        ),
      });

      if (showRecognition) {
        const recogStartFwd = path.boundaryAt(site.position, 'fwdStrand');
        const recogEndFwd = path.boundaryAt(site.recognitionEnd, 'fwdStrand');
        const recogStartRev = path.boundaryAt(site.position, 'revStrand');
        const recogEndRev = path.boundaryAt(site.recognitionEnd, 'revStrand');

        const recogWidth = Math.sqrt(
          (recogEndFwd.x - recogStartFwd.x) ** 2 + (recogEndFwd.y - recogStartFwd.y) ** 2
        );

        if (recogWidth > 0.5) {
          const rh = path.rowHeight / 2;
          const angle = path.backboneAt(site.position).angle;
          const nx = -Math.sin(angle);
          const ny = Math.cos(angle);

          const recognitionPolygon = [
            recogStartFwd.x - nx * rh,
            recogStartFwd.y - ny * rh,
            recogEndFwd.x - nx * rh,
            recogEndFwd.y - ny * rh,
            recogEndRev.x + nx * rh,
            recogEndRev.y + ny * rh,
            recogStartRev.x + nx * rh,
            recogStartRev.y + ny * rh,
          ];

          g.poly(recognitionPolygon);
          g.fill({
            color: isInternal
              ? INTERNAL_CUT_SITE_STYLE.colorPixi
              : isPreview
                ? PREVIEW_CUT_SITE_COLOR
                : RECOG_HIGHLIGHT_FILL,
            alpha: isInternal ? INTERNAL_CUT_SITE_STYLE.recogFillAlpha : RECOG_HIGHLIGHT_ALPHA,
          });

          if (isHovered) {
            g.setStrokeStyle({
              width: path.scaleStroke(2),
              color: RECOG_HOVER_BORDER_COLOR,
              alpha: RECOG_HOVER_BORDER_ALPHA,
            });
            g.poly(recognitionPolygon);
            g.stroke();
          }
        }
      }

      {
        pendingLabelSeeds.push({
          siteId,
          enzymeName: site.enzyme.name,
          payload: hitPayload,
          isHovered,
          color,
          lineColor,
          labelBp: site.cutPositionBottom,
          sortBp: site.cutPositionTop,
          anchorX: bottomCut.x,
          anchorY: bottomCut.y,
          isInternal,
        });
      }
    }

    const pendingLabels: PendingCutSiteLabel[] = filterLabelSeedsByDensity(
      pendingLabelSeeds,
      path,
      state
    ).map((seed) => {
      const labelW = cutSiteLabelWidth(seed.enzymeName);
      const labelH = 16;
      const placement = labelPlacementAt(path, seed.labelBp, labelH);
      return {
        ...seed,
        labelTopX: placement.topX,
        labelTopY: placement.topY,
        labelCenterX: placement.centerX,
        labelCenterY: placement.centerY,
        labelW,
        labelH,
        angle: placement.angle,
      };
    });
    const densityFilteredLabels = filterLabelsByDensity(pendingLabels, path, state);
    const resolvedLabels = resolveCutSiteLabels(densityFilteredLabels, path, genomeLength);

    for (const lbl of resolvedLabels) {
      let textObj: Text;
      if (this.labelIndex < this.labelPool.length) {
        textObj = this.labelPool[this.labelIndex];
        textObj.visible = true;
      } else {
        textObj = new Text({ text: '', style: this.labelStyleNormal });
        textObj.eventMode = 'static';
        textObj.cursor = 'pointer';
        this.container.addChild(textObj);
        this.labelPool.push(textObj);
      }
      this.labelIndex++;

      const thisSiteId = lbl.siteId;
      textObj.off('pointerover');
      textObj.off('pointerout');
      textObj.on('pointerover', () => {
        state.hoveredCutSiteId = thisSiteId;
      });
      textObj.on('pointerout', () => {
        if (state.hoveredCutSiteId === thisSiteId) state.hoveredCutSiteId = null;
      });

      if (textObj.text !== lbl.enzymeName) textObj.text = lbl.enzymeName;
      const targetStyle = lbl.isHovered ? this.labelStyleBold : this.labelStyleNormal;
      if (textObj.style !== targetStyle) textObj.style = targetStyle;
      textObj.tint = lbl.lineColor;

      textObj.anchor.set(0.5, 0.5);
      textObj.x = lbl.finalCenterX;
      textObj.y = lbl.finalCenterY;
      textObj.rotation = readableTextRotation(lbl.finalAngle);
      renderCutSiteLabelText(
        textObj,
        this.curvedLabels,
        path,
        lbl.finalBp,
        lbl.labelH,
        lbl.lineColor
      );

      const bgColor = lbl.isHovered
        ? lightenColor(lbl.color, theme.mode === 'dark' ? 25 : 85)
        : theme.sequenceBackground;

      const internalBorder = (points: Array<{ x: number; y: number }>) => {
        g.setStrokeStyle({
          width: path.scaleStroke(1.75),
          color: INTERNAL_CUT_SITE_STYLE.colorPixi,
          alpha: 1,
        });
        drawDashedPolyline(g, points, 3, 2);
      };

      if (!path.isArcMode) {
        const boxX = lbl.finalTopX - lbl.labelW / 2;
        g.rect(boxX, lbl.finalTopY, lbl.labelW, lbl.labelH);
        g.fill({ color: bgColor, alpha: 0.9 });
        if (lbl.isInternal) {
          internalBorder([
            { x: boxX, y: lbl.finalTopY },
            { x: boxX + lbl.labelW, y: lbl.finalTopY },
            { x: boxX + lbl.labelW, y: lbl.finalTopY + lbl.labelH },
            { x: boxX, y: lbl.finalTopY + lbl.labelH },
            { x: boxX, y: lbl.finalTopY },
          ]);
        } else {
          g.setStrokeStyle({ width: path.scaleStroke(1.25), color: lbl.lineColor, alpha: 1 });
          g.rect(boxX, lbl.finalTopY, lbl.labelW, lbl.labelH);
          g.stroke();
        }
        this.hitRecords.push({
          payload: lbl.payload,
          bounds: { x: boxX, y: lbl.finalTopY, width: lbl.labelW, height: lbl.labelH },
        });
      } else {
        const labelPoly = labelBoxPolygonAtPath(path, lbl.finalBp, lbl.labelW, lbl.labelH);
        g.poly(labelPoly);
        g.fill({ color: bgColor, alpha: 0.9 });
        if (lbl.isInternal) {
          const pts: Array<{ x: number; y: number }> = [];
          for (let i = 0; i + 1 < labelPoly.length; i += 2) {
            pts.push({ x: labelPoly[i], y: labelPoly[i + 1] });
          }
          if (pts.length > 0) pts.push(pts[0]);
          internalBorder(pts);
        } else {
          g.setStrokeStyle({ width: path.scaleStroke(1.25), color: lbl.lineColor, alpha: 1 });
          g.poly(labelPoly);
          g.stroke();
        }
        this.hitRecords.push({
          payload: lbl.payload,
          polygon: labelPoly,
        });
      }

      if (lbl.isInternal) {
        const badgeR = INTERNAL_CUT_SITE_STYLE.badgeRadiusPx;
        const dist = lbl.labelW / 2 + badgeR + 2;
        const badgeCX = lbl.finalCenterX + Math.cos(lbl.finalAngle) * dist;
        const badgeCY = lbl.finalCenterY + Math.sin(lbl.finalAngle) * dist;
        g.circle(badgeCX, badgeCY, badgeR);
        g.fill({ color: INTERNAL_CUT_SITE_STYLE.colorPixi, alpha: 1 });
        g.setStrokeStyle({
          width: path.scaleStroke(INTERNAL_CUT_SITE_STYLE.badgeStrokeWidth),
          color: INTERNAL_CUT_SITE_STYLE.badgeStrokePixi,
          alpha: 1,
        });
        g.circle(badgeCX, badgeCY, badgeR);
        g.stroke();

        let badge: Text;
        if (this.badgeIndex < this.badgePool.length) {
          badge = this.badgePool[this.badgeIndex];
          badge.visible = true;
        } else {
          badge = new Text({ text: INTERNAL_CUT_SITE_STYLE.badgeChar, style: this.badgeStyle });
          badge.eventMode = 'none';
          this.container.addChild(badge);
          this.badgePool.push(badge);
        }
        this.badgeIndex++;
        badge.anchor.set(0.5, 0.5);
        badge.x = badgeCX;
        badge.y = badgeCY;
        badge.rotation = 0;
      }

      {
        g.setStrokeStyle({ width: path.scaleStroke(0.75), color: lbl.lineColor, alpha: 0.6 });
        drawDashedPolyline(
          g,
          buildCutSiteLabelConnectorPolyline(
            path,
            lbl.labelH,
            { x: lbl.anchorX, y: lbl.anchorY },
            lbl.labelBp,
            lbl.finalBp
          ),
          3,
          3
        );
        g.stroke();
      }
    }
  }

  destroy(): void {
    this.curvedLabels.destroy();
    this.graphics.destroy();
    for (const t of this.labelPool) destroyPixiText(t);
    for (const t of this.badgePool) destroyPixiText(t);
  }

  hitTest(screenX: number, screenY: number): WebGLHitTarget | null {
    for (let i = this.hitRecords.length - 1; i >= 0; i--) {
      const record = this.hitRecords[i];
      if (record.bounds && pointInBounds(screenX, screenY, record.bounds)) {
        return { kind: 'cut-site', payload: record.payload };
      }
      if (record.polygon && pointInPolygon(screenX, screenY, record.polygon)) {
        return { kind: 'cut-site', payload: record.payload };
      }
    }
    return null;
  }

  private siteHitPayload(site: CutSite, id: string): CutSiteHitPayload {
    return {
      id,
      enzymeName: site.enzyme.name,
      position: site.position,
      recognitionStart: site.position,
      recognitionEnd: site.recognitionEnd,
      cutPositionTop: site.cutPositionTop,
      cutPositionBottom: site.cutPositionBottom,
    };
  }
}

function paddedBounds(xs: number[], ys: number[], pad: number): HitBounds {
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function pointInBounds(x: number, y: number, bounds: HitBounds): boolean {
  return (
    x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height
  );
}

function pointInPolygon(x: number, y: number, polygon: number[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 2; i < polygon.length; j = i, i += 2) {
    const xi = polygon[i];
    const yi = polygon[i + 1];
    const xj = polygon[j];
    const yj = polygon[j + 1];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
