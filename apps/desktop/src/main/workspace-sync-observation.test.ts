import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeClosedBetaProperties } from '../shared/analytics-allowlist';
import {
  __resetWorkspaceSyncObservationForTests,
  bindWorkspaceSyncObservationSink,
  observeWorkspaceSync,
  workspaceSyncAccessRole,
  observeOrgRegistrySync,
  observeWorkspaceSyncReconcile,
  workspaceSyncErrorCode,
  workspaceSyncVersionFacts,
  type WorkspaceSyncObservation,
} from './workspace-sync-observation';

describe('workspace sync observation', () => {
  afterEach(() => __resetWorkspaceSyncObservationForTests());

  it('maps sync and errno codes onto a closed lowercase list', () => {
    expect(workspaceSyncErrorCode('QUOTA_EXCEEDED')).toBe('quota_exceeded');
    expect(workspaceSyncErrorCode({ code: 'ENOSPC' })).toBe('enospc');
    expect(workspaceSyncErrorCode('/Users/someone/project')).toBe('other');
    expect(workspaceSyncErrorCode(new Error('Project A failed'))).toBe('other');
  });

  it('reports a repeated outcome key once', () => {
    const observations: WorkspaceSyncObservation[] = [];
    bindWorkspaceSyncObservationSink((observation) => observations.push(observation));
    for (let poll = 0; poll < 3; poll += 1) {
      observeWorkspaceSync(
        { sync_operation: 'pull', sync_outcome: 'failed', error_code: 'network' },
        'pull-failed:1:version:network'
      );
    }
    observeWorkspaceSync({ sync_operation: 'pull', sync_outcome: 'pulled' });
    expect(observations.map((observation) => observation.sync_outcome)).toEqual([
      'failed',
      'pulled',
    ]);
  });

  it('never lets the sink interrupt sync', () => {
    bindWorkspaceSyncObservationSink(() => {
      throw new Error('sink failure');
    });
    expect(() =>
      observeWorkspaceSync({ sync_operation: 'upload', sync_outcome: 'uploaded' })
    ).not.toThrow();
  });

  it('buckets version facts and passes the allowlist', () => {
    const observations: WorkspaceSyncObservation[] = [];
    bindWorkspaceSyncObservationSink((observation) => observations.push(observation));
    observeWorkspaceSync({
      sync_operation: 'upload',
      sync_outcome: 'uploaded',
      sync_attempt_count: 2,
      duration_ms: 1_500,
      is_first_upload: true,
      is_shared: true,
      sync_access_role: workspaceSyncAccessRole('editor'),
      ...workspaceSyncVersionFacts({
        sizeBytes: 3 * 1024 * 1024,
        fileCount: 42,
        representation: 'manifest_v1',
      }),
    });
    expect(sanitizeClosedBetaProperties(observations[0])).toMatchObject({
      feature_area: 'workspace',
      sync_operation: 'upload',
      sync_outcome: 'uploaded',
      sync_attempt_count: 2,
      duration_ms: 1_500,
      is_first_upload: true,
      is_shared: true,
      sync_access_role: 'editor',
      size_bucket: '1_10mb',
      file_count_bucket: '21_100',
      sync_representation: 'manifest_v1',
    });
    expect(workspaceSyncAccessRole('admin')).toBe('unknown');
  });

  it('reports every merge but repeated reconcile outcomes once per workspace', () => {
    const observations: WorkspaceSyncObservation[] = [];
    bindWorkspaceSyncObservationSink((observation) => observations.push(observation));
    for (let run = 0; run < 2; run += 1) {
      observeWorkspaceSyncReconcile('workspace-a', { ok: true, outcome: 'merged' });
      observeWorkspaceSyncReconcile('workspace-a', { ok: true, outcome: 'conflicts' });
      observeWorkspaceSyncReconcile('workspace-a', { ok: true, outcome: 'no_remote_change' });
      observeWorkspaceSyncReconcile('workspace-a', { ok: false, code: 'INVALID_REQUEST' });
    }
    expect(observations.map((o) => [o.sync_operation, o.sync_outcome, o.error_code])).toEqual([
      ['reconcile', 'merged', undefined],
      ['reconcile', 'conflict', undefined],
      ['reconcile', 'no_remote_change', undefined],
      ['reconcile', 'failed', 'invalid_request'],
      ['reconcile', 'merged', undefined],
    ]);
    expect(JSON.stringify(observations)).not.toContain('workspace-a');
  });

  it('reports organization Registry sync only when its outcome changes', () => {
    const observations: WorkspaceSyncObservation[] = [];
    bindWorkspaceSyncObservationSink((observation) => observations.push(observation));
    const ready = { ok: true as const, sync: { status: 'ready', conflictCount: 0 } };
    observeOrgRegistrySync('org-a', ready);
    observeOrgRegistrySync('org-a', ready);
    observeOrgRegistrySync('org-a', { ok: true, sync: { status: 'error', errorCode: 'NETWORK' } });
    observeOrgRegistrySync('org-a', { ok: true, sync: { status: 'error', errorCode: 'NETWORK' } });
    observeOrgRegistrySync('org-a', { ok: true, sync: { status: 'ready', conflictCount: 2 } });
    observeOrgRegistrySync('org-a', ready);
    observeOrgRegistrySync('org-b', { thrown: new Error('Org B refused') });
    observeOrgRegistrySync('org-b', { ok: true, sync: { status: 'access_revoked' } });
    expect(observations.map((o) => [o.sync_outcome, o.error_code])).toEqual([
      ['synchronized', undefined],
      ['failed', 'network'],
      ['conflict', undefined],
      ['synchronized', undefined],
      ['failed', 'other'],
      ['access_removed', undefined],
    ]);
    expect(observations.every((o) => o.sync_operation === 'org_registry')).toBe(true);
    expect(JSON.stringify(observations)).not.toMatch(/org-a|org-b|Org B/);
  });
});
