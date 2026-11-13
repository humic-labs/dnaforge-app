// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCanvasStore } from '../../canvas/store';
import { useReferenceHighlight } from './useReferenceHighlight';

function setupTabWithViewState(filePath: string, viewState?: Record<string, unknown>) {
  const store = useCanvasStore.getState();

  const tabId = store.openTab('panel-1', {
    type: 'sequence',
    entityId: filePath,
    sequenceDocument: { kind: 'catalog-sequence', entityId: filePath },
    label: 'test.gb',
    pendingViewState: viewState,
  });

  return tabId;
}

describe('useReferenceHighlight', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      panels: {
        'panel-1': {
          id: 'panel-1',
          tabs: [],
          activeTabId: null,
        },
      },
      layout: { type: 'panel', panelId: 'panel-1' },
      focusedPanelId: 'panel-1',
    });
  });

  it('returns highlightRange from tab viewState', () => {
    const filePath = 'sequence-puc19';
    setupTabWithViewState(filePath, {
      highlightRange: { start: 2534, end: 3182 },
    });

    const { result } = renderHook(() => useReferenceHighlight(filePath));

    expect(result.current.highlightRange).toEqual({
      start: 2534,
      end: 3182,
    });
  });

  it('returns scrollPosition from tab viewState', () => {
    const filePath = 'sequence-puc19';
    setupTabWithViewState(filePath, {
      scrollPosition: 2534,
    });

    const { result } = renderHook(() => useReferenceHighlight(filePath));

    expect(result.current.scrollPosition).toBe(2534);
  });

  it('returns both highlightRange and scrollPosition together', () => {
    const filePath = 'sequence-puc19';
    setupTabWithViewState(filePath, {
      highlightRange: { start: 100, end: 500 },
      scrollPosition: 100,
    });

    const { result } = renderHook(() => useReferenceHighlight(filePath));

    expect(result.current.highlightRange).toEqual({ start: 100, end: 500 });
    expect(result.current.scrollPosition).toBe(100);
  });

  it('returns null values when tab has no viewState', () => {
    const filePath = 'sequence-puc19';
    setupTabWithViewState(filePath);

    const { result } = renderHook(() => useReferenceHighlight(filePath));

    expect(result.current.highlightRange).toBeNull();
    expect(result.current.scrollPosition).toBeNull();
  });

  it('returns null values when no tab exists for filePath', () => {
    const { result } = renderHook(() => useReferenceHighlight('/nonexistent/file.gb'));

    expect(result.current.highlightRange).toBeNull();
    expect(result.current.scrollPosition).toBeNull();
  });

  it('clears highlightRange from viewState after consuming', () => {
    const filePath = 'sequence-puc19';
    setupTabWithViewState(filePath, {
      highlightRange: { start: 100, end: 200 },
    });

    const { result } = renderHook(() => useReferenceHighlight(filePath));

    act(() => {
      result.current.onHighlightApplied();
    });

    expect(result.current.highlightRange).toBeNull();
  });

  it('clears scrollPosition from viewState after consuming', () => {
    const filePath = 'sequence-puc19';
    setupTabWithViewState(filePath, {
      scrollPosition: 500,
    });

    const { result } = renderHook(() => useReferenceHighlight(filePath));

    act(() => {
      result.current.onScrollApplied();
    });

    expect(result.current.scrollPosition).toBeNull();
  });

  it('supports wraps flag in highlightRange', () => {
    const filePath = 'sequence-circular';
    setupTabWithViewState(filePath, {
      highlightRange: { start: 4500, end: 200, wraps: true },
    });

    const { result } = renderHook(() => useReferenceHighlight(filePath));

    expect(result.current.highlightRange).toEqual({
      start: 4500,
      end: 200,
      wraps: true,
    });
  });

  it('reads from viewState when set via setTabViewState (existing tab re-navigation)', () => {
    const filePath = 'sequence-puc19';
    setupTabWithViewState(filePath);

    const store = useCanvasStore.getState();
    const tab = store.panels['panel-1']?.tabs.find((t) => t.entityId === filePath);
    if (tab) {
      store.setTabViewState('panel-1', tab.id, {
        highlightRange: { start: 300, end: 600 },
        scrollPosition: 300,
      });
    }

    const { result } = renderHook(() => useReferenceHighlight(filePath));

    expect(result.current.highlightRange).toEqual({ start: 300, end: 600 });
    expect(result.current.scrollPosition).toBe(300);
  });

  it('exposes the sequence navigation request id for repeated same-position scrolls', () => {
    const filePath = 'sequence-puc19';
    setupTabWithViewState(filePath);

    const store = useCanvasStore.getState();
    const tab = store.panels['panel-1']?.tabs.find((t) => t.entityId === filePath);
    expect(tab).toBeTruthy();
    store.setTabViewState('panel-1', tab!.id, {
      highlightRange: { start: 300, end: 600 },
      scrollPosition: 300,
      sequenceNavigationRequestId: 1,
    });

    const { result } = renderHook(() => useReferenceHighlight(filePath));
    expect(result.current.navigationRequestId).toBe(1);

    act(() => {
      store.setTabViewState('panel-1', tab!.id, {
        highlightRange: { start: 300, end: 600 },
        scrollPosition: 300,
        sequenceNavigationRequestId: 2,
      });
    });

    expect(result.current.scrollPosition).toBe(300);
    expect(result.current.navigationRequestId).toBe(2);
  });

  it('preserves other viewState fields when clearing highlight from viewState', () => {
    const filePath = 'sequence-puc19';
    setupTabWithViewState(filePath);

    const store = useCanvasStore.getState();
    const tab = store.panels['panel-1']?.tabs.find((t) => t.entityId === filePath);
    if (tab) {
      store.setTabViewState('panel-1', tab.id, {
        highlightRange: { start: 100, end: 200 },
        virtualDigestEnzyme: 'EcoRI',
      });
    }

    const { result } = renderHook(() => useReferenceHighlight(filePath));

    act(() => {
      result.current.onHighlightApplied();
    });

    expect(result.current.highlightRange).toBeNull();

    const updatedTab = useCanvasStore
      .getState()
      .panels['panel-1']?.tabs.find((t) => t.entityId === filePath);
    expect(updatedTab?.viewState?.virtualDigestEnzyme).toBe('EcoRI');
  });
});
