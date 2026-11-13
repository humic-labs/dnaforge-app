import { useEffect, useMemo, useRef } from 'react';

import {
  FEATURE_KIND_LABELS,
  createSourceRecordCache,
  resolveAnnotationTracks,
  type AnnotationTrackLayout,
  type GeneModel,
  type SourceRecordCache,
  type TrackBindingId,
} from '@waypoint/genome-data/annotation-catalog';
import {
  annotationCatalogTrackType,
  createAnnotationCatalogTrackRenderers,
  type AnnotationCatalogGeneSpan,
  type AnnotationCatalogTrackData,
  type Chromosome,
  type PixiLinearRenderer,
  type Track,
} from '@waypoint/genome-renderer';

import { useCanvasStore } from '../../canvas/public/store';
import {
  clearAnnotationCatalogWiring,
  publishAnnotationCatalogWiring,
  type AnnotationCatalogDrawingPhase,
  type AnnotationTrackDrawState,
  type HoverableCatalogTrack,
} from './annotation-catalog-wiring-status';
import {
  catalogForSequenceDocument,
  geneModelsContentKey,
  geneModelsFromAnnotations,
  geneSpansByNameAndLocusTag,
  sequenceReaderFor,
  type CatalogSequenceDocument,
} from './document-identity';
import {
  buildStrandHoverIndexes,
  sortRecordsBySpanStart,
  type StrandHoverIndexes,
} from './record-hover-index';
import {
  loadAnnotationCatalogs,
  useAnnotationCatalogSnapshot,
  type AnnotationCatalogForAssembly,
} from './annotation-catalog-registry';

export type AnnotationCatalogLinearRenderer = Pick<
  PixiLinearRenderer,
  'setChromosome' | 'registerTrack' | 'setTrackInstances' | 'setTrackData'
>;

export interface AnnotationCatalogMapHandle {
  getLinearRenderer?: () => AnnotationCatalogLinearRenderer | null;
  requestRender?: () => void;
}

export interface SequenceMapAnnotationCatalog {
  readonly ownerTabId: string;
  readonly assemblyAccession: string;
}

const MAX_RENDERER_WAIT_FRAMES = 120;
const TRACK_SIZING = { kind: 'fitContent', minHeight: 28, maxHeight: 160 } as const;

interface PublishedTrack {
  readonly data: AnnotationCatalogTrackData;
  readonly indexByStrand: StrandHoverIndexes;
}

interface DocumentCatalogContext {
  readonly catalog: AnnotationCatalogForAssembly;
  readonly cache: SourceRecordCache;
  readonly genesByName: ReadonlyMap<string, AnnotationCatalogGeneSpan>;
  readonly published: Map<string, PublishedTrack>;
}

function createDocumentContext(
  catalog: AnnotationCatalogForAssembly,
  sequence: string,
  genes: readonly GeneModel[]
): DocumentCatalogContext {
  return {
    catalog,
    cache: createSourceRecordCache({
      catalog: catalog.sources,
      assembly: catalog.assembly,
      genes,
      sequence: sequenceReaderFor(sequence),
    }),
    genesByName: geneSpansByNameAndLocusTag(genes),
    published: new Map(),
  };
}

const EMPTY_GENES: ReadonlyMap<string, AnnotationCatalogGeneSpan> = new Map();

const registeredTypesByRenderer = new WeakMap<object, ReadonlySet<string>>();
const wiredRenderers = new WeakSet<object>();

function registerCatalogTrackRenderers(
  renderer: AnnotationCatalogLinearRenderer
): ReadonlySet<string> {
  const known = registeredTypesByRenderer.get(renderer);
  if (known) return known;
  const types = new Set<string>();
  for (const trackRenderer of createAnnotationCatalogTrackRenderers()) {
    try {
      renderer.registerTrack(trackRenderer);
    } catch (error) {
      if (!String(error).includes('already registered')) throw error;
    }
    types.add(trackRenderer.type);
  }
  registeredTypesByRenderer.set(renderer, types);
  return types;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSequenceMapAnnotationCatalog(options: {
  readonly entityId: string;
  readonly document: CatalogSequenceDocument;
  readonly viewTransformed: boolean;
  readonly mapRef: { readonly current: AnnotationCatalogMapHandle | null };
  readonly rendererReadyEpoch: number;
  readonly mapCircular: boolean;
  readonly layout: AnnotationTrackLayout | undefined;
}): SequenceMapAnnotationCatalog | null {
  const { entityId, document, viewTransformed, mapRef, rendererReadyEpoch, mapCircular, layout } =
    options;

  const ownerTabId = useCanvasStore((state) => {
    for (const panel of Object.values(state.panels)) {
      const tab = panel.tabs.find((candidate) => candidate.entityId === entityId);
      if (tab) return tab.id;
    }
    return null;
  });

  const catalogSnapshot = useAnnotationCatalogSnapshot();
  useEffect(() => {
    if (catalogSnapshot.status === 'idle') void loadAnnotationCatalogs();
  }, [catalogSnapshot.status]);
  const catalog = useMemo(
    () => catalogForSequenceDocument(document),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [document.name, document.length, document.metadata, catalogSnapshot.catalogs]
  );
  const genes = useMemo(
    () => (catalog ? geneModelsFromAnnotations(document.annotations, document.length) : []),
    [catalog, document.annotations, document.length]
  );
  const genesKey = useMemo(() => geneModelsContentKey(genes), [genes]);
  const context = useMemo(
    () => (catalog ? createDocumentContext(catalog, document.sequence, genes) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, document.sequence, genesKey]
  );

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const layoutKey = layout ? JSON.stringify(layout) : '';

  useEffect(() => {
    let cancelled = false;
    let rafId = 0;
    let framesLeft = MAX_RENDERER_WAIT_FRAMES;
    let waitingPublished = false;
    const wiringLayout = layoutRef.current;

    const publish = (
      drawing: AnnotationCatalogDrawingPhase,
      tracks: ReadonlyMap<TrackBindingId, AnnotationTrackDrawState> = new Map(),
      hoverTracks: readonly HoverableCatalogTrack[] = []
    ) => {
      if (!ownerTabId || !context) return;
      publishAnnotationCatalogWiring(ownerTabId, {
        assembly: context.catalog.assembly,
        displayName: context.catalog.displayName,
        drawing,
        tracks,
        hoverTracks,
      });
    };

    const clearTracks = (renderer: AnnotationCatalogLinearRenderer | null) => {
      if (!renderer || !wiredRenderers.has(renderer)) return;
      renderer.setTrackInstances([]);
      wiredRenderers.delete(renderer);
      mapRef.current?.requestRender?.();
    };

    const wire = (renderer: AnnotationCatalogLinearRenderer, ctx: DocumentCatalogContext) => {
      const activeLayout = wiringLayout;
      const visible = activeLayout?.tracks.filter((track) => track.visible) ?? [];
      if (!activeLayout || visible.length === 0) {
        clearTracks(renderer);
        publish({ phase: 'idle' });
        return;
      }
      const { assembly, displayName } = ctx.catalog;
      const chromosome: Chromosome = {
        id: assembly.accession,
        displayName,
        length: assembly.lengthBp,
        cytobands: [],
      };
      renderer.setChromosome(chromosome);

      let registeredTypes: ReadonlySet<string>;
      try {
        registeredTypes = registerCatalogTrackRenderers(renderer);
      } catch (error) {
        clearTracks(renderer);
        publish({
          phase: 'error',
          message: "Couldn't load the track drawings.",
          detail: errorMessage(error),
        });
        return;
      }

      publish(
        { phase: 'active' },
        new Map(visible.map((track) => [track.id, { status: 'loading' } as const]))
      );

      void resolveAnnotationTracks({
        layout: activeLayout,
        sources: ctx.catalog.sources,
        visualizations: ctx.catalog.visualizations,
        cache: ctx.cache,
      })
        .then((resolved) => {
          if (cancelled || mapRef.current?.getLinearRenderer?.() !== renderer) return;
          const order = new Map(activeLayout.tracks.map((track, index) => [track.id, index]));
          const states = new Map<TrackBindingId, AnnotationTrackDrawState>();
          const instances: Track[] = [];
          const payloads: [string, AnnotationCatalogTrackData][] = [];
          const hoverTracks: HoverableCatalogTrack[] = [];

          for (const track of resolved) {
            const { binding, source, state } = track;
            if (state.status === 'error') {
              states.set(binding.id, {
                status: 'error',
                message: "Couldn't load this source.",
                detail: state.message,
              });
              continue;
            }
            const type = annotationCatalogTrackType(binding.visualizationId);
            if (!registeredTypes.has(type)) {
              states.set(binding.id, {
                status: 'error',
                message: `${track.visualization.label} can't be drawn yet.`,
                detail: null,
              });
              continue;
            }
            const key = `${binding.sourceId}|${binding.kind}|${binding.filter.minScore ?? ''}`;
            let published = ctx.published.get(key);
            if (!published) {
              const records = sortRecordsBySpanStart(state.records);
              published = {
                data: {
                  kind: binding.kind,
                  records,
                  evidence: source.evidence,
                  genomeLengthBp: assembly.lengthBp,
                  genesByName:
                    binding.kind === 'transcription_unit' ? ctx.genesByName : EMPTY_GENES,
                },
                indexByStrand: buildStrandHoverIndexes(records),
              };
              ctx.published.set(key, published);
            }
            const trackId = `${binding.id}:${binding.visualizationId}`;
            const { presentation } = binding;
            instances.push({
              id: trackId,
              type,
              order: order.get(binding.id) ?? instances.length,
              visible: true,
              assemblyId: assembly.accession,
              zone: 'below-legacy',
              sizing: TRACK_SIZING,
              label: binding.label ?? FEATURE_KIND_LABELS[binding.kind],
              ...(presentation.color !== null ? { color: presentation.color } : {}),
              ...(presentation.rowHeightPx !== null
                ? { rowHeightPx: presentation.rowHeightPx }
                : {}),
              ...(presentation.maxRows !== null ? { maxRows: presentation.maxRows } : {}),
            });
            payloads.push([trackId, published.data]);
            states.set(binding.id, {
              status: 'ready',
              recordCount: state.records.length,
              totalBeforeFilter: state.totalBeforeFilter,
            });
            hoverTracks.push({
              trackId,
              bindingId: binding.id,
              kind: binding.kind,
              sourceLabel: source.label,
              evidence: source.evidence,
              licenseSpdx: source.provenance.license.spdx,
              attribution: source.provenance.license.attribution,
              indexByStrand: published.indexByStrand,
            });
          }

          renderer.setTrackInstances(instances);
          if (instances.length > 0) wiredRenderers.add(renderer);
          else wiredRenderers.delete(renderer);
          for (const [trackId, data] of payloads) renderer.setTrackData(trackId, data);
          mapRef.current?.requestRender?.();
          publish({ phase: 'active' }, states, hoverTracks);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          publish({
            phase: 'error',
            message: "Couldn't draw the annotation tracks.",
            detail: errorMessage(error),
          });
        });
    };

    const attempt = () => {
      rafId = 0;
      if (cancelled) return;
      const renderer = mapRef.current?.getLinearRenderer?.() ?? null;
      if (!context) {
        clearTracks(renderer);
        if (ownerTabId) clearAnnotationCatalogWiring(ownerTabId);
        return;
      }
      if (viewTransformed) {
        clearTracks(renderer);
        publish({ phase: 'view-transformed' });
        return;
      }
      if (mapCircular) {
        clearTracks(renderer);
        publish({ phase: 'map-circular' });
        return;
      }
      if (!renderer) {
        if (!waitingPublished) publish({ phase: 'waiting-for-map' });
        waitingPublished = true;
        if (framesLeft > 0) {
          framesLeft -= 1;
          rafId = requestAnimationFrame(attempt);
        }
        return;
      }
      wire(renderer, context);
    };

    attempt();
    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [context, layoutKey, mapCircular, mapRef, ownerTabId, rendererReadyEpoch, viewTransformed]);

  useEffect(() => {
    if (!ownerTabId) return;
    return () => clearAnnotationCatalogWiring(ownerTabId);
  }, [ownerTabId]);

  return useMemo(
    () =>
      ownerTabId && context
        ? { ownerTabId, assemblyAccession: context.catalog.assembly.accession }
        : null,
    [context, ownerTabId]
  );
}
