import { useCallback, useMemo } from 'react';
import {
  detailTrackPreviewProgress,
  cdsDetailZoomProgress,
  cdsReplacementZoomPresentation,
  canRenderNucleotideText,
  type SequenceLodLevel,
} from '@waypoint/workspace-editor';
import type { SequenceViewState } from '../view-state/sequence-view-state';
import type { SequenceViewStatePatchFn } from '../view-state/useSequenceViewState';
import type { ViewerConfig } from '../types';

const EDITOR_CONFIG = {
  showTranslation: true,
  showAnnotations: true,
  showReverseComplement: true,
  showPrimers: true,
};

interface ViewerMetrics {
  charWidth: number;
  fontSize: number;
  rowHeight: number;
}

interface UseSequenceViewerConfigInput {
  seqView: SequenceViewState;
  patchSeqView: SequenceViewStatePatchFn;
  cutSitesVisible: boolean;
  toggleCutSitesVisibility: () => void;
  viewerLodLevel: SequenceLodLevel;
  isDetailLod: boolean;
  isOverviewLod: boolean;
  hideReverseComplement?: boolean;
  aaColorScheme: string;
  scaledViewerMetrics: ViewerMetrics;
}

export function useSequenceViewerConfig({
  seqView,
  patchSeqView,
  cutSitesVisible,
  toggleCutSitesVisibility,
  viewerLodLevel,
  isDetailLod,
  isOverviewLod,
  hideReverseComplement,
  aaColorScheme,
  scaledViewerMetrics,
}: UseSequenceViewerConfigInput) {
  const viewerConfig: ViewerConfig = useMemo(
    () => ({
      showAnnotations: seqView.display.showAnnotations,
      showTranslation: seqView.display.showTranslation,
      showReverseComplement: seqView.display.showReverseComplement,
      showPrimers: seqView.display.showPrimers,
      showResidueNumbers: seqView.display.showResidueNumbers,
      showCutSites: cutSitesVisible,
      zoomLevel: seqView.zoom,
      annotationColorMode: seqView.annotationColorMode,
    }),
    [
      seqView.display.showAnnotations,
      seqView.display.showTranslation,
      seqView.display.showReverseComplement,
      seqView.display.showPrimers,
      seqView.display.showResidueNumbers,
      seqView.zoom,
      seqView.annotationColorMode,
      cutSitesVisible,
    ]
  );

  const editorConfig = useMemo(() => {
    const nucleotideTextVisible = isDetailLod && canRenderNucleotideText(scaledViewerMetrics);
    const detailPreviewProgress = !nucleotideTextVisible
      ? detailTrackPreviewProgress(scaledViewerMetrics)
      : 0;
    return {
      ...EDITOR_CONFIG,
      lodLevel: viewerLodLevel,
      cdsDetailProgress:
        isDetailLod && viewerConfig.showTranslation
          ? viewerConfig.showAnnotations
            ? cdsDetailZoomProgress(scaledViewerMetrics)
            : 1
          : 0,
      cdsZoomPresentation: cdsReplacementZoomPresentation(scaledViewerMetrics.charWidth, 0),
      previewDetailTracks:
        detailPreviewProgress > 0
          ? {
              progress: detailPreviewProgress,
              showTranslation: false,
              showReverseComplement: !hideReverseComplement && viewerConfig.showReverseComplement,
              showResidueNumbers: viewerConfig.showResidueNumbers,
            }
          : undefined,
      overviewLod: isOverviewLod,
      showAnnotations: viewerConfig.showAnnotations,
      showTranslation: viewerConfig.showTranslation,
      showNucleotideLetters: nucleotideTextVisible,
      showReverseComplement: !nucleotideTextVisible
        ? false
        : hideReverseComplement
          ? false
          : viewerConfig.showReverseComplement,
      showPrimers: !isOverviewLod ? viewerConfig.showPrimers : false,
      showResidueNumbers: isDetailLod ? viewerConfig.showResidueNumbers : false,
      annotationColorMode: viewerConfig.annotationColorMode,
      charWidth: scaledViewerMetrics.charWidth,
      fontSize: scaledViewerMetrics.fontSize,
      rowHeight: scaledViewerMetrics.rowHeight,
      aaColorScheme,
    };
  }, [
    viewerConfig,
    viewerLodLevel,
    isDetailLod,
    isOverviewLod,
    hideReverseComplement,
    aaColorScheme,
    scaledViewerMetrics.charWidth,
    scaledViewerMetrics.fontSize,
    scaledViewerMetrics.rowHeight,
  ]);

  const handleConfigChange = useCallback(
    (newConfig: ViewerConfig) => {
      if (newConfig.showCutSites !== cutSitesVisible) {
        toggleCutSitesVisibility();
      }
      patchSeqView({
        zoom: newConfig.zoomLevel,
        annotationColorMode: newConfig.annotationColorMode,
        display: {
          showAnnotations: newConfig.showAnnotations,
          showTranslation: newConfig.showTranslation,
          showReverseComplement: newConfig.showReverseComplement,
          showPrimers: newConfig.showPrimers,
          showResidueNumbers: newConfig.showResidueNumbers,
        },
      });
    },
    [cutSitesVisible, patchSeqView, toggleCutSitesVisibility]
  );

  const handleZoomLevelChange = useCallback(
    (next: number) => {
      patchSeqView({ zoom: next });
    },
    [patchSeqView]
  );

  return {
    viewerConfig,
    editorConfig,
    handleConfigChange,
    handleZoomLevelChange,
  };
}
