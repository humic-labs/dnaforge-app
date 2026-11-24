import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import { applyPresentedTrackScrollReceipt } from './TrackGutter';

export function useTrackGutterScroll(
  webglRef: RefObject<IndexedGenomeTileNativeMapHandle | null>,
  rendererEpoch = 0
) {
  const gutterScrollLayerRef = useRef<HTMLDivElement | null>(null);
  const lastAppliedScrollRef = useRef<{
    target: HTMLDivElement;
    trackScrollTop: number;
  } | null>(null);
  const setGutterScrollLayer = useCallback(
    (target: HTMLDivElement | null) => {
      gutterScrollLayerRef.current = target;
      const receipt = webglRef.current?.getLinearRenderer?.()?.getPresentedTrackScrollReceipt?.();
      if (!target || !receipt) return;
      applyPresentedTrackScrollReceipt(target, receipt);
      lastAppliedScrollRef.current = { target, trackScrollTop: receipt.trackScrollTop };
    },
    [webglRef]
  );
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let retryFrame: number | null = null;
    let disposed = false;

    const syncPresentedScroll = () => {
      const target = gutterScrollLayerRef.current;
      const receipt = webglRef.current?.getLinearRenderer?.()?.getPresentedTrackScrollReceipt?.();
      const applied = lastAppliedScrollRef.current;
      if (
        !target ||
        !receipt ||
        (applied?.target === target && applied.trackScrollTop === receipt.trackScrollTop)
      ) {
        return;
      }
      applyPresentedTrackScrollReceipt(target, receipt);
      lastAppliedScrollRef.current = { target, trackScrollTop: receipt.trackScrollTop };
    };
    const attach = () => {
      if (disposed) return;
      const map = webglRef.current;
      if (!map) {
        retryFrame = requestAnimationFrame(attach);
        return;
      }
      syncPresentedScroll();
      unsubscribe = map.subscribeToPresentedFrames(syncPresentedScroll);
      map.requestRender();
    };
    attach();
    return () => {
      disposed = true;
      if (retryFrame !== null) cancelAnimationFrame(retryFrame);
      unsubscribe?.();
    };
  }, [webglRef, rendererEpoch]);
  return setGutterScrollLayer;
}
