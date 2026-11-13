import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useResizableDrawer } from './useResizableDrawer';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

describe('useResizableDrawer', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('starts closed with the default assembly drawer width', () => {
    const { result } = renderHook(() => useResizableDrawer({ persistKey: 'assembly:design-1' }));

    expect(result.current.open).toBe(false);
    expect(result.current.width).toBe(800);
  });

  it('toggles and closes the drawer', () => {
    const { result } = renderHook(() => useResizableDrawer({ persistKey: 'assembly:design-1' }));

    act(() => result.current.toggleOpen());
    expect(result.current.open).toBe(true);

    act(() => result.current.close());
    expect(result.current.open).toBe(false);
  });

  it('can start open for design drawers that should be visible by default', () => {
    const { result } = renderHook(() =>
      useResizableDrawer({ persistKey: 'assembly:design-1', defaultOpen: true })
    );

    expect(result.current.open).toBe(true);
  });

  it('persists width per design key without leakage', () => {
    const first = renderHook(() => useResizableDrawer({ persistKey: 'assembly:design-1' }));
    const second = renderHook(() => useResizableDrawer({ persistKey: 'assembly:design-2' }));

    act(() => first.result.current.setWidth(720));
    act(() => second.result.current.setWidth(560));

    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'resizable-drawer:assembly:design-1',
      '720'
    );
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'resizable-drawer:assembly:design-2',
      '560'
    );
    expect(first.result.current.width).toBe(720);
    expect(second.result.current.width).toBe(560);
  });

  it('restores and clamps width from localStorage', () => {
    localStorageMock.getItem.mockImplementation((key: string) =>
      key === 'resizable-drawer:assembly:design-1' ? '1200' : null
    );

    const { result } = renderHook(() => useResizableDrawer({ persistKey: 'assembly:design-1' }));

    expect(result.current.width).toBe(1100);

    act(() => result.current.setWidth(100));
    expect(result.current.width).toBe(480);
  });
});
