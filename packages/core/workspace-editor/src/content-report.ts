import type { LayoutSnapshot2D } from './types';

export interface CanvasContentReportCounts {
  totalLines: number;
  annotationLineCount: number;
  cdsLineCount: number;
  forwardOrfLineCount: number;
  reverseOrfLineCount: number;
  complementLineCount: number;
  totalAnnotations: number;
  totalCdsLanes: number;
  totalDraftAnnotations: number;
  totalDraftCds: number;
  totalForwardOrfs: number;
  totalReverseOrfs: number;
  sequenceLength: number;
  isCircular: boolean;
}

const DRAFT_FEATURE_SOURCES = new Set([
  'annotation-draft',
  'orf-candidate-cds',
  'pLannotate-draft',
]);

type FeatureWithSourceQualifier = {
  qualifiers?: {
    source?: readonly string[];
  };
};

export function isDraftContentEntry(feature: FeatureWithSourceQualifier): boolean {
  return feature.qualifiers?.source?.some((source) => DRAFT_FEATURE_SOURCES.has(source)) ?? false;
}

export function buildCanvasContentReportCounts(
  layout: LayoutSnapshot2D
): CanvasContentReportCounts {
  let annotationLineCount = 0;
  let cdsLineCount = 0;
  let forwardOrfLineCount = 0;
  let reverseOrfLineCount = 0;
  let complementLineCount = 0;
  let totalAnnotations = 0;
  let totalCdsLanes = 0;
  let totalDraftAnnotations = 0;
  let totalDraftCds = 0;
  let totalForwardOrfs = 0;
  let totalReverseOrfs = 0;

  for (const line of layout.lines) {
    if (line.annotations.length > 0) annotationLineCount++;
    if ((line.classifiedCDSs?.length ?? 0) > 0) cdsLineCount++;
    if ((line.forwardOrfs?.length ?? 0) > 0) forwardOrfLineCount++;
    if ((line.reverseOrfs?.length ?? 0) > 0) reverseOrfLineCount++;
    if (line.complementSequence.length > 0) complementLineCount++;
    totalAnnotations += line.annotations.length;
    totalCdsLanes += line.translationLaneCount ?? 0;
    totalDraftAnnotations += line.annotations.filter(isDraftContentEntry).length;
    totalDraftCds += (line.classifiedCDSs ?? []).filter(isDraftContentEntry).length;
    totalForwardOrfs += line.forwardOrfs?.length ?? 0;
    totalReverseOrfs += line.reverseOrfs?.length ?? 0;
  }

  return {
    totalLines: layout.lines.length,
    annotationLineCount,
    cdsLineCount,
    forwardOrfLineCount,
    reverseOrfLineCount,
    complementLineCount,
    totalAnnotations,
    totalCdsLanes,
    totalDraftAnnotations,
    totalDraftCds,
    totalForwardOrfs,
    totalReverseOrfs,
    sequenceLength: layout.sequenceLength ?? 0,
    isCircular: layout.isCircular ?? false,
  };
}
