/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import type { WebGLMapHandle } from '@waypoint/plasmid-viewer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SEQUENCE_VIEW_STATE } from '../../view-state/sequence-view-state';
import { useSequenceViewportSync } from '../useSequenceViewportSync';

function makeInput(overrides: Partial<Parameters<typeof useSequenceViewportSync>[0]> = {}) {
  return {
    sequenceLength: 20,
    sequenceViewportScopeKey: 'example.gb',
    circular: true,
    coordinateSpace: undefined,
    seqView: {
      ...DEFAULT_SEQUENCE_VIEW_STATE,
      centerBp: null,
      zoom: 125,
      webglZoom: null,
      webglCenterBp: null,
    },
    patchSeqView: vi.fn(),
    minimapRef: { current: null },
    webglEnabled: true,
    webglRendererReadyEpoch: 0,
    isWebglSyncLocked: true,
    scrollToPositionWithTimeoutRef: { current: vi.fn() },
    scrollActiveSequenceViewerToBiologicalPosition: vi.fn(),
    morphToCircleRef: { current: 0.4 },
    handleMorphToCircleChangeRef: { current: vi.fn() },
    minimapRawSizingRef: {
      current: { paneHeightRaw: 260, geometryHeightRaw: 190 },
    },
    setMinimapHeights: vi.fn(),
    lastSequenceNavigationRef: { current: null },
    ...overrides,
  };
}

describe('useSequenceViewportSync', () => {
  describe('layout changes preserve the last-focused pane', () => {
    const layouts = [
      { rendererVisibility: 'both', mapPlacement: 'left' },
      { rendererVisibility: 'both', mapPlacement: 'top' },
      { rendererVisibility: 'both', mapPlacement: 'bottom' },
      { rendererVisibility: 'sequence', mapPlacement: 'right' },
      { rendererVisibility: 'map', mapPlacement: 'right' },
    ] as const;

    it.each(layouts)(
      'hands off the last-focused pane to $rendererVisibility / $mapPlacement with scroll sync off',
      (nextLayout) => {
        for (const focusedPane of ['sequence', 'map'] as const) {
          const setViewCenter = vi.fn();
          const scrollToPosition = vi.fn();
          const focusedPaneRef = { current: focusedPane };
          const input = makeInput({
            sequenceLength: 10_000,
            circular: false,
            isWebglSyncLocked: false,
            seqView: {
              ...DEFAULT_SEQUENCE_VIEW_STATE,
              centerBp: 2001,
              webglCenterBp: 8001,
              webglZoom: 5,
            },
            minimapRef: {
              current: {
                setViewport: vi.fn(),
                setViewCenter,
                setZoom: vi.fn(),
                getCameraCenter: () => 7000,
              } as unknown as WebGLMapHandle,
            },
            scrollToPositionWithTimeoutRef: { current: scrollToPosition },
          });
          const withLayout = (paneLayout: {
            rendererVisibility: 'sequence' | 'map' | 'both';
            mapPlacement: 'left' | 'right' | 'top' | 'bottom';
          }) => ({
            ...input,
            webglEnabled: paneLayout.rendererVisibility !== 'sequence',
            paneLayout,
            focusedPaneRef,
          });
          const { result, rerender, unmount } = renderHook(
            (paneLayout) => useSequenceViewportSync(withLayout(paneLayout)),
            {
              initialProps: {
                rendererVisibility: 'both' as 'sequence' | 'map' | 'both',
                mapPlacement: 'right' as 'left' | 'right' | 'top' | 'bottom',
              },
            }
          );
          act(() => vi.advanceTimersByTime(500));
          act(() =>
            result.current.handleViewportChange(
              { start: 2950, end: 3050, centerColumn: 3000 },
              'scroll'
            )
          );
          setViewCenter.mockClear();
          scrollToPosition.mockClear();

          rerender(nextLayout);

          act(() => result.current.handleViewportChange({ start: 0, end: 100 }, 'layout'));
          act(() => vi.advanceTimersByTime(500));

          const expectedCenter = focusedPane === 'sequence' ? 3001 : 7001;
          if (nextLayout.rendererVisibility !== 'map') {
            expect(scrollToPosition).toHaveBeenLastCalledWith(
              expectedCenter,
              expect.any(Function),
              { animate: false, completion: 'viewer' }
            );
          }
          if (nextLayout.rendererVisibility !== 'sequence') {
            expect(setViewCenter).toHaveBeenCalledTimes(1);
            expect(setViewCenter).toHaveBeenLastCalledWith(expectedCenter - 1);
          }
          expect(result.current.lastViewportCenterRef.current).toBe(expectedCenter);
          if (nextLayout.rendererVisibility === 'map') {
            act(() => result.current.handleViewportChange({ start: 0, end: 100 }, 'layout'));
            expect(result.current.lastViewportCenterRef.current).toBe(expectedCenter);
          }
          unmount();
        }
      }
    );

    it.each(['sequence', 'map'] as const)(
      'uses the outgoing %s-only pane even when the other pane held focus earlier',
      (visiblePane) => {
        const setViewCenter = vi.fn();
        const input = makeInput({
          sequenceLength: 10_000,
          isWebglSyncLocked: false,
          focusedPaneRef: {
            current: visiblePane === 'map' ? 'sequence' : 'map',
          },
          seqView: { centerBp: 3001, webglCenterBp: 7001, webglZoom: 5 },
          minimapRef: {
            current: {
              setViewport: vi.fn(),
              setViewCenter,
              setZoom: vi.fn(),
              getCameraCenter: () => 7000,
              getCameraZoom: () => 6,
            } as unknown as WebGLMapHandle,
          },
        });
        const { result, rerender } = renderHook(
          (rendererVisibility: 'sequence' | 'map' | 'both') =>
            useSequenceViewportSync({
              ...input,
              webglEnabled: rendererVisibility !== 'sequence',
              paneLayout: { rendererVisibility, mapPlacement: 'bottom' },
            }),
          { initialProps: visiblePane as 'sequence' | 'map' | 'both' }
        );
        act(() => vi.advanceTimersByTime(500));
        rerender('both');
        act(() => vi.advanceTimersByTime(500));
        const expectedCenter = visiblePane === 'map' ? 7001 : 3001;
        expect(setViewCenter).toHaveBeenLastCalledWith(expectedCenter - 1);
        expect(input.scrollToPositionWithTimeoutRef.current).toHaveBeenLastCalledWith(
          expectedCenter,
          expect.any(Function),
          {
            animate: false,
            completion: 'viewer',
          }
        );
        expect(input.patchSeqView).toHaveBeenLastCalledWith(
          {
            centerBp: expectedCenter,
            webglCenterBp: expectedCenter,
            webglZoom: 6,
          },
          { debounce: true }
        );

        const complete = vi
          .mocked(input.scrollToPositionWithTimeoutRef.current!)
          .mock.calls.at(-1)![1];
        act(() => complete?.());
        act(() =>
          result.current.handleViewportChange(
            { start: 3900, end: 4100, centerColumn: 4000 },
            'scroll'
          )
        );
        expect(result.current.lastViewportCenterRef.current).toBe(4001);
      }
    );

    it('restores center and zoom when the map attaches after the initial restore frames', () => {
      const minimapRef = { current: null as WebGLMapHandle | null };
      const input = makeInput({
        sequenceLength: 10_000,
        minimapRef,
        seqView: { centerBp: 3001, webglCenterBp: 7001, webglZoom: 5 },
      });
      const { result, rerender } = renderHook(
        (rendererVisibility: 'sequence' | 'both') =>
          useSequenceViewportSync({
            ...input,
            webglEnabled: rendererVisibility === 'both',
            paneLayout: { rendererVisibility, mapPlacement: 'right' },
          }),
        { initialProps: 'sequence' as 'sequence' | 'both' }
      );
      act(() => vi.advanceTimersByTime(500));
      rerender('both');
      act(() => vi.advanceTimersByTime(500));
      const setViewCenter = vi.fn();
      const setZoom = vi.fn();
      minimapRef.current = {
        setViewport: vi.fn(),
        setViewCenter,
        setZoom,
      } as unknown as WebGLMapHandle;
      act(() => result.current.syncViewportTarget(minimapRef.current));
      expect(setViewCenter).toHaveBeenCalledExactlyOnceWith(3000);
      expect(setZoom).toHaveBeenCalledExactlyOnceWith(5);

      setViewCenter.mockClear();
      setZoom.mockClear();
      act(() => result.current.syncViewportTarget(minimapRef.current));
      expect(setViewCenter).not.toHaveBeenCalled();
      expect(setZoom).not.toHaveBeenCalled();
    });

    it('does not hand the previous document camera to a different document', () => {
      const scrollToPosition = vi.fn();
      const input = makeInput({
        sequenceLength: 10_000,
        seqView: { centerBp: 3001, webglCenterBp: 7001, webglZoom: 5 },
        focusedPaneRef: { current: 'map' },
        scrollToPositionWithTimeoutRef: { current: scrollToPosition },
      });
      const { result, rerender } = renderHook(
        ({ scope, visibility, center }) =>
          useSequenceViewportSync({
            ...input,
            seqView: { ...input.seqView, centerBp: center },
            sequenceViewportScopeKey: scope,
            paneLayout: {
              rendererVisibility: visibility,
              mapPlacement: 'right',
            },
          }),
        {
          initialProps: {
            scope: 'first.gb',
            visibility: 'both' as 'both' | 'sequence',
            center: 3001,
          },
        }
      );
      act(() => vi.advanceTimersByTime(500));
      scrollToPosition.mockClear();
      rerender({ scope: 'second.gb', visibility: 'sequence', center: 101 });
      act(() => vi.advanceTimersByTime(500));
      expect(scrollToPosition).toHaveBeenCalledExactlyOnceWith(101, expect.any(Function), {
        animate: false,
      });
      expect(result.current.lastViewportCenterRef.current).toBe(101);
      expect(input.focusedPaneRef!.current).toBeNull();
    });
  });

  it('persists a changed center without repainting an unchanged passive viewport', () => {
    const setViewport = vi.fn();
    const input = makeInput({
      sequenceLength: 1000,
      circular: false,
      isWebglSyncLocked: false,
      minimapRef: {
        current: { setViewport } as unknown as WebGLMapHandle,
      },
    });
    const { result } = renderHook(() => useSequenceViewportSync(input));

    act(() =>
      result.current.handleViewportChange({ start: 100, end: 300, centerColumn: 150 }, 'scroll')
    );
    act(() =>
      result.current.handleViewportChange(
        { start: 100, end: 300, wraps: false, centerColumn: 190 },
        'scroll'
      )
    );
    expect(result.current.lastViewportCenterRef.current).toBe(191);
    act(() => vi.advanceTimersByTime(500));
    expect(input.patchSeqView).toHaveBeenLastCalledWith({ centerBp: 191 }, { debounce: true });
    expect(setViewport).toHaveBeenCalledExactlyOnceWith({
      start: 100,
      end: 300,
      centerColumn: 150,
    });

    act(() =>
      result.current.handleViewportChange(
        { start: 100, end: 300, wraps: true, centerColumn: 190 },
        'scroll'
      )
    );
    expect(setViewport).toHaveBeenCalledTimes(2);
    expect(setViewport).toHaveBeenLastCalledWith({
      start: 100,
      end: 300,
      wraps: true,
      centerColumn: 190,
    });
  });

  it('replays the restored Canvas range synchronously when a map target attaches, without another readiness event', () => {
    const minimapRef = { current: null as WebGLMapHandle | null };
    const { result } = renderHook(() =>
      useSequenceViewportSync(makeInput({ minimapRef, isWebglSyncLocked: false }))
    );
    act(() => result.current.handleViewportChange({ start: 0, end: 5 }, 'layout'));
    act(() => result.current.handleViewportChange({ start: 11, end: 18 }, 'layout'));
    const setViewport = vi.fn();
    const setViewCenter = vi.fn();
    const target = { setViewport, setViewCenter } as unknown as WebGLMapHandle;
    act(() => result.current.syncViewportTarget(target));
    expect(setViewport).toHaveBeenCalledExactlyOnceWith({ start: 11, end: 18 });
    expect(setViewCenter).not.toHaveBeenCalled();
    act(() => result.current.syncViewportTarget(null));
    expect(setViewport).toHaveBeenCalledTimes(1);
  });
  it('replays the Canvas range when an unsynced map mounts or changes renderer, without moving its camera', () => {
    const minimapRef = { current: null as WebGLMapHandle | null };
    const input = makeInput({
      minimapRef,
      isWebglSyncLocked: false,
      circular: false,
    });
    const { result, rerender } = renderHook(
      ({ epoch, scope }) =>
        useSequenceViewportSync({
          ...input,
          webglRendererReadyEpoch: epoch,
          sequenceViewportScopeKey: scope,
        }),
      { initialProps: { epoch: 0, scope: 'linear-fixture' } }
    );
    const range = { start: 0, end: 15 };
    act(() => result.current.handleViewportChange(range, 'layout'));
    const setViewport = vi.fn();
    const setViewCenter = vi.fn();
    const setZoom = vi.fn();
    minimapRef.current = {
      setViewport,
      setViewCenter,
      setZoom,
    } as unknown as WebGLMapHandle;
    rerender({ epoch: 1, scope: 'linear-fixture' });
    expect(setViewport).toHaveBeenLastCalledWith(range);
    setViewport.mockClear();
    rerender({ epoch: 2, scope: 'linear-fixture' });
    expect(setViewport).toHaveBeenLastCalledWith(range);
    expect(setViewCenter).not.toHaveBeenCalled();
    expect(setZoom).not.toHaveBeenCalled();
    setViewport.mockClear();
    rerender({ epoch: 3, scope: 'different-sequence' });
    expect(setViewport).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (window as unknown as { __test?: unknown }).__test;
  });

  it('restores a saved viewport center without animation and mirrors WebGL center', () => {
    const scrollToPosition = vi.fn();
    const setViewCenter = vi.fn();

    renderHook(() =>
      useSequenceViewportSync(
        makeInput({
          seqView: {
            ...DEFAULT_SEQUENCE_VIEW_STATE,
            centerBp: 7,
            zoom: 125,
            webglZoom: null,
            webglCenterBp: null,
          },
          scrollToPositionWithTimeoutRef: { current: scrollToPosition },
          minimapRef: {
            current: { setViewCenter } as unknown as WebGLMapHandle,
          },
        })
      )
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(scrollToPosition).toHaveBeenCalledWith(7, expect.any(Function), {
      animate: false,
    });
    expect(setViewCenter).toHaveBeenCalledWith(6);
  });

  it('keeps the newer live camera when renderer readiness refreshes before its save', () => {
    let zoom = 128;
    const setZoom = vi.fn((value: number) => {
      zoom = value;
    });
    const input = makeInput({
      sequenceLength: 4_641_652,
      seqView: {
        ...DEFAULT_SEQUENCE_VIEW_STATE,
        centerBp: 2_000_001,
        webglZoom: 128,
        webglCenterBp: 2_000_001,
      },
      minimapRef: {
        current: {
          setViewport: vi.fn(),
          setSelection: vi.fn(),
          setZoom,
          setViewCenter: vi.fn(),
          getCameraZoomBounds: () => ({ min: 0.001, max: 1024 }),
        } satisfies WebGLMapHandle,
      },
    });
    const { result, rerender } = renderHook(
      ({ epoch }) => useSequenceViewportSync({ ...input, webglRendererReadyEpoch: epoch }),
      { initialProps: { epoch: 1 } }
    );
    act(() => vi.advanceTimersByTime(200));
    expect(zoom).toBe(128);
    act(() => {
      zoom = 4;
      result.current.handleWebglMapCameraChange(2_000_000, 'zoom', 4);
    });
    expect(input.patchSeqView).not.toHaveBeenCalled();
    rerender({ epoch: 2 });
    act(() => vi.advanceTimersByTime(20));
    expect(zoom, 'renderer readiness must not replay older persisted zoom over live input').toBe(4);
  });

  it('keeps the saved center until the viewer applies the initial restore ', () => {
    const scrollToPosition = vi.fn();
    const input = makeInput({
      sequenceLength: 10_000,
      circular: false,
      webglEnabled: false,
      isWebglSyncLocked: false,
      seqView: {
        ...DEFAULT_SEQUENCE_VIEW_STATE,
        centerBp: 900,
        webglZoom: null,
        webglCenterBp: null,
      },
      scrollToPositionWithTimeoutRef: { current: scrollToPosition },
    });
    const { result } = renderHook(() =>
      useSequenceViewportSync({
        ...input,
        paneLayout: { rendererVisibility: 'sequence', mapPlacement: 'right' },
      })
    );
    act(() => vi.runOnlyPendingTimers());
    expect(scrollToPosition).toHaveBeenLastCalledWith(900, expect.any(Function), {
      animate: false,
    });

    act(() =>
      result.current.handleViewportChange({ start: 0, end: 254, centerColumn: 126 }, 'layout')
    );
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current.lastViewportCenterRef.current).toBe(900);
    expect(input.patchSeqView).not.toHaveBeenCalledWith(
      expect.objectContaining({ centerBp: 127 }),
      expect.anything()
    );

    act(() => scrollToPosition.mock.calls.at(-1)![1]());
    act(() =>
      result.current.handleViewportChange({ start: 1900, end: 2100, centerColumn: 2000 }, 'scroll')
    );
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current.lastViewportCenterRef.current).toBe(2001);
    expect(input.patchSeqView).toHaveBeenLastCalledWith({ centerBp: 2001 }, { debounce: true });
  });

  it('restores saved WebGL camera state when the map is shown after opening sequence-only', () => {
    const setZoom = vi.fn();
    const setViewCenter = vi.fn();
    const minimapRef = {
      current: null as WebGLMapHandle | null,
    };
    const input = makeInput({
      webglEnabled: false,
      minimapRef,
      seqView: {
        ...DEFAULT_SEQUENCE_VIEW_STATE,
        centerBp: 7,
        zoom: 125,
        webglZoom: 2.5,
        webglCenterBp: 11,
      },
    });

    const { rerender } = renderHook(
      ({ webglEnabled }) =>
        useSequenceViewportSync({
          ...input,
          webglEnabled,
        }),
      { initialProps: { webglEnabled: false } }
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(setZoom).not.toHaveBeenCalled();
    expect(setViewCenter).not.toHaveBeenCalled();

    minimapRef.current = {
      setZoom,
      setViewCenter,
      getCameraZoomBounds: () => ({ min: 0.5, max: 10 }),
    } as unknown as WebGLMapHandle;
    rerender({ webglEnabled: true });

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(setZoom).toHaveBeenCalledWith(2.5);
    expect(setViewCenter).toHaveBeenCalledWith(10);
  });

  it('seeds a center-only saved viewport when the map is shown after opening sequence-only', () => {
    const setViewCenter = vi.fn();
    const minimapRef = {
      current: null as WebGLMapHandle | null,
    };
    const input = makeInput({
      webglEnabled: false,
      minimapRef,
      seqView: {
        ...DEFAULT_SEQUENCE_VIEW_STATE,
        centerBp: 7,
        zoom: 125,
        webglZoom: null,
        webglCenterBp: null,
      },
    });

    const { rerender } = renderHook(
      ({ webglEnabled }) =>
        useSequenceViewportSync({
          ...input,
          webglEnabled,
        }),
      { initialProps: { webglEnabled: false } }
    );

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(setViewCenter).not.toHaveBeenCalled();

    minimapRef.current = { setViewCenter } as unknown as WebGLMapHandle;
    rerender({ webglEnabled: true });

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(setViewCenter).toHaveBeenCalledWith(6);
  });

  it.each([
    {
      label: 'pUC19-sized sequence with the exact Linux +1091 overwrite',
      sequenceLength: 2686,
      initialCenterBp: 900,
      liveCenterBp: 1991,
      expectedMapCenterBp: 899,
    },
    {
      label: 'short sequence whose outgoing viewport clamps to the final base',
      sequenceLength: 20,
      initialCenterBp: 7,
      liveCenterBp: 1991,
      expectedMapCenterBp: 6,
    },
  ])(
    'keeps the initial center-only map seed when the sequence viewport persists during map startup: $label',
    ({ sequenceLength, initialCenterBp, liveCenterBp, expectedMapCenterBp }) => {
      const setViewCenter = vi.fn();
      const minimapRef = {
        current: null as WebGLMapHandle | null,
      };
      const input = makeInput({
        minimapRef,
        sequenceLength,
      });

      const { rerender } = renderHook(
        ({
          webglEnabled,
          centerBp,
          rendererReadyEpoch,
        }: {
          webglEnabled: boolean;
          centerBp: number;
          rendererReadyEpoch: number;
        }) =>
          useSequenceViewportSync({
            ...input,
            webglEnabled,
            webglRendererReadyEpoch: rendererReadyEpoch,
            seqView: {
              ...DEFAULT_SEQUENCE_VIEW_STATE,
              centerBp,
              zoom: 125,
              webglZoom: null,
              webglCenterBp: null,
            },
          }),
        {
          initialProps: {
            webglEnabled: false,
            centerBp: initialCenterBp,
            rendererReadyEpoch: 0,
          },
        }
      );

      act(() => {
        vi.runOnlyPendingTimers();
      });
      minimapRef.current = { setViewCenter } as unknown as WebGLMapHandle;

      rerender({
        webglEnabled: true,
        centerBp: liveCenterBp,
        rendererReadyEpoch: 1,
      });
      act(() => {
        vi.runOnlyPendingTimers();
      });

      expect(setViewCenter).toHaveBeenCalledWith(expectedMapCenterBp);
    }
  );

  it('replays a saved center when renderer readiness arrives after the initial restore window', () => {
    const setViewCenter = vi.fn();
    const minimapRef = {
      current: null as WebGLMapHandle | null,
    };
    const input = makeInput({
      minimapRef,
      seqView: {
        ...DEFAULT_SEQUENCE_VIEW_STATE,
        centerBp: 7,
        zoom: 125,
        webglZoom: null,
        webglCenterBp: null,
      },
    });

    const { rerender } = renderHook(
      ({ rendererReadyEpoch }) =>
        useSequenceViewportSync({
          ...input,
          webglRendererReadyEpoch: rendererReadyEpoch,
        }),
      { initialProps: { rendererReadyEpoch: 0 } }
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(setViewCenter).not.toHaveBeenCalled();

    minimapRef.current = { setViewCenter } as unknown as WebGLMapHandle;
    rerender({ rendererReadyEpoch: 1 });

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(setViewCenter).toHaveBeenCalledWith(6);
  });

  it('persists canvas viewport centers and publishes the Electron test bridge', () => {
    (window as unknown as { __test: Record<string, unknown> }).__test = {};
    const patchSeqView = vi.fn();
    const setViewport = vi.fn();
    const setViewCenter = vi.fn();

    const { result } = renderHook(() =>
      useSequenceViewportSync(
        makeInput({
          patchSeqView,
          minimapRef: {
            current: {
              setViewport,
              setViewCenter,
            } as unknown as WebGLMapHandle,
          },
        })
      )
    );

    act(() => {
      result.current.handleViewportChange({
        start: 0,
        end: 9,
        centerColumn: 4,
      });
    });

    expect(setViewport).toHaveBeenCalledWith({
      start: 0,
      end: 9,
      centerColumn: 4,
    });
    expect(patchSeqView).not.toHaveBeenCalled();
    expect(setViewCenter).toHaveBeenCalledWith(4);
    expect(result.current.lastViewportCenterRef.current).toBe(5);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(patchSeqView).toHaveBeenCalledWith({ centerBp: 5 }, { debounce: true });
    expect(
      (
        window as unknown as {
          __test: {
            workspaceViewer: {
              getLastViewportCenterBp: () => number | null;
              setViewport: (range: { start: number; end: number }) => void;
            };
          };
        }
      ).__test.workspaceViewer.getLastViewportCenterBp()
    ).toBe(5);
    const bridge = (
      window as unknown as {
        __test: {
          workspaceViewer: {
            setViewport: (range: { start: number; end: number }) => void;
          };
        };
      }
    ).__test.workspaceViewer;
    bridge.setViewport({ start: 10, end: 20 });
    expect(setViewport).toHaveBeenLastCalledWith({ start: 10, end: 20 });
  });

  it('does not overwrite an indexed child bridge camera command when the parent sync reruns', () => {
    const indexedSetViewport = vi.fn();
    (
      window as unknown as {
        __test: { workspaceViewer: Record<string, unknown> };
      }
    ).__test = {
      workspaceViewer: { setViewport: indexedSetViewport },
    };
    const { result, rerender } = renderHook(() =>
      useSequenceViewportSync(makeInput({ minimapRef: { current: null } }))
    );

    act(() => {
      result.current.handleViewportChange({
        start: 0,
        end: 9,
        centerColumn: 4,
      });
    });
    const bridge = (window as unknown as { __test: { workspaceViewer: any } }).__test
      .workspaceViewer;
    bridge.setViewport({ start: 10, end: 20 });
    expect(indexedSetViewport).toHaveBeenCalledWith({ start: 10, end: 20 });

    rerender();
    const rerenderedBridge = (window as unknown as { __test: { workspaceViewer: any } }).__test
      .workspaceViewer;
    rerenderedBridge.setViewport({ start: 21, end: 30 });
    expect(indexedSetViewport).toHaveBeenLastCalledWith({ start: 21, end: 30 });
  });

  it('releases only its own Electron test bridge when the viewer unmounts', () => {
    (window as unknown as { __test: Record<string, unknown> }).__test = {};
    const { result, unmount } = renderHook(() => useSequenceViewportSync(makeInput()));

    act(() => {
      result.current.handleViewportChange({
        start: 0,
        end: 9,
        centerColumn: 4,
      });
    });

    const testState = (window as unknown as { __test: { workspaceViewer?: unknown } }).__test;
    const ownedBridge = testState.workspaceViewer;
    expect(ownedBridge).toBeDefined();

    const replacementBridge = { owner: 'new-active-viewer' };
    testState.workspaceViewer = replacementBridge;
    unmount();

    expect(testState.workspaceViewer).toBe(replacementBridge);

    const second = renderHook(() => useSequenceViewportSync(makeInput()));
    act(() => {
      second.result.current.handleViewportChange({
        start: 0,
        end: 9,
        centerColumn: 4,
      });
    });
    expect(testState.workspaceViewer).not.toBe(ownedBridge);

    second.unmount();

    expect(testState.workspaceViewer).toBeUndefined();
  });

  it('settles the saved camera once when the map is ready', () => {
    (window as unknown as { __test: Record<string, unknown> }).__test = {};
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      })
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const setViewport = vi.fn();
    const setZoom = vi.fn();
    const setViewCenter = vi.fn();

    const { result } = renderHook(() =>
      useSequenceViewportSync(
        makeInput({
          seqView: {
            ...DEFAULT_SEQUENCE_VIEW_STATE,
            centerBp: null,
            zoom: 125,
            surfaces: { webgl: true },
            webglZoom: 4,
            webglCenterBp: 11,
          },
          minimapRef: {
            current: {
              getCameraZoomBounds: () => ({ min: 1, max: 10 }),
              setViewport,
              setZoom,
              setViewCenter,
            } as unknown as StadiumMapHandle,
          },
        })
      )
    );

    act(() => {
      result.current.handleViewportChange({
        start: 0,
        end: 9,
        centerColumn: 4,
      });
    });

    const restoreStatus = () =>
      (
        window as unknown as {
          __test: {
            workspaceViewer: {
              getWebglCameraRestoreStatus: () => {
                scopeKey: string;
                phase: 'not-needed' | 'running' | 'settled' | 'cancelled';
                appliedFrames: number;
              };
            };
          };
        }
      ).__test.workspaceViewer.getWebglCameraRestoreStatus();

    expect(restoreStatus()).toEqual({
      scopeKey: 'example.gb',
      phase: 'running',
      appliedFrames: 0,
    });
    setZoom.mockClear();
    setViewCenter.mockClear();

    const callback = callbacks.shift();
    expect(callback).toBeDefined();
    act(() => callback?.(16));
    expect(callbacks).toHaveLength(0);

    expect(setZoom).toHaveBeenCalledOnce();
    expect(setViewCenter).toHaveBeenCalledOnce();
    expect(restoreStatus()).toEqual({
      scopeKey: 'example.gb',
      phase: 'settled',
      appliedFrames: 1,
    });
  });

  it('publishes cancellation when navigation preempts a pending WebGL restore', () => {
    (window as unknown as { __test: Record<string, unknown> }).__test = {};
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((_callback: FrameRequestCallback) => 1)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const setViewport = vi.fn();

    const { result } = renderHook(() =>
      useSequenceViewportSync(
        makeInput({
          seqView: {
            ...DEFAULT_SEQUENCE_VIEW_STATE,
            centerBp: null,
            zoom: 125,
            surfaces: { webgl: true },
            webglZoom: 4,
            webglCenterBp: 11,
          },
          minimapRef: {
            current: { setViewport } as unknown as StadiumMapHandle,
          },
        })
      )
    );

    act(() => {
      result.current.handleViewportChange({
        start: 0,
        end: 9,
        centerColumn: 4,
      });
      result.current.cancelWebglCameraRestore();
    });

    expect(
      (
        window as unknown as {
          __test: {
            workspaceViewer: {
              getWebglCameraRestoreStatus: () => { phase: string };
            };
          };
        }
      ).__test.workspaceViewer.getWebglCameraRestoreStatus().phase
    ).toBe('cancelled');
  });

  it('persists WebGL camera changes and syncs scroll gestures back to the sequence viewer', () => {
    const patchSeqView = vi.fn();
    const scrollActiveSequenceViewerToBiologicalPosition = vi.fn();
    const { result } = renderHook(() =>
      useSequenceViewportSync(
        makeInput({
          patchSeqView,
          scrollActiveSequenceViewerToBiologicalPosition,
        })
      )
    );

    act(() => {
      result.current.handleWebglMapCameraChange(8, 'scroll', 2.5);
    });

    expect(patchSeqView).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(patchSeqView).toHaveBeenCalledWith(
      { webglZoom: 2.5, webglCenterBp: 9 },
      { debounce: true }
    );
    expect(patchSeqView).toHaveBeenCalledWith({ centerBp: 9 }, { debounce: true });
    expect(scrollActiveSequenceViewerToBiologicalPosition).toHaveBeenCalledWith(9, {
      continuousCircular: true,
    });
  });

  it('does not re-scroll the sequence viewer in response to its own setViewCenter echo (self-inflicted scroll-thrash regression)', () => {
    const patchSeqView = vi.fn();
    const scrollActiveSequenceViewerToBiologicalPosition = vi.fn();
    const setViewport = vi.fn();
    const setViewCenterCalls: number[] = [];
    const holder: {
      current: ReturnType<typeof useSequenceViewportSync> | null;
    } = {
      current: null,
    };

    const { result } = renderHook(() => {
      const hookResult = useSequenceViewportSync(
        makeInput({
          patchSeqView,
          scrollActiveSequenceViewerToBiologicalPosition,
          minimapRef: {
            current: {
              setViewport,
              setViewCenter: (centerBp: number) => {
                setViewCenterCalls.push(centerBp);

                holder.current?.handleWebglMapCameraChange(centerBp, 'zoom', 125);
              },
            } as unknown as WebGLMapHandle,
          },
        })
      );
      holder.current = hookResult;
      return hookResult;
    });

    act(() => {
      result.current.handleViewportChange({
        start: 0,
        end: 9,
        centerColumn: 4,
      });
    });

    expect(setViewCenterCalls).toEqual([4]);

    expect(scrollActiveSequenceViewerToBiologicalPosition).not.toHaveBeenCalled();
  });

  it('coalesces high-frequency WebGL camera persistence before touching view state', () => {
    const patchSeqView = vi.fn();
    const { result } = renderHook(() =>
      useSequenceViewportSync(
        makeInput({
          sequenceLength: 1000,
          patchSeqView,
          isWebglSyncLocked: false,
        })
      )
    );

    act(() => {
      for (let i = 0; i < 60; i += 1) {
        result.current.handleWebglMapCameraChange(100 + i, 'zoom', 2 + i / 10);
      }
    });

    expect(
      patchSeqView,
      'high-frequency WebGL camera callbacks must not patch React/tab state synchronously'
    ).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(patchSeqView).toHaveBeenCalledTimes(1);
    expect(patchSeqView).toHaveBeenCalledWith(
      { webglZoom: 7.9, webglCenterBp: 160 },
      { debounce: true }
    );
  });
});
