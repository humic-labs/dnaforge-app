import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import { useLaneScreenBands } from './useLaneScreenBands';

describe('useLaneScreenBands', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls the renderer projection used to align the lane gutter', () => {
    vi.useFakeTimers();
    const getLaneScreenSnapshot = vi.fn(() => ({
      overlayLayout: {
        offset: 20,
        totalHeight: 100,
        annotationHeight: 40,
        fwdStrandTop: 60,
        revStrandBottom: 100,
        trackScrollTop: 0,
      },
      trackScreenBounds: {
        pileup: { topPx: 120, heightPx: 80, scrollsVertically: true },
      },
      annotationOverlay: {
        annotationSearchFocusResolvedTrackId: 'mRNA',
        annotationSearchFocusResolvedCanonicalIdentity: 'ENST00000456328.2',
        annotationSearchFocusPresentationLane: 3,
      },
    }));
    const getRendererDebugSnapshot = vi.fn(() => {
      throw new Error('the DOM gutter must not materialize the forensic renderer snapshot');
    });
    const webglRef = {
      current: {
        getLinearRenderer: () => ({
          getLaneScreenSnapshot,
          getRendererDebugSnapshot,
        }),
      },
    } as unknown as RefObject<IndexedGenomeTileNativeMapHandle | null>;

    const { result, unmount } = renderHook(() => useLaneScreenBands(webglRef));

    expect(result.current.reference).toEqual({ topPx: 20, heightPx: 100 });
    expect(result.current.dataBounds.pileup).toEqual({ topPx: 120, heightPx: 80 });
    expect(result.current.annotationSearchFocusPresentation).toEqual({
      trackId: 'mRNA',
      canonicalIdentity: 'ENST00000456328.2',
      lane: 3,
    });
    expect(getLaneScreenSnapshot).toHaveBeenCalledTimes(1);
    expect(getRendererDebugSnapshot).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(getLaneScreenSnapshot).toHaveBeenCalledTimes(2);
    expect(getRendererDebugSnapshot).not.toHaveBeenCalled();

    unmount();
  });
});
