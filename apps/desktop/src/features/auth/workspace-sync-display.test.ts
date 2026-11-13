// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { WorkspaceSyncStatus } from '../../shared/cloud-sync-status';

import {
  CLOUD_BACKUP_SCOPE_DETAIL,
  describeWorkspaceSyncDisplay,
  formatExclusionDetail,
} from './workspace-sync-display';

function status(patch: Partial<WorkspaceSyncStatus>): WorkspaceSyncStatus {
  return {
    workspaceUuid: 'repo-uuid-a',
    syncAxis: 'idle_synced',
    bufferAxis: 'clean',
    canDisplayPlainSynced: true,
    blockers: [],
    excludedAuthoritativeState: [],
    excludedSummary: null,
    terminalErrorCode: null,
    terminalErrorMessage: null,
    ...patch,
  };
}

describe('workspace sync display mapping', () => {
  it('allows a deliberate backup to reevaluate saved exclusions while withholding a synced claim and public link', () => {
    const excluded = status({
      syncAxis: 'dirty_pending',
      canDisplayPlainSynced: false,
      blockers: ['excluded_authoritative_state'],
      excludedSummary: { unsupportedCount: 52 },
    });
    const display = describeWorkspaceSyncDisplay({ signedIn: true, status: excluded });
    expect(display).toMatchObject({
      label: 'Some files stay local',
      canForceSync: true,
      canCopyShareLink: false,
    });
    expect(
      describeWorkspaceSyncDisplay({
        signedIn: true,
        status: { ...excluded, accessRole: 'viewer' },
      }).canForceSync
    ).toBe(false);
    expect(
      describeWorkspaceSyncDisplay({
        signedIn: true,
        status: { ...excluded, bufferAxis: 'unsaved' },
      }).canForceSync
    ).toBe(false);
  });
  it.each([
    ['signed-out', { signedIn: false, status: status({}) }, 'Off'],
    [
      'local-only',
      {
        signedIn: true,
        status: status({
          workspaceUuid: null,
          syncAxis: 'local_only',
          canDisplayPlainSynced: false,
        }),
      },
      'Local only',
    ],
    [
      'preparing',
      { signedIn: true, status: status({ syncAxis: 'binding', canDisplayPlainSynced: false }) },
      'Preparing backup',
    ],
    [
      'backing-up',
      { signedIn: true, status: status({ syncAxis: 'uploading', canDisplayPlainSynced: false }) },
      'Backing up',
    ],
    ['up-to-date', { signedIn: true, status: status({}) }, 'Up to date'],
    [
      'unsaved',
      {
        signedIn: true,
        status: status({
          syncAxis: 'dirty_pending',
          bufferAxis: 'unsaved',
          canDisplayPlainSynced: false,
        }),
      },
      'Unsaved changes',
    ],
    [
      'offline',
      {
        signedIn: true,
        status: status({ syncAxis: 'offline_retry', canDisplayPlainSynced: false }),
      },
      'Offline, retrying',
    ],
    [
      'service-paused',
      {
        signedIn: true,
        status: status({ syncAxis: 'service_paused', canDisplayPlainSynced: false }),
      },
      'Cloud backup unavailable',
    ],
    [
      'auth-paused',
      { signedIn: true, status: status({ syncAxis: 'auth_paused', canDisplayPlainSynced: false }) },
      'Sign in to resume backup',
    ],
    [
      'conflict',
      { signedIn: true, status: status({ syncAxis: 'conflict', canDisplayPlainSynced: false }) },
      'Backup conflict',
    ],
    [
      'terminal',
      {
        signedIn: true,
        status: status({
          syncAxis: 'terminal_error',
          canDisplayPlainSynced: false,
          terminalErrorMessage: 'Upload failed.',
        }),
      },
      'Backup stopped',
    ],
    [
      'exclusion',
      {
        signedIn: true,
        status: status({
          syncAxis: 'dirty_pending',
          canDisplayPlainSynced: false,
          blockers: ['excluded_authoritative_state'],
          excludedSummary: { privateRawDataCount: 2, unsupportedCount: 1 },
        }),
      },
      'Some files stay local',
    ],
    [
      'quota',
      {
        signedIn: true,
        status: status({
          syncAxis: 'terminal_error',
          canDisplayPlainSynced: false,
          terminalErrorCode: 'QUOTA_EXCEEDED',
        }),
      },
      'Storage limit reached',
    ],
  ])('renders %s state', (_name, input, label) => {
    const display = describeWorkspaceSyncDisplay(input);
    expect(display.label).toBe(label);
    expect(display.scopeDetail).toBeNull();
  });

  it('keeps full cloud-backup scope copy for Enable confirmation / docs', () => {
    expect(CLOUD_BACKUP_SCOPE_DETAIL.toLowerCase()).toContain('not end-to-end encrypted');
  });

  it('signed-out display is minimal (no menu essay)', () => {
    const display = describeWorkspaceSyncDisplay({ signedIn: false, status: null });
    expect(display.label).toBe('Off');
    expect(display.detail).toBe('');
    expect(display.scopeDetail).toBeNull();
  });

  it('allows Backup now from offline and terminal error states', () => {
    expect(
      describeWorkspaceSyncDisplay({
        signedIn: true,
        status: status({ syncAxis: 'service_paused', canDisplayPlainSynced: false }),
      }).canForceSync
    ).toBe(false);
    expect(
      describeWorkspaceSyncDisplay({
        signedIn: true,
        status: status({ syncAxis: 'offline_retry', canDisplayPlainSynced: false }),
      }).canForceSync
    ).toBe(true);
    expect(
      describeWorkspaceSyncDisplay({
        signedIn: true,
        status: status({
          syncAxis: 'terminal_error',
          canDisplayPlainSynced: false,
          terminalErrorMessage: 'Upload failed.',
        }),
      }).canForceSync
    ).toBe(true);
    expect(
      describeWorkspaceSyncDisplay({
        signedIn: true,
        status: status({ syncAxis: 'conflict', canDisplayPlainSynced: false }),
      }).canForceSync
    ).toBe(false);
  });

  it('reports an unreadable status as unknown, NOT as local-only', () => {
    const unavailable = describeWorkspaceSyncDisplay({
      signedIn: true,
      status: null,
      statusUnavailable: true,
    });
    expect(unavailable.label).toBe('Status unavailable');
    expect(unavailable.label).not.toBe('Local only');
    expect(unavailable.tone).toBe('warning');
  });

  it('withholds every capability while the status is unknown', () => {
    const unavailable = describeWorkspaceSyncDisplay({
      signedIn: true,
      status: status({ syncAxis: 'idle_synced' }),
      statusUnavailable: true,
    });
    expect(unavailable.canForceSync).toBe(false);
    expect(unavailable.canCopyShareLink).toBe(false);
    expect(unavailable.canEnableSync).toBe(false);
    expect(unavailable.canDeleteCloudCopy).toBe(false);
  });

  it('still reports a genuinely unmanaged project as local-only', () => {
    expect(describeWorkspaceSyncDisplay({ signedIn: true, status: null }).label).toBe('Local only');
  });

  it('formats exclusion aggregates for the account menu', () => {
    expect(formatExclusionDetail(null)).toBeNull();
    expect(
      formatExclusionDetail({
        privateRawDataCount: 2,
        unsupportedCount: 3,
        fileTooLargeCount: 1,
      })
    ).toBe('Left local: 2 raw/sequencing, 1 too large, 3 unsupported type.');
  });

  describe(' shared projects', () => {
    const shared = (patch: Partial<WorkspaceSyncStatus>) =>
      describeWorkspaceSyncDisplay({
        signedIn: true,
        status: status({ shared: true, accessRole: 'editor', accessSource: 'direct', ...patch }),
      });

    it.each([
      ['uploading', 'Syncing'],
      ['queued', 'Syncing'],
      ['dirty_pending', 'Changes waiting to sync'],
      ['offline_retry', 'Offline — changes saved on this computer'],
      ['conflict', 'Changes need your attention'],
      ['terminal_error', 'Needs attention'],
      ['idle_synced', 'Up to date'],
    ] as const)('uses the shared wording for %s', (syncAxis, label) => {
      expect(shared({ syncAxis, canDisplayPlainSynced: syncAxis === 'idle_synced' }).label).toBe(
        label
      );
    });

    it('keeps the personal wording for projects that are not shared', () => {
      const personal = describeWorkspaceSyncDisplay({
        signedIn: true,
        status: status({ syncAxis: 'offline_retry', canDisplayPlainSynced: false }),
      });
      expect(personal.label).toBe('Offline, retrying');
    });

    it('explains access removal and withholds every cloud action', () => {
      const removed = shared({
        syncAxis: 'access_removed',
        canDisplayPlainSynced: false,
        blockers: ['access_removed'],
      });
      expect(removed.label).toBe('Access removed');
      expect(removed.tone).toBe('danger');
      expect(removed.canForceSync).toBe(false);
      expect(removed.canDeleteCloudCopy).toBe(false);
      expect(removed.canEnableSync).toBe(false);
    });

    it('tells a viewer that their changes stay on this computer', () => {
      const viewer = shared({
        syncAxis: 'view_only',
        accessRole: 'viewer',
        canDisplayPlainSynced: false,
        blockers: ['view_only'],
      });
      expect(viewer.label).toBe('View only');
      expect(viewer.canForceSync).toBe(false);
      expect(viewer.canDeleteCloudCopy).toBe(false);
    });

    it('lets only the controlling owner remove the cloud copy', () => {
      expect(shared({ accessRole: 'manager', accessSource: 'direct' }).canDeleteCloudCopy).toBe(
        false
      );
      expect(shared({ accessRole: 'owner', accessSource: 'owner' }).canDeleteCloudCopy).toBe(true);
      expect(shared({ accessRole: 'owner', accessSource: 'org_admin' }).canDeleteCloudCopy).toBe(
        true
      );
    });
  });
});
