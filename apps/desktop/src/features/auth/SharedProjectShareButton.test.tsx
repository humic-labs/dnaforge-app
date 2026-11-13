import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { openProjectSharing } from './cloud-surface-store';

const h = vi.hoisted(() => ({
  signInEnabled: true,
  cloudSyncEnabled: true,
  signedIn: true,
}));

vi.mock('./useDesktopSignInEnabled', () => ({
  useDesktopSignInEnabled: () => h.signInEnabled,
}));
vi.mock('./useWorkspaceCloudSyncEnabled', () => ({
  useWorkspaceCloudSyncEnabled: () => h.cloudSyncEnabled,
}));
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: (selector: (s: { state: { status: string } }) => unknown) =>
    selector({ state: { status: h.signedIn ? 'signed-in' : 'signed-out' } }),
}));
vi.mock('./cloud-surface-store', () => ({
  openProjectSharing: vi.fn(),
}));

import { SharedProjectShareButton } from './SharedProjectShareButton';

beforeEach(() => {
  cleanup();
  h.signInEnabled = true;
  h.cloudSyncEnabled = true;
  h.signedIn = true;
  vi.mocked(openProjectSharing).mockClear();
});

describe('SharedProjectShareButton', () => {
  it('hides when signed out or cloud sync is off', () => {
    h.signedIn = false;
    const { rerender } = render(<SharedProjectShareButton />);
    expect(screen.queryByTestId('shared-project-share')).toBeNull();
    h.signedIn = true;
    h.cloudSyncEnabled = false;
    rerender(<SharedProjectShareButton />);
    expect(screen.queryByTestId('shared-project-share')).toBeNull();
  });

  it('opens project sharing from the project chrome', () => {
    render(<SharedProjectShareButton />);
    fireEvent.click(screen.getByTestId('shared-project-share'));
    expect(openProjectSharing).toHaveBeenCalled();
  });
});
