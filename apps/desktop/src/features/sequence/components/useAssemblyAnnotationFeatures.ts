import { useEffect, useRef, useState } from 'react';
import type { GenomeAssembly } from '@waypoint/genome-data';
import type { Assembly, Feature } from '@waypoint/genome-renderer';
import { buildAssembly, placementForChrom } from '@waypoint/genome-renderer';
import type {
  AssemblyOverviewResult,
  GenomeSessionShell,
  GenomeTrackTile,
} from '../../../shared/indexed-genome';
import { platform } from '../../../platform';
import {
  applyDensityControls,
  resolveAnnotationFeaturesForViewer,
  type AnnotationLaneStackingOptions,
  type TranscriptCarrierFeature,
} from './indexed-genome-legacy-adapter';
import { collapseToCanonicalIsoforms, type TranscriptDisplayMode } from './isoform-collapse';
import { isTranscriptGlyphV2Enabled } from '../transcript-glyph-flag';
import { offsetFeaturesToGlobal } from './assembly-feature-offset';
import { annotationLayerType } from '../annotation-layer-identity';
import { buildAnnotationTileRequest } from './indexed-annotation-tile-request';
import { shouldEnableTestBridge } from '../../../lib/test-bridge-gate';
import { classifyProcessedAssemblyFeaturesCache } from './assembly-annotation-cache';

const TEST_BRIDGE_ON = typeof window !== 'undefined' && shouldEnableTestBridge(import.meta.env);

const OVERVIEW_VISIBLE_TYPES: ReadonlySet<string> = new Set(['gene', 'mRNA']);
const LANE_STACKING: AnnotationLaneStackingOptions = {
  groupByType: true,
  typeOrder: ['gene', 'mRNA', 'lncRNA', 'ncRNA', 'miRNA', 'snoRNA', 'tRNA'],
};
const EMPTY_EXPANDED: ReadonlySet<string> = new Set<string>();
const TILE_POLL_MS_MIN = 25;
const TILE_POLL_MS_MAX = 400;
const TILE_POLL_BACKOFF = 1.8;
const TILE_MAX_ATTEMPTS = 48;
const PENDING_STATES: ReadonlySet<string> = new Set([
  'missing',
  'queued',
  'loading',
  'building_summary',
  'stale',
]);
const SESSION_CONCURRENCY = 4;

export interface AssemblyAnnotationResult {
  features: Feature[];
  byChrom: ReadonlyMap<string, Feature[]>;
  loadedChroms: number;
  totalChroms: number;
}

interface KeyedAssemblyAnnotationResult {
  key: string;
  value: AssemblyAnnotationResult;
}

function assemblyAnnotationResultKey(
  assembly: GenomeAssembly | undefined,
  workspaceRoot: string | null | undefined,
  deferUntilZoom: boolean,
  requestedIsoformMode: TranscriptDisplayMode
): string | null {
  if (!assembly || !workspaceRoot) return null;
  const indexed = assembly.chromosomes.filter((chrom) => Boolean(chrom.manifest.gffPath));
  if (indexed.length === 0) return null;
  return JSON.stringify([
    assembly.assemblyId,
    workspaceRoot,
    deferUntilZoom,
    requestedIsoformMode,
    indexed.map((chrom) => [chrom.chrom, chrom.length, chrom.manifest.gffPath]),
  ]);
}

export function useAssemblyAnnotationFeatures(
  assembly: GenomeAssembly | undefined,
  workspaceRoot: string | null | undefined,
  deferUntilZoom = false,
  requestedIsoformMode: TranscriptDisplayMode = 'canonical'
): AssemblyAnnotationResult | null {
  const requestedResultKey = assemblyAnnotationResultKey(
    assembly,
    workspaceRoot,
    deferUntilZoom,
    requestedIsoformMode
  );
  const [result, setResult] = useState<KeyedAssemblyAnnotationResult | null>(null);
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!assembly || !workspaceRoot || !requestedResultKey) {
      setResult(null);
      return;
    }
    const indexed = assembly.chromosomes.filter((c) => Boolean(c.manifest.gffPath));
    if (indexed.length === 0) {
      setResult(null);
      return;
    }
    const overviewMode = requestedIsoformMode;
    const key = requestedResultKey;
    keyRef.current = key;
    let cancelled = false;

    const debug: Record<string, unknown> = {
      assemblyId: assembly.assemblyId,
      workspaceRoot,
      indexedCount: indexed.length,
      isoformMode: overviewMode,
      requestedIsoformMode: overviewMode,
      activeResultMode: null,
      resultKey: key,
      deferUntilZoom,
      perChrom: {} as Record<string, unknown>,
    };
    if (TEST_BRIDGE_ON) {
      (window as Window & { __assemblyAnnDebug?: unknown }).__assemblyAnnDebug = debug;
    }
    const dbg = (chrom: string, info: unknown) => {
      (debug.perChrom as Record<string, unknown>)[chrom] = info;
    };

    // global-axis start of each chromosome is computed in ONE place
    const rendererAssembly: Assembly = buildAssembly(
      assembly.assemblyId,
      assembly.displayName,
      assembly.chromosomes.map((c) => ({
        id: c.chrom,
        displayName: c.displayName,
        length: c.length,
        cytobands: [],
      }))
    );

    const byChrom = new Map<string, Feature[]>();
    const emit = () => {
      if (cancelled || keyRef.current !== key) return;
      const merged: Feature[] = [];
      for (const c of assembly.chromosomes) {
        const f = byChrom.get(c.chrom);
        if (f) merged.push(...f);
      }
      debug.activeResultMode = byChrom.size > 0 ? overviewMode : null;
      setResult({
        key,
        value: {
          features: merged,
          byChrom: new Map(byChrom),
          loadedChroms: byChrom.size,
          totalChroms: indexed.length,
        },
      });
    };
    emit();

    type OverviewFeatureModel = Parameters<typeof resolveAnnotationFeaturesForViewer>[1];
    const processOverviewFeatures = (
      entry: (typeof indexed)[number],
      rawOrResolvedFeatures: readonly unknown[],
      featureModel: OverviewFeatureModel
    ): Feature[] => {
      const resolved = resolveAnnotationFeaturesForViewer(
        (Array.isArray(rawOrResolvedFeatures) ? rawOrResolvedFeatures : []) as Parameters<
          typeof resolveAnnotationFeaturesForViewer
        >[0],
        featureModel,
        isTranscriptGlyphV2Enabled()
      );
      const collapsed = collapseToCanonicalIsoforms(resolved as TranscriptCarrierFeature[], {
        mode: overviewMode,
        expandedGeneIds: EMPTY_EXPANDED,
      });
      const presentTypes = new Set(
        collapsed.map((f) => annotationLayerType(f as Parameters<typeof annotationLayerType>[0]))
      );
      const { features: localFeatures } = applyDensityControls(
        collapsed,
        entry.chrom,
        entry.length,
        presentTypes,
        null,
        LANE_STACKING
      );
      const offset = placementForChrom(rendererAssembly, entry.chrom)?.globalStartBp ?? 0;
      return offsetFeaturesToGlobal(localFeatures, offset);
    };

    const fetchChrom = async (entry: (typeof indexed)[number]) => {
      let shell: GenomeSessionShell | null = null;
      try {
        dbg(entry.chrom, { phase: 'opening' });
        shell = await platform().genome.open({
          sourcePath: entry.manifest.gffPath as string,
          workspaceRoot,
          chrom: entry.chrom,
          manifest: entry.manifest,
          intent: { kind: 'internal-assembly-segment' },
        });
        if (cancelled || keyRef.current !== key) return;
        let tile: GenomeTrackTile | null = null;
        let lastState = 'none';
        let pollMs = TILE_POLL_MS_MIN;
        for (let attempt = 0; attempt < TILE_MAX_ATTEMPTS; attempt += 1) {
          if (cancelled || keyRef.current !== key) return;
          tile = await platform().genome.getAnnotationTile(
            shell.sessionId,
            buildAnnotationTileRequest({
              chrom: entry.chrom,
              start: 0,
              end: entry.length,
              lod: 0,
              generation: 1,
              fidelity: 'summary',
              byteBudget: 4_000_000,
              sourceFingerprint: shell.sourceFingerprint,
              visibleTypes: OVERVIEW_VISIBLE_TYPES,
              laneLimit: null,
            }),
            `assembly-overview-${entry.chrom}-${attempt}`
          );
          lastState = tile.state;
          if (!PENDING_STATES.has(tile.state)) break;
          await new Promise((r) => setTimeout(r, pollMs));
          pollMs = Math.min(TILE_POLL_MS_MAX, Math.round(pollMs * TILE_POLL_BACKOFF));
        }
        if (cancelled || keyRef.current !== key || !tile) return;
        const feats = processOverviewFeatures(
          entry,
          Array.isArray(tile.features) ? tile.features : [],
          tile.featureModel ?? 'raw-gff3'
        );
        byChrom.set(entry.chrom, feats);
        dbg(entry.chrom, {
          phase: 'done',
          source: 'session-fallback',
          tileState: lastState,
          tileRecordCount: tile.recordCount,
          rendererFeatures: feats.length,
        });
        emit();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dbg(entry.chrom, { phase: 'error', error: msg });
        console.warn(`[assembly-annotations] ${entry.chrom} overview failed:`, err);
      } finally {
        if (shell) {
          try {
            await platform().genome.closeSession(shell.sessionId);
          } catch {}
        }
      }
    };

    const chromInputs = () =>
      indexed.map((e) => ({
        chrom: e.chrom,
        sourcePath: e.manifest.gffPath as string,
        length: e.length,
      }));

    void (async () => {
      if (deferUntilZoom) {
        if (TEST_BRIDGE_ON) debug.deferred = true;
        emit();
        return;
      }

      try {
        const cached = await platform().genome.readAssemblyOverviewFeatures({
          assemblyId: assembly.assemblyId,
          chromosomes: chromInputs(),
          workspaceRoot,
          mode: overviewMode,
        });
        if (cancelled || keyRef.current !== key) return;
        let cachedByChrom: Record<string, readonly unknown[]> | null = cached?.byChrom ?? null;
        let rawFileManifestMode: string | null = null;
        if (!cachedByChrom && cached?.rawFileJson) {
          try {
            const p = JSON.parse(cached.rawFileJson) as {
              manifest?: { mode?: unknown };
              byChrom?: Record<string, readonly unknown[]>;
            };
            cachedByChrom = p?.byChrom ?? null;
            rawFileManifestMode = typeof p?.manifest?.mode === 'string' ? p.manifest.mode : null;
          } catch {
            cachedByChrom = null;
          }
        }
        const cacheModeMatches =
          cached?.manifest.mode === overviewMode &&
          (!cached?.rawFileJson || rawFileManifestMode === overviewMode);
        if (cachedByChrom && cached && cacheModeMatches) {
          const classified = classifyProcessedAssemblyFeaturesCache(
            indexed.map((entry) => entry.chrom),
            cachedByChrom
          );
          for (const entry of indexed) {
            const feats = classified.featuresByChrom.get(entry.chrom);
            if (feats) {
              byChrom.set(entry.chrom, feats);
              dbg(entry.chrom, {
                phase: 'done',
                source: 'features-cache',
                rendererFeatures: feats.length,
              });
            } else {
              const cachedFeats = cachedByChrom[entry.chrom];
              dbg(entry.chrom, {
                phase: 'cache-empty',
                source: 'features-cache',
                rendererFeatures: Array.isArray(cachedFeats) ? cachedFeats.length : null,
              });
            }
          }
          if (TEST_BRIDGE_ON) {
            debug.featuresCache = {
              hit: classified.hit,
              featureCount: cached.manifest.featureCount,
              chroms: classified.cachedChroms,
              emptyChroms: classified.emptyChroms,
            };
          }
          emit();
          if (classified.hit) return;
        } else if (cached && !cacheModeMatches && TEST_BRIDGE_ON) {
          debug.featuresCache = {
            hit: false,
            rejected: 'mode-mismatch',
            requestedMode: overviewMode,
            manifestMode: cached.manifest.mode,
            rawFileManifestMode,
          };
        }
      } catch {}

      let overview: AssemblyOverviewResult | null = null;
      const readStart = typeof performance !== 'undefined' ? performance.now() : 0;
      try {
        overview = await platform().genome.getAssemblyOverview({
          chromosomes: indexed.map((e) => ({
            chrom: e.chrom,
            sourcePath: e.manifest.gffPath as string,
            length: e.length,
          })),
          workspaceRoot,
        });
      } catch (err) {
        console.warn('[assembly-annotations] unified overview read failed; using sessions:', err);
      }
      const unifiedReadMs =
        typeof performance !== 'undefined' ? Math.round(performance.now() - readStart) : -1;
      if (cancelled || keyRef.current !== key) return;

      const processStart = typeof performance !== 'undefined' ? performance.now() : 0;
      const fallbackQueue: typeof indexed = [];
      for (const entry of indexed) {
        const hit = overview?.byChrom[entry.chrom];
        if (hit && hit.cacheState === 'hit') {
          const feats = processOverviewFeatures(entry, hit.features, 'resolved-transcript-v2');
          byChrom.set(entry.chrom, feats);
          dbg(entry.chrom, {
            phase: 'done',
            source: 'unified-cache',
            rendererFeatures: feats.length,
          });
        } else {
          fallbackQueue.push(entry);
        }
      }
      if (TEST_BRIDGE_ON) {
        debug.unified = {
          hits: overview?.hits ?? 0,
          misses: overview?.misses ?? indexed.length,
          fallbacks: fallbackQueue.length,
          indexedCount: indexed.length,
          unifiedReadMs,
          processMs:
            typeof performance !== 'undefined' ? Math.round(performance.now() - processStart) : -1,
        };
      }
      emit();

      if (fallbackQueue.length > 0 && !cancelled && keyRef.current === key) {
        const queue = [...fallbackQueue];
        const runWorker = async () => {
          while (queue.length > 0 && !cancelled && keyRef.current === key) {
            const entry = queue.shift();
            if (entry) await fetchChrom(entry);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(SESSION_CONCURRENCY, queue.length) }, runWorker)
        );
      }

      if (
        !cancelled &&
        keyRef.current === key &&
        indexed.every((entry) => (byChrom.get(entry.chrom)?.length ?? 0) > 0)
      ) {
        void platform()
          .genome.writeAssemblyOverviewFeatures({
            assemblyId: assembly.assemblyId,
            chromosomes: chromInputs(),
            workspaceRoot,
            mode: overviewMode,
            byChrom: Object.fromEntries(byChrom) as Record<string, unknown[]>,
          })
          .catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assembly, workspaceRoot, deferUntilZoom, requestedIsoformMode, requestedResultKey]);

  return result?.key === requestedResultKey ? result.value : null;
}
