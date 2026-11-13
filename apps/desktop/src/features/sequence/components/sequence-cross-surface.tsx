import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ParsedPlasmid, WebGLMapHandle } from '@waypoint/plasmid-viewer';
import {
  CdsExtensionHoverProvider,
  HoveredAnnotationProvider,
  HoveredCodonProvider,
  ResidueSelectionsProvider,
  useCreateCdsExtensionHoverStore,
  useCreateHoveredAnnotationStore,
  useCreateHoveredCodonStore,
  useCreateResidueSelectionsStore,
  type CdsExtensionHoverStore,
  type HoveredAnnotationStore,
  type HoveredCodonKey,
  type HoveredCodonStore,
  type ResidueSelectionsStore,
} from '@waypoint/workspace-editor';
import {
  HoveredResidueProvider,
  useCreateHoveredResidueStore,
  type HoveredResidueStore,
} from '../../structure-drawer/public/state/hovered-residue-store';
import { useResolvedHover } from '../../structure-drawer/public/hooks/useResolvedHover';
import { useSequenceCodonResidueBridge } from '../../structure-drawer/public/hooks/useSequenceCodonResidueBridge';
import { useProteinSequenceWebGLOverlaySync } from '../../structure-drawer/public/hooks/useProteinSequenceWebGLOverlaySync';
import { registerWorkspaceResidueStore } from '../../structure-drawer/public/state/hovered-residue-registry';
import { registerWorkspaceCodonStore } from '../../structure-drawer/public/state/hovered-codon-registry';
import { registerWorkspaceResidueSelectionsStore } from '../../structure-drawer/public/state/selected-codon-registry';
import {
  buildHoveredAnnotationFeatureIndex,
  createDeferredWebGLHoverSync,
  hoveredAnnotationKeyFromFeature,
  resolveHoveredFeatureId,
} from './webgl-hover-sync';

type MinimapOverlayHandle = WebGLMapHandle;

export interface SequenceCrossSurfaceState {
  stores: SequenceCrossSurfaceStores;
  residueLinkRangeForWebGL: [number, number] | null;
  externalHoveredFeatureId: number | null;
  syncWebGLTarget: (target: MinimapOverlayHandle | null) => void;
  handleWebGLCodonHover: (codon: Omit<HoveredCodonKey, 'source'> | null) => void;
  handleWebGLFeatureHover: (featureId: number | null) => void;
}

export interface SequenceCrossSurfaceStores {
  hoveredAnnotationStore: HoveredAnnotationStore;
  hoveredCodonStore: HoveredCodonStore;
  residueSelectionsStore: ResidueSelectionsStore;
  hoveredResidueStore: HoveredResidueStore;
  cdsExtensionHoverStore: CdsExtensionHoverStore;
}

export function useSequenceCrossSurfaceState({
  entityId,
  webglPlasmid,
  minimapRef,
  webglEnabled,
}: {
  entityId?: string;
  webglPlasmid: ParsedPlasmid;
  minimapRef: RefObject<MinimapOverlayHandle | null>;
  webglEnabled: boolean;
}): SequenceCrossSurfaceState {
  const hoveredAnnotationStore = useCreateHoveredAnnotationStore();
  const webglHoverSync = useMemo(
    () => createDeferredWebGLHoverSync(hoveredAnnotationStore),
    [hoveredAnnotationStore]
  );
  useEffect(() => () => webglHoverSync.dispose(), [webglHoverSync]);

  const hoveredCodonStore = useCreateHoveredCodonStore();
  const residueSelectionsStore = useCreateResidueSelectionsStore();
  const hoveredResidueStore = useCreateHoveredResidueStore();
  const cdsExtensionHoverStore = useCreateCdsExtensionHoverStore();

  useEffect(() => {
    if (!entityId) return;
    return registerWorkspaceResidueStore(entityId, hoveredResidueStore);
  }, [entityId, hoveredResidueStore]);

  useEffect(() => {
    if (!entityId) return;
    return registerWorkspaceCodonStore(entityId, hoveredCodonStore);
  }, [entityId, hoveredCodonStore]);

  useEffect(() => {
    if (!entityId) return;
    return registerWorkspaceResidueSelectionsStore(entityId, residueSelectionsStore);
  }, [entityId, residueSelectionsStore]);

  const residueResolvedHover = useResolvedHover(entityId ?? null, hoveredResidueStore);
  const residueLinkRangeForWebGL = useMemo<[number, number] | null>(() => {
    if (!residueResolvedHover) return null;
    return [residueResolvedHover.bpRange.start, residueResolvedHover.bpRange.end];
  }, [residueResolvedHover]);

  const syncWebGLTarget = useProteinSequenceWebGLOverlaySync({
    entityId,
    hoveredCodonStore,
    residueSelectionsStore,
    hoveredResidueStore,
    targetRef: minimapRef,
    enabled: webglEnabled,
  });

  const lastWebGLLocalCodonRef = useRef<Omit<HoveredCodonKey, 'source'> | null>(null);
  const handleWebGLCodonHover = useCallback(
    (codon: Omit<HoveredCodonKey, 'source'> | null) => {
      if (codon) {
        lastWebGLLocalCodonRef.current = codon;
        hoveredCodonStore.set({ ...codon, source: 'sequence' });
        return;
      }
      const prev = hoveredCodonStore.getSnapshot();
      const lastLocal = lastWebGLLocalCodonRef.current;
      lastWebGLLocalCodonRef.current = null;
      if (
        prev?.source === 'sequence' &&
        lastLocal &&
        prev.start === lastLocal.start &&
        prev.end === lastLocal.end &&
        prev.strand === lastLocal.strand
      ) {
        hoveredCodonStore.set(null);
        return;
      }
      minimapRef.current?.setHoveredCodon?.(
        prev ? { start: prev.start, end: prev.end, strand: prev.strand } : null
      );
    },
    [hoveredCodonStore, minimapRef]
  );

  useSequenceCodonResidueBridge({
    entityId,
    hoveredCodonStore,
    hoveredResidueStore,
  });

  const handleWebGLFeatureHover = useCallback(
    (featureId: number | null) => {
      if (featureId === null) {
        webglHoverSync.schedule(null);
        return;
      }
      const feature = webglPlasmid.features[featureId];
      if (!feature) {
        webglHoverSync.schedule(null);
        return;
      }
      webglHoverSync.schedule(hoveredAnnotationKeyFromFeature(feature));
    },
    [webglHoverSync, webglPlasmid.features]
  );

  const hoveredAnnotationFromStore = useSyncExternalStore(
    hoveredAnnotationStore.subscribe,
    hoveredAnnotationStore.getSnapshot
  );
  const hoveredAnnotationFeatureIndex = useMemo(
    () => buildHoveredAnnotationFeatureIndex(webglPlasmid.features),
    [webglPlasmid.features]
  );
  const externalHoveredFeatureId = useMemo<number | null>(() => {
    return resolveHoveredFeatureId(hoveredAnnotationFeatureIndex, hoveredAnnotationFromStore);
  }, [hoveredAnnotationFeatureIndex, hoveredAnnotationFromStore]);

  const stores = useMemo(
    () => ({
      hoveredAnnotationStore,
      hoveredCodonStore,
      residueSelectionsStore,
      hoveredResidueStore,
      cdsExtensionHoverStore,
    }),
    [
      cdsExtensionHoverStore,
      hoveredAnnotationStore,
      hoveredCodonStore,
      hoveredResidueStore,
      residueSelectionsStore,
    ]
  );

  return {
    stores,
    residueLinkRangeForWebGL,
    externalHoveredFeatureId,
    syncWebGLTarget,
    handleWebGLCodonHover,
    handleWebGLFeatureHover,
  };
}

export function SequenceCrossSurfaceProviders({
  stores,
  children,
}: {
  stores: SequenceCrossSurfaceStores;
  children: ReactNode;
}) {
  return (
    <HoveredAnnotationProvider value={stores.hoveredAnnotationStore}>
      <HoveredCodonProvider value={stores.hoveredCodonStore}>
        <ResidueSelectionsProvider value={stores.residueSelectionsStore}>
          <HoveredResidueProvider value={stores.hoveredResidueStore}>
            <CdsExtensionHoverProvider value={stores.cdsExtensionHoverStore}>
              {children}
            </CdsExtensionHoverProvider>
          </HoveredResidueProvider>
        </ResidueSelectionsProvider>
      </HoveredCodonProvider>
    </HoveredAnnotationProvider>
  );
}
