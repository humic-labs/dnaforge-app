import { toUserMessage } from '@waypoint/user-messages';
import type { CSSProperties } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { describeWorkspaceSyncDisplay, type WorkspaceSyncTone } from './workspace-sync-display';
import { useWorkspaceCloudSyncEnabled } from './useWorkspaceCloudSyncEnabled';
import { useActiveWorkspaceSyncStatus } from './useCloudWorkspaceController';
import { openCloudSurface } from './cloud-surface-store';

function toneClass(tone: WorkspaceSyncTone): string {
  switch (tone) {
    case 'success':
      return 'border-success/40 bg-success/10 text-success';
    case 'warning':
      return 'border-warning/40 bg-warning/10 text-warning';
    case 'danger':
      return 'border-error/40 bg-error/10 text-error';
    case 'info':
      return 'border-accent/40 bg-accent/10 text-accent';
    default:
      return 'border-border bg-bg-muted text-fg-muted';
  }
}

export function SharedProjectStatusChip() {
  const cloudSyncEnabled = useWorkspaceCloudSyncEnabled();
  const authState = useAuthStore((s) => s.state);
  const signedIn = authState.status === 'signed-in';
  const status = useActiveWorkspaceSyncStatus(cloudSyncEnabled && signedIn);
  if (!status || !status.shared) return null;
  const display = describeWorkspaceSyncDisplay({ signedIn, status });
  return (
    <button
      type="button"
      data-testid="shared-project-status-chip"
      data-sync-axis={status.syncAxis}
      title={toUserMessage(display.detail, 'failure.open-cloud-backup')}
      onClick={() => openCloudSurface()}
      className={`ml-2 inline-flex max-w-[260px] items-center gap-1.5 truncate rounded border px-1.5 py-0.5 text-[10px] font-medium ${toneClass(display.tone)}`}
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      <span className="truncate">{display.label}</span>
    </button>
  );
}
