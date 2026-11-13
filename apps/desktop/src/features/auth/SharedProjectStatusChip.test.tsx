import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { openCloudSurface } from './cloud-surface-store';

const h = vi.hoisted(() => ({
  signedIn: true,
  status: {
    shared: true,
    syncAxis: 'idle' as const,
    bufferAxis: 'clean' as const,
    canDisplayPlainSynced: true,
    blockers: [] as string[],
    excludedAuthoritativeState: [] as string[],
    excludedSummary: null,
    terminalErrorCode: null,
    terminalErrorMessage: null,
    workspaceUuid: 'ws',
  },
}));

vi.mock('../../stores/auth-store', () => ({
  useAuthStore: (selector: (s: { state: { status: string } }) => unknown) =>
    selector({ state: { status: h.signedIn ? 'signed-in' : 'signed-out' } }),
}));
vi.mock('./useWorkspaceCloudSyncEnabled', () => ({
  useWorkspaceCloudSyncEnabled: () => true,
}));
vi.mock('./useCloudWorkspaceController', () => ({
  useActiveWorkspaceSyncStatus: () => h.status,
}));
vi.mock('./cloud-surface-store', () => ({
  openCloudSurface: vi.fn(),
}));
vi.mock('./workspace-sync-display', () => ({
  describeWorkspaceSyncDisplay: () => ({
    label: 'Up to date',
    detail: 'Shared and current',
    scopeDetail: null,
    exclusionDetail: null,
    tone: 'success',
    canForceSync: false,
    canCopyShareLink: false,
    canEnableSync: false,
    canDeleteCloudCopy: false,
  }),
}));

import { SharedProjectStatusChip } from './SharedProjectStatusChip';

beforeEach(() => {
  cleanup();
  h.signedIn = true;
  h.status.shared = true;
  vi.mocked(openCloudSurface).mockClear();
});

describe('SharedProjectStatusChip', () => {
  it('opens Cloud backup when clicked', () => {
    render(<SharedProjectStatusChip />);
    fireEvent.click(screen.getByTestId('shared-project-status-chip'));
    expect(openCloudSurface).toHaveBeenCalledWith();
  });
});
