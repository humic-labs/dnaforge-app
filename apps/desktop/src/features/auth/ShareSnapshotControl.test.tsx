import { expectToastCall } from '../../test/toast-assertions';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  signedIn: true,
  accountId: 'account-a',
  editMode: false,
  workspaceUuid: 'repo-uuid-a' as string | null,
  copyShareLink: vi.fn(),
  addToast: vi.fn(),
  confirmDialog: vi.fn(async () => true),
  dbSelect: vi.fn(),
  writeClipboardText: vi.fn(),
}));

vi.mock('../../stores/auth-store', () => ({
  useAuthStore: (
    sel: (s: { state: { status: string; session: { accountId: string } } }) => unknown
  ) =>
    sel({
      state: {
        status: h.signedIn ? 'signed-in' : 'signed-out',
        session: { accountId: h.accountId },
      },
    }),
}));

vi.mock('../../stores/sequence-edit-mode-store', () => ({
  useSequenceEditModeStore: (sel: (s: { active: boolean }) => unknown) =>
    sel({ active: h.editMode }),
}));

vi.mock('../../stores/toast-store', () => ({
  useToastStore: (sel: (s: { addToast: typeof h.addToast }) => unknown) =>
    sel({ addToast: h.addToast }),
}));

vi.mock('../../components/confirm-dialog-store', () => ({
  confirmDialog: (...args: unknown[]) => h.confirmDialog(...args),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    db: {
      select: (...args: unknown[]) => h.dbSelect(...args),
    },
    clipboard: {
      writeText: (...args: unknown[]) => h.writeClipboardText(...args),
    },
    cloudSync: {
      copyShareLink: (...args: unknown[]) => h.copyShareLink(...args),
    },
  }),
}));

vi.mock('../../shared/components/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

import { ShareSnapshotControl } from './ShareSnapshotControl';
import {
  SHARE_SNAPSHOT_CONFIRM_MESSAGE,
  SHARE_SNAPSHOT_CONFIRM_TITLE,
  SHARE_SNAPSHOT_EDIT_MODE_BLOCKED,
} from './share-snapshot';

describe('ShareSnapshotControl', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.signedIn = true;
    h.accountId = 'account-a';
    h.editMode = false;
    h.workspaceUuid = 'repo-uuid-a';
    h.dbSelect.mockResolvedValue([{ repo_uuid: 'repo-uuid-a' }]);
    h.copyShareLink.mockResolvedValue({
      ok: true,
      url: 'https://dnaforge.com/d/abc#token=t',
      versionId: 'v1',
      versionNumber: 3,
    });
    h.confirmDialog.mockResolvedValue(true);
    h.writeClipboardText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('disables share while sequence edit mode is active', async () => {
    h.editMode = true;
    render(<ShareSnapshotControl workspaceRootPath="/workspace/project" />);
    const button = await screen.findByTestId('share-snapshot-button');
    expect(button).toBeDisabled();
    expect(button.getAttribute('data-share-disabled-reason')).toBe(
      SHARE_SNAPSHOT_EDIT_MODE_BLOCKED
    );
    fireEvent.click(button);
    expect(h.copyShareLink).not.toHaveBeenCalled();
  });

  it('confirms public warning then backups and copies the snapshot link', async () => {
    render(<ShareSnapshotControl workspaceRootPath="/workspace/project" />);
    const button = await screen.findByTestId('share-snapshot-button');
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() =>
      expect(h.confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: SHARE_SNAPSHOT_CONFIRM_TITLE,
          message: SHARE_SNAPSHOT_CONFIRM_MESSAGE,
          confirmLabel: 'Back up & copy link',
        })
      )
    );
    await waitFor(() => expect(h.copyShareLink).toHaveBeenCalledWith('repo-uuid-a'));
    expectToastCall(h.addToast, expect.stringContaining('Anyone with this link'), 'success');
  });

  it('retries only Copy for the same published snapshot after clipboard rejection', async () => {
    h.writeClipboardText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    render(<ShareSnapshotControl workspaceRootPath="/workspace/project" />);
    const button = await screen.findByTestId('share-snapshot-button');
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await screen.findByRole('button', { name: 'Copy snapshot link' });
    expect(h.copyShareLink).toHaveBeenCalledTimes(1);
    expect(h.confirmDialog).toHaveBeenCalledTimes(1);
    fireEvent.click(button);
    await waitFor(() => expect(h.writeClipboardText).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button).toHaveAccessibleName('Share snapshot'));
    expect(h.copyShareLink).toHaveBeenCalledTimes(1);
    expect(h.confirmDialog).toHaveBeenCalledTimes(1);
    expect(h.writeClipboardText.mock.calls.map(([text]) => text)).toEqual([
      'https://dnaforge.com/d/abc#token=t',
      'https://dnaforge.com/d/abc#token=t',
    ]);
    expectToastCall(h.addToast, expect.stringContaining('Snapshot link copied (v3)'), 'success');
  });

  it('hides the old workspace binding and retained link until the new root resolves', async () => {
    h.writeClipboardText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    const view = render(<ShareSnapshotControl workspaceRootPath="/workspace/a" />);
    const button = await screen.findByTestId('share-snapshot-button');
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await screen.findByRole('button', { name: 'Copy snapshot link' });
    let complete: ((rows: Array<{ repo_uuid: string }>) => void) | undefined;
    h.dbSelect.mockReturnValueOnce(
      new Promise<Array<{ repo_uuid: string }>>((resolve) => {
        complete = resolve;
      })
    );
    view.rerender(<ShareSnapshotControl workspaceRootPath="/workspace/b" />);
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleName('Share snapshot');
    fireEvent.click(button);
    expect(h.copyShareLink).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (!complete) throw new Error('New workspace lookup did not start');
      complete([{ repo_uuid: 'repo-uuid-b' }]);
    });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(h.copyShareLink).toHaveBeenLastCalledWith('repo-uuid-b'));
    expect(h.confirmDialog).toHaveBeenCalledTimes(2);
  });

  it('retires a retained link when the account changes while signedIn stays true', async () => {
    h.writeClipboardText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    const view = render(<ShareSnapshotControl workspaceRootPath="/workspace/project" />);
    const button = await screen.findByTestId('share-snapshot-button');
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await screen.findByRole('button', { name: 'Copy snapshot link' });
    h.accountId = 'account-b';
    h.dbSelect.mockResolvedValue([{ repo_uuid: 'repo-b' }]);
    view.rerender(<ShareSnapshotControl workspaceRootPath="/workspace/project" />);
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveAccessibleName('Share snapshot');
    fireEvent.click(button);
    await waitFor(() => expect(h.copyShareLink).toHaveBeenLastCalledWith('repo-b'));
    expect(h.confirmDialog).toHaveBeenCalledTimes(2);
  });

  it('does not publish a confirmation accepted after the workspace changes', async () => {
    let confirm: ((accepted: boolean) => void) | undefined;
    h.confirmDialog.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        confirm = resolve;
      })
    );
    const view = render(<ShareSnapshotControl workspaceRootPath="/workspace/a" />);
    const button = await screen.findByTestId('share-snapshot-button');
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(h.confirmDialog).toHaveBeenCalledTimes(1));
    view.rerender(<ShareSnapshotControl workspaceRootPath="/workspace/b" />);
    await act(async () => {
      if (!confirm) throw new Error('Snapshot confirmation did not start');
      confirm(true);
    });
    expect(h.copyShareLink).not.toHaveBeenCalled();
    expect(h.writeClipboardText).not.toHaveBeenCalled();
  });

  it('does not copy or announce an old publication after an account switch', async () => {
    let finish: ((value: { ok: true; url: string; versionId: string }) => void) | undefined;
    h.copyShareLink.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const view = render(<ShareSnapshotControl workspaceRootPath="/workspace/project" />);
    const button = await screen.findByTestId('share-snapshot-button');
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(h.copyShareLink).toHaveBeenCalledTimes(1));
    h.accountId = 'account-b';
    view.rerender(<ShareSnapshotControl workspaceRootPath="/workspace/project" />);
    await act(async () => {
      if (!finish) throw new Error('Snapshot publication did not start');
      finish({
        ok: true,
        url: 'https://example.invalid/OLD_PRIVATE_LINK',
        versionId: 'old-version',
      });
    });
    expect(h.writeClipboardText).not.toHaveBeenCalled();
    expect(h.addToast).not.toHaveBeenCalled();
  });
});
