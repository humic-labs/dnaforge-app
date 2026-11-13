
import type { Tab } from '../../canvas/public/types';

export type IndexedTab = Tab & {
  indexedGenome: NonNullable<Tab['indexedGenome']>;
};

export interface IndexedCurrentViewSnapshot {
  ok: true;
  tabId: string;
  sourcePath: string;
  chrom: string;
  assemblyId?: string;
  scopeKind: 'all' | 'chromosome' | 'locus';
  start0?: number;
  end0?: number;
  highlight?: { start0: number; end0: number };
}

export type IndexedCurrentViewFailure = {
  ok: false;
  error:
    | 'NO_INDEXED_VIEW'
    | 'CANCELLED'
    | 'MALFORMED_INTERVAL'
    | 'CHROM_NOT_FOUND'
    | 'OUT_OF_RANGE'
    | 'VIEW_NOT_APPLIED';
  message: string;
};

export interface IndexedViewTarget {
  chrom: string;
  chromLength?: number;
}

export interface IndexedCanvasStoreSlice {
  panels: Record<string, { tabs: Tab[]; activeTabId: string | null }>;
  focusedPanelId?: string | null;
}

export function isIndexedTab(tab: Tab | undefined): tab is IndexedTab {
  return Boolean(tab?.indexedGenome?.sourcePath && tab.indexedGenome.chrom);
}

export function projectIndexedCurrentView(
  tab: Tab,
  liveViewport?: { chrom: string; start0: number; end0: number } | null
): IndexedCurrentViewSnapshot | IndexedCurrentViewFailure {
  if (!isIndexedTab(tab)) {
    return {
      ok: false,
      error: 'NO_INDEXED_VIEW',
      message: 'No indexed genome tab is open.',
    };
  }
  const genome = tab.indexedGenome;
  const scopeKind = genome.scope?.kind ?? 'all';
  const scopedChrom =
    genome.scope && genome.scope.kind !== 'all' ? genome.scope.chrom : genome.chrom;
  const snapshot: IndexedCurrentViewSnapshot = {
    ok: true,
    tabId: tab.id,
    sourcePath: genome.sourcePath,
    chrom: liveViewport?.chrom ?? scopedChrom,
    scopeKind,
  };
  if (genome.assembly?.assemblyId) snapshot.assemblyId = genome.assembly.assemblyId;

  const commanded =
    liveViewport === null
      ? null
      : (liveViewport ??
        (genome.scope?.kind === 'locus'
          ? { start0: genome.scope.start, end0: genome.scope.end }
          : tab.viewState?.indexedViewport
            ? {
                start0: tab.viewState.indexedViewport.start0,
                end0: tab.viewState.indexedViewport.end0,
              }
            : null));
  if (commanded && Number.isFinite(commanded.start0) && Number.isFinite(commanded.end0)) {
    if (commanded.start0 < 0 || commanded.end0 < commanded.start0) {
      return {
        ok: false,
        error: 'MALFORMED_INTERVAL',
        message: 'Indexed view interval must be 0-based half-open with end0 >= start0.',
      };
    }
    if (commanded.end0 > commanded.start0) {
      snapshot.start0 = commanded.start0;
      snapshot.end0 = commanded.end0;
    }
  }

  const highlight = tab.viewState?.highlightRange;
  if (highlight && highlight.end >= highlight.start) {
    snapshot.highlight = { start0: highlight.start, end0: highlight.end + 1 };
  }
  return snapshot;
}

export function resolveIndexedViewTarget(
  tab: IndexedTab,
  input: Readonly<{ chrom: string; start0: number; end0: number }>
): IndexedViewTarget | IndexedCurrentViewFailure {
  const genome = tab.indexedGenome;
  const requestedChrom = input.chrom.trim();
  const assemblyChromosome = genome.assembly?.chromosomes.find(
    (chromosome) =>
      chromosome.chrom === requestedChrom ||
      Object.values(chromosome.aliases ?? {}).includes(requestedChrom)
  );
  let target: IndexedViewTarget | null = null;
  if (genome.assembly) {
    if (assemblyChromosome) {
      target = { chrom: assemblyChromosome.chrom, chromLength: assemblyChromosome.length };
    }
  } else if (requestedChrom === genome.chrom || requestedChrom === genome.manifest?.chrom) {
    const length = genome.manifest?.length ?? genome.metadata?.length;
    target = {
      chrom: genome.chrom,
      ...(typeof length === 'number' && length > 0 ? { chromLength: length } : {}),
    };
  }
  if (!target) {
    return {
      ok: false,
      error: 'CHROM_NOT_FOUND',
      message: `Chromosome "${requestedChrom}" is not present in the open indexed reference.`,
    };
  }
  if (target.chromLength !== undefined && input.end0 > target.chromLength) {
    return {
      ok: false,
      error: 'OUT_OF_RANGE',
      message: `${target.chrom}:${input.start0}-${input.end0} exceeds chromosome length ${target.chromLength}.`,
    };
  }
  return target;
}

export function findIndexedTab(
  tabs: ReadonlyArray<Tab>,
  activeTabId: string | null
): IndexedTab | undefined {
  const active = tabs.find((tab) => tab.id === activeTabId);
  if (isIndexedTab(active)) return active;
  return tabs.find((tab) => isIndexedTab(tab));
}

export function findOpenIndexedTab(
  store: IndexedCanvasStoreSlice
): { panelId: string; tab: IndexedTab } | null {
  const panelIds: string[] = [];
  const preferred =
    store.focusedPanelId && store.panels[store.focusedPanelId]
      ? store.focusedPanelId
      : store.panels.main
        ? 'main'
        : null;
  if (preferred) panelIds.push(preferred);
  for (const panelId of Object.keys(store.panels)) {
    if (!panelIds.includes(panelId)) panelIds.push(panelId);
  }
  for (const panelId of panelIds) {
    const panel = store.panels[panelId];
    const tab = findIndexedTab(panel.tabs, panel.activeTabId);
    if (tab) return { panelId, tab };
  }
  return null;
}
