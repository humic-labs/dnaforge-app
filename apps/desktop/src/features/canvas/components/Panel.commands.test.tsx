import { PresentationBoundary } from '../../../presentation/PresentationSurface';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { CommandScopeProvider } from '../../../commands/CommandScopeProvider';
import { useCommandScope } from '../../../commands/useCommandScope';
import { COMMAND_IDS, COMMAND_SCOPES, type CommandScope } from '../../../commands/types';
import { Panel } from './Panel';

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

import { TabPortalProvider } from './TabContentPortalManager';
import { useCanvasStore } from '../store';
import type { Tab } from '../types';
import { observeWorkflowAction } from '../../../lib/workflow-telemetry';

vi.mock('./PanelContent', () => ({
  PanelContent: ({ tab }: { tab: Tab }) => (
    <div data-testid={`body-${tab.id}`}>Synthetic document</div>
  ),
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

function Scope({ scope }: { scope: CommandScope }) {
  useCommandScope(scope, { claimOnMount: true });
  return null;
}
function Panes({ duplicateFocus = false }: { duplicateFocus?: boolean }) {
  const panels = useCanvasStore((state) => state.panels);
  const focused = useCanvasStore((state) => state.focusedPanelId);
  return (
    <TabPortalProvider>
      {Object.values(panels).map((panel) => (
        <Panel key={panel.id} panel={panel} isFocused={duplicateFocus || focused === panel.id} />
      ))}
    </TabPortalProvider>
  );
}
function Scene({
  children,
  show = true,
  duplicateFocus = false,
}: {
  children?: import('react').ReactNode;
  show?: boolean;
  duplicateFocus?: boolean;
}) {
  return (
    <CommandScopeProvider>
      {children}
      {show && <Panes duplicateFocus={duplicateFocus} />}
    </CommandScopeProvider>
  );
}
function press(target: EventTarget = window, shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    ctrlKey: true,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}
const active = (panel: string) => useCanvasStore.getState().panels[panel]?.activeTabId;

let left: string[];
let right: string[];
let rightPanel: string;
beforeEach(() => {
  vi.clearAllMocks();
  useCanvasStore.getState().reset();
  const store = useCanvasStore.getState();
  left = ['A', 'B', 'C'].map((label) =>
    store.openTab('main', {
      type: 'text',
      entityId: `/synthetic/F29-left-${label}.txt`,
      label: `Left ${label}`,
    })
  );
  rightPanel = store.splitPanel('main', 'vertical');
  right = ['A', 'B'].map((label) =>
    store.openTab(rightPanel, {
      type: 'text',
      entityId: `/synthetic/F29-right-${label}.txt`,
      label: `Right ${label}`,
    })
  );
  store.focusPanel('main');
});
afterEach(() => {
  cleanup();
  useCanvasStore.getState().reset();
});

describe('CV2 real Panel/store/command authority', () => {
  it('wraps both directions only in the pointer-selected pane', async () => {
    render(<Scene />);
    fireEvent.pointerDown(screen.getByTestId(`body-${right[1]}`));
    expect(press().defaultPrevented).toBe(true);
    expect(active(rightPanel)).toBe(right[0]);
    expect(active('main')).toBe(left[2]);
    expect(press(window, true).defaultPrevented).toBe(true);
    expect(active(rightPanel)).toBe(right[1]);
    fireEvent.pointerDown(screen.getByTestId(`body-${left[2]}`));
    press();
    expect(active('main')).toBe(left[0]);
    press(window, true);
    expect(active('main')).toBe(left[2]);
  });

  it('uses live store state for repeated keys before a React rerender', async () => {
    render(<Scene />);
    act(() => {
      for (let n = 0; n < 4; n++)
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Tab',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          })
        );
    });
    expect(active('main')).toBe(left[0]);
  });

  it('blocks an independent true modal without consuming its intended key, then resumes', async () => {
    const observed = vi.fn();
    const view = render(
      <Scene>
        <PresentationBoundary capture="modal">
          <div role="dialog" aria-modal="true">
            <button onKeyDown={(event) => observed(event.defaultPrevented)}>Modal control</button>
          </div>
        </PresentationBoundary>
      </Scene>
    );
    const event = press(screen.getByRole('button', { name: 'Modal control' }));
    expect(active('main')).toBe(left[2]);
    expect(event.defaultPrevented).toBe(false);
    expect(observed).toHaveBeenCalledWith(false);
    view.rerender(<Scene />);
    press();
    expect(active('main')).toBe(left[0]);
  });

  it('retains ordinary cycling through a bare non-modal dialog', async () => {
    render(
      <Scene>
        <div role="dialog">
          <button>Bare control</button>
        </div>
      </Scene>
    );
    expect(press(screen.getByRole('button', { name: 'Bare control' })).defaultPrevented).toBe(true);
    expect(active('main')).toBe(left[0]);
  });

  it('blocks cycling behind the actual tab context menu and releases the claim on close', async () => {
    render(<Scene />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: /Left C/ }), { clientX: 5, clientY: 5 });
    expect(screen.getByTestId('tab-context-menu')).toBeVisible();
    expect(press().defaultPrevented).toBe(false);
    expect(active('main')).toBe(left[2]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('tab-context-menu')).toBeNull();
    press();
    expect(active('main')).toBe(left[0]);
  });

  it.each([COMMAND_SCOPES.menuContext])('respects claimed %s without consuming', (scope) => {
    const view = render(
      <Scene>
        <Scope scope={scope} />
      </Scene>
    );
    expect(press().defaultPrevented).toBe(false);
    expect(active('main')).toBe(left[2]);
    view.rerender(<Scene />);
    press();
    expect(active('main')).toBe(left[0]);
  });

  it('leaves explicitly owned and already-consumed events with their targets', async () => {
    const widget = vi.fn();
    render(
      <Scene>
        <div data-command-shortcut-owner={COMMAND_IDS.canvasNextTab}>
          <button onKeyDown={widget}>Owned control</button>
        </div>
      </Scene>
    );
    expect(press(screen.getByRole('button', { name: 'Owned control' })).defaultPrevented).toBe(
      false
    );
    expect(active('main')).toBe(left[2]);
    expect(widget).toHaveBeenCalledTimes(1);
    const consumed = new KeyboardEvent('keydown', {
      key: 'Tab',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    consumed.preventDefault();
    act(() => window.dispatchEvent(consumed));
    expect(active('main')).toBe(left[2]);
  });

  it('never registers more than the actual focused pane even if two prop snapshots claim focus', async () => {
    render(<Scene duplicateFocus />);
    press();
    expect(active('main')).toBe(left[0]);
    expect(active(rightPanel)).toBe(right[1]);
    act(() => useCanvasStore.setState({ focusedPanelId: null }));
    expect(press().defaultPrevented).toBe(false);
    expect(active('main')).toBe(left[0]);
  });

  it('focuses the actual pointer pane even when stale props already claim both panes are focused', async () => {
    render(<Scene duplicateFocus />);
    fireEvent.pointerDown(screen.getByTestId(`body-${right[1]}`));
    expect(useCanvasStore.getState().focusedPanelId).toBe(rightPanel);
    expect(press().defaultPrevented).toBe(true);
    expect(active(rightPanel)).toBe(right[0]);
    expect(active('main')).toBe(left[2]);
  });

  it('leaves one-tab and unmounted panes as no-ops, then binds the current remount', async () => {
    act(() => {
      useCanvasStore.getState().closeTab('main', left[0]);
      useCanvasStore.getState().closeTab('main', left[1]);
    });
    const view = render(<Scene />);
    expect(press().defaultPrevented).toBe(false);
    expect(active('main')).toBe(left[2]);
    view.rerender(<Scene show={false} />);
    const before = active(rightPanel);
    act(() => useCanvasStore.getState().focusPanel(rightPanel));
    expect(press().defaultPrevented).toBe(false);
    expect(active(rightPanel)).toBe(before);
    view.rerender(<Scene />);
    press();
    expect(active(rightPanel)).toBe(right[0]);
  });

  it.each(['Cancel', "Don't Save", 'Save'] as const)(
    'keeps dirty-close %s bound to its document while cycling is blocked',
    async (choice) => {
      act(() => useCanvasStore.getState().updateTab('main', left[2], { isDirty: true }));
      render(<Scene />);
      fireEvent.click(screen.getByTestId(`tab-close-${left[2]}`));
      expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
      expect(press().defaultPrevented).toBe(false);
      expect(press(window, true).defaultPrevented).toBe(false);
      expect(active('main')).toBe(left[2]);
      await act(async () => fireEvent.click(screen.getByRole('button', { name: choice })));
      if (choice === 'Save') {
        expect(documentLifecycle.save).toHaveBeenCalledExactlyOnceWith(
          { kind: 'file', filePath: '/synthetic/F29-left-C.txt' },
          left[2]
        );
        expect(press().defaultPrevented).toBe(false);
        expect(active('main')).toBe(left[2]);
        await act(async () =>
          completeSave({ kind: 'file', filePath: '/synthetic/F29-left-C.txt', success: false })
        );
        expect(active('main')).toBe(left[2]);
      } else if (choice === "Don't Save") {
        expect(useCanvasStore.getState().panels.main.tabs.some((tab) => tab.id === left[2])).toBe(
          false
        );
      } else expect(active('main')).toBe(left[2]);
      const prior = active('main');
      expect(press().defaultPrevented).toBe(true);
      expect(active('main')).not.toBe(prior);
      expect(active(rightPanel)).toBe(right[1]);
    }
  );
});

describe('CV1 real Panel/store guarded close ownership', () => {
  const filePath = '/synthetic/F29-left-C.txt';
  async function complete(detail: SaveDocumentTarget & { success: boolean }) {
    await act(async () => completeSave(detail));
  }
  function requestClose() {
    act(() => useCanvasStore.getState().updateTab('main', left[2], { isDirty: true }));
    render(<Scene />);
    fireEvent.click(screen.getByTestId(`tab-close-${left[2]}`));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  }
  const targetStillOpen = () =>
    useCanvasStore.getState().panels.main.tabs.some((tab) => tab.id === left[2]);
  const closeReceipts = () =>
    vi
      .mocked(observeWorkflowAction)
      .mock.calls.map(([input]) => input)
      .filter((input) => input.outcomeKind?.startsWith('canvas_close'));

  it.each(['Save', "Don't Save"] as const)(
    'routes notebook %s through its page target',
    async (choice) => {
      act(() =>
        useCanvasStore.getState().updateTab('main', left[2], {
          type: 'page',
          entityId: 'synthetic-page',
          isDirty: true,
        })
      );
      render(<Scene />);
      fireEvent.click(screen.getByTestId(`tab-close-${left[2]}`));
      await act(async () => fireEvent.click(screen.getByRole('button', { name: choice })));
      if (choice === 'Save') {
        expect(documentLifecycle.save).toHaveBeenCalledExactlyOnceWith(
          { kind: 'page', pageId: 'synthetic-page' },
          left[2]
        );
        expect(targetStillOpen()).toBe(true);
        await complete({ kind: 'file', filePath: 'synthetic-page', success: true });
        expect(targetStillOpen()).toBe(true);
        await complete({ kind: 'page', pageId: 'synthetic-page', success: true });
      } else {
        expect(documentLifecycle.discard).toHaveBeenCalledExactlyOnceWith(
          { kind: 'page', pageId: 'synthetic-page' },
          left[2]
        );
      }
      expect(targetStillOpen()).toBe(false);
      expect(active(rightPanel)).toBe(right[1]);
    }
  );

  it('observes an unanswered confirmation and Cancel without a completed removal', async () => {
    requestClose();
    await complete({ kind: 'file', filePath, success: true });
    expect(closeReceipts()).toHaveLength(1);
    expect(closeReceipts()[0]).toMatchObject({
      outcomeKind: 'canvas_close',
      status: 'selected',
      resultCount: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(closeReceipts()).toHaveLength(2);
    expect(closeReceipts()[1]).toMatchObject({
      status: 'cancelled',
      success: false,
      operationId: closeReceipts()[0].operationId,
    });
    expect(closeReceipts().some((input) => input.phase === 'commit')).toBe(false);
    expect(targetStillOpen()).toBe(true);
  });

  it('observes Save choice as waiting and removal only after the matching controlled owner result', async () => {
    requestClose();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(closeReceipts()).toHaveLength(2);
    expect(closeReceipts()[1]).toMatchObject({
      outcomeKind: 'canvas_close_save',
      status: 'needs_action',
      resultCount: 0,
    });
    expect(closeReceipts().some((input) => input.phase === 'commit')).toBe(false);
    await complete({ kind: 'file', filePath, success: true });
    expect(closeReceipts()).toHaveLength(3);
    expect(closeReceipts()[2]).toMatchObject({
      outcomeKind: 'canvas_close',
      phase: 'commit',
      status: 'completed',
      resultCount: 1,
      operationId: closeReceipts()[0].operationId,
    });
    expect(closeReceipts().some((input) => input.status === 'saved')).toBe(false);
    expect(targetStillOpen()).toBe(false);
  });

  it('separates discard confirmation from the actual tab removal', async () => {
    requestClose();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: "Don't Save" })));
    expect(closeReceipts().map((input) => [input.outcomeKind, input.phase])).toEqual([
      ['canvas_close', 'result'],
      ['canvas_close_discard', 'result'],
      ['canvas_close', 'commit'],
    ]);
    expect(targetStillOpen()).toBe(false);
  });

  it('ignores same-target completion before the user has chosen Save', async () => {
    requestClose();
    await complete({ kind: 'file', filePath, success: true });
    expect(targetStillOpen()).toBe(true);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(active('main')).toBe(left[2]);
    expect(active(rightPanel)).toBe(right[1]);
    expect(press().defaultPrevented).toBe(false);
  });

  it('ignores another target and a different target kind with the same string identity', async () => {
    requestClose();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await complete({ kind: 'file', filePath: '/synthetic/unrelated.txt', success: true });
    await complete({ kind: 'tab', tabId: filePath, success: true });
    expect(targetStillOpen()).toBe(true);
    expect(press().defaultPrevented).toBe(false);
    await complete({ kind: 'file', filePath, success: true });
    expect(targetStillOpen()).toBe(false);
    expect(active(rightPanel)).toBe(right[1]);
    expect(press().defaultPrevented).toBe(true);
  });

  it('keeps Cancel final when a late completion arrives and a new confirmation is unanswered', async () => {
    requestClose();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await complete({ kind: 'file', filePath, success: true });
    expect(targetStillOpen()).toBe(true);
    fireEvent.click(screen.getByTestId(`tab-close-${left[2]}`));
    await complete({ kind: 'file', filePath, success: true });
    expect(targetStillOpen()).toBe(true);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('preserves the document after failure and permits a deliberate Save retry', async () => {
    requestClose();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await complete({ kind: 'file', filePath, success: false });
    expect(targetStillOpen()).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await complete({ kind: 'file', filePath, success: true });
    expect(targetStillOpen()).toBe(true);
    fireEvent.click(screen.getByTestId(`tab-close-${left[2]}`));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await complete({ kind: 'file', filePath, success: true });
    expect(targetStillOpen()).toBe(false);
  });

  it('accepts an immediately resolved promise from the requested owner port', async () => {
    requestClose();
    vi.mocked(documentLifecycle.save).mockResolvedValueOnce(true);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(targetStillOpen()).toBe(false);
    expect(press().defaultPrevented).toBe(true);
  });

  it("preserves the artifact owner's stable tab target when Save promotes a draft entity", async () => {
    act(() =>
      useCanvasStore.getState().updateTab('main', left[2], {
        type: 'protein',
        entityId: 'protein-draft:synthetic',
        isDirty: true,
        artifactDocument: {
          kind: 'protein',
          persistence: 'draft',
          workspaceRoot: '/synthetic',
          destinationPath: '/synthetic',
        },
      })
    );
    render(<Scene />);
    fireEvent.click(screen.getByTestId(`tab-close-${left[2]}`));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    act(() =>
      useCanvasStore.getState().updateTab('main', left[2], {
        entityId: 'recorded-protein:synthetic',
        artifactDocument: undefined,
        isDirty: false,
      })
    );
    await complete({ kind: 'tab', tabId: left[2], success: true });
    expect(targetStillOpen()).toBe(false);
    expect(active(rightPanel)).toBe(right[1]);
  });

  it('advances the existing close queue when a successful artifact owner removed its own draft', async () => {
    act(() => {
      const store = useCanvasStore.getState();
      store.updateTab('main', left[2], {
        type: 'primer',
        entityId: 'primer-draft:synthetic',
        isDirty: true,
        artifactDocument: {
          kind: 'primer',
          persistence: 'draft',
          workspaceRoot: '/synthetic',
          destinationPath: '/synthetic',
        },
      });
      store.updateTab('main', left[1], { isDirty: true });
    });
    render(<Scene />);
    act(() =>
      window.dispatchEvent(
        new CustomEvent('artifact-document-close-request', {
          detail: { panelId: 'main', tabIds: [left[2], left[1]] },
        })
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    act(() => useCanvasStore.getState().closeTab('main', left[2]));
    await complete({ kind: 'tab', tabId: left[2], success: true });
    expect(screen.getByRole('dialog')).toHaveTextContent('Left B');
    expect(useCanvasStore.getState().panels.main.tabs.some((tab) => tab.id === left[1])).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['move', 'retarget', 'close'] as const)(
    'does not use a late completion to close a replacement or another pane after %s',
    async (change) => {
      requestClose();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      act(() => {
        const store = useCanvasStore.getState();
        if (change === 'move') store.moveTab('main', rightPanel, left[2]);
        else if (change === 'retarget')
          store.updateTab('main', left[2], { entityId: '/synthetic/replacement.txt' });
        else store.closeTab('main', left[2]);
      });
      const before = useCanvasStore.getState().panels;
      await complete({ kind: 'file', filePath, success: true });
      expect(useCanvasStore.getState().panels).toBe(before);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      if (change === 'move') {
        expect(
          useCanvasStore.getState().panels[rightPanel].tabs.some((tab) => tab.id === left[2])
        ).toBe(true);
      } else if (change === 'retarget') {
        expect(
          useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === left[2])?.entityId
        ).toBe('/synthetic/replacement.txt');
      }
    }
  );

  it("refuses stale Don't Save rather than discarding a replacement document", async () => {
    requestClose();
    act(() =>
      useCanvasStore
        .getState()
        .updateTab('main', left[2], { entityId: '/synthetic/replacement.txt' })
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: "Don't Save" })));
    expect(documentLifecycle.discard).not.toHaveBeenCalled();
    expect(targetStillOpen()).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

it.each([
  [COMMAND_IDS.canvasNextTab, false],
  [COMMAND_IDS.canvasPreviousTab, true],
] as const)('leaves the explicit nested owner of %s in control', (command, backward) => {
  const owned = vi.fn();
  render(
    <Scene>
      <div data-command-shortcut-owner={command}>
        <button onKeyDown={owned}>Nested owner</button>
      </div>
    </Scene>
  );
  expect(
    press(screen.getByRole('button', { name: 'Nested owner' }), backward).defaultPrevented
  ).toBe(false);
  expect(owned).toHaveBeenCalledTimes(1);
  expect(active('main')).toBe(left[2]);
});
