import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSidebar } from './useSidebar';
import { readSidebarState, writeSidebarState } from '../shared/ui-persistence';

describe('useSidebar', () => {
  const defaultOptions = { toolboxBadge: '' };

  beforeEach(() => {
    localStorage.clear();
  });

  it('auto-opens the Toolbox on first launch while downloading (dev)', () => {
    const { result } = renderHook(() => useSidebar({ toolboxBadge: 'downloading' }));
    expect(result.current.activeView).toBe('toolbox');
  });

  it('does NOT auto-open the Toolbox in the shipped (production) build', () => {
    vi.stubEnv('DEV', false);
    try {
      const { result } = renderHook(() => useSidebar({ toolboxBadge: 'downloading' }));
      expect(result.current.activeView).toBe('files');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('initializes with default state', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    expect(result.current.activeView).toBe('files');
    expect(result.current.sidebarVisible).toBe(true);
    expect(result.current.sidebarWidth).toBe(260);
  });

  it('switches view without changing width for non-wide views', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    act(() => result.current.handleViewChange('search'));
    expect(result.current.activeView).toBe('search');
    expect(result.current.sidebarWidth).toBe(260);
  });

  it('opens AI Tools beside the canvas and restores its sidebar state', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    act(() => result.current.handleViewChange('ai'));
    expect(result.current.activeView).toBe('ai');
    expect(result.current.sidebarVisible).toBe(true);
    expect(readSidebarState()).toMatchObject({ activeView: 'ai', sidebarVisible: true });
  });

  it('opens Jobs as a normal left-sidebar view and persists the selection', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    act(() => result.current.handleViewChange('jobs'));

    expect(result.current.activeView).toBe('jobs');
    expect(result.current.sidebarVisible).toBe(true);
    expect(result.current.sidebarWidth).toBe(260);
    expect(readSidebarState().activeView).toBe('jobs');
  });

  it('opens settings as a workspace view without expanding the sidebar', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    act(() => result.current.handleViewChange('settings'));
    expect(result.current.activeView).toBe('settings');
    expect(result.current.sidebarVisible).toBe(false);
    expect(result.current.sidebarWidth).toBe(260);
  });

  it('opens home as a workspace view without expanding the sidebar', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    act(() => result.current.handleViewChange('home'));
    expect(result.current.activeView).toBe('home');
    expect(result.current.sidebarVisible).toBe(false);
    expect(result.current.sidebarWidth).toBe(260);
  });

  it('shows the sidebar again when leaving settings for a sidebar view', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    act(() => result.current.handleViewChange('settings'));
    expect(result.current.sidebarVisible).toBe(false);
    act(() => result.current.handleViewChange('files'));
    expect(result.current.sidebarVisible).toBe(true);
    expect(result.current.sidebarWidth).toBe(260);
  });

  it('shows the sidebar again when leaving home for a sidebar view', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    act(() => result.current.handleViewChange('home'));
    expect(result.current.sidebarVisible).toBe(false);
    act(() => result.current.handleViewChange('files'));
    expect(result.current.sidebarVisible).toBe(true);
    expect(result.current.sidebarWidth).toBe(260);
  });

  it('keeps the sidebar hidden across a workspace-view-to-workspace-view switch (home -> settings)', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    act(() => result.current.handleViewChange('home'));
    expect(result.current.sidebarVisible).toBe(false);
    act(() => result.current.handleViewChange('settings'));
    expect(result.current.activeView).toBe('settings');
    expect(result.current.sidebarVisible).toBe(false);
    expect(result.current.sidebarWidth).toBe(260);
  });

  it('shows sidebar when changing view while hidden', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    act(() => result.current.toggleSidebar());
    expect(result.current.sidebarVisible).toBe(false);
    act(() => result.current.handleViewChange('search'));
    expect(result.current.sidebarVisible).toBe(true);
  });

  it('toggles sidebar visibility', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    expect(result.current.sidebarVisible).toBe(true);
    act(() => result.current.toggleSidebar());
    expect(result.current.sidebarVisible).toBe(false);
    act(() => result.current.toggleSidebar());
    expect(result.current.sidebarVisible).toBe(true);
  });

  it('auto-opens toolbox view when toolboxBadge becomes downloading', () => {
    const { result, rerender } = renderHook(({ badge }) => useSidebar({ toolboxBadge: badge }), {
      initialProps: { badge: '' },
    });
    expect(result.current.activeView).toBe('files');
    rerender({ badge: 'downloading' });
    expect(result.current.activeView).toBe('toolbox');
  });

  it('only auto-opens toolbox once', () => {
    const { result, rerender } = renderHook(({ badge }) => useSidebar({ toolboxBadge: badge }), {
      initialProps: { badge: '' },
    });
    rerender({ badge: 'downloading' });
    expect(result.current.activeView).toBe('toolbox');

    act(() => result.current.handleViewChange('files'));
    rerender({ badge: '' });
    rerender({ badge: 'downloading' });
    expect(result.current.activeView).toBe('files');
  });

  it('handleOpenSettings opens settings as a workspace view', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    act(() => result.current.handleOpenSettings());
    expect(result.current.activeView).toBe('settings');
    expect(result.current.sidebarVisible).toBe(false);
    expect(result.current.sidebarWidth).toBe(260);
  });

  it('restores a persisted view, visibility and width', () => {
    writeSidebarState({ activeView: 'search', sidebarVisible: false, sidebarWidth: 340 });
    const { result } = renderHook(() => useSidebar(defaultOptions));
    expect(result.current.activeView).toBe('search');
    expect(result.current.sidebarVisible).toBe(false);
    expect(result.current.sidebarWidth).toBe(340);
  });

  it('persists a view switch', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    act(() => result.current.handleViewChange('lims'));
    expect(readSidebarState().activeView).toBe('lims');
  });

  it('persists a visibility toggle', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    act(() => result.current.toggleSidebar());
    expect(readSidebarState().sidebarVisible).toBe(false);
    act(() => result.current.toggleSidebar());
    expect(readSidebarState().sidebarVisible).toBe(true);
  });

  it('quitting from Settings restores to Files WITH the sidebar shown', () => {
    const { result, unmount } = renderHook(() => useSidebar(defaultOptions));
    act(() => result.current.handleOpenSettings());
    expect(readSidebarState().activeView).toBe('files');
    unmount();

    const relaunched = renderHook(() => useSidebar(defaultOptions));
    expect(relaunched.result.current.activeView).toBe('files');
    expect(relaunched.result.current.sidebarVisible).toBe(true);
  });
});

describe('useSidebar callback identity ', () => {
  const defaultOptions = { toolboxBadge: '' };

  function commitSidebar(result: { current: ReturnType<typeof useSidebar> }, width: number): void {
    act(() => {
      result.current.commitSidebarWidth(width);
    });
  }

  it('keeps handleViewChange stable across a committed sidebar resize', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    const before = result.current.handleViewChange;

    commitSidebar(result, 320);

    expect(result.current.sidebarWidth).not.toBe(260);
    expect(result.current.handleViewChange).toBe(before);
  });

  it('keeps commitSidebarWidth stable across a committed sidebar resize', () => {
    const { result } = renderHook(() => useSidebar(defaultOptions));
    const before = result.current.commitSidebarWidth;

    commitSidebar(result, 180);

    expect(result.current.sidebarWidth).not.toBe(260);
    expect(result.current.commitSidebarWidth).toBe(before);
  });
});
