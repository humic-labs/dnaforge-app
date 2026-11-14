import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandScopeProvider } from '../../../commands/CommandScopeProvider';
import { PresentationBoundary } from '../../../presentation/PresentationSurface';
import { useCanvasStore } from '../store';
import type { Tab } from '../types';
import { Panel } from './Panel';
import { TabPortalProvider } from './TabContentPortalManager';

const native = vi.hoisted(() => ({
  listeners: new Map<string, Set<(request: { frameName: string; direction: 1 | -1 }) => void>>(),
}));
vi.mock('../../../platform', async (original) => {
  const real = await original<typeof import('../../../platform')>();
  return {
    ...real,
    platform: () => ({
      ...real.platform(),
      on: (channel: string, callback: (...args: never[]) => void) => {
        const listener = (request: { frameName: string; direction: 1 | -1 }) =>
          Reflect.apply(callback, undefined, [request]);
        const listeners = native.listeners.get(channel) ?? new Set();
        listeners.add(listener);
        native.listeners.set(channel, listeners);
        return () => listeners.delete(listener);
      },
    }),
  };
});
vi.mock('./PanelContent', () => ({
  PanelContent: ({ tab }: { tab: Tab }) =>
    tab.type === 'html' ? (
      <iframe data-testid={`frame-${tab.id}`} name={`dnaforge-tab-frame:${tab.id}`} sandbox="" />
    ) : (
      <input aria-label={tab.label} />
    ),
}));
vi.mock('../../page/public/embeds/structure3d/molstar/cache', () => ({
  getPaneRendererHostCacheKey: (key: string) => key,
  acquireCachedViewerLease: vi.fn(),
  releaseCachedViewerLease: vi.fn(),
}));
vi.mock('@waypoint/genome-renderer/react', async () => ({
  HiddenMapIdlePolicyContext: (await import('react')).createContext('host-retained'),
}));
vi.mock('../../../lib/workflow-telemetry', () => ({ observeWorkflowAction: vi.fn() }));
vi.mock('../../memory-pressure/public', async (original) => ({
  ...(await original<typeof import('../../memory-pressure/public')>()),
  useMemoryPressureMonitoring: vi.fn(),
}));

function Scene({ children }: { children?: import('react').ReactNode }) {
  const panels = useCanvasStore((state) => state.panels);
  const focused = useCanvasStore((state) => state.focusedPanelId);
  return (
    <CommandScopeProvider>
      {children}
      <TabPortalProvider>
        {Object.values(panels).map((panel) => (
          <Panel key={panel.id} panel={panel} isFocused={focused === panel.id} />
        ))}
      </TabPortalProvider>
    </CommandScopeProvider>
  );
}

function openPair(panel = 'main') {
  const store = useCanvasStore.getState();
  const other = store.openTab(panel, {
    type: 'text',
    entityId: `/synthetic/${panel}.txt`,
    label: `Other ${panel}`,
  });
  const html = store.openTab(panel, {
    type: 'html',
    entityId: `/synthetic/${panel}.html`,
    label: `HTML ${panel}`,
  });
  return { other, html };
}

function deliver(frameName: string, direction: 1 | -1) {
  act(() => {
    for (const listener of native.listeners.get('window:frame-tab-navigation') ?? [])
      listener({ frameName, direction });
  });
}

beforeEach(() => {
  native.listeners.clear();
  useCanvasStore.getState().reset();
});
afterEach(() => {
  cleanup();
  useCanvasStore.getState().reset();
});

it.each([1, -1] as const)(
  'routes native frame direction %s through the current pane command',
  (direction) => {
    const { other, html } = openPair();
    render(<Scene />);
    const frame = screen.getByTestId(`frame-${html}`);
    act(() => frame.focus());
    expect(frame).toHaveFocus();

    deliver(frame.getAttribute('name')!, direction);

    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(other);
    expect(frame).toHaveAttribute('sandbox', '');
  }
);

it('rejects a delayed delivery for a replaced iframe', () => {
  const { html } = openPair();
  render(<Scene />);
  const frame = screen.getByTestId(`frame-${html}`);
  act(() => frame.focus());

  deliver('dnaforge-tab-frame:retired', 1);

  expect(useCanvasStore.getState().panels.main.activeTabId).toBe(html);
});

it('rejects frame delivery after focus moved to an ordinary document control', () => {
  const { other, html } = openPair();
  render(<Scene />);
  const frame = screen.getByTestId(`frame-${html}`);
  act(() => {
    useCanvasStore.getState().setActiveTab('main', other);
  });
  act(() => screen.getByLabelText('Other main').focus());

  deliver(frame.getAttribute('name')!, 1);

  expect(useCanvasStore.getState().panels.main.activeTabId).toBe(other);
});

it('uses the pane containing the active iframe even when prior canvas focus belongs elsewhere', () => {
  const left = openPair();
  const rightPanel = useCanvasStore.getState().splitPanel('main', 'vertical');
  const right = openPair(rightPanel);
  useCanvasStore.getState().focusPanel('main');
  render(<Scene />);
  const frame = screen.getByTestId(`frame-${right.html}`);
  act(() => frame.focus());
  expect(useCanvasStore.getState().focusedPanelId).toBe('main');

  deliver(frame.getAttribute('name')!, 1);

  expect(useCanvasStore.getState().focusedPanelId).toBe(rightPanel);
  expect(useCanvasStore.getState().panels[rightPanel].activeTabId).toBe(right.other);
  expect(useCanvasStore.getState().panels.main.activeTabId).toBe(left.html);
});

it.each(['modal', 'keyboard'] as const)(
  'preserves a %s overlay above native frame navigation',
  (capture) => {
    const { html } = openPair();
    render(
      <Scene>
        <PresentationBoundary capture={capture}>
          <div role="dialog">Blocking overlay</div>
        </PresentationBoundary>
      </Scene>
    );
    const frame = screen.getByTestId(`frame-${html}`);
    act(() => frame.focus());

    deliver(frame.getAttribute('name')!, 1);

    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(html);
  }
);

it('unsubscribes the native transport when the pane unmounts', () => {
  openPair();
  const view = render(<Scene />);
  view.unmount();
  expect(native.listeners.get('window:frame-tab-navigation')?.size ?? 0).toBe(0);
});
