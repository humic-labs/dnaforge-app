import { act, renderHook } from '@testing-library/react';
import { useLayoutEffect, type RefObject } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import { useLaneScreenBands } from './useLaneScreenBands';

describe('useLaneScreenBands', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the presented renderer projection used to align the lane gutter', () => {
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
    const listeners = new Set<() => void>();
    const unsubscribe = vi.fn();
    const requestRender = vi.fn();
    const webglRef = {
      current: {
        requestRender,
        subscribeToPresentedFrames: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            unsubscribe();
          };
        },
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
    expect(getLaneScreenSnapshot).toHaveBeenCalledTimes(1);
    expect(requestRender).toHaveBeenCalledOnce();
    act(() => {
      for (const listener of listeners) listener();
    });
    expect(getLaneScreenSnapshot).toHaveBeenCalledTimes(2);
    expect(getRendererDebugSnapshot).not.toHaveBeenCalled();

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });
});

describe('useLaneScreenBands lifecycle publication', () => {
  it('keeps changed presented bands current without flushing inside a React layout lifecycle', () => {
    const snapshot = {
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
        annotationSearchFocusResolvedCanonicalIdentity: 'fixture-canonical-initial',
        annotationSearchFocusPresentationLane: 3,
      },
    };
    const getLaneScreenSnapshot = vi.fn(() => snapshot);
    const getRendererDebugSnapshot = vi.fn(() => {
      throw new Error('the DOM gutter must not materialize the forensic renderer snapshot');
    });
    const listeners = new Set<() => void>();
    const unsubscribe = vi.fn();
    const requestRender = vi.fn();
    const webglRef = {
      current: {
        requestRender,
        subscribeToPresentedFrames: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            unsubscribe();
          };
        },
        getLinearRenderer: () => ({ getLaneScreenSnapshot, getRendererDebugSnapshot }),
      },
    } as unknown as RefObject<IndexedGenomeTileNativeMapHandle | null>;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lifecycleWarnings = () =>
      consoleError.mock.calls.filter((args) =>
        args.some(
          (value) =>
            typeof value === 'string' &&
            value.includes('flushSync was called from inside a lifecycle method')
        )
      );
    let unmount: (() => void) | undefined;
    try {
      const hook = renderHook(
        ({ publishFromLayout }) => {
          const bands = useLaneScreenBands(webglRef);
          useLayoutEffect(() => {
            if (publishFromLayout) {
              for (const listener of listeners) listener();
            }
          }, [publishFromLayout]);
          return bands;
        },
        { initialProps: { publishFromLayout: false } }
      );
      unmount = hook.unmount;
      expect(listeners.size).toBe(1);
      expect(requestRender).toHaveBeenCalledOnce();
      expect(hook.result.current.dataBounds.pileup).toEqual({ topPx: 120, heightPx: 80 });
      expect(hook.result.current.annotationSearchFocusPresentation).toEqual({
        trackId: 'mRNA',
        canonicalIdentity: 'fixture-canonical-initial',
        lane: 3,
      });

      snapshot.trackScreenBounds.pileup = {
        topPx: 130,
        heightPx: 90,
        scrollsVertically: true,
      };
      snapshot.annotationOverlay.annotationSearchFocusResolvedCanonicalIdentity =
        'fixture-canonical-outside';
      snapshot.annotationOverlay.annotationSearchFocusPresentationLane = 4;
      act(() => {
        for (const listener of listeners) listener();
      });
      expect(hook.result.current.dataBounds.pileup).toEqual({ topPx: 130, heightPx: 90 });
      expect(hook.result.current.annotationSearchFocusPresentation).toEqual({
        trackId: 'mRNA',
        canonicalIdentity: 'fixture-canonical-outside',
        lane: 4,
      });
      expect(getLaneScreenSnapshot).toHaveBeenCalledTimes(2);
      expect(lifecycleWarnings()).toEqual([]);

      snapshot.trackScreenBounds.pileup = {
        topPx: 140,
        heightPx: 100,
        scrollsVertically: true,
      };
      snapshot.annotationOverlay.annotationSearchFocusResolvedCanonicalIdentity =
        'fixture-canonical-layout';
      snapshot.annotationOverlay.annotationSearchFocusPresentationLane = 5;
      hook.rerender({ publishFromLayout: true });
      expect(hook.result.current.dataBounds.pileup).toEqual({ topPx: 140, heightPx: 100 });
      expect(hook.result.current.annotationSearchFocusPresentation).toEqual({
        trackId: 'mRNA',
        canonicalIdentity: 'fixture-canonical-layout',
        lane: 5,
      });
      expect(hook.result.current.reference).toEqual({ topPx: 20, heightPx: 100 });
      expect(getLaneScreenSnapshot).toHaveBeenCalledTimes(3);
      expect(getRendererDebugSnapshot).not.toHaveBeenCalled();
      expect(requestRender).toHaveBeenCalledOnce();
      expect(lifecycleWarnings()).toEqual([]);
    } finally {
      unmount?.();
      consoleError.mockRestore();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });
});
