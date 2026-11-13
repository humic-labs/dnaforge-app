import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import type {
  RestrictionEnzyme,
  CutterFilter as CutterFilterType,
  VendorCode,
  CutSite,
} from '@waypoint/sequence-utils';
import { getEnzymeColor } from '@waypoint/sequence-utils';

import { EnzymeSearch } from './EnzymeSearch';
import { VendorSelector } from './VendorSelector';
import { CutterFilter } from './CutterFilter';
import { EnzymeList, EnzymeListHandle } from './EnzymeList';
import { ActiveEnzymeList } from './ActiveEnzymeList';

type CutSiteScanPhase = 'idle' | 'scanning' | 'partial' | 'complete';
export interface EnzymeCutCountSummary {
  count: number;
  capped: boolean;
}
const MAX_ACTIVE_POSITION_CHIPS = 100;

interface RestrictionEnzymeDropdownProps {
  availableEnzymes: RestrictionEnzyme[];
  activeEnzymes: RestrictionEnzyme[];
  sequence: string;
  activeCutSites?: CutSite[];
  activeCutSitePhase?: CutSiteScanPhase;
  enzymeCutCounts?: Map<string, EnzymeCutCountSummary>;
  enzymeCutCountPhase?: CutSiteScanPhase;
  enzymeCutCountLimit?: number;
  vendor: VendorCode;
  cutterFilter: CutterFilterType;
  onAddEnzyme: (enzyme: RestrictionEnzyme) => void;
  onRemoveEnzyme: (enzymeName: string) => void;
  onClearEnzymes: () => void;
  onVendorChange: (vendor: VendorCode) => void;
  onCutterFilterChange: (filter: CutterFilterType) => void;
  onClose: () => void;
  isLoading?: boolean;
  scrollToEnzyme?: string | null;
  onScrollToEnzymeProcessed?: () => void;
  highlightActiveEnzyme?: string | null;
  onHighlightActiveEnzymeProcessed?: () => void;
  onPositionClick?: (position: number, recognitionStart: number, recognitionEnd: number) => void;
  disableClickOutside?: boolean;
  layout?: 'popover' | 'embedded';
  onEnzymeHover?: (enzymeName: string | null) => void;
  onPositionHover?: (
    info: {
      enzymeName: string;
      position: number;
      recognitionStart: number;
      recognitionEnd: number;
    } | null
  ) => void;
  onVirtualDigest?: (enzymeNames: string[]) => void;
  activeVirtualDigestEnzyme?: string | null;
  activeVirtualDigestEnzymes?: string[] | null;
  activeEnzymesCollapsed?: boolean;
  onActiveEnzymesCollapsedChange?: (collapsed: boolean) => void;
  scope?: { note: string; positionOffset: number };
}

export function RestrictionEnzymeDropdown({
  availableEnzymes,
  activeEnzymes,
  sequence,
  activeCutSites = [],
  activeCutSitePhase = 'idle',
  enzymeCutCounts,
  enzymeCutCountPhase = 'idle',
  enzymeCutCountLimit = 3,
  vendor,
  cutterFilter,
  onAddEnzyme,
  onRemoveEnzyme,
  onClearEnzymes,
  onVendorChange,
  onCutterFilterChange,
  onClose,
  isLoading = false,
  scrollToEnzyme,
  onScrollToEnzymeProcessed,
  highlightActiveEnzyme,
  onHighlightActiveEnzymeProcessed,
  onPositionClick,
  disableClickOutside = false,
  layout = 'popover',
  onEnzymeHover,
  onPositionHover,
  onVirtualDigest,
  activeVirtualDigestEnzyme,
  activeVirtualDigestEnzymes,
  activeEnzymesCollapsed,
  onActiveEnzymesCollapsedChange,
  scope,
}: RestrictionEnzymeDropdownProps): React.ReactElement {
  const positionOffset = scope?.positionOffset ?? 0;
  const [nameSearch, setNameSearch] = useState('');
  const [sequenceSearch, setSequenceSearch] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [shouldScrollToHighlight, setShouldScrollToHighlight] = useState(false);
  const enzymeListRef = useRef<EnzymeListHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const countScanReady = enzymeCutCountPhase === 'complete';
  const exactActiveScanReady = activeCutSitePhase === 'complete';

  const filteredEnzymes = useMemo(() => {
    if (cutterFilter === 'none') {
      return [];
    }

    let filtered = availableEnzymes;

    if (nameSearch) {
      const nameLower = nameSearch.toLowerCase();
      filtered = filtered.filter((enzyme) => enzyme.name.toLowerCase().includes(nameLower));
    }

    if (sequenceSearch) {
      const seqUpper = sequenceSearch.toUpperCase();
      filtered = filtered.filter((enzyme) => enzyme.recognition_sequence?.includes(seqUpper));
    }

    if (cutterFilter === 'both' || !sequence) {
      return filtered;
    }

    if (!countScanReady) return [];

    return filtered.filter((enzyme) => {
      const summary = enzymeCutCounts?.get(enzyme.name);
      if (!summary || summary.capped) return false;
      switch (cutterFilter) {
        case 'single':
          return summary.count === 1;
        case 'double':
          return summary.count === 2;
        case 'single-double':
          return summary.count === 1 || summary.count === 2;
        default:
          return true;
      }
    });
  }, [
    availableEnzymes,
    countScanReady,
    cutterFilter,
    enzymeCutCounts,
    nameSearch,
    sequence,
    sequenceSearch,
  ]);

  const activeCutSitesByName = useMemo(() => {
    const byName = new Map<string, CutSite[]>();
    for (const site of activeCutSites) {
      const sites = byName.get(site.enzyme.name);
      if (sites) sites.push(site);
      else byName.set(site.enzyme.name, [site]);
    }
    return byName;
  }, [activeCutSites]);

  const activeEnzymesWithCounts = useMemo(() => {
    return activeEnzymes.map((enzyme, index) => {
      const exactSites = activeCutSitesByName.get(enzyme.name) ?? [];
      if (!exactActiveScanReady || !sequence) {
        return {
          enzyme,
          cutCount: undefined as number | undefined,
          cutPositions: [] as Array<{
            position: number;
            recognitionStart: number;
            recognitionEnd: number;
          }>,
          color: getEnzymeColor(index),
          hasValidGGPair: false,
        };
      }
      const visiblePositions = exactSites.slice(0, MAX_ACTIVE_POSITION_CHIPS);
      const cutPositions = visiblePositions.map((site) => ({
        position: site.cutPositionTop + 1 + positionOffset,
        recognitionStart: site.recognitionStart + positionOffset,
        recognitionEnd: site.recognitionEnd + positionOffset,
      }));
      const hasForward = exactSites.some((site) => site.strand === 'forward');
      const hasReverse = exactSites.some((site) => site.strand === 'reverse');
      const hasValidGGPair = hasForward && hasReverse;
      return {
        enzyme,
        cutCount: exactSites.length as number | undefined,
        cutPositions,
        hiddenCutPositionCount: Math.max(0, exactSites.length - visiblePositions.length),
        color: getEnzymeColor(index),
        hasValidGGPair,
      };
    });
  }, [activeCutSitesByName, activeEnzymes, exactActiveScanReady, sequence, positionOffset]);

  const activeEnzymeNames = useMemo(
    () => new Set(activeEnzymes.map((e) => e.name)),
    [activeEnzymes]
  );

  const isCountScanActive = enzymeCutCountPhase === 'scanning' || enzymeCutCountPhase === 'partial';
  const isCutterFilterWaiting =
    sequence !== '' &&
    (cutterFilter === 'single' || cutterFilter === 'double' || cutterFilter === 'single-double') &&
    !countScanReady;

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [nameSearch, sequenceSearch]);

  useEffect(() => {
    if (!scrollToEnzyme) return;

    setNameSearch('');
    setSequenceSearch('');

    requestAnimationFrame(() => {
      const enzymeIndex = filteredEnzymes.findIndex(
        (e) => e.name.toLowerCase() === scrollToEnzyme.toLowerCase()
      );
      if (enzymeIndex >= 0) {
        setHighlightedIndex(enzymeIndex);
        setShouldScrollToHighlight(true);
      }
      enzymeListRef.current?.focus();

      onScrollToEnzymeProcessed?.();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only run when scrollToEnzyme changes
  }, [scrollToEnzyme]);

  useEffect(() => {
    if (shouldScrollToHighlight) {
      const timer = setTimeout(() => setShouldScrollToHighlight(false), 100);
      return () => clearTimeout(timer);
    }
  }, [shouldScrollToHighlight]);

  useEffect(() => {
    if (disableClickOutside) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose, disableClickOutside]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleArrowDownFromSearch = useCallback(() => {
    if (filteredEnzymes.length > 0) {
      setHighlightedIndex(0);
      enzymeListRef.current?.focus();
    }
  }, [filteredEnzymes.length]);

  const handleArrowUpToSearch = useCallback(() => {
    setHighlightedIndex(-1);
  }, []);

  const handleSelectEnzyme = useCallback(
    (enzyme: RestrictionEnzyme) => {
      if (activeEnzymeNames.has(enzyme.name)) {
        onRemoveEnzyme(enzyme.name);
      } else {
        onAddEnzyme(enzyme);
      }
    },
    [activeEnzymeNames, onAddEnzyme, onRemoveEnzyme]
  );

  const hoverRafRef = useRef<number>(0);
  const lastFiredHoverRef = useRef<string | null | undefined>(undefined);
  const handleEnzymeHover = useCallback(
    (enzyme: RestrictionEnzyme | null) => {
      const name = enzyme?.name ?? null;
      if (name === lastFiredHoverRef.current) return;
      cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = requestAnimationFrame(() => {
        if (name !== lastFiredHoverRef.current) {
          lastFiredHoverRef.current = name;
          onEnzymeHover?.(name);
        }
      });
    },
    [onEnzymeHover]
  );
  useEffect(() => () => cancelAnimationFrame(hoverRafRef.current), []);

  return (
    <div
      ref={containerRef}
      style={
        layout === 'embedded'
          ? { ...styles.container, ...styles.embeddedContainer }
          : styles.container
      }
    >
      {}
      <div style={styles.header}>
        <span style={styles.title}>Restriction Enzymes</span>
        <button onClick={onClose} style={styles.closeButton}>
          ×
        </button>
      </div>

      {isLoading ? (
        <div style={styles.loadingState}>Loading enzymes...</div>
      ) : (
        <div style={styles.content}>
          {scope && (
            <div style={styles.scanStatusBanner} data-testid="enzyme-dropdown-scope-note">
              {scope.note}
            </div>
          )}
          {(isCountScanActive || isCutterFilterWaiting) && (
            <div style={styles.scanStatusBanner} data-testid="enzyme-dropdown-scan-status-banner">
              <div>
                {isCutterFilterWaiting
                  ? 'Filtering enzymes after the cut-count scan finishes...'
                  : 'Calculating enzyme cut counts in the background...'}
              </div>
              <div style={styles.scanStatusBannerMeta}>
                Catalog counts are exact through {enzymeCutCountLimit}; denser cutters show as &gt;
                {enzymeCutCountLimit}.
              </div>
            </div>
          )}

          {}
          <div style={styles.filterRow}>
            <VendorSelector value={vendor} onChange={onVendorChange} compact />
            <CutterFilter value={cutterFilter} onChange={onCutterFilterChange} compact />
          </div>

          {}
          <EnzymeSearch
            nameValue={nameSearch}
            sequenceValue={sequenceSearch}
            onNameChange={setNameSearch}
            onSequenceChange={setSequenceSearch}
            onArrowDown={handleArrowDownFromSearch}
          />

          {}
          {isCutterFilterWaiting ? (
            <div style={styles.filteredLoadingState}>Scanning cut counts...</div>
          ) : (
            <EnzymeList
              ref={enzymeListRef}
              enzymes={filteredEnzymes}
              highlightedIndex={highlightedIndex}
              onSelect={handleSelectEnzyme}
              onHighlightChange={setHighlightedIndex}
              onArrowUp={handleArrowUpToSearch}
              activeEnzymeNames={activeEnzymeNames}
              maxHeight={200}
              scrollToHighlight={shouldScrollToHighlight}
              onEnzymeHover={handleEnzymeHover}
              cutCounts={enzymeCutCounts}
              cutCountsLoading={isCountScanActive}
              cutCountLimit={enzymeCutCountLimit}
            />
          )}

          {}
          <ActiveEnzymeList
            enzymes={activeEnzymesWithCounts}
            onRemove={onRemoveEnzyme}
            onClear={onClearEnzymes}
            highlightEnzyme={highlightActiveEnzyme}
            onHighlightProcessed={onHighlightActiveEnzymeProcessed}
            onPositionClick={onPositionClick}
            onPositionHover={onPositionHover}
            fillHeight
            onVirtualDigest={onVirtualDigest}
            activeVirtualDigestEnzyme={activeVirtualDigestEnzyme}
            activeVirtualDigestEnzymes={activeVirtualDigestEnzymes}
            isCollapsed={activeEnzymesCollapsed}
            onCollapsedChange={onActiveEnzymesCollapsedChange}
          />
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: '4px',
    width: '320px',
    height: '100%',
    backgroundColor: 'hsl(var(--color-bg))',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)',
    border: '1px solid hsl(var(--color-border))',
    zIndex: 100,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  embeddedContainer: {
    position: 'relative',
    top: 'auto',
    right: 'auto',
    marginTop: 0,
    width: '100%',
    height: 'auto',
    flex: '1 1 auto',
    minHeight: 0,
    borderRadius: 0,
    boxShadow: 'none',
    border: 'none',
    zIndex: 'auto',
  },
  content: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  },
  filterRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '6px 12px',
    borderBottom: '1px solid hsl(var(--color-border))',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    borderBottom: '1px solid hsl(var(--color-border))',
    backgroundColor: 'hsl(var(--color-bg-subtle))',
  },
  title: {
    fontWeight: 600,
    fontSize: '14px',
    color: 'hsl(var(--color-fg))',
  },
  closeButton: {
    background: 'none',
    border: 'none',
    color: 'hsl(var(--color-fg-muted))',
    fontSize: '20px',
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: '1',
  },
  loadingState: {
    padding: '40px 20px',
    textAlign: 'center',
    color: 'hsl(var(--color-fg-subtle))',
    fontSize: '13px',
  },
  scanStatusBanner: {
    padding: '8px 12px',
    margin: '0 0 8px 0',
    background: 'hsl(var(--color-bg-subtle))',
    border: '1px solid hsl(var(--color-border))',
    borderRadius: '4px',
    fontSize: '12px',
    color: 'hsl(var(--color-fg-subtle))',
    lineHeight: '1.4',
  },
  scanStatusBannerMeta: {
    marginTop: '4px',
    fontSize: '11px',
    color: 'hsl(var(--color-fg-muted))',
  },
  filteredLoadingState: {
    padding: '20px',
    textAlign: 'center',
    color: 'hsl(var(--color-fg-subtle))',
    fontSize: '13px',
  },
};
