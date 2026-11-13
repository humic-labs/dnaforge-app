import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../features/canvas/store';
import { __resetScreenTelemetryForTests } from '../lib/screen-telemetry';
import { ScreenViewTelemetryObserver } from './ScreenViewTelemetryObserver';

const analyticsMocks = vi.hoisted(() => ({
  trackRendererEvent: vi.fn(() => true),
  setAnalyticsScreenCategory: vi.fn(),
  isAnalyticsCaptureReady: vi.fn(() => true),
  subscribeAnalyticsCaptureReady: vi.fn(() => () => {}),
}));
vi.mock('../lib/analytics', () => analyticsMocks);

describe('ScreenViewTelemetryObserver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetScreenTelemetryForTests();
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [{ id: 'sequence-1', type: 'sequence', entityId: '/x.gb', label: 'x.gb' }],
          activeTabId: 'sequence-1',
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
    });
  });

  it('emits the restored active target once and survives remount duplication', () => {
    const props = {
      activeView: 'files' as const,
      hasActiveWorkspace: true,
      projectHomeVisible: false,
      ready: true,
    };
    const first = render(<ScreenViewTelemetryObserver {...props} />);
    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledWith('screen_viewed', {
      feature_area: 'navigation',
      screen_category: 'sequence',
      source_surface: 'startup',
    });
    first.unmount();
    render(<ScreenViewTelemetryObserver {...props} />);
    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledOnce();
  });

  it('ignores background tab mounts and emits the next committed active destination', async () => {
    const view = render(
      <ScreenViewTelemetryObserver
        activeView="files"
        hasActiveWorkspace={true}
        projectHomeVisible={false}
        ready={true}
      />
    );
    act(() => {
      useCanvasStore.setState((state) => ({
        panels: {
          ...state.panels,
          main: {
            ...state.panels.main,
            tabs: [
              ...state.panels.main.tabs,
              { id: 'design-1', type: 'design', entityId: 'design', label: 'Assembly' },
            ],
          },
        },
      }));
    });
    view.rerender(
      <ScreenViewTelemetryObserver
        activeView="files"
        hasActiveWorkspace={true}
        projectHomeVisible={false}
        ready={true}
      />
    );
    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledOnce();

    act(() => useCanvasStore.getState().setActiveTab('main', 'design-1'));
    await waitFor(() =>
      expect(analyticsMocks.trackRendererEvent).toHaveBeenLastCalledWith('screen_viewed', {
        feature_area: 'navigation',
        screen_category: 'assembly',
        source_surface: 'tab',
      })
    );
    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledTimes(2);
  });

  it('emits sidebar navigation only after the destination render commits', () => {
    const view = render(
      <ScreenViewTelemetryObserver
        activeView="files"
        hasActiveWorkspace={true}
        projectHomeVisible={false}
        ready={true}
      />
    );
    view.rerender(
      <ScreenViewTelemetryObserver
        activeView="search"
        hasActiveWorkspace={true}
        projectHomeVisible={false}
        ready={true}
      />
    );
    expect(analyticsMocks.trackRendererEvent).toHaveBeenLastCalledWith('screen_viewed', {
      feature_area: 'navigation',
      screen_category: 'search',
      source_surface: 'sidebar',
    });
  });

  it('names the welcome home view instead of leaving it unknown', () => {
    render(
      <ScreenViewTelemetryObserver
        activeView="home"
        hasActiveWorkspace={true}
        projectHomeVisible={false}
        ready={true}
      />
    );
    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledWith('screen_viewed', {
      feature_area: 'navigation',
      screen_category: 'home',
      source_surface: 'startup',
    });
  });

  it('names a chat tab and keeps a notebook tab as page', async () => {
    const view = render(
      <ScreenViewTelemetryObserver
        activeView="files"
        hasActiveWorkspace={true}
        projectHomeVisible={false}
        ready={true}
      />
    );
    act(() => {
      useCanvasStore.setState({
        panels: {
          main: {
            id: 'main',
            tabs: [{ id: 'chat-1', type: 'chat', entityId: 'chat', label: 'Ask AI' }],
            activeTabId: 'chat-1',
          },
        },
        focusedPanelId: 'main',
      });
    });
    view.rerender(
      <ScreenViewTelemetryObserver
        activeView="files"
        hasActiveWorkspace={true}
        projectHomeVisible={false}
        ready={true}
      />
    );
    await waitFor(() =>
      expect(analyticsMocks.trackRendererEvent).toHaveBeenLastCalledWith('screen_viewed', {
        feature_area: 'navigation',
        screen_category: 'chat',
        source_surface: 'tab',
      })
    );

    act(() => {
      useCanvasStore.setState({
        panels: {
          main: {
            id: 'main',
            tabs: [{ id: 'page-1', type: 'page', entityId: 'page', label: 'Notes' }],
            activeTabId: 'page-1',
          },
        },
        focusedPanelId: 'main',
      });
    });
    view.rerender(
      <ScreenViewTelemetryObserver
        activeView="files"
        hasActiveWorkspace={true}
        projectHomeVisible={false}
        ready={true}
      />
    );
    await waitFor(() =>
      expect(analyticsMocks.trackRendererEvent).toHaveBeenLastCalledWith('screen_viewed', {
        feature_area: 'navigation',
        screen_category: 'page',
        source_surface: 'tab',
      })
    );
  });
});
