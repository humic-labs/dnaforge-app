import { useWorkspaceStore } from '../../stores/workspaceStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  observeCommittedWorkspaceOpen,
  observeSampleAssetOpen,
  observeWorkspaceSetPath,
  recordWorkspaceIndex,
  __resetWorkspaceTelemetryForTests,
  beginProjectLifecycle,
  bindProjectLifecycle,
  captureProjectLifecycle,
  observeProjectLifecyclePhase,
} from './workspace-telemetry';

const analyticsMocks = vi.hoisted(() => ({ trackRendererEvent: vi.fn() }));
vi.mock('../../lib/analytics', () => analyticsMocks);

describe('workspace open telemetry commit/index join', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorkspaceTelemetryForTests();
  });

  it('emits only after a real loader commit joins the existing workspace index result', () => {
    observeCommittedWorkspaceOpen({
      rootPath: '/workspace/project',
      workspaceSource: 'folder_picker',
      workspaceKind: 'managed',
    });
    expect(analyticsMocks.trackRendererEvent).not.toHaveBeenCalled();

    recordWorkspaceIndex('/workspace/project', 21);

    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledOnce();
    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledWith('workspace_opened', {
      feature_area: 'workspace',
      workspace_source: 'folder_picker',
      workspace_kind: 'managed',
      file_count: 21,
      file_count_bucket: '21_100',
    });
  });

  it('reuses a prior committed index without emitting for direct store/index injection', () => {
    recordWorkspaceIndex('/workspace/project', 0);
    expect(analyticsMocks.trackRendererEvent).not.toHaveBeenCalled();

    observeCommittedWorkspaceOpen({
      rootPath: '/workspace/project',
      workspaceSource: 'recent',
      workspaceKind: 'git',
    });

    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledWith(
      'workspace_opened',
      expect.objectContaining({ file_count_bucket: '0' })
    );
  });

  it('deduplicates retry deliveries while preserving a later explicit reopen', () => {
    recordWorkspaceIndex('/workspace/project', 3);
    const retryDelivery = {
      rootPath: '/workspace/project',
      workspaceSource: 'startup_arg' as const,
      workspaceKind: 'folder' as const,
      deliveryId: 'delivery-1',
    };

    observeCommittedWorkspaceOpen(retryDelivery);
    observeCommittedWorkspaceOpen(retryDelivery);
    observeCommittedWorkspaceOpen(retryDelivery);
    observeCommittedWorkspaceOpen({ ...retryDelivery, deliveryId: 'delivery-2' });

    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledTimes(2);
  });

  it('classifies managed share imports as sync rather than command-line folder opens', () => {
    recordWorkspaceIndex('/workspace/shared-project', 4);

    observeWorkspaceSetPath('/workspace/shared-project', 'share-delivery-1', 'managed_sync');

    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledWith('workspace_opened', {
      feature_area: 'workspace',
      workspace_source: 'sync',
      workspace_kind: 'managed',
      file_count: 4,
      file_count_bucket: '2_5',
    });
  });

  it.each([
    [1, '1'],
    [2, '2_5'],
    [5, '2_5'],
    [6, '6_20'],
    [20, '6_20'],
    [100, '21_100'],
    [101, '100_plus'],
  ])('buckets %i committed files as %s', (fileCount, bucket) => {
    recordWorkspaceIndex('/workspace/project', fileCount);
    observeCommittedWorkspaceOpen({
      rootPath: '/workspace/project',
      workspaceSource: 'unknown',
      workspaceKind: 'unknown',
    });
    expect(analyticsMocks.trackRendererEvent).toHaveBeenLastCalledWith(
      'workspace_opened',
      expect.objectContaining({ file_count_bucket: bucket })
    );
  });
});

describe('sample provision is not deliberate activation', () => {
  it.each(['automatic_sample', 'startup_arg', 'unknown'] as const)(
    'records %s sample open without admitting a first-product proxy',
    (source) => {
      expect(observeSampleAssetOpen(source)).toBe(false);
      expect(analyticsMocks.trackRendererEvent).toHaveBeenLastCalledWith('sample_project_opened', {
        feature_area: 'project',
        workspace_source: source,
      });
    }
  );
  it('telemetry failure never changes the sample open outcome', () => {
    analyticsMocks.trackRendererEvent.mockImplementationOnce(() => {
      throw new Error('collector unavailable');
    });
    expect(() => observeSampleAssetOpen('automatic_sample')).not.toThrow();
  });
  it('admits only an owner-declared deliberate sample selection', () => {
    expect(observeSampleAssetOpen('sample_selection')).toBe(true);
  });
});

describe('accepted project lifecycle (F22)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorkspaceTelemetryForTests();
    useWorkspaceStore.getState().clearWorkspace();
  });
  it('keeps acceptance, mount, current index, and visible tree separate without private properties', () => {
    const root = '/fixture/private-project-name';
    const lifecycle = beginProjectLifecycle({
      source: 'local',
      mode: 'add',
      intent: 'folder_picker',
    });
    lifecycle.authority('reference');
    bindProjectLifecycle(root, lifecycle);
    useWorkspaceStore.getState().addFolder(root, 'Private fixture', { pinned: true });
    lifecycle.phase('registered');
    lifecycle.phase('mounted');
    expect(
      analyticsMocks.trackRendererEvent.mock.calls
        .filter(([event]) => event === 'project_lifecycle_observed')
        .map(([, props]) => props.project_phase)
    ).toEqual(['accepted', 'registered', 'mounted']);
    const token = captureProjectLifecycle(root);
    observeProjectLifecyclePhase(root, token, 'indexed');
    observeProjectLifecyclePhase(root, token, 'tree_ready');
    observeProjectLifecyclePhase(root, token, 'tree_ready');
    const payloads = analyticsMocks.trackRendererEvent.mock.calls
      .filter(([event]) => event === 'project_lifecycle_observed')
      .map(([, props]) => props);
    expect(payloads.map((props) => props.project_phase)).toEqual([
      'accepted',
      'registered',
      'mounted',
      'indexed',
      'tree_ready',
    ]);
    expect(new Set(payloads.map((props) => props.operation_id)).size).toBe(1);
    expect(payloads[0].operation_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(payloads)).not.toContain(root);
    expect(JSON.stringify(payloads)).not.toContain('Private fixture');
    expect(
      payloads.every((props) =>
        Object.keys(props).every((key) =>
          [
            'feature_area',
            'operation_id',
            'occurred_at_ms',
            'project_phase',
            'project_source',
            'project_open_mode',
            'workspace_source',
            'project_authority',
            'project_stage',
          ].includes(key)
        )
      )
    ).toBe(true);
  });
  it('cached counts and old-generation callbacks cannot qualify a new tree or index', () => {
    const root = '/fixture/current';
    useWorkspaceStore.getState().addFolder(root);
    recordWorkspaceIndex(root, 9);
    const old = beginProjectLifecycle({ source: 'local', mode: 'add', intent: 'recent' });
    bindProjectLifecycle(root, old);
    const current = beginProjectLifecycle({ source: 'local', mode: 'add', intent: 'recent' });
    bindProjectLifecycle(root, current);
    observeProjectLifecyclePhase(root, old, 'indexed');
    observeProjectLifecyclePhase(root, old, 'tree_ready');
    const phases = analyticsMocks.trackRendererEvent.mock.calls
      .filter(([event]) => event === 'project_lifecycle_observed')
      .map(([, props]) => props.project_phase);
    expect(phases).toEqual(['accepted', 'accepted', 'superseded']);
    useWorkspaceStore.getState().removeFolder(root);
    observeProjectLifecyclePhase(root, current, 'indexed');
    expect(
      analyticsMocks.trackRendererEvent.mock.calls
        .filter(([event]) => event === 'project_lifecycle_observed')
        .map(([, props]) => props.project_phase)
    ).toEqual(['accepted', 'accepted', 'superseded', 'superseded']);
  });
  it('telemetry failure cannot reject an accepted operation or later phase', () => {
    analyticsMocks.trackRendererEvent.mockImplementation(() => {
      throw new Error('controlled schema rejection');
    });
    expect(() =>
      beginProjectLifecycle({ source: 'empty', mode: 'replace', intent: 'unknown' }).phase('failed')
    ).not.toThrow();
    analyticsMocks.trackRendererEvent.mockReset();
  });
});

describe('project lifecycle UUID availability', () => {
  it('does not block product work or emit a fake ID when random UUID generation is unavailable', () => {
    const uuid = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('controlled UUID failure');
    });
    analyticsMocks.trackRendererEvent.mockClear();
    try {
      const lifecycle = beginProjectLifecycle({ source: 'local', mode: 'add', intent: 'unknown' });
      expect(lifecycle.operationId).toBeUndefined();
      expect(() => lifecycle.phase('mounted')).not.toThrow();
      expect(analyticsMocks.trackRendererEvent).not.toHaveBeenCalled();
    } finally {
      uuid.mockRestore();
    }
  });
});
