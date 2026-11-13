import { toUserMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type {
  RestrictionEnzyme,
  ColoredCutSite,
  CutterFilter,
  VendorCode,
  CutSite,
} from '@waypoint/sequence-utils';
import {
  loadAllEnzymes,
  filterByVendor,
  sortCutSitesByPosition,
  assignEnzymeColors,
} from '@waypoint/sequence-utils';
import { useSequenceStateOptional } from '../context';
import { useCutSiteScanner, type ScanPhase } from './cut-site-scanner';

const STORAGE_KEY = 'waypoint-active-enzymes';
const STORAGE_KEY_VENDOR = 'waypoint-enzyme-vendor';
const STORAGE_KEY_VISIBLE = 'waypoint-enzyme-visible';
const STORAGE_KEY_SOURCE_DISPLAY = 'waypoint-enzyme-source-display';
const EMPTY_ACTIVE_ENZYMES: RestrictionEnzyme[] = [];
const CATALOG_SUMMARY_EXACT_COUNT_LIMIT = 10;
const CATALOG_SUMMARY_SCAN_HIT_LIMIT = CATALOG_SUMMARY_EXACT_COUNT_LIMIT + 1;

export interface CutSitesState {
  availableEnzymes: RestrictionEnzyme[];
  activeEnzymes: RestrictionEnzyme[];
  cutSites: ColoredCutSite[];
  enzymeCutCounts: Map<string, CutSiteCountSummary>;
  enzymeCutCountPhase: ScanPhase;
  enzymeCutCountLimit: number;
  scannedCutSites: ColoredCutSite[];
  hoveredCutSite: ColoredCutSite | null;
  vendor: VendorCode;
  cutterFilter: CutterFilter;
  searchTerm: string;
  isVisible: boolean;
  isLoading: boolean;
  error: string | null;
  scanPhase: ScanPhase;
  scanProgress: number;
  scanSettled: boolean;
}

export interface CutSitesActions {
  addEnzyme: (enzyme: RestrictionEnzyme) => void;
  removeEnzyme: (enzymeName: string) => void;
  clearAllEnzymes: () => void;
  setVendor: (vendor: VendorCode) => void;
  setCutterFilter: (filter: CutterFilter) => void;
  setSearchTerm: (term: string) => void;
  toggleVisibility: () => void;
  setHoveredCutSite: (cutSite: ColoredCutSite | null) => void;
  cancelScan: () => void;
}

export interface CutSiteCountSummary {
  count: number;
  capped: boolean;
}

export interface UseCutSitesOptions {
  circular?: boolean;
  catalogSummaryEnabled?: boolean;
  displayRequest?: CutSiteDisplayRequest | null;
  onDisplayRequestApplied?: (id: string) => void;
  scanDebounceMs?: number;
}

export interface CutSiteDisplayRequest {
  id: string;
  enzymeNames: readonly string[];
}

function isClient(): boolean {
  return typeof window !== 'undefined';
}

function scopedStorageKey(baseKey: string, scopeKey?: string): string {
  return scopeKey ? `${baseKey}:${scopeKey}` : baseKey;
}

function loadPersistedEnzymes(storageKey = STORAGE_KEY): string[] {
  if (!isClient()) return [];
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.warn('Failed to load persisted enzymes:', e);
  }
  return [];
}

function persistEnzymes(enzymeNames: string[], storageKey = STORAGE_KEY): void {
  if (!isClient()) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(enzymeNames));
  } catch (e) {
    console.warn('Failed to persist enzymes:', e);
  }
}

function loadPersistedVendor(): VendorCode {
  if (!isClient()) return 'N';
  try {
    const stored = localStorage.getItem(STORAGE_KEY_VENDOR);
    if (stored) {
      return stored as VendorCode;
    }
  } catch (e) {
    console.warn('Failed to load persisted vendor:', e);
  }
  return 'N';
}

function persistVendor(vendor: VendorCode): void {
  if (!isClient()) return;
  try {
    localStorage.setItem(STORAGE_KEY_VENDOR, vendor);
  } catch (e) {
    console.warn('Failed to persist vendor:', e);
  }
}

function loadPersistedVisibility(storageKey = STORAGE_KEY_VISIBLE, defaultValue = true): boolean {
  if (!isClient()) return defaultValue;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) {
      return stored === 'true';
    }
  } catch (e) {
    console.warn('Failed to load persisted visibility:', e);
  }
  return defaultValue;
}

function persistVisibility(visible: boolean, storageKey = STORAGE_KEY_VISIBLE): void {
  if (!isClient()) return;
  try {
    localStorage.setItem(storageKey, String(visible));
  } catch (e) {
    console.warn('Failed to persist visibility:', e);
  }
}

function enzymeHasVendor(enzyme: RestrictionEnzyme, vendorCode: VendorCode): boolean {
  return enzyme.suppliers?.some((s) => s.code === vendorCode) ?? false;
}

export function useCutSites(
  sequenceParam?: string,
  storageScopeKey?: string,
  options: UseCutSitesOptions = {}
): [CutSitesState, CutSitesActions] {
  const catalogSummaryEnabled = options.catalogSummaryEnabled ?? false;
  const circular = options.circular ?? false;
  const sequenceState = useSequenceStateOptional();

  const sequence =
    sequenceParam !== undefined ? sequenceParam : (sequenceState?.currentSequence ?? '');
  const activeEnzymeStorageKey = useMemo(
    () => scopedStorageKey(STORAGE_KEY, storageScopeKey),
    [storageScopeKey]
  );
  const visibilityStorageKey = useMemo(
    () => scopedStorageKey(STORAGE_KEY_VISIBLE, storageScopeKey),
    [storageScopeKey]
  );

  const [allEnzymes, setAllEnzymes] = useState<RestrictionEnzyme[]>([]);
  const sourceDisplayStorageKey = scopedStorageKey(STORAGE_KEY_SOURCE_DISPLAY, storageScopeKey);
  const [activeEnzymeState, setActiveEnzymeState] = useState<{
    storageKey: string;
    enzymes: RestrictionEnzyme[];
    includeOtherVendors?: boolean;
  }>(() => ({ storageKey: activeEnzymeStorageKey, enzymes: [] }));
  const [hoveredCutSite, setHoveredCutSite] = useState<ColoredCutSite | null>(null);
  const [vendor, setVendorState] = useState<VendorCode>(loadPersistedVendor);
  const [cutterFilter, setCutterFilter] = useState<CutterFilter>('both');
  const [searchTerm, setSearchTerm] = useState('');
  const [visibilityState, setVisibilityState] = useState<{
    storageKey: string;
    isVisible: boolean;
  }>(() => ({
    storageKey: visibilityStorageKey,
    isVisible: loadPersistedVisibility(visibilityStorageKey),
  }));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const hasInitializedRef = useRef(false);

  useEffect(() => {
    async function loadEnzymes() {
      setIsLoading(true);
      setError(null);
      try {
        const enzymes = await loadAllEnzymes();
        setAllEnzymes(enzymes);
      } catch (e) {
        setError(toUserMessage(e, 'failure.failed-to-load-enzymes'));
        hasInitializedRef.current = true;
      } finally {
        setIsLoading(false);
      }
    }
    loadEnzymes();
  }, []);

  useEffect(() => {
    hasInitializedRef.current = false;
    setHoveredCutSite(null);

    if (allEnzymes.length === 0) {
      setActiveEnzymeState({ storageKey: activeEnzymeStorageKey, enzymes: [] });
      return;
    }

    const persistedNames = loadPersistedEnzymes(activeEnzymeStorageKey);
    const restoredEnzymes =
      persistedNames.length > 0 ? allEnzymes.filter((e) => persistedNames.includes(e.name)) : [];
    setActiveEnzymeState({
      storageKey: activeEnzymeStorageKey,
      enzymes: restoredEnzymes,
      includeOtherVendors: loadPersistedVisibility(sourceDisplayStorageKey, false),
    });
    hasInitializedRef.current = true;
  }, [allEnzymes, activeEnzymeStorageKey, sourceDisplayStorageKey]);

  useEffect(() => {
    setVisibilityState({
      storageKey: visibilityStorageKey,
      isVisible: loadPersistedVisibility(visibilityStorageKey),
    });
  }, [visibilityStorageKey]);

  const appliedDisplayRequest = useRef<string | null>(null);
  const displayRequest = options.displayRequest;
  const onDisplayRequestApplied = options.onDisplayRequestApplied;
  useEffect(() => {
    if (!displayRequest || isLoading || allEnzymes.length === 0) return;
    const key = JSON.stringify([activeEnzymeStorageKey, displayRequest.id]);
    if (appliedDisplayRequest.current === key) return;
    appliedDisplayRequest.current = key;
    const names = new Set(displayRequest.enzymeNames);
    const enzymes = allEnzymes.filter((enzyme) => names.has(enzyme.name));
    const missing = [...names].filter((name) => !enzymes.some((enzyme) => enzyme.name === name));
    if (missing.length > 0) {
      setError(
        userMessageWithValues('sequence.enzymesMissing', {
          names: userMessageValue(missing.join(', ')),
        })
      );
      onDisplayRequestApplied?.(displayRequest.id);
      return;
    }
    setError(null);
    setActiveEnzymeState({
      storageKey: activeEnzymeStorageKey,
      enzymes,
      includeOtherVendors: true,
    });
    setVisibilityState({ storageKey: visibilityStorageKey, isVisible: true });
    setHoveredCutSite(null);
    setCutterFilter('both');
    setSearchTerm('');
    onDisplayRequestApplied?.(displayRequest.id);
  }, [
    displayRequest,
    onDisplayRequestApplied,
    isLoading,
    allEnzymes,
    activeEnzymeStorageKey,
    visibilityStorageKey,
  ]);

  useEffect(() => {
    if (!hasInitializedRef.current || activeEnzymeState.storageKey !== activeEnzymeStorageKey)
      return;
    persistVisibility(activeEnzymeState.includeOtherVendors === true, sourceDisplayStorageKey);
  }, [activeEnzymeState, activeEnzymeStorageKey, sourceDisplayStorageKey]);

  const allActiveEnzymes =
    activeEnzymeState.storageKey === activeEnzymeStorageKey
      ? activeEnzymeState.enzymes
      : EMPTY_ACTIVE_ENZYMES;
  const isVisible =
    visibilityState.storageKey === visibilityStorageKey ? visibilityState.isVisible : true;

  const availableEnzymes = useMemo(() => {
    if (allEnzymes.length === 0) return [];
    return filterByVendor(allEnzymes, vendor);
  }, [allEnzymes, vendor]);

  const activeEnzymes = useMemo(() => {
    if (
      activeEnzymeState.storageKey === activeEnzymeStorageKey &&
      activeEnzymeState.includeOtherVendors
    ) {
      return allActiveEnzymes;
    }
    return allActiveEnzymes.filter((enzyme) => enzymeHasVendor(enzyme, vendor));
  }, [allActiveEnzymes, vendor, activeEnzymeState, activeEnzymeStorageKey]);
  const activeNames = useMemo(
    () => new Set(activeEnzymes.map((enzyme) => enzyme.name)),
    [activeEnzymes]
  );

  const setVendor = useCallback((newVendor: VendorCode) => {
    setVendorState(newVendor);
    setActiveEnzymeState((state) => ({ ...state, includeOtherVendors: false }));
    setHoveredCutSite(null);
  }, []);

  const [scanState, scanControls] = useCutSiteScanner({
    sequence,
    circular,
    activeEnzymes,
    debounceMs: options.scanDebounceMs,
  });

  const shouldScanCatalogSummary =
    catalogSummaryEnabled ||
    cutterFilter === 'single' ||
    cutterFilter === 'double' ||
    cutterFilter === 'single-double';
  const catalogSummaryEnzymes = useMemo(() => {
    if (!sequence || !shouldScanCatalogSummary) return [];
    return availableEnzymes;
  }, [availableEnzymes, sequence, shouldScanCatalogSummary]);
  const [catalogSummaryScanState] = useCutSiteScanner({
    sequence,
    circular,
    activeEnzymes: catalogSummaryEnzymes,
    maxHitsPerEnzyme: CATALOG_SUMMARY_SCAN_HIT_LIMIT,
    debounceMs: options.scanDebounceMs,
  });

  const colorByName = useMemo(() => {
    const assigned = assignEnzymeColors(activeEnzymes.map((e) => e.name));
    const m = new Map<string, string>();
    for (const [name, color] of assigned) m.set(name, color.hex);
    return m;
  }, [activeEnzymes]);

  const cutSites = useMemo((): ColoredCutSite[] => {
    if (!sequence || activeEnzymes.length === 0) return [];
    return scanState.hits.map((s) => ({
      ...s,
      color: colorByName.get(s.enzyme.name) ?? '#9ca3af',
    }));
  }, [sequence, activeEnzymes, scanState.hits, colorByName]);

  const enzymeCutCounts = useMemo((): Map<string, CutSiteCountSummary> => {
    const counts = new Map<string, CutSiteCountSummary>();

    if (scanState.phase === 'complete') {
      for (const enzyme of activeEnzymes) {
        counts.set(enzyme.name, { count: 0, capped: false });
      }
      for (const site of scanState.hits) {
        const current = counts.get(site.enzyme.name)?.count ?? 0;
        counts.set(site.enzyme.name, { count: current + 1, capped: false });
      }
    }

    if (catalogSummaryScanState.phase === 'complete') {
      for (const enzyme of catalogSummaryEnzymes) {
        counts.set(enzyme.name, { count: 0, capped: false });
      }
      for (const site of catalogSummaryScanState.hits) {
        const current = counts.get(site.enzyme.name)?.count ?? 0;
        const next = Math.min(CATALOG_SUMMARY_SCAN_HIT_LIMIT, current + 1);
        counts.set(site.enzyme.name, {
          count: Math.min(next, CATALOG_SUMMARY_EXACT_COUNT_LIMIT),
          capped: next > CATALOG_SUMMARY_EXACT_COUNT_LIMIT,
        });
      }
    }

    return counts;
  }, [
    activeEnzymes,
    catalogSummaryEnzymes,
    catalogSummaryScanState.hits,
    catalogSummaryScanState.phase,
    scanState.hits,
    scanState.phase,
  ]);

  const scannedCutSites = useMemo((): ColoredCutSite[] => {
    const targetCutCounts =
      cutterFilter === 'single'
        ? new Set([1])
        : cutterFilter === 'double'
          ? new Set([2])
          : cutterFilter === 'single-double'
            ? new Set([1, 2])
            : null;
    if (!sequence || !targetCutCounts) {
      return [];
    }
    if (catalogSummaryScanState.phase !== 'complete') return [];

    const grayColor = '#9ca3af';
    const byEnzyme = new Map<string, CutSite[]>();

    for (const site of catalogSummaryScanState.hits) {
      if (activeNames.has(site.enzyme.name)) continue;
      const sites = byEnzyme.get(site.enzyme.name);
      if (sites) sites.push(site);
      else byEnzyme.set(site.enzyme.name, [site]);
    }

    const allSites: ColoredCutSite[] = [];
    for (const sites of byEnzyme.values()) {
      if (!targetCutCounts.has(sites.length)) continue;
      sites.forEach((site) => allSites.push({ ...site, color: grayColor }));
    }
    return sortCutSitesByPosition(allSites) as ColoredCutSite[];
  }, [
    sequence,
    cutterFilter,
    catalogSummaryScanState.phase,
    catalogSummaryScanState.hits,
    activeNames,
  ]);

  useEffect(() => {
    if (!hasInitializedRef.current || activeEnzymeState.storageKey !== activeEnzymeStorageKey) {
      return;
    }
    const names = allActiveEnzymes.map((e) => e.name);
    persistEnzymes(names, activeEnzymeStorageKey);
  }, [activeEnzymeState.storageKey, activeEnzymeStorageKey, allActiveEnzymes]);

  useEffect(() => {
    persistVendor(vendor);
  }, [vendor]);

  useEffect(() => {
    if (visibilityState.storageKey !== visibilityStorageKey) return;
    persistVisibility(isVisible, visibilityStorageKey);
  }, [visibilityState.storageKey, visibilityStorageKey, isVisible]);

  const addEnzyme = useCallback(
    (enzyme: RestrictionEnzyme) => {
      setActiveEnzymeState((prevState) => {
        const prev = prevState.storageKey === activeEnzymeStorageKey ? prevState.enzymes : [];
        if (prev.some((e) => e.name === enzyme.name)) {
          return { ...prevState, storageKey: activeEnzymeStorageKey, enzymes: prev };
        }
        return {
          storageKey: activeEnzymeStorageKey,
          enzymes: [...prev, enzyme],
          includeOtherVendors:
            prevState.storageKey === activeEnzymeStorageKey && prevState.includeOtherVendors,
        };
      });
    },
    [activeEnzymeStorageKey]
  );

  const removeEnzyme = useCallback(
    (enzymeName: string) => {
      setActiveEnzymeState((prevState) => {
        const prev = prevState.storageKey === activeEnzymeStorageKey ? prevState.enzymes : [];
        return {
          storageKey: activeEnzymeStorageKey,
          enzymes: prev.filter((e) => e.name !== enzymeName),
          includeOtherVendors:
            prevState.storageKey === activeEnzymeStorageKey && prevState.includeOtherVendors,
        };
      });
      setHoveredCutSite((prev) => (prev?.enzyme.name === enzymeName ? null : prev));
    },
    [activeEnzymeStorageKey]
  );

  const clearAllEnzymes = useCallback(() => {
    setActiveEnzymeState((prevState) => {
      const prev = prevState.storageKey === activeEnzymeStorageKey ? prevState.enzymes : [];
      return {
        storageKey: activeEnzymeStorageKey,
        enzymes: prevState.includeOtherVendors
          ? []
          : prev.filter((e) => !enzymeHasVendor(e, vendor)),
      };
    });
    setHoveredCutSite(null);
  }, [activeEnzymeStorageKey, vendor]);

  const toggleVisibility = useCallback(() => {
    setVisibilityState((prev) => {
      const current =
        prev.storageKey === visibilityStorageKey
          ? prev.isVisible
          : loadPersistedVisibility(visibilityStorageKey);
      return { storageKey: visibilityStorageKey, isVisible: !current };
    });
  }, [visibilityStorageKey]);

  const state: CutSitesState = {
    availableEnzymes,
    activeEnzymes,
    cutSites,
    enzymeCutCounts,
    enzymeCutCountPhase: shouldScanCatalogSummary ? catalogSummaryScanState.phase : 'idle',
    enzymeCutCountLimit: CATALOG_SUMMARY_EXACT_COUNT_LIMIT,
    scannedCutSites,
    hoveredCutSite,
    vendor,
    cutterFilter,
    searchTerm,
    isVisible,
    isLoading,
    error,
    scanPhase: scanState.phase,
    scanProgress: scanState.progress,
    scanSettled: scanState.settled,
  };

  const actions: CutSitesActions = {
    addEnzyme,
    removeEnzyme,
    clearAllEnzymes,
    setVendor,
    setCutterFilter,
    setSearchTerm,
    toggleVisibility,
    setHoveredCutSite,
    cancelScan: scanControls.cancel,
  };

  return [state, actions];
}
