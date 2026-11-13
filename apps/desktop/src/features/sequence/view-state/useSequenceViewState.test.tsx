import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../../canvas/store';
import {
  readSequenceViewMemory,
  sequenceViewMemoryKey,
  writeSequenceViewMemory,
} from './sequence-view-state';
import { useSequenceViewState } from './useSequenceViewState';

const PANEL = 'main';

function openSequenceTab(documentId: string): void {
  useCanvasStore.getState().openTab(PANEL, {
    type: 'sequence',
    entityId: documentId,
    label: documentId,
    sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
  });
}

function tabViewStateFor(path: string) {
  for (const panel of Object.values(useCanvasStore.getState().panels)) {
    const tab = panel.tabs.find((t) => t.entityId === path);
    if (tab) return tab.viewState;
  }
  return undefined;
}

beforeEach(() => {
  localStorage.clear();
  useCanvasStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSequenceViewState — seed (synchronous at mount, no jump)', () => {
  it('returns defaults for a never-seen file', () => {
    const path = 'sequence-document-new';
    openSequenceTab(path);
    const { result } = renderHook(() => useSequenceViewState(path));
    const [viewState] = result.current;
    expect(viewState.canvasMode).toBe('2d');
    expect(viewState.rendererVisibility).toBe('both');
    expect(viewState.mapShape).toBe('circular');
    expect(viewState.mapPlacement).toBe('bottom');
    expect(viewState.zoom).toBe(100);
    expect(viewState.webglPerformancePreference).toBe('auto');
    expect(viewState.centerBp).toBeNull();
  });

  it('seeds zoom + webgl synchronously from per-file memory on the FIRST render', () => {
    const path = 'sequence-document-reopen';
    writeSequenceViewMemory(path, {
      zoom: 60,
      rendererVisibility: 'map',
      mapShape: 'linear',
      mapPlacement: 'left',
      centerBp: 1234,
      annotationColorMode: 'manual',
    });
    openSequenceTab(path);

    const { result } = renderHook(() => useSequenceViewState(path));
    const [viewState] = result.current;
    expect(viewState.zoom).toBe(60);
    expect(viewState.rendererVisibility).toBe('map');
    expect(viewState.mapShape).toBe('linear');
    expect(viewState.mapPlacement).toBe('left');
    expect(viewState.centerBp).toBe(1234);
    expect(viewState.annotationColorMode).toBe('manual');
  });

  it('seeds selection and sequenceRanges from per-file memory on the FIRST render', () => {
    const path = 'sequence-document-reopen-selection';
    writeSequenceViewMemory(path, {
      selection: { start: 4, end: 12 },
      sequenceRanges: [{ start: 4, end: 12 }],
    });
    openSequenceTab(path);
    const { result } = renderHook(() => useSequenceViewState(path));
    const [viewState] = result.current;
    expect(viewState.selection).toEqual({ start: 4, end: 12 });
    expect(viewState.sequenceRanges).toEqual([{ start: 4, end: 12 }]);
  });

  it('lets live tab state win over per-file memory (tab-switch back to an open tab)', () => {
    const path = 'sequence-document-switch';
    writeSequenceViewMemory(path, { zoom: 60 });
    openSequenceTab(path);
    act(() => {
      const { panels } = useCanvasStore.getState();
      const tab = panels[PANEL].tabs.find((t) => t.entityId === path)!;
      useCanvasStore.getState().setTabViewState(PANEL, tab.id, {
        sequenceViewportZoomLevel: 85,
      });
    });

    const { result } = renderHook(() => useSequenceViewState(path));
    const [viewState] = result.current;
    expect(viewState.zoom).toBe(85);
  });

  it('seeds the live tab store from memory on mount so all consumers converge', () => {
    const path = 'sequence-document-converge';
    writeSequenceViewMemory(path, {
      canvasMode: '1d' as never,
      rendererVisibility: 'map',
      mapShape: 'linear',
      mapPlacement: 'right',
      zoom: 70,
    });
    openSequenceTab(path);
    expect(tabViewStateFor(path)?.sequenceViewMode).toBeUndefined();

    renderHook(() => useSequenceViewState(path));
    expect(tabViewStateFor(path)?.sequenceViewMode).toBe('2d');
    expect(tabViewStateFor(path)?.sequenceRendererVisibility).toBe('map');
    expect(tabViewStateFor(path)?.sequenceMapShape).toBe('linear');
    expect(tabViewStateFor(path)?.sequenceMapPlacement).toBe('right');
    expect(tabViewStateFor(path)?.sequenceViewportZoomLevel).toBe(70);
    expect(tabViewStateFor(path)?.sequenceAnnotationColorMode).toBeUndefined();
    expect(readSequenceViewMemory(path)).toMatchObject({
      canvasMode: '2d',
      rendererVisibility: 'map',
      mapShape: 'linear',
      mapPlacement: 'right',
      zoom: 70,
    });
  });

  it('seeds annotation color mode into the live tab store on reopen', () => {
    const path = 'sequence-document-colors';
    writeSequenceViewMemory(path, { annotationColorMode: 'manual' });
    openSequenceTab(path);

    renderHook(() => useSequenceViewState(path));

    expect(tabViewStateFor(path)?.sequenceAnnotationColorMode).toBe('manual');
  });

  it('keys state by document ID — two documents never cross-contaminate', () => {
    writeSequenceViewMemory('sequence-document-a', { zoom: 40 });
    writeSequenceViewMemory('sequence-document-b', { zoom: 90 });
    openSequenceTab('sequence-document-a');
    openSequenceTab('sequence-document-b');

    const a = renderHook(() => useSequenceViewState('sequence-document-a'));
    const b = renderHook(() => useSequenceViewState('sequence-document-b'));
    expect(a.result.current[0].zoom).toBe(40);
    expect(b.result.current[0].zoom).toBe(90);
  });
});

describe('useSequenceViewState — patch (immediate fields)', () => {
  it('merges a partial update and reflects it on the next render', () => {
    const path = 'sequence-document-patch';
    openSequenceTab(path);
    const { result } = renderHook(() => useSequenceViewState(path));

    act(() => result.current[1]({ zoom: 80 }));
    expect(result.current[0].zoom).toBe(80);
    expect(result.current[0].canvasMode).toBe('2d');
  });

  it('writes immediate fields to the live tab store synchronously', () => {
    const path = 'sequence-document-immediate';
    openSequenceTab(path);
    const { result } = renderHook(() => useSequenceViewState(path));

    act(() =>
      result.current[1]({
        rendererVisibility: 'sequence',
        canvasMode: 'tracks',
        mapShape: 'linear',
        mapPlacement: 'top',
        webglPerformancePreference: 'stability',
      })
    );
    expect(tabViewStateFor(path)?.sequenceRendererVisibility).toBe('sequence');
    expect(tabViewStateFor(path)?.sequenceViewMode).toBe('tracks');
    expect(tabViewStateFor(path)?.sequenceMapShape).toBe('linear');
    expect(tabViewStateFor(path)?.sequenceMapPlacement).toBe('top');
    expect(tabViewStateFor(path)?.sequenceWebglPerformancePreference).toBe('stability');
  });

  it('mirrors changes to per-file memory so they survive close→reopen', () => {
    vi.useFakeTimers();
    const path = 'sequence-document-persist';
    openSequenceTab(path);
    const { result } = renderHook(() => useSequenceViewState(path));

    act(() =>
      result.current[1]({
        rendererVisibility: 'map',
        zoom: 80,
        canvasMode: 'tracks',
        mapShape: 'linear',
        mapPlacement: 'left',
        centerBp: 999,
      })
    );
    act(() => vi.advanceTimersByTime(200));

    expect(readSequenceViewMemory(path)).toMatchObject({
      rendererVisibility: 'map',
      zoom: 80,
      canvasMode: 'tracks',
      mapShape: 'linear',
      mapPlacement: 'left',
      centerBp: 999,
    });
  });

  it('persists selection to per-file memory so it survives close→reopen', () => {
    vi.useFakeTimers();
    const path = 'sequence-document-selection-persist';
    openSequenceTab(path);
    const { result } = renderHook(() => useSequenceViewState(path));

    act(() => result.current[1]({ selection: { start: 4, end: 12 } }));
    act(() => vi.advanceTimersByTime(200));

    expect(result.current[0].selection).toEqual({ start: 4, end: 12 });
    expect(readSequenceViewMemory(path)).toMatchObject({
      selection: { start: 4, end: 12 },
    });
  });

  it('persists sequenceRanges to per-file memory so they survive close→reopen', () => {
    vi.useFakeTimers();
    const path = 'sequence-document-ranges-persist';
    openSequenceTab(path);
    const { result } = renderHook(() => useSequenceViewState(path));

    act(() => result.current[1]({ sequenceRanges: [{ start: 1, end: 8 }] }));
    act(() => vi.advanceTimersByTime(200));

    expect(result.current[0].sequenceRanges).toEqual([{ start: 1, end: 8 }]);
    expect(readSequenceViewMemory(path)).toMatchObject({
      sequenceRanges: [{ start: 1, end: 8 }],
    });
  });

  it('persists display toggles to per-file memory so they survive close→reopen', () => {
    vi.useFakeTimers();
    const path = 'sequence-document-display';
    openSequenceTab(path);
    const { result } = renderHook(() => useSequenceViewState(path));

    act(() => result.current[1]({ display: { showTranslation: false } }));
    act(() => vi.advanceTimersByTime(200));

    expect(readSequenceViewMemory(path).display?.showTranslation).toBe(false);
    expect(result.current[0].display.showTranslation).toBe(false);
    expect(result.current[0].display.showAnnotations).toBe(true);
  });
});

describe('useSequenceViewState — patch (debounced viewport) + flush', () => {
  it('coalesces debounced viewport writes to the tab store', () => {
    vi.useFakeTimers();
    const path = 'sequence-document-scroll';
    openSequenceTab(path);
    const { result } = renderHook(() => useSequenceViewState(path));

    act(() => {
      result.current[1]({ centerBp: 10 }, { debounce: true });
      result.current[1]({ centerBp: 20 }, { debounce: true });
      result.current[1]({ centerBp: 30 }, { debounce: true });
    });
    expect(tabViewStateFor(path)?.sequenceViewportCenterBp).toBeUndefined();

    act(() => vi.advanceTimersByTime(200));
    expect(tabViewStateFor(path)?.sequenceViewportCenterBp).toBe(30);
  });

  it('keeps a live zoom gesture out of the tab store until its quiet period', () => {
    vi.useFakeTimers();
    const path = 'sequence-document-live-zoom';
    openSequenceTab(path);
    const { result } = renderHook(() => useSequenceViewState(path));

    act(() => result.current[1]({ zoom: 81 }, { debounce: true, debounceMs: 300 }));
    act(() => vi.advanceTimersByTime(250));
    act(() => result.current[1]({ zoom: 82 }, { debounce: true, debounceMs: 300 }));
    act(() => vi.advanceTimersByTime(250));
    expect(tabViewStateFor(path)?.sequenceViewportZoomLevel).toBeUndefined();
    act(() => vi.advanceTimersByTime(50));
    expect(tabViewStateFor(path)?.sequenceViewportZoomLevel).toBe(82);
  });

  it('flushes a pending debounced patch to memory on unmount (tab close)', () => {
    vi.useFakeTimers();
    const path = 'sequence-document-close';
    openSequenceTab(path);
    const { result, unmount } = renderHook(() => useSequenceViewState(path));

    act(() => result.current[1]({ centerBp: 4242, zoom: 55 }, { debounce: true }));
    expect(readSequenceViewMemory(path).centerBp).toBeUndefined();

    unmount();
    expect(readSequenceViewMemory(path)).toMatchObject({ centerBp: 4242, zoom: 55 });
  });

  it('flushes reopen memory without a missing-tab warning after the store closes first', () => {
    vi.useFakeTimers();
    const path = 'sequence-document-store-close-first';
    openSequenceTab(path);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result, unmount } = renderHook(() => useSequenceViewState(path));

    act(() => result.current[1]({ centerBp: 73 }, { debounce: true }));
    const activeTabId = useCanvasStore.getState().panels[PANEL]?.activeTabId;
    if (!activeTabId) throw new Error('Expected an active sequence tab.');
    act(() => useCanvasStore.getState().closeTab(PANEL, activeTabId));
    unmount();

    expect(readSequenceViewMemory(path)).toMatchObject({ centerBp: 73 });
    expect(warning).not.toHaveBeenCalledWith(expect.stringContaining('Tab not found'));
    warning.mockRestore();
  });
});

describe('useSequenceViewState — robustness', () => {
  it('never throws when the per-file memory write fails (quota / unavailable)', () => {
    vi.useFakeTimers();
    const path = 'sequence-document-no-ls';
    openSequenceTab(path);
    const realSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      if (key === sequenceViewMemoryKey(path)) throw new Error('quota');
      return realSetItem.call(this, key, value);
    });
    try {
      const { result } = renderHook(() => useSequenceViewState(path));
      act(() => result.current[1]({ zoom: 80 }));
      expect(() => act(() => vi.advanceTimersByTime(200))).not.toThrow();
      expect(result.current[0].zoom).toBe(80);
    } finally {
      spy.mockRestore();
    }
    expect(localStorage.getItem(sequenceViewMemoryKey(path))).toBeNull();
  });
});

describe('useSequenceViewState — capability context gating ', () => {
  it('opens a saved Tracks sequence in Wrap and persists the corrected setting', () => {
    vi.useFakeTimers();
    const documentId = 'sequence-document-wrap-only';
    writeSequenceViewMemory(documentId, { canvasMode: 'tracks', zoom: 70 });
    openSequenceTab(documentId);
    const tab = useCanvasStore
      .getState()
      .panels[PANEL].tabs.find((t) => t.entityId === documentId)!;
    useCanvasStore.getState().setTabViewState(PANEL, tab.id, { sequenceViewMode: 'tracks' });

    const { result } = renderHook(() =>
      useSequenceViewState(documentId, { circular: true, surface: 'sequence' })
    );
    expect(result.current[0].canvasMode).toBe('2d');
    expect(result.current[0].zoom).toBe(70);
    expect(tabViewStateFor(documentId)?.sequenceViewMode).toBe('2d');
    act(() => vi.advanceTimersByTime(200));
    expect(readSequenceViewMemory(documentId).canvasMode).toBe('2d');

    act(() => result.current[1]({ canvasMode: 'tracks' }));
    expect(result.current[0].canvasMode).toBe('2d');
    expect(tabViewStateFor(documentId)?.sequenceViewMode).toBe('2d');
  });

  it('drops a capability-forbidden field for a linear file (cannot persist morph)', () => {
    vi.useFakeTimers();
    const path = 'sequence-document-linear';
    openSequenceTab(path);
    const { result } = renderHook(() => useSequenceViewState(path, { circular: false }));

    act(() => result.current[1]({ webglMorph: 0.7, mapShape: 'linear', zoom: 80 }));
    act(() => vi.advanceTimersByTime(200));

    const mem = readSequenceViewMemory(path);
    expect(mem.webglMorph, 'linear file does not persist a morph').toBeUndefined();
    expect(mem.mapShape, 'linear file does not persist circular-only map shape').toBeUndefined();
    expect(mem.zoom, 'other fields still persist').toBe(80);
    expect(result.current[0].webglMorph).toBeNull();
    expect(result.current[0].mapShape).toBe('circular');
  });

  it('keeps a capability-allowed field for a circular file (persists morph)', () => {
    vi.useFakeTimers();
    const path = 'sequence-document-circular';
    openSequenceTab(path);
    const { result } = renderHook(() => useSequenceViewState(path, { circular: true }));

    act(() => result.current[1]({ webglMorph: 0.7, mapShape: 'linear' }));
    act(() => vi.advanceTimersByTime(200));

    expect(readSequenceViewMemory(path).webglMorph).toBe(0.7);
    expect(readSequenceViewMemory(path).mapShape).toBe('linear');
    expect(result.current[0].webglMorph).toBe(0.7);
    expect(result.current[0].mapShape).toBe('linear');
  });

  it('seeded morph from memory is suppressed when the file is linear', () => {
    const path = 'sequence-document-was-circular-now-linear';
    writeSequenceViewMemory(path, { webglMorph: 0.5 });
    openSequenceTab(path);
    const { result } = renderHook(() => useSequenceViewState(path, { circular: false }));
    expect(result.current[0].webglMorph).toBeNull();
  });
});
