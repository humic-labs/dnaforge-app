import { useEffect, useRef, useState, type RefObject } from 'react';

import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import { normalizeLaneScreenBands, type LaneScreenBands } from './lane-screen-bands';

const EMPTY: LaneScreenBands = { dataBounds: {} };

const POLL_MS = 200;

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
    const read = () => {
      const renderer = webglRef.current?.getLinearRenderer?.();
      const snap = renderer?.getLaneScreenSnapshot?.();
      const next = snap ? normalizeLaneScreenBands(snap) : EMPTY;
      const key = bandsKey(next);
      if (key !== lastKeyRef.current) {
        lastKeyRef.current = key;
        setBands(next);
      }
    };
    read();
    const id = setInterval(read, POLL_MS);
    return () => clearInterval(id);
  }, [webglRef]);

  return bands;
}
