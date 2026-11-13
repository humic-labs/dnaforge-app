// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from './store';
import type { observeWorkflowAction } from '../../lib/workflow-telemetry';

const telemetry = vi.hoisted(() => ({ observe: vi.fn<typeof observeWorkflowAction>(() => true) }));
vi.mock('../../lib/workflow-telemetry', () => ({ observeWorkflowAction: telemetry.observe }));
const receipts = () => telemetry.observe.mock.calls.map(([input]) => input);
const placed = () => receipts().filter((input) => input.phase === 'commit');

beforeEach(() => {
  useCanvasStore.getState().reset();
  telemetry.observe.mockReset().mockReturnValue(true);
});

describe('CV1 actual store placement observations', () => {
  it('joins real move/reorder/split/merge/reopen transitions while preserving document descriptors', () => {
    const store = useCanvasStore.getState();
    const first = store.openTab('main', { type: 'file', entityId: '/synthetic/a.txt', label: 'A' });
    store.openTab('main', { type: 'table', entityId: '/synthetic/b.csv', label: 'B' });
    const third = store.openTab('main', { type: 'text', entityId: '/synthetic/c.txt', label: 'C' });
    const descriptor = useCanvasStore.getState().panels.main.tabs[0];
    const right = store.splitPanel('main', 'vertical');
    store.moveTabAtIndex('main', right, first, 0);
    store.reorderTab('main', third, 0);
    store.mergePanels(right, 'main');
    expect(useCanvasStore.getState().panels.main.tabs.find((tab) => tab.id === first)).toBe(
      descriptor
    );
    store.closeTab('main', first);
    store.reopenLastClosedTab();
    expect(placed().map((input) => input.outcomeKind)).toEqual([
      'canvas_split',
      'canvas_move',
      'canvas_reorder',
      'canvas_merge',
      'canvas_reopen',
    ]);
    for (const terminal of placed()) {
      expect(receipts()).toContainEqual(
        expect.objectContaining({
          outcomeKind: terminal.outcomeKind,
          actionId: terminal.actionId,
          operationId: terminal.operationId,
          phase: 'result',
          status: 'selected',
        })
      );
    }
    expect(JSON.stringify(receipts())).not.toContain('/synthetic');
    expect(JSON.stringify(receipts())).not.toContain(first);
    expect(receipts().some((input) => input.workflow === 'content')).toBe(false);
  });

  it('refuses missing and unreachable split targets without adding an orphan pane', () => {
    const store = useCanvasStore.getState();
    const before = useCanvasStore.getState();
    expect(store.splitPanel('missing', 'vertical')).toBe('');
    expect(useCanvasStore.getState()).toBe(before);
    useCanvasStore.setState({
      panels: { ...before.panels, orphan: { id: 'orphan', tabs: [], activeTabId: null } },
    });
    const withOrphan = useCanvasStore.getState();
    expect(store.splitPanel('orphan', 'horizontal')).toBe('');
    expect(useCanvasStore.getState()).toBe(withOrphan);
    expect(
      receipts().every(
        (input) => input.outcomeKind === 'canvas_split' && input.status === 'blocked'
      )
    ).toBe(true);
  });

  it('distinguishes no-ops and refusals without mutating the current pane', () => {
    const store = useCanvasStore.getState();
    const tab = store.openTab('main', { type: 'text', entityId: '/synthetic/a.txt', label: 'A' });
    const before = useCanvasStore.getState();
    store.reorderTab('main', tab, 0);
    store.moveTab('main', 'main', tab);
    store.reopenLastClosedTab();
    expect(useCanvasStore.getState()).toBe(before);
    expect(receipts().every((input) => input.cached === true && input.resultCount === 0)).toBe(
      true
    );
    telemetry.observe.mockClear();
    store.moveTab('main', 'missing', tab);
    store.reorderTab('main', 'missing', 0);
    store.mergePanels('missing', 'main');
    expect(useCanvasStore.getState()).toBe(before);
    expect(receipts().every((input) => input.status === 'blocked' && input.success === false)).toBe(
      true
    );
  });

  it('keeps reopened file availability pending and does not emit a readable-document result', () => {
    const store = useCanvasStore.getState();
    const tab = store.openTab('main', {
      type: 'file',
      entityId: '/synthetic/a.txt',
      label: 'A',
      loadStatus: 'loaded',
    });
    store.closeTab('main', tab);
    store.reopenLastClosedTab();
    const current = useCanvasStore.getState().panels.main;
    expect(current.tabs[0].id).not.toBe(tab);
    expect(current.tabs[0].loadStatus).toBe('pending');
    expect(placed()).toHaveLength(1);
    expect(placed()[0].outcomeKind).toBe('canvas_reopen');
    expect(
      receipts().some((input) => input.workflow === 'content' || input.usableResult === true)
    ).toBe(false);
  });

  it('classifies reopen as a no-op when the intended existing tab is already active', () => {
    const store = useCanvasStore.getState();
    const first = store.openTab('main', { type: 'text', entityId: '/synthetic/a.txt', label: 'A' });
    store.closeTab('main', first);
    const existing = store.openTab('main', {
      type: 'text',
      entityId: '/synthetic/a.txt',
      label: 'A',
    });
    telemetry.observe.mockClear();
    store.reopenLastClosedTab();
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(1);
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(existing);
    expect(receipts()).toHaveLength(2);
    expect(receipts()[1]).toMatchObject({
      outcomeKind: 'canvas_reopen',
      cached: true,
      resultCount: 0,
    });
    expect(placed()).toHaveLength(0);
  });

  it('keeps product placement unchanged when observation throws', () => {
    const store = useCanvasStore.getState();
    const tab = store.openTab('main', { type: 'text', entityId: '/synthetic/a.txt', label: 'A' });
    store.openTab('main', { type: 'text', entityId: '/synthetic/b.txt', label: 'B' });
    telemetry.observe.mockImplementation(() => {
      throw new Error('collector unavailable');
    });
    const right = store.splitPanel('main', 'vertical');
    expect(() => store.moveTab('main', right, tab)).not.toThrow();
    expect(useCanvasStore.getState().panels[right].activeTabId).toBe(tab);
    expect(useCanvasStore.getState().focusedPanelId).toBe(right);
    expect(() => store.mergePanels(right, 'main')).not.toThrow();
    expect(
      useCanvasStore.getState().panels.main.tabs.some((candidate) => candidate.id === tab)
    ).toBe(true);
  });
});
