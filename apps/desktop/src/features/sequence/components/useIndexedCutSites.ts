import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CutSite } from '@waypoint/genome-renderer';
import { useCutSites } from '@waypoint/workspace-editor';

import {
  formatIndexedScanWindow,
  planIndexedCutSiteWindow,
  type IndexedChromosomeSpan,
  type IndexedScanWindow,
} from './indexed-cut-site-window';
import { toWebGLCutSite } from './useSequenceCutSitesView';

const NO_CUT_SITES: CutSite[] = [];

const CAMERA_SAMPLE_INTERVAL_MS = 50;

interface LoadedWindow {
  readonly window: IndexedScanWindow;
  readonly bases: string;
}

export type IndexedCutSiteAvailability =
  | { readonly kind: 'ready'; readonly scopeLabel: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'zoomed-out'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'error'; readonly reason: string };

export function useIndexedCutSites({
  drawerOpen,
  viewport,
  viewerWidthPx,
  chromosomes,
  readSequence,
  scopeKey,
}: {
  drawerOpen: boolean;
  viewport: Readonly<{ start: number; end: number }> | null;
  viewerWidthPx: number;
  chromosomes: ReadonlyArray<IndexedChromosomeSpan>;
  readSequence: (chrom: string, start0: number, end0: number) => Promise<string>;
  scopeKey: string;
}) {
  const [loaded, setLoaded] = useState<LoadedWindow | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const readSequenceRef = useRef(readSequence);
  readSequenceRef.current = readSequence;
  const requestIdRef = useRef(0);
  const readInFlightRef = useRef(false);

  const [cutSitesState, cutSitesActions] = useCutSites(loaded?.bases ?? '', scopeKey, {
    circular: false,
    catalogSummaryEnabled: drawerOpen,
    scanDebounceMs: 0,
  });
  const enabled = drawerOpen || (cutSitesState.isVisible && cutSitesState.activeEnzymes.length > 0);

  const plan = useMemo(
    () =>
      planIndexedCutSiteWindow({
        viewport,
        viewerWidthPx,
        chromosomes,
        current: loaded?.window ?? null,
      }),
    [viewport, viewerWidthPx, chromosomes, loaded]
  );

  const latestViewportRef = useRef(viewport);
  const lastCommittedViewportRef = useRef(viewport);
  if (viewport !== lastCommittedViewportRef.current) {
    lastCommittedViewportRef.current = viewport;
    latestViewportRef.current = viewport;
  }
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const planInputsRef = useRef({ viewerWidthPx, chromosomes, enabled });
  planInputsRef.current = { viewerWidthPx, chromosomes, enabled };

  const maybeLoad = useCallback(() => {
    const inputs = planInputsRef.current;
    if (!inputs.enabled || readInFlightRef.current) return;
    const next = planIndexedCutSiteWindow({
      viewport: latestViewportRef.current,
      viewerWidthPx: inputs.viewerWidthPx,
      chromosomes: inputs.chromosomes,
      current: loadedRef.current?.window ?? null,
    });
    if (next.action !== 'load' || !next.window) return;
    const target = next.window;
    const requestId = ++requestIdRef.current;
    readInFlightRef.current = true;
    readSequenceRef
      .current(target.chrom, target.start0, target.end0)
      .then((bases) => {
        if (requestId !== requestIdRef.current) return;
        setLoaded({ window: target, bases: bases.toUpperCase() });
        setReadError(null);
      })
      .catch((error: unknown) => {
        if (requestId !== requestIdRef.current) return;
        setReadError(toUserMessage(error, 'failure.could-not-read-the-reference'));
      })
      .finally(() => {
        if (requestId === requestIdRef.current) readInFlightRef.current = false;
      });
  }, []);

  useEffect(() => {
    if (enabled) {
      maybeLoad();
      return;
    }
    requestIdRef.current += 1;
    readInFlightRef.current = false;
    setLoaded(null);
  }, [enabled, viewport, viewerWidthPx, chromosomes, loaded, maybeLoad]);

  const lastSampleAtRef = useRef(0);
  const onCameraSample = useCallback(
    (range: Readonly<{ start: number; end: number }>) => {
      latestViewportRef.current = range;
      const now = performance.now();
      if (now - lastSampleAtRef.current < CAMERA_SAMPLE_INTERVAL_MS) return;
      lastSampleAtRef.current = now;
      maybeLoad();
    },
    [maybeLoad]
  );

  const currentSites = useMemo<CutSite[]>(() => {
    if (!loaded) return NO_CUT_SITES;
    const offset = loaded.window.chromGlobalStart + loaded.window.start0;
    const shift = (site: CutSite): CutSite => ({
      ...site,
      position: site.position + offset,
      cutPositionTop: site.cutPositionTop + offset,
      cutPositionBottom: site.cutPositionBottom + offset,
      recognitionEnd: site.recognitionEnd + offset,
    });
    return [
      ...cutSitesState.cutSites.map((site) => shift(toWebGLCutSite(site))),
      ...cutSitesState.scannedCutSites.map((site) => shift(toWebGLCutSite(site, true))),
    ];
  }, [loaded, cutSitesState.cutSites, cutSitesState.scannedCutSites]);

  const windowKey = loaded ? formatIndexedScanWindow(loaded.window) : '';
  const lastGoodRef = useRef<{ windowKey: string; sites: CutSite[] }>({
    windowKey: '',
    sites: NO_CUT_SITES,
  });
  const webglCutSites = useMemo<CutSite[]>(() => {
    if (!cutSitesState.isVisible || !enabled) return NO_CUT_SITES;
    const lastGood = lastGoodRef.current;
    if (cutSitesState.scanSettled || lastGood.windowKey === windowKey) {
      lastGoodRef.current = { windowKey, sites: currentSites };
      return currentSites;
    }
    return lastGood.sites;
  }, [cutSitesState.isVisible, cutSitesState.scanSettled, enabled, windowKey, currentSites]);

  const availability = useMemo<IndexedCutSiteAvailability>(() => {
    if (plan.unavailable) {
      return { kind: 'unavailable', reason: 'Restriction sites appear once the view is ready' };
    }
    if (!plan.showable) {
      return {
        kind: 'zoomed-out',
        reason: `Zoom in to ${plan.maxViewBp.toLocaleString()} bp or less to see restriction sites`,
      };
    }
    if (readError) return { kind: 'error', reason: readError };
    if (!loaded) return { kind: 'loading' };
    return { kind: 'ready', scopeLabel: formatIndexedScanWindow(loaded.window) };
  }, [plan, readError, loaded]);

  return {
    cutSitesState,
    cutSitesActions,
    webglCutSites,
    availability,
    scannedBases: loaded?.bases ?? '',
    scannedWindow: loaded?.window ?? null,
    onCameraSample,
  };
}
