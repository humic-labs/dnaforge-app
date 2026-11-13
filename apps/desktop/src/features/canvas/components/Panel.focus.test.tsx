/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { Panel } from './Panel';
import { TabPortalProvider } from './TabContentPortalManager';
import { useCanvasStore } from '../store';
import type { Tab } from '../types';
import { CommandScopeProvider } from '../../../commands/CommandScopeProvider';

vi.mock('./PanelContent', () => ({
  PanelContent: ({ tab }: { tab: Tab }) => (
    <div>
      <span data-testid={`body-${tab.id}`}>Content for {tab.label}</span>
      <button
        data-testid={`control-${tab.id}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        Document control
      </button>
      <input aria-label={`Edit ${tab.label}`} defaultValue="Existing text" />
    </div>
  ),
}));

vi.mock('../../page/public/embeds/structure3d/molstar/cache', () => ({
  getPaneRendererHostCacheKey: (key: string) => key,
  acquireCachedViewerLease: vi.fn(),
  releaseCachedViewerLease: vi.fn(),
}));

vi.mock('../../../lib/workflow-telemetry', () => ({ observeWorkflowAction: vi.fn() }));

vi.mock('../../memory-pressure/public', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory-pressure/public')>()),
  useMemoryPressureMonitoring: vi.fn(),
}));

function Panes() {
  const panels = useCanvasStore((state) => state.panels);
  const focusedPanelId = useCanvasStore((state) => state.focusedPanelId);
  return (
    <CommandScopeProvider>
      <TabPortalProvider>
        {Object.values(panels).map((panel) => (
          <Panel key={panel.id} panel={panel} isFocused={focusedPanelId === panel.id} />
        ))}
      </TabPortalProvider>
    </CommandScopeProvider>
  );
}

describe('Pane focus through stable tab portals', () => {
  let rightPanelId: string;
  let leftTabs: string[];
  let rightTabs: string[];

  beforeEach(() => {
    useCanvasStore.getState().reset();
    const store = useCanvasStore.getState();
    leftTabs = ['Left one', 'Left two'].map((label) =>
      store.openTab('main', { type: 'text', entityId: `/pane-focus/${label}.txt`, label })
    );
    rightPanelId = store.splitPanel('main', 'vertical');
    rightTabs = ['Right one', 'Right two', 'Right three'].map((label) =>
      store.openTab(rightPanelId, { type: 'text', entityId: `/pane-focus/${label}.txt`, label })
    );
    store.focusPanel('main');
  });

  afterEach(() => {
    cleanup();
    useCanvasStore.getState().reset();
  });

  it('routes both shortcut directions and wraparound to the clicked portal body', () => {
    render(<Panes />);

    fireEvent.pointerDown(screen.getByTestId(`body-${rightTabs[2]}`));
    expect(useCanvasStore.getState().focusedPanelId).toBe(rightPanelId);

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(useCanvasStore.getState().panels[rightPanelId].activeTabId).toBe(rightTabs[0]);
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(useCanvasStore.getState().panels[rightPanelId].activeTabId).toBe(rightTabs[2]);
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(leftTabs[1]);

    fireEvent.pointerDown(screen.getByTestId(`body-${leftTabs[1]}`));
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(useCanvasStore.getState().focusedPanelId).toBe('main');
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(leftTabs[0]);
    expect(useCanvasStore.getState().panels[rightPanelId].activeTabId).toBe(rightTabs[2]);
  });

  it('captures presses before a document control stops event propagation', () => {
    render(<Panes />);
    fireEvent.pointerDown(screen.getByTestId(`control-${rightTabs[2]}`));
    expect(useCanvasStore.getState().focusedPanelId).toBe(rightPanelId);
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(useCanvasStore.getState().panels[rightPanelId].activeTabId).toBe(rightTabs[0]);
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(leftTabs[1]);
  });

  it('preserves editable control focus and input', () => {
    render(<Panes />);
    const input = screen.getByRole('textbox', { name: 'Edit Right three' });
    fireEvent.pointerDown(input);
    input.focus();
    fireEvent.change(input, { target: { value: 'Still editable' } });
    expect(useCanvasStore.getState().focusedPanelId).toBe(rightPanelId);
    expect(input).toHaveFocus();
    expect(input).toHaveValue('Still editable');
  });

  it('uses the new pane owner after a portal host moves between panes', () => {
    render(<Panes />);
    act(() => {
      useCanvasStore.getState().moveTab('main', rightPanelId, leftTabs[1]);
      useCanvasStore.getState().focusPanel('main');
    });
    fireEvent.pointerDown(screen.getByTestId(`body-${leftTabs[1]}`));
    expect(useCanvasStore.getState().focusedPanelId).toBe(rightPanelId);
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(useCanvasStore.getState().panels[rightPanelId].activeTabId).toBe(rightTabs[2]);
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(leftTabs[0]);
  });

  it('focuses empty pane content and removes its listener on unmount', () => {
    act(() => {
      const store = useCanvasStore.getState();
      rightTabs.forEach((tabId) => store.closeTab(rightPanelId, tabId));
      rightPanelId = store.splitPanel('main', 'vertical');
      store.focusPanel('main');
    });
    const view = render(<Panes />);
    const content = view.container.querySelector(`[data-panel-content="${rightPanelId}"]`)!;
    fireEvent.pointerDown(content);
    expect(useCanvasStore.getState().focusedPanelId).toBe(rightPanelId);

    act(() => useCanvasStore.getState().focusPanel('main'));
    view.unmount();
    fireEvent.pointerDown(content);
    expect(useCanvasStore.getState().focusedPanelId).toBe('main');
  });
});
