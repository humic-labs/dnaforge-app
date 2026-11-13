import { useCanvasStore } from '../canvas/public/store';
import type { Tab } from '../canvas/public/types';
import { trackRendererEvent } from '../../lib/analytics';
import { workflowCountBucket } from '../../lib/workflow-telemetry';
import { HOSTED_REFERENCE_UCSC_TRACK_TARGETS_V1 } from '../../shared/hosted-reference-ucsc-targets';

type GenomeViewTab = Pick<Tab, 'id' | 'loadStatus' | 'indexedGenome'>;
type GenomeViewPhase = 'ready' | 'failed' | 'abandoned';

export interface GenomeViewTelemetryDeps {
  tabs: () => readonly GenomeViewTab[];
  subscribe: (listener: () => void) => () => void;
  track: (event: string, properties: Record<string, unknown>) => void;
  now: () => number;
}

const CATALOG_BUILDS = new Set(HOSTED_REFERENCE_UCSC_TRACK_TARGETS_V1.map(({ id }) => id));

function canvasTabs(): GenomeViewTab[] {
  return Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs);
}

function defaultDeps(): GenomeViewTelemetryDeps {
  return {
    tabs: canvasTabs,
    subscribe: (listener) =>
      useCanvasStore.subscribe((state, previous) => {
        if (state.panels !== previous.panels) listener();
      }),
    track: (event, properties) => {
      trackRendererEvent(event, properties);
    },
    now: () => Date.now(),
  };
}

export function genomeViewSource(tab: GenomeViewTab): Record<string, unknown> {
  const assemblyId = tab.indexedGenome?.assembly?.assemblyId;
  if (!assemblyId) return { genome_source: 'indexed_file' };
  if (CATALOG_BUILDS.has(assemblyId)) return { genome_source: 'catalog', genome_build: assemblyId };
  return { genome_source: 'local_reference' };
}

function savedTrackCount(tab: GenomeViewTab): number {
  const state = tab.indexedGenome;
  if (!state) return 0;
  return (
    (state.bamTracks?.length ?? 0) +
    (state.dataTracks?.length ?? 0) +
    (state.signalReadPileupViews?.length ?? 0) +
    (state.variantSource ? 1 : 0)
  );
}

function isIndexedTab(tab: GenomeViewTab): boolean {
  return (
    tab.loadStatus === 'indexed-pending' ||
    tab.loadStatus === 'indexed' ||
    tab.loadStatus === 'indexed-error'
  );
}

export function installGenomeViewTelemetry(
  deps: GenomeViewTelemetryDeps = defaultDeps()
): () => void {
  const pendingSince = new Map<string, number>();
  const report = (tab: GenomeViewTab, phase: GenomeViewPhase, startedAt: number) => {
    try {
      deps.track('genome_view_observed', {
        feature_area: 'scientific_workflow',
        view_phase: phase,
        ...genomeViewSource(tab),
        track_count_bucket: workflowCountBucket(savedTrackCount(tab)),
        duration_ms: Math.max(0, deps.now() - startedAt),
      });
    } catch {}
  };
  const lastSeen = new Map<string, GenomeViewTab>();
  const observe = () => {
    const current = new Set<string>();
    for (const tab of deps.tabs()) {
      if (!isIndexedTab(tab)) continue;
      current.add(tab.id);
      lastSeen.set(tab.id, tab);
      if (tab.loadStatus === 'indexed-pending') {
        if (!pendingSince.has(tab.id)) pendingSince.set(tab.id, deps.now());
        continue;
      }
      const startedAt = pendingSince.get(tab.id);
      if (startedAt === undefined) continue;
      pendingSince.delete(tab.id);
      report(tab, tab.loadStatus === 'indexed' ? 'ready' : 'failed', startedAt);
    }
    for (const [tabId, startedAt] of pendingSince) {
      if (current.has(tabId)) continue;
      pendingSince.delete(tabId);
      const tab = lastSeen.get(tabId);
      if (tab) report(tab, 'abandoned', startedAt);
    }
    for (const tabId of lastSeen.keys()) {
      if (!current.has(tabId)) lastSeen.delete(tabId);
    }
  };
  observe();
  return deps.subscribe(observe);
}
