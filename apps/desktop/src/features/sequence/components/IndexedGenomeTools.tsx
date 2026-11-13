import { toOptionalUserMessage } from '@waypoint/user-messages';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { RestrictionEnzymeDropdown } from '@waypoint/ui-components';

import { useStructureDrawerStore } from '../../structure-drawer/public';
import { StructureDrawerContent } from '../../structure-drawer/public/components/StructureDrawerContent';
import type { StructureDrawerRequest } from '../../structure-drawer/public/types/structure-drawer';

import { useDrawerState } from '../hooks/useDrawerState';
import { DEFAULT_VIEWER_CONFIG, type ViewerConfig } from '../types';
import { SEQUENCE_VIEWER_TOOLS } from '../viewer-tools';
import type { IndexedChromosomeSpan } from './indexed-cut-site-window';
import type { IndexedSequenceOverlays } from './indexed-sequence-overlays';
import { SequenceDrawer } from './SequenceDrawer';
import { SequenceToolbarSidebar } from './SequenceToolbarSidebar';
import { useIndexedCutSites, type IndexedCutSiteAvailability } from './useIndexedCutSites';
import { useIndexedPrimers, type IndexedPrimerSelection } from './useIndexedPrimers';
import type { IndexedGenomePrimerBinding } from '../../../shared/indexed-genome';
import type { PrimerDirection } from '../../primers/public/types';

const INDEXED_TOOLS = SEQUENCE_VIEWER_TOOLS['indexed-genome'];

const NO_PRIMERS: IndexedSequenceOverlays['primers'] = [];

const INDEXED_DRAWER_WIDTH_KEY = 'indexed-genome';

export function useIndexedGenomeTools({
  scopeKey,
  structureEntityId,
  viewport,
  selection,
  viewerWidthPx,
  chromosomes,
  readSequence,
  onRevealRange,
  primerBindings,
  persistPrimerBindings,
  primerWorkspaceRoot,
  onError,
  workspaceFolders,
  openPrimerDocument,
}: {
  scopeKey: string;
  structureEntityId: string;
  viewport: Readonly<{ start: number; end: number }> | null;
  selection: IndexedPrimerSelection | null;
  viewerWidthPx: number;
  chromosomes: ReadonlyArray<IndexedChromosomeSpan>;
  readSequence: (chrom: string, start0: number, end0: number) => Promise<string>;
  onRevealRange: (start: number, end: number) => void;
  primerBindings: readonly IndexedGenomePrimerBinding[];
  persistPrimerBindings: (
    updater: (
      previous: readonly IndexedGenomePrimerBinding[]
    ) => readonly IndexedGenomePrimerBinding[]
  ) => void;
  primerWorkspaceRoot: string | null;
  onError: (message: string) => void;
  workspaceFolders: Parameters<typeof useIndexedPrimers>[0]['workspaceFolders'];
  openPrimerDocument: Parameters<typeof useIndexedPrimers>[0]['openPrimerDocument'];
}): {
  toolRail: ReactNode;
  drawerSlot: ReactNode;
  sequenceOverlays: IndexedSequenceOverlays;
  openStructure: (request: StructureDrawerRequest) => void;
  onCameraSample: (range: Readonly<{ start: number; end: number }>) => void;
  bindingAtHit: ReturnType<typeof useIndexedPrimers>['bindingAtHit'];
  primerMenuActions: ReturnType<typeof useIndexedPrimers>['primerMenuActions'];
  attachPrimers: (selection: IndexedPrimerSelection | null) => void;
  createPrimerFromSelection: (
    selection: IndexedPrimerSelection,
    direction: PrimerDirection
  ) => void;
} {
  const drawer = useDrawerState(INDEXED_DRAWER_WIDTH_KEY);
  const enzymeDrawerOpen = drawer.activeDrawer === 'restriction-enzymes';

  const cut = useIndexedCutSites({
    drawerOpen: enzymeDrawerOpen,
    viewport,
    viewerWidthPx,
    chromosomes,
    readSequence,
    scopeKey: `indexed-genome:${scopeKey}`,
  });
  const { cutSitesState, cutSitesActions, availability, scannedWindow } = cut;
  const unavailableReason = cutSitesUnavailableReason(availability);

  const showPrimersDrawer = useCallback(() => {
    if (drawer.activeDrawer !== 'primers') drawer.openDrawer('primers');
  }, [drawer]);
  const primers = useIndexedPrimers({
    scopeKey,
    viewport,
    selection,
    bindings: primerBindings,
    persistBindings: persistPrimerBindings,
    chromosomes,
    readSequence,
    workspaceRoot: primerWorkspaceRoot,
    onRevealRange,
    onError,
    workspaceFolders,
    openPrimerDocument,
    showPrimersDrawer,
  });
  const primersDrawerOpen = drawer.activeDrawer === 'primers';
  const [showPrimers, setShowPrimers] = useState(true);
  const togglePrimersDrawer = useCallback(() => drawer.toggleDrawer('primers'), [drawer]);
  const { startCreatePrimer, openFind } = primers;
  const attachPrimers = useCallback(
    (target: IndexedPrimerSelection | null) => {
      if (drawer.activeDrawer !== 'primers') drawer.openDrawer('primers');
      openFind(target);
    },
    [drawer, openFind]
  );
  const createPrimerFromSelection = useCallback(
    (selection: IndexedPrimerSelection, direction: PrimerDirection) => {
      if (drawer.activeDrawer !== 'primers') drawer.openDrawer('primers');
      startCreatePrimer(selection, direction);
    },
    [drawer, startCreatePrimer]
  );

  const config = useMemo<ViewerConfig>(
    () => ({ ...DEFAULT_VIEWER_CONFIG, showCutSites: cutSitesState.isVisible, showPrimers }),
    [cutSitesState.isVisible, showPrimers]
  );
  const handleConfigChange = useCallback(
    (next: ViewerConfig) => {
      if (next.showCutSites !== cutSitesState.isVisible) cutSitesActions.toggleVisibility();
      if (next.showPrimers !== showPrimers) setShowPrimers(next.showPrimers);
    },
    [cutSitesActions, cutSitesState.isVisible, showPrimers]
  );

  const toggleEnzymeDrawer = useCallback(
    () => drawer.toggleDrawer('restriction-enzymes'),
    [drawer]
  );

  const structureDrawerOpen = drawer.activeDrawer === 'structure';
  const hasStructure = useStructureDrawerStore(
    (state) => state.status !== 'idle' && state.request?.entityId === structureEntityId
  );
  const toggleStructureDrawer = useCallback(() => drawer.toggleDrawer('structure'), [drawer]);
  const openStructure = useCallback(
    (request: StructureDrawerRequest) => {
      if (drawer.activeDrawer !== 'structure') flushSync(() => drawer.openDrawer('structure'));
      void useStructureDrawerStore.getState().open(request);
    },
    [drawer]
  );

  const handlePositionClick = useCallback(
    (_position: number, recognitionStart0: number, recognitionEnd0: number) => {
      if (!scannedWindow) return;
      onRevealRange(
        scannedWindow.chromGlobalStart + recognitionStart0,
        scannedWindow.chromGlobalStart + recognitionEnd0
      );
    },
    [onRevealRange, scannedWindow]
  );

  const toolRail = (
    <SequenceToolbarSidebar
      tools={INDEXED_TOOLS}
      config={config}
      onConfigChange={handleConfigChange}
      isEnzymePanelOpen={enzymeDrawerOpen}
      onEnzymePanelToggle={toggleEnzymeDrawer}
      restrictionEnzymesDisabledReason={toOptionalUserMessage(
        enzymeDrawerOpen ? undefined : unavailableReason
      )}
      cutSitesDisabledReason={toOptionalUserMessage(unavailableReason)}
      onOpenPrimers={togglePrimersDrawer}
      isPrimersPanelOpen={primersDrawerOpen}
      onOpenStructure={toggleStructureDrawer}
      isStructureDrawerOpen={structureDrawerOpen}
      isStructureAvailable={hasStructure || structureDrawerOpen}
    />
  );

  const drawerSlot = primersDrawerOpen ? (
    <SequenceDrawer width={drawer.drawerWidth} onWidthChange={drawer.setDrawerWidth}>
      {primers.drawerContent}
    </SequenceDrawer>
  ) : structureDrawerOpen ? (
    <SequenceDrawer width={drawer.drawerWidth} onWidthChange={drawer.setDrawerWidth}>
      <StructureDrawerContent onCloseDrawer={drawer.closeDrawer} />
    </SequenceDrawer>
  ) : enzymeDrawerOpen ? (
    <SequenceDrawer width={drawer.drawerWidth} onWidthChange={drawer.setDrawerWidth}>
      <div data-testid="restriction-enzymes-drawer" className="flex h-full flex-col bg-bg">
        <RestrictionEnzymeDropdown
          availableEnzymes={cutSitesState.availableEnzymes}
          activeEnzymes={cutSitesState.activeEnzymes}
          sequence={availability.kind === 'ready' ? cut.scannedBases : ''}
          activeCutSites={cutSitesState.cutSites}
          activeCutSitePhase={cutSitesState.scanPhase}
          enzymeCutCounts={cutSitesState.enzymeCutCounts}
          enzymeCutCountPhase={cutSitesState.enzymeCutCountPhase}
          enzymeCutCountLimit={cutSitesState.enzymeCutCountLimit}
          vendor={cutSitesState.vendor}
          cutterFilter={cutSitesState.cutterFilter}
          onAddEnzyme={cutSitesActions.addEnzyme}
          onRemoveEnzyme={cutSitesActions.removeEnzyme}
          onClearEnzymes={cutSitesActions.clearAllEnzymes}
          onVendorChange={cutSitesActions.setVendor}
          onCutterFilterChange={cutSitesActions.setCutterFilter}
          onClose={drawer.closeDrawer}
          isLoading={cutSitesState.isLoading}
          disableClickOutside
          layout="embedded"
          onPositionClick={handlePositionClick}
          scope={{
            note: enzymeDrawerScopeNote(availability),
            positionOffset: scannedWindow?.start0 ?? 0,
          }}
        />
      </div>
    </SequenceDrawer>
  ) : null;

  const visiblePrimers = useMemo(
    () =>
      !showPrimers
        ? NO_PRIMERS
        : primersDrawerOpen
          ? primers.rendererPrimers
          : primers.rendererPrimers.filter((primer) => !primer.isCandidate),
    [primers.rendererPrimers, primersDrawerOpen, showPrimers]
  );
  const sequenceOverlays = useMemo<IndexedSequenceOverlays>(
    () => ({ cutSites: cut.webglCutSites, primers: visiblePrimers }),
    [cut.webglCutSites, visiblePrimers]
  );

  return {
    toolRail,
    drawerSlot,
    sequenceOverlays,
    openStructure,
    onCameraSample: cut.onCameraSample,
    createPrimerFromSelection,
    attachPrimers,
    bindingAtHit: primers.bindingAtHit,
    primerMenuActions: primers.primerMenuActions,
  };
}

function cutSitesUnavailableReason(availability: IndexedCutSiteAvailability): string | undefined {
  return availability.kind === 'zoomed-out' || availability.kind === 'unavailable'
    ? availability.reason
    : undefined;
}

function enzymeDrawerScopeNote(availability: IndexedCutSiteAvailability): string {
  switch (availability.kind) {
    case 'ready':
      return `Counts and cut positions cover ${availability.scopeLabel}, around the current view, not the whole reference.`;
    case 'loading':
      return 'Reading the bases around the current view…';
    case 'zoomed-out':
    case 'unavailable':
    case 'error':
      return availability.reason;
  }
}
