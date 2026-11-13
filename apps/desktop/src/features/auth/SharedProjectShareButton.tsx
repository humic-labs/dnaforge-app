import type { CSSProperties } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { openProjectSharing } from './cloud-surface-store';
import { useDesktopSignInEnabled } from './useDesktopSignInEnabled';
import { useWorkspaceCloudSyncEnabled } from './useWorkspaceCloudSyncEnabled';

export function SharedProjectShareButton() {
  const signInEnabled = useDesktopSignInEnabled();
  const cloudSyncEnabled = useWorkspaceCloudSyncEnabled();
  const signedIn = useAuthStore((s) => s.state.status === 'signed-in');
  if (!signInEnabled || !cloudSyncEnabled || !signedIn) return null;
  return (
    <button
      type="button"
      data-testid="shared-project-share"
      title="Invite people to this project"
      onClick={() => openProjectSharing()}
      className="ml-1 inline-flex items-center rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-fg-muted hover:bg-bg-muted hover:text-fg"
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      Share
    </button>
  );
}
