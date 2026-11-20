import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../../canvas/public/store';
import { readSequenceViewMemory, sequenceViewMemoryKey } from './sequence-view-state';
import { useSequenceViewState } from './useSequenceViewState';

const panelId = 'main',
  documentId = 'sequence-document-ordering';
function open() {
  useCanvasStore.getState().openTab(panelId, {
    type: 'sequence',
    entityId: documentId,
    label: 'Ordering fixture',
    sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
  });
}
function tabState() {
  return Object.values(useCanvasStore.getState().panels)
    .flatMap((p) => p.tabs)
    .find((t) => t.entityId === documentId)?.viewState;
}
beforeEach(() => {
  localStorage.clear();
  useCanvasStore.getState().reset();
  vi.useFakeTimers();
  open();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ordered view-state supersession through the real hook, canvas store and reopen memory', () => {
  it('remembers each unlocked map layout through rapid switches and reopening', () => {
    const openView = () =>
      useSequenceViewState(documentId, { circular: true, surface: 'sequence' });
    const { result, unmount } = renderHook(openView);
    const patch = result.current[1];
    act(() => patch({ rendererVisibility: 'both', mapPlacement: 'right' }));
    act(() => patch({ webglZoom: 2 }, { debounce: true }));
    act(() => patch({ mapPlacement: 'bottom' }));
    expect(result.current[0].webglZoom).toBe(1);
    act(() => patch({ webglZoom: 4 }, { debounce: true }));
    act(() => patch({ mapPlacement: 'left' }));
    expect(result.current[0].webglZoom).toBe(2);
    act(() => patch({ rendererVisibility: 'map' }));
    act(() => patch({ webglZoom: 3 }, { debounce: true }));
    act(() => patch({ rendererVisibility: 'sequence' }));
    act(() => patch({ rendererVisibility: 'both', mapPlacement: 'top' }));
    expect(result.current[0].webglZoom).toBe(4);
    unmount();
    useCanvasStore.getState().reset();
    open();
    const reopened = renderHook(openView).result;
    act(() => reopened.current[1]({ rendererVisibility: 'map' }));
    expect(reopened.current[0].webglZoom).toBe(3);
    act(() => reopened.current[1]({ rendererVisibility: 'both', mapPlacement: 'right' }));
    expect(reopened.current[0].webglZoom).toBe(2);
  });

  it('reads the live camera on departure and carries zoom across locked layouts', () => {
    let camera = 2;
    const { result } = renderHook(() =>
      useSequenceViewState(documentId, { circular: true, surface: 'sequence' }, () => camera)
    );
    const patch = result.current[1];
    act(() => patch({ rendererVisibility: 'both', mapPlacement: 'right' }));
    camera = 3;
    act(() => patch({ mapPlacement: 'bottom' }));
    act(() => patch({ mapPlacement: 'right' }));
    expect(result.current[0].webglZoom).toBe(3);
    act(() => patch({ scrollSynced: true, webglZoom: 5 }));
    act(() => patch({ mapPlacement: 'bottom' }));
    expect(result.current[0].webglZoom).toBe(5);
  });

  it('keeps newer immediate zoom after the older timer and writes the same reopen value', () => {
    const { result } = renderHook(() => useSequenceViewState(documentId));
    act(() => result.current[1]({ zoom: 80 }, { debounce: true }));
    act(() => result.current[1]({ zoom: 120 }));
    expect(tabState()?.sequenceViewportZoomLevel).toBe(120);
    act(() => vi.advanceTimersByTime(120));
    expect(tabState()?.sequenceViewportZoomLevel).toBe(120);
    expect(result.current[0].zoom).toBe(120);
    expect(readSequenceViewMemory(documentId).zoom).toBe(120);
  });
  it('merges nested display fields in event order without dropping pending siblings', () => {
    const { result } = renderHook(() => useSequenceViewState(documentId));
    act(() =>
      result.current[1](
        { display: { showAnnotations: false, showTranslation: false } },
        { debounce: true }
      )
    );
    act(() => result.current[1]({ display: { showAnnotations: true } }));
    expect(tabState()?.sequenceShowAnnotations).toBe(true);
    act(() => vi.advanceTimersByTime(120));
    expect(result.current[0].display).toMatchObject({
      showAnnotations: true,
      showTranslation: false,
    });
    expect(readSequenceViewMemory(documentId).display).toMatchObject({
      showAnnotations: true,
      showTranslation: false,
    });
  });
  it('commits unrelated pending scalar fields with the newer immediate patch once', () => {
    const { result } = renderHook(() => useSequenceViewState(documentId));
    const sink = vi.spyOn(useCanvasStore.getState(), 'setTabViewState');
    act(() => result.current[1]({ centerBp: 73, zoom: 80 }, { debounce: true }));
    act(() => result.current[1]({ zoom: 120 }));
    expect(tabState()).toMatchObject({
      sequenceViewportCenterBp: 73,
      sequenceViewportZoomLevel: 120,
    });
    expect(sink).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(120));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(readSequenceViewMemory(documentId)).toMatchObject({ centerBp: 73, zoom: 120 });
  });
  it('retains newer debounced values after an immediate write and resets the quiet period', () => {
    const { result } = renderHook(() => useSequenceViewState(documentId));
    act(() => result.current[1]({ zoom: 120 }));
    act(() => result.current[1]({ zoom: 81 }, { debounce: true, debounceMs: 300 }));
    act(() => vi.advanceTimersByTime(250));
    act(() => result.current[1]({ zoom: 82 }, { debounce: true, debounceMs: 300 }));
    act(() => vi.advanceTimersByTime(299));
    expect(tabState()?.sequenceViewportZoomLevel).toBe(120);
    act(() => vi.advanceTimersByTime(1));
    expect(tabState()?.sequenceViewportZoomLevel).toBe(82);
    expect(readSequenceViewMemory(documentId).zoom).toBe(82);
  });
  it('coalesces 100 gesture patches into one idle tab write and one scoped memory write', () => {
    const { result } = renderHook(() => useSequenceViewState(documentId));
    const sink = vi.spyOn(useCanvasStore.getState(), 'setTabViewState');
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    act(() => {
      for (let n = 1; n <= 100; n += 1) result.current[1]({ zoom: n }, { debounce: true });
    });
    expect(sink).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(119));
    expect(sink).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(tabState()?.sequenceViewportZoomLevel).toBe(100);
    expect(
      storage.mock.calls.filter(([key]) => key === sequenceViewMemoryKey(documentId))
    ).toHaveLength(1);
    expect(readSequenceViewMemory(documentId).zoom).toBe(100);
  });
  it('preserves newest reopen memory when the store closes before unmount, without recreating a tab', () => {
    const { result, unmount } = renderHook(() => useSequenceViewState(documentId));
    act(() => result.current[1]({ zoom: 80, centerBp: 73 }, { debounce: true }));
    act(() => result.current[1]({ zoom: 120 }));
    const tabId = useCanvasStore.getState().panels[panelId]?.activeTabId;
    if (!tabId) throw new Error('Expected owned tab');
    act(() => useCanvasStore.getState().closeTab(panelId, tabId));
    unmount();
    expect(tabState()).toBeUndefined();
    expect(readSequenceViewMemory(documentId)).toMatchObject({ zoom: 120, centerBp: 73 });
    open();
    const reopened = renderHook(() => useSequenceViewState(documentId));
    expect(reopened.result.current[0]).toMatchObject({ zoom: 120, centerBp: 73 });
    expect(tabState()).toMatchObject({
      sequenceViewportZoomLevel: 120,
      sequenceViewportCenterBp: 73,
    });
  });
});
