/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { WebGLMapHandle } from '@waypoint/plasmid-viewer';
import { useWebglCameraZoomState } from './useWebglCameraZoomState';

describe('useWebglCameraZoomState', () => {
  it('updates camera limits from presented geometry after late renderer readiness', () => {
    let publishBounds: ((bounds: { min: number; max: number }) => void) | undefined;
    const unsubscribe = vi.fn();
    const minimapRef = createRef<WebGLMapHandle | null>();
    const { result, rerender, unmount } = renderHook(
      ({ rendererReadyEpoch, viewportScopeKey }) =>
        useWebglCameraZoomState({
          minimapRef,
          persistedZoom: 1,
          viewportScopeKey,
          rendererReadyEpoch,
        }),
      { initialProps: { rendererReadyEpoch: 0, viewportScopeKey: 'seq-a' } }
    );
    minimapRef.current = {
      setViewport: vi.fn(),
      setSelection: vi.fn(),
      requestRender: vi.fn(),
      getCameraZoomBounds: () => ({ min: 0.05, max: 299 }),
      subscribeToCameraZoomBounds: (listener) => {
        publishBounds = listener;
        return unsubscribe;
      },
    };
    rerender({ rendererReadyEpoch: 1, viewportScopeKey: 'seq-a' });
    expect(publishBounds).toBeTypeOf('function');
    act(() => publishBounds!({ min: 0.2, max: 299 }));
    expect(result.current.webglCameraZoomBounds).toEqual({ min: 0.2, max: 299 });
    act(() => publishBounds!({ min: 0.2005, max: 299 }));
    expect(result.current.webglCameraZoomBounds).toEqual({ min: 0.2005, max: 299 });
    const retiredPublication = publishBounds!;
    minimapRef.current = null;
    rerender({ rendererReadyEpoch: 0, viewportScopeKey: 'seq-b' });
    expect(unsubscribe).toHaveBeenCalledOnce();
    const currentBounds = result.current.webglCameraZoomBounds;
    act(() => retiredPublication({ min: 5, max: 50 }));
    expect(result.current.webglCameraZoomBounds).toEqual(currentBounds);
    unmount();
  });

  it.each(['wheel', 'control'] as const)(
    'keeps live %s zoom authoritative over delayed saved values',
    (route) => {
      vi.useFakeTimers();
      try {
        const minimapRef = createRef<WebGLMapHandle | null>();
        const { result, rerender, unmount } = renderHook(
          ({ persistedZoom, viewportScopeKey }) =>
            useWebglCameraZoomState({ minimapRef, persistedZoom, viewportScopeKey }),
          { initialProps: { persistedZoom: 1, viewportScopeKey: 'seq-a' } }
        );
        act(() => {
          if (route === 'wheel') result.current.scheduleWebglCameraZoomStateSync(20);
          else result.current.commitWebglCameraZoomState(20);
        });
        rerender({ persistedZoom: 15, viewportScopeKey: 'seq-a' });
        expect(result.current.webglCameraZoomSource.getSnapshot()).toBe(20);
        act(() => vi.advanceTimersByTime(200));
        expect(result.current.webglCameraZoom).toBe(20);
        rerender({ persistedZoom: 18, viewportScopeKey: 'seq-a' });
        expect(result.current.webglCameraZoomSource.getSnapshot()).toBe(20);
        rerender({ persistedZoom: 3, viewportScopeKey: 'seq-b' });
        expect(result.current.webglCameraZoomSource.getSnapshot()).toBe(3);
        expect(result.current.webglCameraZoom).toBe(3);
        unmount();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('clamps an extreme persisted zoom to the renderer bounds on commit', () => {
    const minimapRef = createRef<WebGLMapHandle | null>();
    minimapRef.current = {
      getCameraZoomBounds: () => ({ min: 0.5, max: 185 }),
    } as WebGLMapHandle;

    const { result } = renderHook(() =>
      useWebglCameraZoomState({
        minimapRef,
        persistedZoom: 5000,
        viewportScopeKey: 'seq-a',
      })
    );

    act(() => {
      result.current.commitWebglCameraZoomState(5000);
    });

    expect(result.current.webglCameraZoom).toBe(185);
    expect(result.current.webglCameraZoomBounds).toEqual({ min: 0.5, max: 185 });
  });

  it('ignores non-finite scheduled zooms', () => {
    const minimapRef = createRef<WebGLMapHandle | null>();
    const { result } = renderHook(() =>
      useWebglCameraZoomState({
        minimapRef,
        persistedZoom: 1,
        viewportScopeKey: 'seq-a',
      })
    );
    const before = result.current.webglCameraZoom;
    act(() => {
      result.current.scheduleWebglCameraZoomStateSync(Number.NaN);
    });
    expect(result.current.webglCameraZoom).toBe(before);
  });
});
