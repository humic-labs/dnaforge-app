// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isApplePlatform } from '@waypoint/ui-components/keyboard';
import { CommandScopeProvider, useCommandRegistry } from '../../../commands/CommandScopeProvider';
import { getHighestActiveFocusScope } from '../../../commands/commandRegistry';
import { useCommandScope } from '../../../commands/useCommandScope';
import { COMMAND_SCOPES } from '../../../commands/types';
import { useWorkspaceViewerFindCommands } from '../../sequence/public/components/useWorkspaceViewerFindCommands';
import { Panel } from './Panel';
import { TabPortalProvider } from './TabContentPortalManager';
import { useCanvasStore } from '../store';
import type { Tab } from '../types';

const found = vi.fn();
let readFocusScope: () => string | null = () => null;

vi.mock('./PanelContent', () => ({
  PanelContent: ({ tab }: { tab: Tab }) => <SequenceFindProbe tab={tab} />,
}));
vi.mock('../../page/public/embeds/structure3d/molstar/cache', () => ({
  getPaneRendererHostCacheKey: (key: string) => key,
  acquireCachedViewerLease: vi.fn(),
  releaseCachedViewerLease: vi.fn(),
}));
vi.mock('../../../lib/workflow-telemetry', () => ({ observeWorkflowAction: vi.fn() }));
vi.mock('../../memory-pressure/public', async (original) => ({
  ...(await original<typeof import('../../memory-pressure/public')>()),
  useMemoryPressureMonitoring: vi.fn(),
}));

function SequenceFindProbe({ tab }: { tab: Tab }) {
  const { sequenceScope } = useWorkspaceViewerFindCommands({
    surface: 'sequence',
    commandEntityId: tab.entityId,
    isGapped: false,
    search: { isOpen: false, mode: 'nucleotide', openInMode: () => found(tab.label) },
  });
  return (
    <div data-testid={`body-${tab.id}`} {...sequenceScope.eventHandlers}>
      {tab.label}
    </div>
  );
}

function FileTreeSurface() {
  const scope = useCommandScope(COMMAND_SCOPES.sidebarFileTree);
  return (
    <button type="button" {...scope.eventHandlers}>
      file tree
    </button>
  );
}

function FocusScopeReader() {
  const { getDebugState } = useCommandRegistry();
  readFocusScope = () => getHighestActiveFocusScope(new Set(getDebugState().activeScopes));
  return null;
}

function Scene() {
  const panels = useCanvasStore((state) => state.panels);
  const focused = useCanvasStore((state) => state.focusedPanelId);
  return (
    <CommandScopeProvider>
      <FocusScopeReader />
      <FileTreeSurface />
      <TabPortalProvider>
        {Object.values(panels).map((panel) => (
          <Panel key={panel.id} panel={panel} isFocused={focused === panel.id} />
        ))}
      </TabPortalProvider>
    </CommandScopeProvider>
  );
}

function selectTab(tabId: string) {
  const tab = screen.getByTestId(`tab-${tabId}`);
  fireEvent.pointerDown(tab, { button: 0 });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.mouseUp(document, { button: 0 });
}

function pressFind() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'f',
        code: 'KeyF',
        metaKey: isApplePlatform(),
        ctrlKey: !isApplePlatform(),
        bubbles: true,
        cancelable: true,
      })
    );
  });
}

let left: string;
let right: string;

function sequenceTab(entityId: string, label: string): Omit<Tab, 'id'> {
  return {
    type: 'sequence',
    entityId,
    label,
    sequenceDocument: { kind: 'catalog-sequence', entityId },
  };
}

beforeEach(() => {
  found.mockClear();
  useCanvasStore.getState().reset();
  const store = useCanvasStore.getState();
  left = store.openTab('main', sequenceTab('sequence-document-a', 'A'));
  const rightPanel = store.splitPanel('main', 'vertical');
  right = store.openTab(rightPanel, sequenceTab('sequence-document-b', 'B'));
  store.focusPanel(rightPanel);
});

afterEach(() => {
  cleanup();
  useCanvasStore.getState().reset();
});

describe('Panel content command scope', () => {
  it('opens Find in the document of the pane selected by its tab', () => {
    render(<Scene />);

    selectTab(right);
    pressFind();
    expect(found.mock.calls).toEqual([['B']]);

    selectTab(left);
    pressFind();
    selectTab(right);
    pressFind();
    expect(found.mock.calls).toEqual([['B'], ['A'], ['B']]);
  });

  it('gives Find back to the selected document after the file tree had focus', () => {
    render(<Scene />);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'file tree' }));
    expect(readFocusScope()).toBe(COMMAND_SCOPES.sidebarFileTree);
    pressFind();
    expect(found).not.toHaveBeenCalled();

    selectTab(right);
    expect(readFocusScope()).toBe(COMMAND_SCOPES.tabSequence);
    pressFind();
    expect(found.mock.calls).toEqual([['B']]);
  });
});
