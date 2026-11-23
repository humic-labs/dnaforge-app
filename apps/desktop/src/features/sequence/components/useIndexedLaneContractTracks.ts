import { useEffect, useLayoutEffect, useRef } from 'react';

import type { PileupRecord } from '@waypoint/genome-data';
import { alignedReadSourceGenerationKey } from '@waypoint/genome-data';
import {
  BUILTIN_TRACK_TYPES,
  CYTOBAND_TYPE,
  PENDING_INTERVAL_BAND_HEIGHT_PX,
  PixiAnnotationTrackRenderer,
  PixiCytobandTrackRenderer,
  PixiPileupTrackRenderer,
  PixiQuantitativeTrackRenderer,
  PixiTranscriptTrackRenderer,
  PixiVariantTrackRenderer,
  type Assembly,
  type Chromosome,
  type PixiLinearRenderer,
  type Track,
  type SupplementalLinearTrack,
} from '@waypoint/genome-renderer';

import type { ActiveStressDataset } from '../lane-contract-store';
import { chromosomeForChrom } from '../tracks/cytobands';
import type { IndexedPileupStreamingController } from './useIndexedPileupStreaming';
import type { IndexedUcscStreamingController } from './useIndexedUcscTrackStreaming';
import type { IndexedExperimentalHybridPileupController } from './useExperimentalHybridPileupStreaming';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import { useTrackGutterLayoutStore } from './track-gutter-layout-store';

interface UseIndexedLaneContractTracksOptions {
  enabled?: boolean;
  supplementalTracks?: readonly SupplementalLinearTrack[];
  onTrackSelection?: (start: number, end: number, trackId: string) => void;
  webglRef: { readonly current: IndexedGenomeTileNativeMapHandle | null };
  rendererReadyEpoch?: number;
  rendererAssembly: Assembly | null;
  manifestChrom: string;
  manifestChromLength?: number;
  sequenceChromosome?: Chromosome;
  activeStressDatasets?: ReadonlyArray<ActiveStressDataset>;
  pileupStreaming?: Pick<IndexedPileupStreamingController, 'streamPileupViaTileEngine'> &
    Partial<Pick<IndexedPileupStreamingController, 'noteLaneContractWired'>>;
  ucscStreaming?: Pick<IndexedUcscStreamingController, 'noteLaneContractWired'>;
  experimentalHybridStreaming?: Pick<
    IndexedExperimentalHybridPileupController,
    'noteLaneContractWired'
  >;
  recordEvent?: (event: string, detail?: Record<string, unknown>) => void;
}

const PILEUP_ROW_GAP_PX = 1;
const PILEUP_READ_BODY_SCALE = 1.2;
const DEFAULT_PILEUP_ROW_PITCH_PX = 3;
const DEFAULT_PILEUP_MAX_ROWS = 60;
const MAX_IMPORTED_INTERVAL_LABELS = 96;
const EMPTY_DATASETS: readonly ActiveStressDataset[] = [];
const EMPTY_SUPPLEMENTAL_TRACKS: readonly SupplementalLinearTrack[] = [];

function pileupPresentationGeometry(dataset: ActiveStressDataset): {
  rowPitchPx: number;
  trackHeightPx: number;
} {
  const sourceRowPitchPx = dataset.laneHeightPx ?? DEFAULT_PILEUP_ROW_PITCH_PX;
  const sourceBodyHeightPx = Math.max(0, sourceRowPitchPx - PILEUP_ROW_GAP_PX);
  const rowPitchPx = roundLayoutPx(PILEUP_ROW_GAP_PX + sourceBodyHeightPx * PILEUP_READ_BODY_SCALE);
  const maxRows = dataset.maxLanes ?? DEFAULT_PILEUP_MAX_ROWS;
  const trackHeightPx = roundLayoutPx(
    dataset.trackPx + (rowPitchPx - sourceRowPitchPx) * maxRows + PENDING_INTERVAL_BAND_HEIGHT_PX
  );
  return { rowPitchPx, trackHeightPx };
}

function roundLayoutPx(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function useIndexedLaneContractTracks({
  enabled = true,
  supplementalTracks = EMPTY_SUPPLEMENTAL_TRACKS,
  onTrackSelection,
  webglRef,
  rendererReadyEpoch = 0,
  rendererAssembly,
  manifestChrom,
  manifestChromLength,
  sequenceChromosome,
  activeStressDatasets = EMPTY_DATASETS,
  pileupStreaming,
  ucscStreaming,
  experimentalHybridStreaming,
  recordEvent,
}: UseIndexedLaneContractTracksOptions): void {
  const trackSelectionRef = useRef(onTrackSelection);
  trackSelectionRef.current = onTrackSelection;
  const pileupStreamingRef = useRef(pileupStreaming);
  pileupStreamingRef.current = pileupStreaming;
  const ucscStreamingRef = useRef(ucscStreaming);
  ucscStreamingRef.current = ucscStreaming;
  const experimentalHybridStreamingRef = useRef(experimentalHybridStreaming);
  experimentalHybridStreamingRef.current = experimentalHybridStreaming;
  const liveDatasetsRef = useRef(activeStressDatasets);
  liveDatasetsRef.current = activeStressDatasets;
  const lastWiredDatasetsRef = useRef<{
    renderer: PixiLinearRenderer;
    assembly: Assembly | null;
    chrom: string;
    datasets: ReadonlyMap<string, ActiveStressDataset>;
  } | null>(null);
  const mountDatasetsRef = useRef(activeStressDatasets);
  if (!sameMountDatasets(mountDatasetsRef.current, activeStressDatasets)) {
    mountDatasetsRef.current = activeStressDatasets;
  }
  const mountDatasets = mountDatasetsRef.current;

  const liveBindings = useRef(supplementalTracks);
  liveBindings.current = supplementalTracks;
  const mountBindingsRef = useRef(supplementalTracks);
  if (
    supplementalTracks.length !== mountBindingsRef.current.length ||
    supplementalTracks.some(
      (binding, i) =>
        binding.track !== mountBindingsRef.current[i].track ||
        binding.renderer !== mountBindingsRef.current[i].renderer
    )
  )
    mountBindingsRef.current = supplementalTracks;
  const mountBindings = mountBindingsRef.current;
  const appliedBindings = useRef<readonly SupplementalLinearTrack[]>([]);

  const cytobandVisible = useTrackGutterLayoutStore((state) => state.cytobandVisible);

  useLayoutEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let rafId = 0;
    let intervalId: number | null = null;
    let wiredRenderer: PixiLinearRenderer | null = null;
    let observedLaneContractRevision = -1;
    const chromosome =
      sequenceChromosome ??
      chromosomeForChrom(manifestChrom) ??
      (manifestChromLength && manifestChromLength > 0
        ? {
            id: manifestChrom,
            displayName: manifestChrom,
            length: manifestChromLength,
            cytobands: [],
          }
        : null);
    const sourceBackedPileupWithoutAssembly = mountDatasets.filter(
      (dataset) =>
        !rendererAssembly && dataset.kind === 'pileup' && Boolean(dataset.source?.bamPath)
    );
    const mountableDatasets = mountDatasets.filter(
      (dataset) => !sourceBackedPileupWithoutAssembly.includes(dataset)
    );
    const ideogramId = rendererAssembly ? rendererAssembly.id : manifestChrom;
    const hasIdeogram =
      !sequenceChromosome &&
      (rendererAssembly != null || chromosomeForChrom(manifestChrom) != null);
    const cytobandTrack: Track | null =
      hasIdeogram && cytobandVisible
        ? {
            id: `cytoband-${ideogramId}`,
            type: BUILTIN_TRACK_TYPES.cytoband,
            order: 0,
            visible: true,
            assemblyId: ideogramId,
            sizing: CYTOBAND_TYPE.defaultSizing,
            label: 'Cytoband',
            zone: 'above-legacy',
          }
        : null;
    const expectedTrackIds = [
      ...(cytobandTrack ? [cytobandTrack.id] : []),
      ...mountableDatasets.map((dataset) => dataset.trackId),
      ...mountBindings.map((binding) => binding.track.id),
    ];

    const wire = (renderer: PixiLinearRenderer, reason: string) => {
      const rendererChanged = renderer !== wiredRenderer;
      for (const dataset of sourceBackedPileupWithoutAssembly) {
        recordEvent?.('pileup-source-rejected-without-renderer-assembly', {
          trackId: dataset.trackId,
          trackType: dataset.trackType,
          manifestChrom,
          hasDatasetCoverage: Boolean(dataset.coverage),
        });
      }

      if (rendererAssembly || chromosome) {
        registerTrackIdempotently(renderer, new PixiCytobandTrackRenderer());
        if (rendererAssembly) renderer.setAssembly(rendererAssembly);
        else if (chromosome) renderer.setChromosome(chromosome);
      }
      renderer.setTrackHitHandler((result) => {
        if (result.kind === 'jump-to-bp') webglRef.current?.setViewCenter?.(result.bp);
        else if (result.kind === 'frame-bp-range') {
          webglRef.current?.setViewport({ start: result.startBp, end: result.endBp });
        } else if (result.kind === 'select-bp-range') {
          webglRef.current?.setSelection?.(result.startBp, result.endBp - 1);
          trackSelectionRef.current?.(result.startBp, result.endBp - 1, result.trackId);
        }
      });

      const instances: Track[] = cytobandTrack ? [cytobandTrack] : [];
      for (let i = 0; i < mountableDatasets.length; i += 1) {
        const dataset = mountableDatasets[i];
        const pileupGeometry =
          dataset.kind === 'pileup' ? pileupPresentationGeometry(dataset) : null;
        if (dataset.kind === 'pileup') {
          registerTrackIdempotently(
            renderer,
            new PixiPileupTrackRenderer({
              type: dataset.trackType,
              rowHeightPx: pileupGeometry!.rowPitchPx,
              maxRows: dataset.maxLanes,
              overflowBandHeightPx: dataset.overflowBandHeightPx,
              readColor: dataset.color,
            })
          );
        } else if (dataset.kind === 'variant') {
          registerTrackIdempotently(
            renderer,
            new PixiVariantTrackRenderer({ type: dataset.trackType })
          );
        } else if (dataset.trackType === BUILTIN_TRACK_TYPES.importedTranscript) {
          registerTrackIdempotently(
            renderer,
            new PixiTranscriptTrackRenderer({
              type: dataset.trackType,
              maxLanes: dataset.maxLanes,
              maxLabels: MAX_IMPORTED_INTERVAL_LABELS,
            })
          );
        } else if (
          dataset.trackType === BUILTIN_TRACK_TYPES.quantitative ||
          dataset.trackType === BUILTIN_TRACK_TYPES.peak
        ) {
          registerTrackIdempotently(
            renderer,
            new PixiQuantitativeTrackRenderer({
              type: dataset.trackType,
              mode: dataset.trackType === BUILTIN_TRACK_TYPES.peak ? 'peak' : 'signal',
            })
          );
        } else {
          registerTrackIdempotently(
            renderer,
            new PixiAnnotationTrackRenderer({
              type: dataset.trackType,
              maxLabels:
                dataset.trackType === BUILTIN_TRACK_TYPES.genericInterval ||
                dataset.trackType === BUILTIN_TRACK_TYPES.repeat
                  ? MAX_IMPORTED_INTERVAL_LABELS
                  : 0,
            })
          );
        }
        instances.push({
          id: dataset.trackId,
          type: dataset.trackType,
          order: 1 + i,
          visible: true,
          assemblyId: manifestChrom,
          sizing: {
            kind: 'fixed',
            pixels: pileupGeometry?.trackHeightPx ?? dataset.trackPx,
          },
          label: dataset.label,
          color: colorToCss(dataset.color),
          rowHeightPx: pileupGeometry?.rowPitchPx ?? dataset.laneHeightPx,
          maxRows: dataset.maxLanes,
          quantitative: dataset.quantitativePresentation,
          quantitativeSourceSummary: dataset.quantitativeSourceSummary,
          zone: 'below-legacy',
        });
      }

      for (const binding of mountBindings) {
        registerTrackIdempotently(renderer, binding.renderer);
        instances.push({ ...binding.track, assemblyId: manifestChrom });
      }
      renderer.setTrackInstances(instances);
      for (const binding of liveBindings.current)
        renderer.setTrackData(binding.track.id, binding.data);
      appliedBindings.current = liveBindings.current;
      syncTrackColors(renderer, liveDatasetsRef.current);
      const previousWiring = lastWiredDatasetsRef.current;
      const previousDatasets =
        previousWiring?.renderer === renderer &&
        previousWiring.assembly === rendererAssembly &&
        previousWiring.chrom === manifestChrom
          ? previousWiring.datasets
          : null;
      const reseededTrackIds: string[] = [];
      for (const dataset of mountableDatasets) {
        const previousDataset = previousDatasets?.get(dataset.trackId);
        if (
          previousDataset &&
          sameTrackDataDataset(previousDataset, dataset) &&
          renderer.hasTrackData(dataset.trackId)
        ) {
          continue;
        }
        const engineOwnedPileup =
          Boolean(rendererAssembly) &&
          dataset.kind === 'pileup' &&
          Boolean(dataset.source?.bamPath);
        if (engineOwnedPileup) {
          if (!renderer.hasTrackData(dataset.trackId)) {
            renderer.setTrackData(dataset.trackId, {
              dataAuthority: 'tile-engine',
              records: [],
              ...pileupCoverageCutoffData(dataset),
            });
          }
        } else {
          renderer.setTrackData(
            dataset.trackId,
            dataset.kind === 'pileup'
              ? {
                  dataAuthority: 'static',
                  records:
                    dataset.pileupRecords ?? (dataset.records as ReadonlyArray<PileupRecord>),
                  coverage: dataset.coverage,
                  readSource: {
                    truncated: false,
                    sourceGenerationKey: alignedReadSourceGenerationKey(dataset.source?.generation),
                  },
                  ...pileupCoverageCutoffData(dataset),
                }
              : { records: dataset.records }
          );
        }
        reseededTrackIds.push(dataset.trackId);
      }
      lastWiredDatasetsRef.current = {
        renderer,
        assembly: rendererAssembly,
        chrom: manifestChrom,
        datasets: new Map(mountableDatasets.map((dataset) => [dataset.trackId, dataset])),
      };
      ucscStreamingRef.current?.noteLaneContractWired(reseededTrackIds);

      const initialRange = webglRef.current?.getViewportRange?.() ?? null;
      if (rendererAssembly) {
        pileupStreamingRef.current?.noteLaneContractWired?.(
          renderer,
          initialRange,
          expectedTrackIds
        );
      }
      experimentalHybridStreamingRef.current?.noteLaneContractWired();
      if (rendererAssembly) {
        pileupStreamingRef.current?.streamPileupViaTileEngine(initialRange);
      }

      webglRef.current?.requestRender?.();

      wiredRenderer = renderer;
      observedLaneContractRevision = renderer.getLaneContractRevision();
      recordEvent?.('lane-contract-wire', {
        reason,
        rendererChanged,
        trackIds: expectedTrackIds,
        stressDatasetCount: mountableDatasets.length,
        rejectedSourceBackedPileupCount: sourceBackedPileupWithoutAssembly.length,
      });
    };

    const tryWire = () => {
      if (cancelled) return;
      const renderer = webglRef.current?.getLinearRenderer?.();
      if (!renderer) {
        if (rafId === 0) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            tryWire();
          });
        }
        return;
      }
      const revision = renderer.getLaneContractRevision();
      if (renderer === wiredRenderer && revision === observedLaneContractRevision) return;
      if (
        rendererNeedsWire(
          renderer,
          wiredRenderer,
          expectedTrackIds,
          mountableDatasets,
          rendererAssembly
        )
      ) {
        wire(renderer, renderer !== wiredRenderer ? 'renderer-ready' : 'self-heal');
      } else {
        observedLaneContractRevision = revision;
      }
    };

    tryWire();
    intervalId = window.setInterval(tryWire, 250);
    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, [
    cytobandVisible,
    enabled,
    manifestChrom,
    manifestChromLength,
    mountDatasets,
    recordEvent,
    rendererAssembly,
    rendererReadyEpoch,
    webglRef,
    mountBindings,
    sequenceChromosome,
  ]);

  useLayoutEffect(() => {
    const renderer = webglRef.current?.getLinearRenderer?.();
    if (!renderer || appliedBindings.current === supplementalTracks) return;
    let changed = false;
    for (const [i, binding] of supplementalTracks.entries()) {
      if (binding.data === appliedBindings.current[i]?.data) continue;
      renderer.setTrackData(binding.track.id, binding.data);
      changed = true;
    }
    appliedBindings.current = supplementalTracks;
    if (changed) webglRef.current?.requestRender();
  }, [supplementalTracks, webglRef]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let rafId = 0;
    const apply = () => {
      if (cancelled) return;
      const renderer = webglRef.current?.getLinearRenderer?.();
      if (!renderer) {
        rafId = requestAnimationFrame(apply);
        return;
      }
      if (syncTrackColors(renderer, activeStressDatasets)) {
        webglRef.current?.requestRender();
      }
    };
    apply();
    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [activeStressDatasets, enabled, webglRef]);
}

function sameTrackDataDataset(left: ActiveStressDataset, right: ActiveStressDataset): boolean {
  return (
    left.kind === right.kind &&
    left.records === right.records &&
    left.pileupRecords === right.pileupRecords &&
    left.coverage === right.coverage &&
    left.coverageCutoffDepth === right.coverageCutoffDepth &&
    left.source === right.source
  );
}

function sameMountDatasets(
  previous: ReadonlyArray<ActiveStressDataset>,
  next: ReadonlyArray<ActiveStressDataset>
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  return previous.every((left, index) => {
    const right = next[index];
    return (
      left.trackType === right.trackType &&
      left.trackId === right.trackId &&
      left.label === right.label &&
      left.laneHeightPx === right.laneHeightPx &&
      left.maxLanes === right.maxLanes &&
      left.trackPx === right.trackPx &&
      left.records === right.records &&
      left.pileupRecords === right.pileupRecords &&
      left.kind === right.kind &&
      left.coverage === right.coverage &&
      left.overflowBandHeightPx === right.overflowBandHeightPx &&
      left.source === right.source &&
      left.experimentalHybrid?.alignmentTrackId === right.experimentalHybrid?.alignmentTrackId &&
      left.experimentalHybrid?.quantitativeTrackId ===
        right.experimentalHybrid?.quantitativeTrackId &&
      left.quantitativePresentation === right.quantitativePresentation &&
      left.quantitativeSourceSummary === right.quantitativeSourceSummary
    );
  });
}

function colorToCss(color: number): string {
  const bounded = Math.max(0, Math.min(0xff_ffff, Math.round(color)));
  return `#${bounded.toString(16).padStart(6, '0')}`;
}

function syncTrackColors(
  renderer: PixiLinearRenderer,
  datasets: ReadonlyArray<ActiveStressDataset>
): boolean {
  let changed = false;
  for (const dataset of datasets) {
    changed = renderer.setTrackColor(dataset.trackId, colorToCss(dataset.color)) || changed;
  }
  return changed;
}

function pileupCoverageCutoffData(
  dataset: ActiveStressDataset
): { coverageCutoffDepth: number } | Record<string, never> {
  const value = dataset.coverageCutoffDepth;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? { coverageCutoffDepth: value }
    : {};
}

function registerTrackIdempotently(renderer: PixiLinearRenderer, trackRenderer: unknown): void {
  try {
    renderer.registerTrack(trackRenderer as Parameters<PixiLinearRenderer['registerTrack']>[0]);
  } catch (err) {
    if (!String(err).includes('already registered')) throw err;
  }
}

function rendererNeedsWire(
  renderer: PixiLinearRenderer,
  wiredRenderer: PixiLinearRenderer | null,
  expectedTrackIds: ReadonlyArray<string>,
  activeStressDatasets: ReadonlyArray<ActiveStressDataset>,
  rendererAssembly: Assembly | null
): boolean {
  if (renderer !== wiredRenderer) return true;
  for (const id of expectedTrackIds) {
    if (!renderer.hasTrackInstance(id)) return true;
  }
  for (const dataset of activeStressDatasets) {
    if (rendererAssembly && dataset.kind === 'pileup' && dataset.source?.bamPath) continue;
    if (!renderer.hasTrackData(dataset.trackId)) return true;
  }
  return false;
}
