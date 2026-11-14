import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandScopeProvider } from '../../../commands/CommandScopeProvider';
import { useCommandScope } from '../../../commands/useCommandScope';
import { COMMAND_SCOPES } from '../../../commands/types';
import { PresentationBoundary } from '../../../presentation/PresentationSurface';
import { TAB_TYPES, type Tab } from '../types';
import { useCanvasStore } from '../store';
import { Panel } from './Panel';
import { TabPortalProvider } from './TabContentPortalManager';

vi.mock('./PanelContent', () => ({
  PanelContent: ({ tab }: { tab: Tab }) => {
    const scope = useCommandScope(COMMAND_SCOPES.inputEditor);
    const consume = (event: import('react').KeyboardEvent) => {
      event.stopPropagation();
      if (event.ctrlKey) event.preventDefault();
    };
    return (
      <div {...scope.eventHandlers}>
        <input data-testid={`input-${tab.id}`} defaultValue="Retained input" onKeyDown={consume} />
        <textarea
          data-testid={`textarea-${tab.id}`}
          defaultValue="Retained text"
          onKeyDown={consume}
        />
        <div
          contentEditable
          suppressContentEditableWarning
          data-testid={`editable-${tab.id}`}
          onKeyDown={consume}
        >
          Retained notebook text
        </div>
        <div data-terminal-surface>
          <textarea
            data-testid={`terminal-${tab.id}`}
            defaultValue="Retained terminal input"
            onKeyDown={consume}
          />
        </div>
      </div>
    );
  },
}));
vi.mock('../../page/public/embeds/structure3d/molstar/cache', () => ({
  getPaneRendererHostCacheKey: (key: string) => key,
  acquireCachedViewerLease: vi.fn(),
  releaseCachedViewerLease: vi.fn(),
}));
vi.mock('../../../lib/workflow-telemetry', () => ({ observeWorkflowAction: vi.fn() }));
vi.mock('@waypoint/genome-renderer/react', async () => ({
  HiddenMapIdlePolicyContext: (await import('react')).createContext('host-retained'),
}));
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

function press(target: EventTarget, ctrlKey: boolean, shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    code: 'Tab',
    ctrlKey,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => useCanvasStore.getState().reset());
afterEach(() => {
  cleanup();
  useCanvasStore.getState().reset();
});

describe('focused pane tab navigation', () => {
  it.each(TAB_TYPES)('cycles in both directions from focused widgets in a %s tab', (type) => {
    const store = useCanvasStore.getState();
    const other = store.openTab('main', {
      type: 'text',
      entityId: '/synthetic/other.txt',
      label: 'Other',
    });
    const subject = store.openTab('main', {
      type,
      entityId: type === 'sequence' ? 'synthetic-sequence' : `/synthetic/${type}`,
      label: `Subject ${type}`,
      ...(type === 'sequence'
        ? {
            sequenceDocument: { kind: 'catalog-sequence' as const, entityId: 'synthetic-sequence' },
          }
        : {}),
    });
    render(<Scene />);

    for (const widget of ['input', 'textarea', 'editable', 'terminal']) {
      for (const reverse of [false, true]) {
        fireEvent.click(screen.getByRole('tab', { name: `Subject ${type}` }));
        const target = screen.getByTestId(`${widget}-${subject}`);
        fireEvent.pointerDown(target);
        act(() => target.focus());

        const event = press(target, true, reverse);

        expect(event.defaultPrevented, `${widget}, reverse=${reverse}`).toBe(true);
        expect(
          useCanvasStore.getState().panels.main.activeTabId,
          `${widget}, reverse=${reverse}`
        ).toBe(other);
      }
    }
    fireEvent.click(screen.getByRole('tab', { name: `Subject ${type}` }));
    expect(screen.getByTestId(`input-${subject}`)).toHaveValue('Retained input');
    expect(screen.getByTestId(`textarea-${subject}`)).toHaveValue('Retained text');
    expect(screen.getByTestId(`editable-${subject}`)).toHaveTextContent('Retained notebook text');
    expect(screen.getByTestId(`terminal-${subject}`)).toHaveValue('Retained terminal input');
  });

  it('leaves unmodified Tab and Shift+Tab with the focused editor', () => {
    const store = useCanvasStore.getState();
    store.openTab('main', { type: 'text', entityId: '/synthetic/other.txt', label: 'Other' });
    const notebook = store.openTab('main', {
      type: 'page',
      entityId: '/synthetic/notebook.md',
      label: 'Notebook',
    });
    render(<Scene />);
    const target = screen.getByTestId(`editable-${notebook}`);
    act(() => target.focus());

    expect(press(target, false).defaultPrevented).toBe(false);
    expect(press(target, false, true).defaultPrevented).toBe(false);
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(notebook);
  });

  it('keeps navigation in the pane containing the focused editor', () => {
    const store = useCanvasStore.getState();
    const left = store.openTab('main', {
      type: 'page',
      entityId: '/synthetic/left.md',
      label: 'Left',
    });
    store.openTab('main', { type: 'text', entityId: '/synthetic/left.txt', label: 'Left other' });
    const right = store.splitPanel('main', 'vertical');
    const rightOther = store.openTab(right, {
      type: 'text',
      entityId: '/synthetic/right.txt',
      label: 'Right other',
    });
    const rightPage = store.openTab(right, {
      type: 'page',
      entityId: '/synthetic/right.md',
      label: 'Right',
    });
    store.focusPanel('main');
    render(<Scene />);
    const target = screen.getByTestId(`editable-${rightPage}`);
    fireEvent.pointerDown(target);
    act(() => target.focus());

    press(target, true);

    expect(useCanvasStore.getState().focusedPanelId).toBe(right);
    expect(useCanvasStore.getState().panels[right].activeTabId).toBe(rightOther);
    expect(useCanvasStore.getState().panels.main.activeTabId).not.toBe(left);
  });

  it('does not move document tabs when a separate terminal dock owns focus', () => {
    const store = useCanvasStore.getState();
    store.openTab('main', { type: 'text', entityId: '/synthetic/other.txt', label: 'Other' });
    const notebook = store.openTab('main', {
      type: 'page',
      entityId: '/synthetic/notebook.md',
      label: 'Notebook',
    });
    render(
      <Scene>
        <PresentationBoundary id="separate-terminal-dock">
          <div data-terminal-surface>
            <textarea aria-label="Separate terminal" />
          </div>
        </PresentationBoundary>
      </Scene>
    );
    const terminal = screen.getByLabelText('Separate terminal');
    act(() => terminal.focus());

    expect(press(terminal, true).defaultPrevented).toBe(false);
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(notebook);
  });
});
