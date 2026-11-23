import { useEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';

import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import { normalizeLaneScreenBands, type LaneScreenBands } from './lane-screen-bands';

const EMPTY: LaneScreenBands = { dataBounds: {} };

function bandKey(v?: { topPx: number; heightPx: number }): string {
  return v ? `${Math.round(v.topPx)}:${Math.round(v.heightPx)}` : '-';
}

function bandsKey(b: LaneScreenBands): string {
  const data = Object.entries(b.dataBounds)
    .map(([id, v]) => `${id}=${bandKey(v)}`)
    .sort()
    .join(',');
  const focus = b.annotationSearchFocusPresentation;
  const focusKey = focus ? `${focus.trackId}:${focus.canonicalIdentity}:${focus.lane}` : '-';
  return `r${bandKey(b.reference)}|a${bandKey(b.annotation)}|s${bandKey(b.sequence)}|f${focusKey}|${data}`;
}

export function useLaneScreenBands(
  webglRef: RefObject<IndexedGenomeTileNativeMapHandle | null>
): LaneScreenBands {
  const [bands, setBands] = useState<LaneScreenBands>(EMPTY);
  const lastKeyRef = useRef<string>('');

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let retryFrame: number | null = null;
    let disposed = false;
    const read = (presented = false) => {
      if (disposed) return;
      const renderer = webglRef.current?.getLinearRenderer?.();
      const snap = renderer?.getLaneScreenSnapshot?.();
      const next = snap ? normalizeLaneScreenBands(snap) : EMPTY;
      const key = bandsKey(next);
      if (key !== lastKeyRef.current) {
        lastKeyRef.current = key;
        if (presented) flushSync(() => setBands(next));
        else setBands(next);
      }
    };
    const attach = () => {
      if (disposed) return;
      const map = webglRef.current;
      if (!map) {
        retryFrame = requestAnimationFrame(attach);
        return;
      }
      read();
      unsubscribe = map.subscribeToPresentedFrames(() => read(true));
      map.requestRender();
    };
    attach();
    return () => {
      disposed = true;
      if (retryFrame !== null) cancelAnimationFrame(retryFrame);
      unsubscribe?.();
    };
  }, [webglRef]);

  return bands;
}
