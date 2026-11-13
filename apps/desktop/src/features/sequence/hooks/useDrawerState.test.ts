import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { drawerRequiresEditingAccess, useDrawerState } from './useDrawerState';

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

describe('useDrawerState', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it.each([
    ['git-history', true, false],
    ['git-history', false, true],
    ['annotations', true, true],
    ['primers', true, true],
  ] as const)(
    'requires editing access for %s with managed History %s: %s',
    (drawer, managed, expected) => {
      expect(drawerRequiresEditingAccess(drawer, managed)).toBe(expected);
    }
  );

  it('starts with no active drawer', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    expect(result.current.activeDrawer).toBeNull();
    expect(result.current.isDrawerOpen).toBe(false);
  });

  it('restores an alignment review for the same document and respects an explicit close', () => {
    const first = renderHook(() => useDrawerState('sequence-document:clone-review'));
    act(() => first.result.current.openDrawer('alignments'));
    first.unmount();
    const reopened = renderHook(() => useDrawerState('sequence-document:clone-review'));
    expect(reopened.result.current.activeDrawer).toBe('alignments');
    const unrelated = renderHook(() => useDrawerState('sequence-document:other'));
    expect(unrelated.result.current.activeDrawer).toBeNull();
    unrelated.unmount();
    act(() => reopened.result.current.closeDrawer());
    reopened.unmount();
    expect(
      renderHook(() => useDrawerState('sequence-document:clone-review')).result.current.activeDrawer
    ).toBeNull();
  });

  it('opens a drawer', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    act(() => result.current.toggleDrawer('annotations'));
    expect(result.current.activeDrawer).toBe('annotations');
    expect(result.current.isDrawerOpen).toBe(true);
  });

  it('closes drawer when toggling the same one', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    act(() => result.current.toggleDrawer('annotations'));
    act(() => result.current.toggleDrawer('annotations'));
    expect(result.current.activeDrawer).toBeNull();
  });

  it('switches drawer when toggling a different one', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    act(() => result.current.toggleDrawer('annotations'));
    act(() => result.current.toggleDrawer('alignments'));
    expect(result.current.activeDrawer).toBe('alignments');
  });

  it('openDrawer opens without toggling closed when the same drawer is already active', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    act(() => result.current.openDrawer('structure'));
    act(() => result.current.openDrawer('structure'));
    expect(result.current.activeDrawer).toBe('structure');
    expect(result.current.isDrawerOpen).toBe(true);
  });

  it('openDrawer switches drawers and clears annotation edit target', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    act(() => result.current.openToAnnotation(7));
    act(() => result.current.openDrawer('structure'));
    expect(result.current.activeDrawer).toBe('structure');
    expect(result.current.editTargetIndex).toBeNull();
  });

  it('getDrawerWidth can read the structure width before the drawer is the local active drawer', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    expect(result.current.getDrawerWidth('structure')).toBe(480);
  });

  it('uses default width of 350', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    act(() => result.current.toggleDrawer('annotations'));
    expect(result.current.drawerWidth).toBe(350);
  });

  it('gives the primer drawer a wider default and retains a resized width', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    expect(result.current.getDrawerWidth('primers')).toBe(360);
    act(() => result.current.openDrawer('primers'));
    expect(result.current.drawerWidth).toBe(360);
    act(() => result.current.setDrawerWidth(390));
    act(() => result.current.closeDrawer());
    act(() => result.current.openDrawer('primers'));
    expect(result.current.drawerWidth).toBe(390);
  });

  it('persists width to localStorage per drawer+filePath combo', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    act(() => result.current.toggleDrawer('annotations'));
    act(() => result.current.setDrawerWidth(400));
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'drawer-width:annotations:/path/to/file.gb',
      '400'
    );
  });

  it('restores width from localStorage', () => {
    localStorageMock.getItem.mockImplementation((key: string) =>
      key === 'drawer-width:annotations:/path/to/file.gb' ? '420' : null
    );
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    act(() => result.current.toggleDrawer('annotations'));
    expect(result.current.drawerWidth).toBe(420);
  });

  it('clamps width to min 250 and max 800', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    act(() => result.current.toggleDrawer('annotations'));
    act(() => result.current.setDrawerWidth(100));
    expect(result.current.drawerWidth).toBe(250);
    act(() => result.current.setDrawerWidth(2000));
    expect(result.current.drawerWidth).toBe(800);
  });

  it('closeDrawer closes any open drawer', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    act(() => result.current.toggleDrawer('alignments'));
    act(() => result.current.closeDrawer());
    expect(result.current.activeDrawer).toBeNull();
  });

  it('openToAnnotation opens annotations drawer and sets edit target', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    act(() => result.current.openToAnnotation(3));
    expect(result.current.activeDrawer).toBe('annotations');
    expect(result.current.editTargetIndex).toBe(3);
    expect(result.current.isDrawerOpen).toBe(true);
  });

  it('editTargetIndex resets to null when toggling drawer', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    act(() => result.current.openToAnnotation(3));
    act(() => result.current.toggleDrawer('annotations'));
    expect(result.current.editTargetIndex).toBeNull();
  });

  it('clearEditTarget clears the edit target index', () => {
    const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
    act(() => result.current.openToAnnotation(3));
    act(() => result.current.clearEditTarget());
    expect(result.current.editTargetIndex).toBeNull();
    expect(result.current.activeDrawer).toBe('annotations');
  });

  describe('git-history drawer type', () => {
    it('toggleDrawer opens the git-history drawer', () => {
      const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
      act(() => result.current.toggleDrawer('git-history'));
      expect(result.current.activeDrawer).toBe('git-history');
      expect(result.current.isDrawerOpen).toBe(true);
    });

    it('toggling git-history again closes it', () => {
      const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
      act(() => result.current.toggleDrawer('git-history'));
      act(() => result.current.toggleDrawer('git-history'));
      expect(result.current.activeDrawer).toBeNull();
      expect(result.current.isDrawerOpen).toBe(false);
    });

    it('opening git-history while annotations is open switches to git-history', () => {
      const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
      act(() => result.current.toggleDrawer('annotations'));
      expect(result.current.activeDrawer).toBe('annotations');
      act(() => result.current.toggleDrawer('git-history'));
      expect(result.current.activeDrawer).toBe('git-history');
    });

    it('persists width to localStorage with git-history key', () => {
      const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
      act(() => result.current.toggleDrawer('git-history'));
      act(() => result.current.setDrawerWidth(500));
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'drawer-width:git-history:/path/to/file.gb',
        '500'
      );
    });

    it('opening git-history clears editTargetIndex', () => {
      const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));
      act(() => result.current.openToAnnotation(5));
      expect(result.current.editTargetIndex).toBe(5);
      act(() => result.current.toggleDrawer('git-history'));
      expect(result.current.editTargetIndex).toBeNull();
      expect(result.current.activeDrawer).toBe('git-history');
    });
  });

  describe('restriction-enzymes drawer type', () => {
    it('opens as a first-class drawer and switches away from other drawers', () => {
      const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));

      act(() => result.current.toggleDrawer('annotations'));
      act(() => result.current.toggleDrawer('restriction-enzymes'));

      expect(result.current.activeDrawer).toBe('restriction-enzymes');
      expect(result.current.isDrawerOpen).toBe(true);
      expect(result.current.drawerWidth).toBe(350);
    });

    it('persists width with a restriction-enzymes-specific key', () => {
      const { result } = renderHook(() => useDrawerState('/path/to/file.gb'));

      act(() => result.current.toggleDrawer('restriction-enzymes'));
      act(() => result.current.setDrawerWidth(390));

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'drawer-width:restriction-enzymes:/path/to/file.gb',
        '390'
      );
    });
  });
});
