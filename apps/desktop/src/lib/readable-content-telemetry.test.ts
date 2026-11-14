import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../features/canvas/store';
import type { observeWorkflowAction } from './workflow-telemetry';
import {
  __resetReadableContentTelemetryForTests,
  commitReadableContent,
  failReadableContent,
  registerPendingReadableContent,
  beginReadableContentOwner,
  registerCanvasReadRequest,
  commitCanvasReadPlacement,
  cancelCanvasReadRequest,
} from './readable-content-telemetry';

const workflowMocks = vi.hoisted(() => ({
  observeWorkflowAction: vi.fn<typeof observeWorkflowAction>(() => true),
}));
vi.mock('./workflow-telemetry', () => workflowMocks);

describe('readable content telemetry', () => {
  afterEach(() => __resetReadableContentTelemetryForTests());
  beforeEach(() => {
    vi.clearAllMocks();
    workflowMocks.observeWorkflowAction.mockReset().mockReturnValue(true);
    __resetReadableContentTelemetryForTests();
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [{ id: 'tab-1', type: 'text', entityId: '/workspace/a.txt', label: 'a.txt' }],
          activeTabId: 'tab-1',
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
    });
  });

  describe('CV1 current viewer generation joined to canvas placement', () => {
    const operation = { id: '550e8400-e29b-41d4-a716-446655440005', initiatedAtMs: 100 };
    const laterOperation = { id: '550e8400-e29b-41d4-a716-446655440006', initiatedAtMs: 200 };
    const register = () =>
      registerCanvasReadRequest({ panelId: 'main', tabId: 'tab-1', operation });
    const begin = () =>
      beginReadableContentOwner({ tabId: 'tab-1', contentKey: '/workspace/a.txt' });

    it('requires both committed placement and an actual current owner completion', () => {
      const owner = begin();
      expect(owner).not.toBeNull();
      register();
      expect(commitCanvasReadPlacement(operation)).toBe(false);
      expect(workflowMocks.observeWorkflowAction).not.toHaveBeenCalled();
      expect(owner?.readable()).toBe(true);
      expect(workflowMocks.observeWorkflowAction).toHaveBeenCalledWith(
        expect.objectContaining({
          workflow: 'content',
          action: 'view',
          phase: 'result',
          status: 'viewed',
          success: true,
          initiator: 'system',
          actionId: owner?.generationId,
          operationId: operation.id,
        })
      );
      expect(owner?.readable()).toBe(false);
      expect(commitCanvasReadPlacement(operation)).toBe(false);
      expect(workflowMocks.observeWorkflowAction).toHaveBeenCalledOnce();
    });

    it('supports deliberate return to an already loaded owner without inventing a fresh file read', () => {
      const owner = begin();
      expect(owner?.readable()).toBe(false);
      register();
      expect(workflowMocks.observeWorkflowAction).not.toHaveBeenCalled();
      expect(commitCanvasReadPlacement(operation)).toBe(true);
      expect(workflowMocks.observeWorkflowAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: owner?.generationId,
          operationId: operation.id,
        })
      );
    });

    it('makes an old same-key completion and cleanup inert after a new generation starts', () => {
      const old = begin();
      register();
      commitCanvasReadPlacement(operation);
      const current = begin();
      expect(current?.generationId).not.toBe(old?.generationId);
      expect(old?.readable()).toBe(false);
      old?.release();
      expect(workflowMocks.observeWorkflowAction).not.toHaveBeenCalled();
      expect(current?.readable()).toBe(true);
      expect(workflowMocks.observeWorkflowAction).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: current?.generationId })
      );
    });

    it('does not settle a request after focus/active ownership changes or the target is retargeted', () => {
      const owner = begin();
      register();
      commitCanvasReadPlacement(operation);
      useCanvasStore.setState({ focusedPanelId: null });
      expect(owner?.readable()).toBe(false);
      expect(workflowMocks.observeWorkflowAction).not.toHaveBeenCalled();
      useCanvasStore.setState({ focusedPanelId: 'main' });
      register();
      useCanvasStore
        .getState()
        .retargetTab('main', 'tab-1', { type: 'text', entityId: '/workspace/replacement.txt' });
      expect(commitCanvasReadPlacement(operation)).toBe(false);
      expect(workflowMocks.observeWorkflowAction).not.toHaveBeenCalled();
    });

    it('does not revive an old navigation after departing and returning before React can render', () => {
      const owner = begin();
      register();
      commitCanvasReadPlacement(operation);
      useCanvasStore.setState({ focusedPanelId: null });
      useCanvasStore.setState({ focusedPanelId: 'main' });
      expect(owner?.readable()).toBe(false);
      expect(workflowMocks.observeWorkflowAction).not.toHaveBeenCalled();
      registerCanvasReadRequest({ panelId: 'main', tabId: 'tab-1', operation: laterOperation });
      expect(commitCanvasReadPlacement(laterOperation)).toBe(true);
    });

    it('does not reuse a cached readable owner after current file availability becomes missing', () => {
      const owner = begin();
      owner?.readable();
      register();
      useCanvasStore.getState().updateTab('main', 'tab-1', { loadStatus: 'missing' });
      expect(commitCanvasReadPlacement(operation)).toBe(false);
      expect(workflowMocks.observeWorkflowAction).not.toHaveBeenCalled();
    });

    it('cancels the previous navigation and never lets it settle a newer operation', () => {
      const owner = begin();
      register();
      commitCanvasReadPlacement(operation);
      cancelCanvasReadRequest(operation);
      registerCanvasReadRequest({ panelId: 'main', tabId: 'tab-1', operation: laterOperation });
      expect(commitCanvasReadPlacement(operation)).toBe(false);
      expect(owner?.readable()).toBe(false);
      expect(commitCanvasReadPlacement(laterOperation)).toBe(true);
      expect(workflowMocks.observeWorkflowAction).toHaveBeenCalledOnce();
      expect(workflowMocks.observeWorkflowAction).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: laterOperation.id })
      );
    });

    it('does not accept a legacy content-key callback as the canvas generation authority', () => {
      register();
      commitCanvasReadPlacement(operation);
      registerPendingReadableContent({ tabId: 'tab-1', contentKey: '/workspace/a.txt' });
      expect(commitReadableContent('/workspace/a.txt')).toBe(true);
      expect(
        workflowMocks.observeWorkflowAction.mock.calls.every(([input]) => !('operationId' in input))
      ).toBe(true);
      expect(commitCanvasReadPlacement(operation)).toBe(false);
      const owner = begin();
      expect(owner?.readable()).toBe(true);
      expect(workflowMocks.observeWorkflowAction).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: operation.id })
      );
    });

    it('records a current load failure once and requires a fresh generation for a retry', () => {
      const owner = begin();
      register();
      commitCanvasReadPlacement(operation);
      expect(owner?.fail()).toBe(true);
      expect(owner?.readable()).toBe(false);
      expect(workflowMocks.observeWorkflowAction).toHaveBeenCalledOnce();
      expect(workflowMocks.observeWorkflowAction).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          success: false,
          errorClass: 'viewer_load_failed',
        })
      );
      const retry = begin();
      registerCanvasReadRequest({ panelId: 'main', tabId: 'tab-1', operation: laterOperation });
      commitCanvasReadPlacement(laterOperation);
      expect(retry?.readable()).toBe(true);
    });

    it('contains telemetry errors and refuses released owners without changing product state', () => {
      const owner = begin();
      register();
      commitCanvasReadPlacement(operation);
      const before = useCanvasStore.getState();
      workflowMocks.observeWorkflowAction.mockImplementation(() => {
        throw new Error('collector unavailable');
      });
      expect(owner?.readable()).toBe(false);
      expect(useCanvasStore.getState()).toBe(before);
      owner?.release();
      expect(owner?.readable()).toBe(false);
      expect(beginReadableContentOwner({ contentKey: '/workspace/a.txt' })).toBeNull();
      expect(
        beginReadableContentOwner({ tabId: 'tab-1', contentKey: '/workspace/wrong.txt' })
      ).toBeNull();
    });
  });

  it('qualifies once only after an explicit pending request becomes readable', () => {
    expect(commitReadableContent('/workspace/a.txt')).toBe(false);
    registerPendingReadableContent({ contentKey: '/workspace/a.txt', tabId: 'tab-1' });
    expect(commitReadableContent('/workspace/a.txt')).toBe(true);
    expect(commitReadableContent('/workspace/a.txt')).toBe(false);
    expect(workflowMocks.observeWorkflowAction).toHaveBeenCalledOnce();
    expect(workflowMocks.observeWorkflowAction).toHaveBeenCalledWith({
      workflow: 'content',
      action: 'view',
      status: 'viewed',
      phase: 'result',
    });
  });

  it('does not qualify failed loads or content whose originating tab closed', () => {
    registerPendingReadableContent({ contentKey: '/workspace/a.txt', tabId: 'tab-1' });
    failReadableContent('/workspace/a.txt');
    expect(commitReadableContent('/workspace/a.txt')).toBe(false);

    registerPendingReadableContent({ contentKey: '/workspace/a.txt', tabId: 'tab-1' });
    useCanvasStore.setState({ panels: {} });
    expect(commitReadableContent('/workspace/a.txt')).toBe(false);
    expect(workflowMocks.observeWorkflowAction).not.toHaveBeenCalled();
  });
});
