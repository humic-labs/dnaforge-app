import { useCallback, useMemo } from 'react';
import { useCutSites, type CutSiteDisplayRequest } from '@waypoint/workspace-editor';
import type { ColoredCutSite } from '@waypoint/sequence-utils';
import type { WebGLMap } from '@waypoint/plasmid-viewer';
import type { ComponentProps } from 'react';

export type WebGLCutSite = NonNullable<ComponentProps<typeof WebGLMap>['cutSites']>[number];

interface UseSequenceCutSitesViewInput {
  sequenceText: string;
  circular: boolean;
  scopeKey: string | undefined;
  displayRequest?: CutSiteDisplayRequest | null;
  onDisplayRequestApplied?: (id: string) => void;
  catalogSummaryEnabled: boolean;
  isFeatureOrDetailLod: boolean;
  internalCutSiteMarkers?: ColoredCutSite[];
  isDigestPanelExpanded: boolean;
  collapseDigestPanel: () => void;
  setEnzymePanelOpen: (open: boolean) => void;
  setHoveredEnzymeName: (enzymeName: string | null) => void;
}

export function toWebGLCutSite(site: ColoredCutSite, isPreview = false): WebGLCutSite {
  const cutTop = site.enzyme.cut_position_top ?? 0;
  const cutBottom = site.enzyme.cut_position_bottom ?? cutTop;
  const overhang =
    site.enzyme.overhang_type === '5_prime'
      ? '5prime'
      : site.enzyme.overhang_type === '3_prime'
        ? '3prime'
        : cutTop === cutBottom
          ? 'blunt'
          : cutTop < cutBottom
            ? '5prime'
            : '3prime';

  return {
    enzyme: {
      name: site.enzyme.name,
      recognition: site.enzyme.recognition_sequence,
      cutTop,
      cutBottom,
    },
    position: site.recognitionStart,
    cutPositionTop: site.cutPositionTop,
    cutPositionBottom: site.cutPositionBottom,
    recognitionEnd: site.recognitionEnd,
    overhang,
    isInternalCutSite: site.isInternalCutSite,
    isPreview,
    color: site.color,
  };
}

export function useSequenceCutSitesView({
  sequenceText,
  circular,
  scopeKey,
  displayRequest,
  onDisplayRequestApplied,
  catalogSummaryEnabled,
  isFeatureOrDetailLod,
  internalCutSiteMarkers,
  isDigestPanelExpanded,
  collapseDigestPanel,
  setEnzymePanelOpen,
  setHoveredEnzymeName,
}: UseSequenceCutSitesViewInput) {
  const [cutSitesState, cutSitesActions] = useCutSites(sequenceText, scopeKey, {
    catalogSummaryEnabled,
    circular,
    displayRequest,
    onDisplayRequestApplied,
  });

  const webglCutSites = useMemo(
    () => [
      ...(cutSitesState.isVisible
        ? cutSitesState.cutSites.map((site) => toWebGLCutSite(site))
        : []),
      ...(cutSitesState.isVisible
        ? cutSitesState.scannedCutSites.map((site) => toWebGLCutSite(site, true))
        : []),
      ...(internalCutSiteMarkers ?? []).map((site) => toWebGLCutSite(site)),
    ],
    [
      cutSitesState.isVisible,
      cutSitesState.cutSites,
      cutSitesState.scannedCutSites,
      internalCutSiteMarkers,
    ]
  );

  const twoDInternalCutSites = useMemo(
    () => (isFeatureOrDetailLod ? (internalCutSiteMarkers ?? []) : []),
    [isFeatureOrDetailLod, internalCutSiteMarkers]
  );

  const twoDCutSites = useMemo(() => {
    return [
      ...(isFeatureOrDetailLod && cutSitesState.isVisible ? cutSitesState.cutSites : []),
      ...twoDInternalCutSites,
    ];
  }, [isFeatureOrDetailLod, cutSitesState.isVisible, cutSitesState.cutSites, twoDInternalCutSites]);

  const handleCutSiteDoubleClick = useCallback(
    (cutSite: { enzyme: { name: string } }) => {
      setEnzymePanelOpen(true);
      if (isDigestPanelExpanded) {
        collapseDigestPanel();
      }
      setHoveredEnzymeName(cutSite.enzyme.name);
    },
    [collapseDigestPanel, isDigestPanelExpanded, setEnzymePanelOpen, setHoveredEnzymeName]
  );

  return {
    cutSitesState,
    cutSitesActions,
    webglCutSites,
    twoDInternalCutSites,
    twoDCutSites,
    handleCutSiteDoubleClick,
  };
}
