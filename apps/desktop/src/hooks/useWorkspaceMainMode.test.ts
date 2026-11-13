import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWorkspaceMainMode } from './useWorkspaceMainMode';

const mockPanels = vi.hoisted(() => ({ current: {} as Record<string, { tabs: unknown[] }> }));

vi.mock('../features/canvas', () => ({
  useCanvasStore: (selector: (state: { panels: typeof mockPanels.current }) => unknown) =>
    selector({ panels: mockPanels.current }),
}));

describe('useWorkspaceMainMode', () => {
  it('keeps the canvas visible alongside the AI conversations sidebar', () => {
    mockPanels.current = { main: { tabs: [{ id: 'chat' }] } };
    const { result } = renderHook(() => useWorkspaceMainMode('ai', true));
    expect(result.current.featureViewActive).toBe(false);
    expect(result.current.workspaceTakeoverActive).toBe(false);
    expect(result.current.sidebarChromeVisible).toBe(true);
    expect(result.current.homeWorkbenchActive).toBe(false);
  });

  it('shows the Home workbench on empty Files and on Home, not on Search/Settings/open tabs', () => {
    mockPanels.current = {};
    const emptyFiles = renderHook(() => useWorkspaceMainMode('files', true));
    expect(emptyFiles.result.current.homeWorkbenchActive).toBe(true);
    expect(emptyFiles.result.current.emptyFilesHomeActive).toBe(true);
    expect(emptyFiles.result.current.workspaceTakeoverActive).toBe(false);

    const home = renderHook(() => useWorkspaceMainMode('home', false));
    expect(home.result.current.homeWorkbenchActive).toBe(true);
    expect(home.result.current.homeViewActive).toBe(true);
    expect(home.result.current.workspaceTakeoverActive).toBe(true);
    expect(home.result.current.sidebarChromeVisible).toBe(false);

    const search = renderHook(() => useWorkspaceMainMode('search', true));
    expect(search.result.current.homeWorkbenchActive).toBe(false);

    const settings = renderHook(() => useWorkspaceMainMode('settings', false));
    expect(settings.result.current.homeWorkbenchActive).toBe(false);
    expect(settings.result.current.settingsViewActive).toBe(true);
    expect(settings.result.current.workspaceTakeoverActive).toBe(true);
    expect(settings.result.current.sidebarChromeVisible).toBe(false);

    const references = renderHook(() => useWorkspaceMainMode('references', false));
    expect(references.result.current.referencesViewActive).toBe(true);
    expect(references.result.current.workspaceTakeoverActive).toBe(true);
    expect(references.result.current.sidebarChromeVisible).toBe(false);

    mockPanels.current = { main: { tabs: [{ id: 'open' }] } };
    const filesWithTabs = renderHook(() => useWorkspaceMainMode('files', true));
    expect(filesWithTabs.result.current.homeWorkbenchActive).toBe(false);
    expect(filesWithTabs.result.current.emptyFilesHomeActive).toBe(false);
  });
});
