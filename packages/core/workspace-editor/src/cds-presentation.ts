import type { ClassifiedCDS, WorkspaceEditorConfig } from './types';
import {
  ANNOTATION_BAR_HEIGHT,
  TRANSLATION_PILL_HEIGHT,
  TRANSLATION_TRANSCRIPT_HEIGHT,
  TRANSLATION_AA_HEIGHT_RATIO,
  translationLaneHeight,
} from './layout-constants';
import { ANNOTATION_CANVAS_CONSTANTS } from './canvas-constants';
import { cdsMorphPhases, CDS_GLYPH_STYLE } from '@waypoint/platform';
import { rowPaintBounds, rowPaintY } from './predictive-wrap-layout';
import type { Layout2DRow } from './types';

export function projectedCdsDiagnostics(
  row: Layout2DRow,
  cds: Pick<
    ClassifiedCDS,
    | '_paintedPresentation'
    | '_cdsPillBounds'
    | '_cdsLineBounds'
    | '_exonPillBounds'
    | '_intronPillBounds'
    | '_interactionOutlineContours'
  >
) {
  const pose = cds._paintedPresentation;
  const project = (y: number, height: number) => rowPaintBounds(row, y, height, 2);
  const pills = <T extends { y?: number; h?: number }>(bounds: T[] | undefined) =>
    bounds?.map((p) =>
      p.y === undefined
        ? p
        : { ...p, y: project(p.y, p.h ?? 14).y, h: project(p.y, p.h ?? 14).height }
    );
  if (!pose)
    return {
      presentation: undefined,
      namePills: pills(cds._cdsPillBounds),
      topLines: pills(cds._cdsLineBounds),
      exonPills: pills(cds._exonPillBounds),
      intronPills: pills(cds._intronPillBounds),
    };
  const bar = project(pose.barY, pose.barHeight),
    label = project(pose.labelY, pose.labelHeight),
    aa = project(pose.aaY, pose.aaHeight),
    line = project(pose.intronY - 0.5, 1);
  return {
    labelY: label.y + label.height / 2,
    presentation: {
      ...pose,
      barY: bar.y,
      barHeight: bar.height,
      barCenterY: bar.y + bar.height / 2,
      labelY: label.y,
      labelHeight: label.height,
      aaY: aa.y,
      aaHeight: aa.height,
      intronY: line.y + line.height / 2,
    },
    namePills: pills(cds._cdsPillBounds),
    topLines: pills(cds._cdsLineBounds),
    exonPills: pills(cds._exonPillBounds),
    intronPills: pills(cds._intronPillBounds),
    interactionContours: cds._interactionOutlineContours?.map((contour) =>
      contour.map((p) => ({ x: p.x, y: rowPaintY(row, p.y) }))
    ),
  };
}

type PresentationConfig = Pick<WorkspaceEditorConfig, 'rowHeight' | 'showResidueNumbers'> &
  Partial<
    Pick<
      WorkspaceEditorConfig,
      | 'cdsDetailProgress'
      | 'lodLevel'
      | 'showAnnotations'
      | 'showTranslation'
      | 'cdsZoomPresentation'
    >
  >;

export function cdsDetailProgress(config: Partial<PresentationConfig>): number {
  if (config.showAnnotations === false && config.showTranslation) return 1;
  return Math.max(
    0,
    Math.min(1, config.cdsDetailProgress ?? (config.lodLevel === 'feature' ? 0 : 1))
  );
}

export function cdsLaneHeight(config: PresentationConfig): number {
  return (
    translationLaneHeight(
      config.rowHeight,
      config.showResidueNumbers,
      config.cdsZoomPresentation?.aaHeight,
      cdsLayoutProgress(config)
    ) * (config.cdsZoomPresentation ? 1 : cdsLayoutProgress(config))
  );
}

export function cdsLayoutProgress(config: Partial<PresentationConfig>): number {
  return cdsPresentationPhases(config).bandProgress;
}

export function cdsPresentationPhases(config: Partial<PresentationConfig>) {
  const indexed = config.cdsZoomPresentation;
  if (indexed)
    return config.showAnnotations === false && config.showTranslation
      ? { ...indexed, progress: 1, bandProgress: 1 }
      : indexed;
  return cdsMorphPhases(cdsDetailProgress(config));
}

export function cdsPresentationGeometry(
  cds: ClassifiedCDS,
  translationY: number,
  annotationY: number,
  config: PresentationConfig
) {
  const progress = cdsDetailProgress(config);
  const cohesive = config.cdsDetailProgress !== undefined;
  const phases = cdsPresentationPhases(config);
  const layoutProgress = cohesive ? phases.bandProgress : progress;
  const detailY =
    (cds._detailAnnotationHeight === undefined
      ? translationY
      : annotationY + cds._detailAnnotationHeight) +
    cds.translationLane *
      translationLaneHeight(
        config.rowHeight,
        config.showResidueNumbers,
        config.cdsZoomPresentation?.aaHeight,
        layoutProgress
      );
  if (config.cdsZoomPresentation) {
    const zoom = config.cdsZoomPresentation;
    const aaHeight = zoom.aaHeight;
    const bandY = detailY + TRANSLATION_PILL_HEIGHT * layoutProgress;
    return {
      progress: config.showAnnotations === false && config.showTranslation ? 1 : zoom.progress,
      bandProgress: phases.bandProgress,
      topLineHeight: zoom.topLineHeight,
      bandHeight: zoom.bandHeight,
      colorAlpha: phases.colorAlpha,
      chevronProgress: phases.chevronProgress,
      residueAlpha: phases.residueAlpha,
      aaFontSize: zoom.aaFontSize,
      viewportSpanPx: zoom.viewportSpanPx,
      labelY: detailY,
      labelHeight: TRANSLATION_PILL_HEIGHT,
      barY: bandY,
      barHeight: aaHeight,
      barCenterY: bandY + aaHeight / 2,
      aaY: bandY,
      aaHeight,
      intronY: bandY + aaHeight / 2,
    };
  }
  const compactCenter =
    annotationY +
    (cds._compactLane ?? 0) * (ANNOTATION_BAR_HEIGHT + ANNOTATION_CANVAS_CONSTANTS.LANE_SPACING) +
    ANNOTATION_BAR_HEIGHT / 2;
  const center =
    cds._compactLane !== undefined && layoutProgress < 1
      ? compactCenter + (detailY + TRANSLATION_PILL_HEIGHT / 2 - compactCenter) * layoutProgress
      : detailY + TRANSLATION_PILL_HEIGHT / 2;
  const labelY = center - TRANSLATION_PILL_HEIGHT / 2;
  const thinHeight = CDS_GLYPH_STYLE.thinBandHeight;
  const aaHeight = cohesive
    ? thinHeight + (config.rowHeight * TRANSLATION_AA_HEIGHT_RATIO - thinHeight) * layoutProgress
    : config.rowHeight * TRANSLATION_AA_HEIGHT_RATIO * progress;
  const aaY = cohesive
    ? center - thinHeight / 2 + (TRANSLATION_PILL_HEIGHT / 2 + thinHeight / 2) * layoutProgress
    : labelY + TRANSLATION_PILL_HEIGHT;
  const barHeight = cohesive
    ? 5
    : ANNOTATION_BAR_HEIGHT + (TRANSLATION_TRANSCRIPT_HEIGHT - ANNOTATION_BAR_HEIGHT) * progress;
  return {
    progress,
    bandProgress: phases.bandProgress,
    colorAlpha: phases.colorAlpha,
    chevronProgress: phases.chevronProgress,
    labelY,
    labelHeight: TRANSLATION_PILL_HEIGHT,
    barY: center - barHeight / 2,
    barHeight,
    barCenterY: center,
    aaY,
    aaHeight,
    intronY: cohesive
      ? aaY + aaHeight / 2
      : center +
        (TRANSLATION_PILL_HEIGHT / 2 + (config.rowHeight * TRANSLATION_AA_HEIGHT_RATIO) / 2) *
          progress,
    residueAlpha: cohesive ? phases.residueAlpha : progress * progress,
  };
}
