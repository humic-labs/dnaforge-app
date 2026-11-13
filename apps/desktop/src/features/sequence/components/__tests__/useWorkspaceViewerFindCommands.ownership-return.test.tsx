import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CommandScopeProvider } from '../../../../commands/CommandScopeProvider';
import { useCanvasStore } from '../../../canvas/public/store';
import { useWorkspaceViewerFindCommands } from '../useWorkspaceViewerFindCommands';

beforeEach(() => {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
});

afterEach(cleanup);

it.each([
  { surface: 'assembly', type: 'design', activeId: 'owner', generic: true, editing: false },
  { surface: 'sequence', type: 'sequence', activeId: 'owner', generic: true, editing: true },
  { surface: 'assembly', type: 'design', activeId: 'other', generic: false, editing: false },
] as const)(
  'returns generic=$generic and sequence=$editing ownership for $surface/$activeId',
  ({ surface, type, activeId, generic, editing }) => {
    useCanvasStore.getState().openTab('main', {
      type,
      entityId: activeId,
      label: activeId,
      sequenceDocument:
        type === 'sequence' ? { kind: 'catalog-sequence', entityId: activeId } : undefined,
    });
    const { result } = renderHook(
      () =>
        useWorkspaceViewerFindCommands({
          surface,
          commandEntityId: 'owner',
          isGapped: false,
          search: { isOpen: false, mode: 'nucleotide', openInMode: () => undefined },
        }),
      { wrapper: ({ children }) => <CommandScopeProvider>{children}</CommandScopeProvider> }
    );
    expect(result.current).toMatchObject({
      viewerCommandIsActive: generic,
      sequenceCommandIsActive: editing,
    });
  }
);
