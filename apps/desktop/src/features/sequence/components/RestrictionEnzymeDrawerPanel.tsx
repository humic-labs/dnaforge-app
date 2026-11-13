import type { Annotation } from '@waypoint/sequence-utils';
import type { CutSitesActions, CutSitesState } from '@waypoint/workspace-editor';
import { RestrictionEnzymeDropdown } from '@waypoint/ui-components';
import { SequenceDrawer } from './SequenceDrawer';
import { VirtualDigestPanel } from '../../assembly-panel/public/components/VirtualDigestPanel';
import type {
  VirtualDigestFragment,
  VirtualDigestResult,
} from '../../assembly-panel/public/hooks/useVirtualDigest';

type DigestPanelSection = 'enzymes' | 'digest';

interface HoveredCutPosition {
  enzymeName: string;
  position: number;
  recognitionStart: number;
  recognitionEnd: number;
}

interface RestrictionEnzymeDrawerPanelProps {
  width: number;
  onWidthChange: (width: number) => void;
  cutSitesState: CutSitesState;
  cutSitesActions: CutSitesActions;
  sequenceString: string;
  sequenceName: string;
  sourceSequenceId: string;
  sourceAnnotations: Annotation[];
  sourceIsCircular: boolean;
  activeVirtualDigestEnzyme: string | null;
  activeVirtualDigestEnzymes: string[];
  activeVirtualDigestLabel: string;
  expandedSection: DigestPanelSection;
  virtualDigestResult: VirtualDigestResult | null;
  virtualDigestError?: 'limit' | 'unknown';
  hoveredDigestFragment: VirtualDigestFragment | null;
  onClose: () => void;
  onPositionClick: (position: number, recognitionStart: number, recognitionEnd: number) => void;
  onVirtualDigest: (enzymeNames: string[]) => void;
  onClearVirtualDigest: () => void;
  onDigestFragmentHover: (fragment: VirtualDigestFragment | null) => void;
  onDigestFragmentClick: (fragment: VirtualDigestFragment) => void;
  onEnzymesCollapsedChange: (collapsed: boolean) => void;
  onDigestCollapsedChange: (collapsed: boolean) => void;
  onEnzymeHover: (enzymeName: string | null) => void;
  onPositionHover: (info: HoveredCutPosition | null) => void;
}

export function RestrictionEnzymeDrawerPanel({
  width,
  onWidthChange,
  cutSitesState,
  cutSitesActions,
  sequenceString,
  sequenceName,
  sourceSequenceId,
  sourceAnnotations,
  sourceIsCircular,
  activeVirtualDigestEnzyme,
  activeVirtualDigestEnzymes,
  activeVirtualDigestLabel,
  expandedSection,
  virtualDigestResult,
  virtualDigestError,
  hoveredDigestFragment,
  onClose,
  onPositionClick,
  onVirtualDigest,
  onClearVirtualDigest,
  onDigestFragmentHover,
  onDigestFragmentClick,
  onEnzymesCollapsedChange,
  onDigestCollapsedChange,
  onEnzymeHover,
  onPositionHover,
}: RestrictionEnzymeDrawerPanelProps) {
  return (
    <SequenceDrawer width={width} onWidthChange={onWidthChange}>
      <div data-testid="restriction-enzymes-drawer" className="h-full flex flex-col bg-bg">
        <RestrictionEnzymeDropdown
          availableEnzymes={cutSitesState.availableEnzymes}
          activeEnzymes={cutSitesState.activeEnzymes}
          sequence={sequenceString}
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
          onClose={onClose}
          isLoading={cutSitesState.isLoading}
          disableClickOutside={true}
          layout="embedded"
          onPositionClick={onPositionClick}
          onVirtualDigest={onVirtualDigest}
          activeVirtualDigestEnzyme={activeVirtualDigestEnzyme}
          activeVirtualDigestEnzymes={activeVirtualDigestEnzymes}
          activeEnzymesCollapsed={expandedSection !== 'enzymes'}
          onActiveEnzymesCollapsedChange={onEnzymesCollapsedChange}
          onEnzymeHover={onEnzymeHover}
          onPositionHover={onPositionHover}
        />

        {virtualDigestError && activeVirtualDigestEnzymes.length > 0 ? (
          <div role="alert" data-testid="virtual-digest-error">
            {virtualDigestError === 'limit'
              ? 'This digest exceeds the fragment limit.'
              : 'The digest could not be computed.'}
          </div>
        ) : null}
        {virtualDigestResult && activeVirtualDigestEnzymes.length > 0 ? (
          <VirtualDigestPanel
            enzymeName={activeVirtualDigestLabel}
            sequenceName={sequenceName}
            fragments={virtualDigestResult.fragments}
            ggStatus={virtualDigestResult.ggStatus}
            digestKind={virtualDigestResult.digestKind}
            warning={virtualDigestResult.warning}
            diagnostics={virtualDigestResult.diagnostics}
            overhangLength={virtualDigestResult.overhangLength}
            onClose={onClearVirtualDigest}
            onFragmentHover={onDigestFragmentHover}
            onFragmentClick={onDigestFragmentClick}
            hoveredFragmentIndex={hoveredDigestFragment?.index ?? null}
            isCollapsed={expandedSection !== 'digest'}
            onCollapsedChange={onDigestCollapsedChange}
            sourceSequence={sequenceString}
            sourceSequenceId={sourceSequenceId}
            sourceAnnotations={sourceAnnotations}
            sourceIsCircular={sourceIsCircular}
          />
        ) : null}
      </div>
    </SequenceDrawer>
  );
}
