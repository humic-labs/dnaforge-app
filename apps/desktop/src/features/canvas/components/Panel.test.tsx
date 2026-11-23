/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Panel } from './Panel';
import { registerTerminalTabCloser } from '../../terminal/terminal-opening';

import { documentLifecycle } from '../../../shared/document-lifecycle';
import {
  saveDocumentTargetId,
  type SaveDocumentTarget,
} from '../../../shared/save-document-events';

const pendingSaves = new Map<string, (success: boolean) => void>();
const saveKey = (target: SaveDocumentTarget) => `${target.kind}:${saveDocumentTargetId(target)}`;
beforeEach(() => {
  pendingSaves.clear();
  vi.spyOn(documentLifecycle, 'save').mockImplementation(
    (target) =>
      new Promise<boolean>((resolve) => {
        pendingSaves.set(saveKey(target), resolve);
      })
  );
  vi.spyOn(documentLifecycle, 'discard').mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());
function completeSave(detail: SaveDocumentTarget & { success: boolean }) {
  const key = saveKey(detail);
  pendingSaves.get(key)?.(detail.success);
  pendingSaves.delete(key);
}

import type { PanelState, Tab } from '../types';
import { consumeSequenceTabCloseGesture } from '../../../shared/tab-close-gesture';

const mockSetActiveTab = vi.fn();
const mockCloseTab = vi.fn();
const mockReorderTab = vi.fn();
const mockFocusPanel = vi.fn();
const mockUpdateTab = vi.fn();
const mockFindTab = vi.fn();
const mockSetTabViewState = vi.fn();
const metadataMocks = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock('../../entity-details/public/editing-sessions', () => ({
  findUnsettledEntityDetailsSession: metadataMocks.find,
}));
const { mockObserveWorkflowAction } = vi.hoisted(() => ({
  mockObserveWorkflowAction: vi.fn(),
}));
const canvasRuntime = vi.hoisted(() => ({
  panels: {} as Record<string, PanelState>,
  focusedPanelId: null as string | null,
}));

vi.mock('../../../lib/workflow-telemetry', () => ({
  observeWorkflowAction: mockObserveWorkflowAction,
}));

vi.mock('../store', () => ({
  useCanvasStore: Object.assign(
    (selector: (state: unknown) => unknown) => {
      const state = {
        setActiveTab: mockSetActiveTab,
        closeTab: mockCloseTab,
        reorderTab: mockReorderTab,
        focusPanel: mockFocusPanel,
        updateTab: mockUpdateTab,
        findTab: mockFindTab,
      };
      return selector(state);
    },
    {
      subscribe: () => () => undefined,
      getState: () => ({
        setActiveTab: mockSetActiveTab,
        panels: canvasRuntime.panels,
        focusedPanelId: canvasRuntime.focusedPanelId,
        setTabViewState: mockSetTabViewState,
      }),
    }
  ),
}));

vi.mock('../dragStore', () => ({
  useDragStore: () => ({
    isDragging: false,
    dropTargetPanelId: null,
    dropInsertIndex: null,
    dragTabId: null,
  }),
}));

vi.mock('../../page/store', () => ({
  usePageStore: () => ({
    updatePageTitle: vi.fn(),
  }),
}));

vi.mock('./PanelContent', () => ({
  PanelContent: ({ tab }: { tab: Tab }) => (
    <div data-testid="panel-content">Content for {tab.label}</div>
  ),
}));

describe('Panel', () => {
  const createTab = (overrides: Partial<Tab> = {}): Tab => ({
    id: 'tab-1',
    type: 'text',
    entityId: '/path/to/file.ts',
    label: 'file.ts',
    isDirty: false,
    ...overrides,
  });

  const createPanel = (overrides: Partial<PanelState> = {}): PanelState => ({
    id: 'panel-1',
    tabs: [createTab()],
    activeTabId: 'tab-1',
    ...overrides,
  });

  function renderPanel(panel: PanelState, isFocused: boolean) {
    canvasRuntime.panels = { ...canvasRuntime.panels, [panel.id]: panel };
    if (isFocused) canvasRuntime.focusedPanelId = panel.id;
    return render(<Panel panel={panel} isFocused={isFocused} />);
  }
  const switchReceipts = () =>
    mockObserveWorkflowAction.mock.calls
      .filter(([input]) => input.action === 'switch_tab')
      .map(([input]) => input);

  beforeEach(() => {
    vi.clearAllMocks();
    metadataMocks.find.mockReset();
    mockObserveWorkflowAction.mockReset();
    canvasRuntime.panels = {};
    canvasRuntime.focusedPanelId = null;
    mockSetActiveTab.mockImplementation((panelId: string, tabId: string) => {
      const panel = canvasRuntime.panels[panelId];
      if (!panel || !panel.tabs.some((tab) => tab.id === tabId)) return;
      canvasRuntime.panels = {
        ...canvasRuntime.panels,
        [panelId]: { ...panel, activeTabId: tabId },
      };
      canvasRuntime.focusedPanelId = panelId;
    });
  });

  it('records a user-visible tab switch but not a click on the active tab', () => {
    const second = createTab({ id: 'tab-2', label: 'second.ts' });
    const panel = createPanel({ tabs: [createTab(), second] });
    canvasRuntime.panels = { [panel.id]: panel };
    canvasRuntime.focusedPanelId = panel.id;
    const view = renderPanel(panel, true);

    fireEvent.mouseDown(screen.getByTestId('tab-tab-2'), { button: 0 });
    fireEvent.mouseUp(document);
    expect(mockSetActiveTab).toHaveBeenCalledWith('panel-1', 'tab-2');
    expect(switchReceipts()).toHaveLength(0);

    view.rerender(<Panel panel={{ ...panel, activeTabId: 'tab-2' }} isFocused={true} />);
    expect(switchReceipts()).toEqual([
      expect.objectContaining({
        workflow: 'navigation',
        action: 'switch_tab',
        status: 'completed',
      }),
    ]);

    mockObserveWorkflowAction.mockClear();
    fireEvent.mouseDown(screen.getByTestId('tab-tab-2'), { button: 0 });
    fireEvent.mouseUp(document);
    expect(switchReceipts()).toHaveLength(0);
  });

  it('does not record a requested tab switch when the store rejects the change', () => {
    const second = createTab({ id: 'tab-2', label: 'second.ts' });
    const panel = createPanel({ tabs: [createTab(), second] });
    canvasRuntime.panels = { [panel.id]: panel };
    canvasRuntime.focusedPanelId = panel.id;
    mockSetActiveTab.mockImplementation(() => undefined);
    const view = renderPanel(panel, true);

    fireEvent.mouseDown(screen.getByTestId('tab-tab-2'), { button: 0 });
    fireEvent.mouseUp(document);
    view.rerender(<Panel panel={{ ...panel, activeTabId: 'tab-2' }} isFocused={true} />);

    expect(switchReceipts()).toHaveLength(0);
  });

  it('distinguishes accepted intent, placement and same-active no-op without leaking identities', () => {
    const panel = createPanel({ tabs: [createTab(), createTab({ id: 'tab-2' })] });
    const view = renderPanel(panel, true);
    fireEvent.mouseDown(screen.getByTestId('tab-tab-2'), { button: 0 });
    fireEvent.mouseUp(document);
    const accepted = mockObserveWorkflowAction.mock.calls[0][0];
    expect(accepted).toMatchObject({ action: 'select', status: 'selected', resultCount: 1 });
    expect(switchReceipts()).toHaveLength(0);
    view.rerender(<Panel panel={canvasRuntime.panels[panel.id]} isFocused={true} />);
    expect(switchReceipts()).toEqual([
      expect.objectContaining({
        action: 'switch_tab',
        status: 'completed',
        actionId: accepted.actionId,
        operationId: accepted.operationId,
      }),
    ]);
    mockObserveWorkflowAction.mockClear();
    mockSetActiveTab.mockClear();
    fireEvent.mouseDown(screen.getByTestId('tab-tab-2'), { button: 0 });
    fireEvent.mouseUp(document);
    expect(mockSetActiveTab).not.toHaveBeenCalled();
    expect(mockObserveWorkflowAction.mock.calls[0][0]).toMatchObject({
      action: 'select',
      status: 'completed',
      resultCount: 0,
      cached: true,
    });
    expect(switchReceipts()).toHaveLength(0);
  });

  it.each(['focus-lost', 'retargeted', 'removed'] as const)(
    'cancels a pending placement after %s before the requested pane snapshot commits',
    (change) => {
      const panel = createPanel({ tabs: [createTab(), createTab({ id: 'tab-2' })] });
      const view = renderPanel(panel, true);
      fireEvent.mouseDown(screen.getByTestId('tab-tab-2'), { button: 0 });
      fireEvent.mouseUp(document);
      const current = canvasRuntime.panels[panel.id];
      if (change === 'focus-lost') canvasRuntime.focusedPanelId = 'another-panel';
      else
        canvasRuntime.panels[panel.id] = {
          ...current,
          tabs:
            change === 'removed'
              ? current.tabs.filter((tab) => tab.id !== 'tab-2')
              : current.tabs.map((tab) =>
                  tab.id === 'tab-2' ? { ...tab, entityId: '/replacement.txt' } : tab
                ),
        };
      view.rerender(
        <Panel panel={canvasRuntime.panels[panel.id]} isFocused={change !== 'focus-lost'} />
      );
      expect(switchReceipts()).toHaveLength(0);
      expect(mockObserveWorkflowAction.mock.calls.map(([input]) => input)).toContainEqual(
        expect.objectContaining({ action: 'select', status: 'cancelled', errorClass: 'superseded' })
      );
    }
  );

  it('releases a pending placement on unmount without a completed switch receipt', () => {
    const panel = createPanel({ tabs: [createTab(), createTab({ id: 'tab-2' })] });
    const view = renderPanel(panel, true);
    fireEvent.mouseDown(screen.getByTestId('tab-tab-2'), { button: 0 });
    fireEvent.mouseUp(document);
    view.unmount();
    expect(switchReceipts()).toHaveLength(0);
    expect(mockObserveWorkflowAction.mock.calls.map(([input]) => input)).toContainEqual(
      expect.objectContaining({ action: 'select', status: 'cancelled', errorClass: 'unmounted' })
    );
  });

  it('commits the same product navigation when telemetry throws', () => {
    const panel = createPanel({ tabs: [createTab(), createTab({ id: 'tab-2' })] });
    mockObserveWorkflowAction.mockImplementation(() => {
      throw new Error('collector unavailable');
    });
    const view = renderPanel(panel, true);
    fireEvent.mouseDown(screen.getByTestId('tab-tab-2'), { button: 0 });
    fireEvent.mouseUp(document);
    expect(canvasRuntime.panels[panel.id].activeTabId).toBe('tab-2');
    expect(() =>
      view.rerender(<Panel panel={canvasRuntime.panels[panel.id]} isFocused={true} />)
    ).not.toThrow();
    mockObserveWorkflowAction.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('focuses the pane on a pointer press in its content, before click', () => {
    const panel = createPanel();
    const view = renderPanel(panel, false);
    const content = view.container.querySelector('[data-panel-content]')!;

    fireEvent.pointerDown(content);

    expect(mockFocusPanel).toHaveBeenCalledWith(panel.id);
  });

  it.each([true, false])(
    'respects the terminal session owner when closing a tab (%s)',
    async (allowed) => {
      const tab = createTab({ type: 'terminal', entityId: 'terminal-view', label: 'Shell' });
      const panel = createPanel({ tabs: [tab] });
      const approve = vi.fn(
        async (_viewId: string, stillOwned: () => boolean) => allowed && stillOwned()
      );
      const unregister = registerTerminalTabCloser(approve);
      try {
        renderPanel(panel, true);
        await act(async () => {
          fireEvent.click(screen.getByTestId('tab-close-tab-1'));
        });
        expect(approve).toHaveBeenCalledWith(tab.entityId, expect.any(Function));
        expect(mockCloseTab).toHaveBeenCalledTimes(allowed ? 1 : 0);
      } finally {
        unregister();
      }
    }
  );

  describe('close confirmation for dirty tabs', () => {
    it('reopens an unsettled metadata session instead of allowing a tab discard to bypass it', () => {
      const tab = createTab({
        type: 'primer',
        entityId: 'registered-oligo',
        isDirty: true,
      });
      const showError = vi.fn();
      metadataMocks.find.mockReturnValue({ target: { entityId: 'registered-oligo' }, showError });
      const panel = createPanel({ tabs: [tab] });
      renderPanel(panel, true);
      fireEvent.click(screen.getByTestId('tab-close-tab-1'));
      expect(mockCloseTab).not.toHaveBeenCalled();
      expect(mockSetActiveTab).toHaveBeenCalledWith(panel.id, tab.id);
      expect(mockSetTabViewState).toHaveBeenCalledWith(panel.id, tab.id, {
        entityDetailsOpen: true,
        entityDetailsEntityId: 'registered-oligo',
      });
      expect(showError).toHaveBeenCalledWith(
        expect.stringContaining('metadata changes before closing')
      );
      expect(mockObserveWorkflowAction.mock.calls.map(([input]) => input)).toContainEqual(
        expect.objectContaining({
          action: 'dismiss',
          status: 'blocked',
          outcomeKind: 'canvas_close',
          success: false,
        })
      );
      expect(screen.queryByText('Do you want to save changes?')).not.toBeInTheDocument();
    });
    it('shows confirmation dialog when closing a dirty tab', async () => {
      const dirtyTab = createTab({ isDirty: true });
      const panel = createPanel({ tabs: [dirtyTab] });

      renderPanel(panel, true);

      const closeButton = screen.getByLabelText(/close file\.ts/i);
      fireEvent.click(closeButton);

      await waitFor(() => {
        expect(screen.getByText('Do you want to save changes?')).toBeInTheDocument();
      });
    });

    it('closes tab immediately when not dirty', async () => {
      const cleanTab = createTab({ isDirty: false });
      const panel = createPanel({ tabs: [cleanTab] });

      renderPanel(panel, true);

      const closeButton = screen.getByLabelText(/close file/i);
      fireEvent.click(closeButton);

      expect(mockCloseTab).toHaveBeenCalledWith('panel-1', 'tab-1');
      expect(screen.queryByText('Do you want to save changes?')).not.toBeInTheDocument();
    });

    it('closes dialog and tab when "Don\'t Save" is clicked', async () => {
      const dirtyTab = createTab({ isDirty: true });
      const panel = createPanel({ tabs: [dirtyTab] });

      renderPanel(panel, true);

      const closeButton = screen.getByLabelText(/close file/i);
      fireEvent.click(closeButton);

      await waitFor(() => {
        expect(screen.getByText('Do you want to save changes?')).toBeInTheDocument();
      });

      await act(async () => fireEvent.click(screen.getByRole('button', { name: "Don't Save" })));
      expect(documentLifecycle.discard).toHaveBeenCalledWith(
        { kind: 'file', filePath: dirtyTab.entityId },
        dirtyTab.id
      );

      expect(mockCloseTab).toHaveBeenCalledWith('panel-1', 'tab-1');

      await waitFor(() => {
        expect(screen.queryByText('Do you want to save changes?')).not.toBeInTheDocument();
      });
    });

    it('closes dialog without closing tab when "Cancel" is clicked', async () => {
      const dirtyTab = createTab({ isDirty: true });
      const panel = createPanel({ tabs: [dirtyTab] });

      renderPanel(panel, true);

      const closeButton = screen.getByLabelText(/close file/i);
      fireEvent.click(closeButton);

      await waitFor(() => {
        expect(screen.getByText('Do you want to save changes?')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(mockCloseTab).not.toHaveBeenCalled();

      await waitFor(() => {
        expect(screen.queryByText('Do you want to save changes?')).not.toBeInTheDocument();
      });
    });

    it('does not leave a sequence close token when confirmation is cancelled before a tab switch', async () => {
      const dirtySequence = createTab({
        id: 'sequence-dirty',
        type: 'sequence',
        entityId: 'sequence-document:dirty',
        isDirty: true,
      });
      const otherTab = createTab({ id: 'other-tab', entityId: '/path/to/other.txt' });
      const panel = createPanel({
        tabs: [dirtySequence, otherTab],
        activeTabId: dirtySequence.id,
      });
      const view = renderPanel(panel, true);

      fireEvent.click(screen.getByTestId(`tab-close-${dirtySequence.id}`));
      await waitFor(() => {
        expect(screen.getByText('Do you want to save changes?')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      view.rerender(<Panel panel={{ ...panel, activeTabId: otherTab.id }} isFocused={true} />);

      expect(mockCloseTab).not.toHaveBeenCalled();
      expect(consumeSequenceTabCloseGesture(dirtySequence.id)).toBeUndefined();
    });

    it('saves through the file owner when "Save" is clicked for a text tab', async () => {
      const dirtyTab = createTab({
        isDirty: true,
        entityId: '/path/to/testfile.ts',
      });
      const panel = createPanel({ tabs: [dirtyTab] });

      const saveRequestHandler = vi.mocked(documentLifecycle.save);

      renderPanel(panel, true);

      const closeButton = screen.getByLabelText(/close file/i);
      fireEvent.click(closeButton);

      await waitFor(() => {
        expect(screen.getByText('Do you want to save changes?')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(saveRequestHandler).toHaveBeenCalled();
      expect(saveRequestHandler.mock.calls[0]).toEqual([
        {
          kind: 'file',
          filePath: '/path/to/testfile.ts',
        },
        'tab-1',
      ]);
    });

    it('saves through a sequence-document owner without presenting the ID as a file path', async () => {
      const dirtyTab = createTab({
        type: 'sequence',
        isDirty: true,
        entityId: 'sequence-package-01',
      });
      const panel = createPanel({ tabs: [dirtyTab] });

      const saveRequestHandler = vi.mocked(documentLifecycle.save);

      renderPanel(panel, true);
      fireEvent.click(screen.getByLabelText(/close file/i));
      await waitFor(() => {
        expect(screen.getByText('Do you want to save changes?')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(saveRequestHandler.mock.calls[0]).toEqual([
        {
          kind: 'sequence-document',
          documentId: 'sequence-package-01',
        },
        'tab-1',
      ]);
    });

    it('cannot discard an embedded assembly working copy through the sequence close dialog', async () => {
      const tab = createTab({
        type: 'sequence',
        entityId: 'sequence-package-01',
        assemblyEditDesignId: 'package-copy-1',
        isDirty: true,
      });
      const panel = createPanel({ tabs: [tab] });
      const onDiscard = vi.mocked(documentLifecycle.discard);
      renderPanel(panel, true);
      fireEvent.click(screen.getByLabelText(/close file/i));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: "Don't Save" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(mockCloseTab).not.toHaveBeenCalled();
      expect(onDiscard).not.toHaveBeenCalled();
    });

    it('uses the stable tab save target for an unsaved artifact draft', async () => {
      const dirtyTab = createTab({
        type: 'design',
        entityId: 'assembly-draft:1',
        label: 'Untitled Assembly',
        isDirty: true,
        artifactDocument: {
          kind: 'assembly',
          persistence: 'draft',
          workspaceRoot: '/workspace',
          destinationPath: '/workspace/assemblies',
        },
      });
      const panel = createPanel({ tabs: [dirtyTab] });
      const saveRequestHandler = vi.mocked(documentLifecycle.save);

      renderPanel(panel, true);
      fireEvent.click(screen.getByLabelText(/close untitled assembly/i));
      fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

      expect(saveRequestHandler.mock.calls[0]).toEqual([
        {
          kind: 'tab',
          tabId: 'tab-1',
        },
        'tab-1',
      ]);
      await act(async () => {
        completeSave({ kind: 'tab', tabId: 'tab-1', success: true });
      });
      await waitFor(() => expect(mockCloseTab).toHaveBeenCalledWith('panel-1', 'tab-1'));
    });

    it('handles an editor Cancel through the same dirty close confirmation', async () => {
      const dirtyTab = createTab({ isDirty: true });
      const panel = createPanel({ tabs: [dirtyTab] });
      renderPanel(panel, true);

      act(() => {
        window.dispatchEvent(
          new CustomEvent('artifact-document-close-request', {
            detail: { panelId: 'panel-1', tabIds: ['tab-1'] },
          })
        );
      });

      expect(await screen.findByText('Do you want to save changes?')).toBeInTheDocument();
      expect(mockCloseTab).not.toHaveBeenCalled();
    });

    it('uses one ordered close queue for pristine drafts and multiple dirty tabs', async () => {
      const pristineDraft = createTab({
        id: 'draft-tab',
        type: 'design',
        entityId: 'assembly-draft:1',
        label: 'Untitled Assembly',
        artifactDocument: {
          kind: 'assembly',
          persistence: 'draft',
          workspaceRoot: '/workspace',
          destinationPath: '/workspace/assemblies',
        },
      });
      const firstDirty = createTab({ id: 'dirty-one', label: 'first.txt', isDirty: true });
      const secondDirty = createTab({ id: 'dirty-two', label: 'second.txt', isDirty: true });
      const panel = createPanel({ tabs: [pristineDraft, firstDirty, secondDirty] });
      renderPanel(panel, true);
      act(() => {
        window.dispatchEvent(
          new CustomEvent('artifact-document-close-request', {
            detail: { panelId: panel.id, tabIds: panel.tabs.map((tab) => tab.id) },
          })
        );
      });

      expect(mockCloseTab).toHaveBeenCalledWith(panel.id, pristineDraft.id);
      expect(documentLifecycle.discard).toHaveBeenCalledWith(
        { kind: 'tab', tabId: pristineDraft.id },
        pristineDraft.id
      );
      expect(await screen.findByRole('dialog')).toHaveTextContent('first.txt');

      fireEvent.click(screen.getByRole('button', { name: "Don't Save" }));
      await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('second.txt'));
      expect(mockCloseTab).toHaveBeenCalledWith(panel.id, firstDirty.id);
      expect(mockCloseTab).not.toHaveBeenCalledWith(panel.id, secondDirty.id);

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('closes tab after its save promise succeeds', async () => {
      const dirtyTab = createTab({
        isDirty: true,
        entityId: '/path/to/testfile.ts',
      });
      const panel = createPanel({ tabs: [dirtyTab] });

      renderPanel(panel, true);

      const closeButton = screen.getByLabelText(/close file/i);
      fireEvent.click(closeButton);

      await waitFor(() => {
        expect(screen.getByText('Do you want to save changes?')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await act(async () => {
        completeSave({
          kind: 'file',
          filePath: '/path/to/testfile.ts',
          success: true,
        });
      });

      await waitFor(() => {
        expect(mockCloseTab).toHaveBeenCalledWith('panel-1', 'tab-1');
      });

      await waitFor(() => {
        expect(screen.queryByText('Do you want to save changes?')).not.toBeInTheDocument();
      });
    });

    it('does not close tab if its save promise returns false', async () => {
      const dirtyTab = createTab({
        isDirty: true,
        entityId: '/path/to/testfile.ts',
      });
      const panel = createPanel({ tabs: [dirtyTab] });

      renderPanel(panel, true);

      const closeButton = screen.getByLabelText(/close file/i);
      fireEvent.click(closeButton);

      await waitFor(() => {
        expect(screen.getByText('Do you want to save changes?')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await act(async () => {
        completeSave({
          kind: 'file',
          filePath: '/path/to/testfile.ts',
          success: false,
        });
      });

      expect(mockCloseTab).not.toHaveBeenCalled();

      await waitFor(() => {
        expect(screen.queryByText('Do you want to save changes?')).not.toBeInTheDocument();
      });
    });

    it('ignores another document owner finishing its save', async () => {
      const dirtyTab = createTab({
        isDirty: true,
        entityId: '/path/to/testfile.ts',
      });
      const panel = createPanel({ tabs: [dirtyTab] });

      renderPanel(panel, true);

      const closeButton = screen.getByLabelText(/close file/i);
      fireEvent.click(closeButton);

      await waitFor(() => {
        expect(screen.getByText('Do you want to save changes?')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await act(async () => {
        completeSave({
          kind: 'file',
          filePath: '/different/file.ts',
          success: true,
        });
      });

      expect(mockCloseTab).not.toHaveBeenCalled();

      expect(mockCloseTab).not.toHaveBeenCalled();
      expect(screen.queryByText('Do you want to save changes?')).not.toBeInTheDocument();
    });
  });
});
