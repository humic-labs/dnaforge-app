import type { ColoredCutSite } from '@waypoint/sequence-utils';
import type { SequenceViewMode } from './SequenceViewerModeToggle';

const EMPTY_COLORED_CUT_SITES: ColoredCutSite[] = [];

export function sequenceSearchOverlayProps<T>(search: {
  isOpen: boolean;
  matches: T;
  activeHighlightRange: unknown;
  activeIndex: number;
}): { searchMatches: T | undefined; activeSearchIndex: number } {
  return {
    searchMatches: search.isOpen ? search.matches : undefined,
    activeSearchIndex: search.activeHighlightRange ? search.activeIndex : -1,
  };
}

export function sequenceMutationsForCoordinateSpace<T>(
  coordinateSpace: unknown,
  mutations: T
): T | undefined {
  return coordinateSpace ? mutations : undefined;
}

export function sequenceReverseComplementVisible(
  hideReverseComplement: boolean | undefined,
  showReverseComplement: boolean
): boolean {
  return hideReverseComplement ? false : showReverseComplement;
}

export function sequenceScannedCutSites(
  isFeatureOrDetailLod: boolean,
  cutSitesVisible: boolean,
  scannedCutSites: ColoredCutSite[]
): ColoredCutSite[] {
  return isFeatureOrDetailLod && cutSitesVisible ? scannedCutSites : EMPTY_COLORED_CUT_SITES;
}

export function sequenceShowCutSites(
  isFeatureOrDetailLod: boolean,
  cutSitesVisible: boolean,
  internalCutSiteCount: number
): boolean {
  return isFeatureOrDetailLod && (cutSitesVisible || internalCutSiteCount > 0);
}

export function whenFlag<T>(flag: boolean, value: T): T | undefined {
  return flag ? value : undefined;
}

export function unlessFlag<T>(flag: boolean, value: T): T | undefined {
  return flag ? undefined : value;
}

export function workspaceViewerMapSurfaceOrders(mapPlacedBeforeSequence: boolean): {
  sequenceSurfaceOrder: number;
  mapSurfaceOrder: number;
} {
  return mapPlacedBeforeSequence
    ? { sequenceSurfaceOrder: 2, mapSurfaceOrder: 0 }
    : { sequenceSurfaceOrder: 0, mapSurfaceOrder: 2 };
}

export function workspaceViewerMapSurfaceVisible(
  emptySequenceEditing: boolean,
  mapVisible: boolean
): boolean {
  return emptySequenceEditing ? false : mapVisible;
}

export function sequenceSurfaceMode(
  sequenceSurfaceVisible: boolean,
  sequenceViewMode: SequenceViewMode
): 'hidden' | 'tracks' | '2d' {
  if (!sequenceSurfaceVisible) return 'hidden';
  return sequenceViewMode === 'tracks' ? 'tracks' : '2d';
}
