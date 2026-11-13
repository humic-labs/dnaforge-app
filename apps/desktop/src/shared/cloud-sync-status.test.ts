// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_SYNC_V1_EXCLUDED_AUTHORITATIVE_STATE,
  deriveWorkspaceSyncStatus,
  type WorkspaceSyncStatusInput,
} from './cloud-sync-status';

const BASE: WorkspaceSyncStatusInput = {
  workspaceUuid: 'workspace-a',
  isManagedWorkspace: true,
  syncEnabled: true,
  remoteWorkspaceId: 'remote-a',
  queueDepth: 0,
  authState: 'ok',
  currentLocalHeadSha: 'head-a',
  latestAckedLocalHeadSha: 'head-a',
  dirtyByWorkspace: {},
  excludedSummary: null,
};

function status(overrides: Partial<WorkspaceSyncStatusInput> = {}) {
  return deriveWorkspaceSyncStatus({ ...BASE, ...overrides });
}

describe('deriveWorkspaceSyncStatus', () => {
  it('allows plain Synced only for a clean managed workspace with matching acked head', () => {
    expect(status()).toMatchObject({
      syncAxis: 'idle_synced',
      bufferAxis: 'clean',
      canDisplayPlainSynced: true,
      blockers: [],
    });
  });

  it('treats external or unbound workspaces as local-only, never plain synced', () => {
    expect(status({ isManagedWorkspace: false })).toMatchObject({
      syncAxis: 'local_only',
      canDisplayPlainSynced: false,
      blockers: expect.arrayContaining(['not_managed_workspace']),
    });
    expect(status({ workspaceUuid: null })).toMatchObject({
      syncAxis: 'local_only',
      canDisplayPlainSynced: false,
      blockers: expect.arrayContaining(['missing_workspace_uuid']),
    });
  });

  it('keeps dirty buffers scoped to the active workspace uuid', () => {
    const result = status({
      dirtyByWorkspace: {
        'workspace-b': {
          dirtyPageIds: ['page-b'],
          dirtySequenceDocumentIds: ['sequence-document-b'],
        },
      },
    });

    expect(result.bufferAxis).toBe('clean');
    expect(result.canDisplayPlainSynced).toBe(true);

    expect(
      status({
        dirtyByWorkspace: {
          'workspace-a': { dirtySequenceDocumentIds: ['sequence-document-a'] },
          'workspace-b': { dirtyPageIds: ['page-b'] },
        },
      })
    ).toMatchObject({
      syncAxis: 'dirty_pending',
      bufferAxis: 'unsaved',
      canDisplayPlainSynced: false,
      blockers: expect.arrayContaining(['dirty_buffers']),
    });
  });

  it('blocks plain Synced while saves are in flight or failed', () => {
    expect(
      status({ dirtyByWorkspace: { 'workspace-a': { savingPageIds: ['page-a'] } } })
    ).toMatchObject({
      syncAxis: 'dirty_pending',
      bufferAxis: 'saving',
      canDisplayPlainSynced: false,
      blockers: expect.arrayContaining(['save_in_flight']),
    });

    expect(
      status({ dirtyByWorkspace: { 'workspace-a': { saveFailedSequencePaths: ['a.gb'] } } })
    ).toMatchObject({
      syncAxis: 'dirty_pending',
      bufferAxis: 'save_failed',
      canDisplayPlainSynced: false,
      blockers: expect.arrayContaining(['save_failed']),
    });
  });

  it('blocks plain Synced when V1 excludes authoritative local state', () => {
    const result = status({
      excludedSummary: {
        unsupportedCount: 0,
        privateRawDataCount: 1,
        referencePointerCount: 0,
        fileTooLargeCount: 0,
        bundleTooLargeCount: 0,
      },
    });

    expect(result).toMatchObject({
      syncAxis: 'dirty_pending',
      bufferAxis: 'clean',
      canDisplayPlainSynced: false,
      blockers: expect.arrayContaining(['excluded_authoritative_state']),
    });
    expect(result.excludedAuthoritativeState).toEqual(
      WORKSPACE_SYNC_V1_EXCLUDED_AUTHORITATIVE_STATE
    );
  });

  it('chooses explicit paused/error axes before idle synced', () => {
    expect(status({ archived: true }).syncAxis).toBe('archived_paused');
    expect(status({ trashed: true }).syncAxis).toBe('trashed_paused');
    expect(status({ authState: 'revoked' }).syncAxis).toBe('auth_paused');
    expect(status({ conflict: true }).syncAxis).toBe('conflict');
    expect(status({ terminalError: 'quota exceeded' }).syncAxis).toBe('terminal_error');
    expect(status({ offline: true }).syncAxis).toBe('offline_retry');
  });

  it('carries terminal queue error details for renderer display', () => {
    expect(
      status({ terminalError: 'quota exceeded', terminalErrorCode: 'QUOTA_EXCEEDED' })
    ).toMatchObject({
      syncAxis: 'terminal_error',
      terminalErrorCode: 'QUOTA_EXCEEDED',
      terminalErrorMessage: 'quota exceeded',
      blockers: expect.arrayContaining(['terminal_error']),
    });
  });

  it('distinguishes binding, in-flight, queued, and local-head mismatch states', () => {
    expect(status({ remoteWorkspaceId: null }).syncAxis).toBe('binding');
    expect(status({ inFlightPhase: 'debouncing' }).syncAxis).toBe('debouncing');
    expect(status({ inFlightPhase: 'snapshotting' }).syncAxis).toBe('snapshotting');
    expect(status({ inFlightPhase: 'uploading' }).syncAxis).toBe('uploading');
    expect(status({ inFlightPhase: 'restoring' }).syncAxis).toBe('restoring');
    expect(status({ queueDepth: 2 }).syncAxis).toBe('queued');

    expect(status({ currentLocalHeadSha: 'head-b' })).toMatchObject({
      syncAxis: 'dirty_pending',
      canDisplayPlainSynced: false,
      blockers: expect.arrayContaining(['local_head_mismatch']),
    });
  });

  it('requires an acked local head before plain Synced', () => {
    expect(status({ latestAckedLocalHeadSha: null })).toMatchObject({
      syncAxis: 'dirty_pending',
      canDisplayPlainSynced: false,
      blockers: expect.arrayContaining(['missing_ack']),
    });
  });

  it(': reports access removal ahead of every other axis and keeps local work', () => {
    const removed = status({
      detachedReason: 'access_removed',
      shared: true,
      accessRole: 'editor',
    });
    expect(removed).toMatchObject({
      syncAxis: 'access_removed',
      canDisplayPlainSynced: false,
      shared: true,
      blockers: expect.arrayContaining(['access_removed']),
    });
    expect(status({ detachedReason: 'access_removed', remoteWorkspaceId: null }).syncAxis).toBe(
      'access_removed'
    );
    expect(status({ detachedReason: 'access_removed', queueDepth: 3 }).syncAxis).toBe(
      'access_removed'
    );
  });

  it(': a viewer sees view-only instead of plain synced and never a pending upload', () => {
    const viewer = status({ accessRole: 'viewer', accessSource: 'direct', shared: true });
    expect(viewer).toMatchObject({
      syncAxis: 'view_only',
      accessRole: 'viewer',
      accessSource: 'direct',
      canDisplayPlainSynced: false,
      blockers: expect.arrayContaining(['view_only']),
    });
    expect(status({ accessRole: 'viewer', currentLocalHeadSha: 'head-b' }).syncAxis).toBe(
      'view_only'
    );
  });

  it(': personal projects report owner access with no shared flag by default', () => {
    expect(status()).toMatchObject({ shared: false, accessRole: null, accessSource: null });
    expect(status({ accessRole: 'owner', accessSource: 'owner' }).syncAxis).toBe('idle_synced');
  });
});
