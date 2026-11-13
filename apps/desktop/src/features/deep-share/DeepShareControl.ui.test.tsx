/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmDialogHost } from '../../components/ConfirmDialogHost';
import { useConfirmDialogStore } from '../../components/confirm-dialog-store';
import { useAuthStore } from '../../stores/auth-store';
import { useSequenceEditModeStore } from '../../stores/sequence-edit-mode-store';
import { useToastStore } from '../../stores/toast-store';
import { DeepShareControl } from './DeepShareControl';
import type { DeepShareReview } from '../../shared/deep-share-ipc';

const platformMocks = vi.hoisted(() => ({
  select: vi.fn(),
  exists: vi.fn(),
  preflightDeepShare: vi.fn(),
  setEnabled: vi.fn(),
  cancelDeepShare: vi.fn(),
  publishDeepShare: vi.fn(),
  writeClipboardText: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    db: { select: platformMocks.select },
    fs: { exists: platformMocks.exists },
    cloudSync: {
      preflightDeepShare: platformMocks.preflightDeepShare,
      setEnabled: platformMocks.setEnabled,
      cancelDeepShare: platformMocks.cancelDeepShare,
      publishDeepShare: platformMocks.publishDeepShare,
    },
    clipboard: { writeText: platformMocks.writeClipboardText },
  }),
}));

const realStartSignIn = useAuthStore.getState().startSignIn;
const startSignIn = vi.fn().mockResolvedValue(undefined);

function sequenceReview(includeConversation = false): DeepShareReview {
  const artifact = { id: 'sequence-1', type: 'sequence' as const, name: 'pUC19' };
  const chats: DeepShareReview['chats'] = includeConversation
    ? [
        {
          id: 'chat-1',
          title: 'Design notes',
          createdAt: '2026-10-02T04:00:00Z',
          updatedAt: '2026-10-02T04:00:00Z',
          messages: [
            {
              id: 'message-1',
              role: 'assistant',
              content: 'Portable conclusion',
              createdAt: '2026-10-02T04:00:00Z',
              references: [],
            },
          ],
        },
      ]
    : [];
  return {
    workspace: { uuid: 'workspace-1', name: 'Project', remoteWorkspaceId: 'remote-1' },
    rootArtifactId: artifact.id,
    rootArtifact: artifact,
    manifest: {
      rootArtifactId: artifact.id,
      artifacts: [artifact],
      relationships: [],
      files: [],
      chats: chats.map((chat) => ({ conversationId: chat.id, title: chat.title })),
      omissions: [],
    },
    files: [],
    chats,
    conversationCandidates: [
      { id: 'chat-1', title: 'Design notes', createdAt: 1, updatedAt: 2, exactReferenceCount: 1 },
    ],
    digest: 'a'.repeat(64),
  };
}

function signInForReview(accountId = 'account-1') {
  useAuthStore.setState({
    state: {
      status: 'signed-in',
      session: {
        accountId,
        email: 'scientist@example.com',
        displayName: 'Scientist',
      },
    },
  });
  platformMocks.select.mockResolvedValue([
    {
      repo_uuid: 'workspace-1',
      artifact_id: 'sequence-1',
      artifact_type: 'sequence',
      file_path: '/workspace/pUC19',
      file_kind: 'waypoint-sequence',
    },
  ]);
}

describe('DeepShareControl entry point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformMocks.preflightDeepShare.mockReset();
    platformMocks.publishDeepShare.mockReset();
    platformMocks.writeClipboardText.mockReset();
    startSignIn.mockClear();
    useAuthStore.setState({ state: { status: 'signed-out' }, startSignIn });
    useSequenceEditModeStore.setState({ active: false });
    useToastStore.getState().clearToasts();
    platformMocks.select.mockResolvedValue([]);
    platformMocks.exists.mockResolvedValue(false);
  });

  afterEach(() => {
    useConfirmDialogStore.getState().resolveCurrent(false);
    cleanup();
    useAuthStore.setState({ startSignIn: realStartSignIn });
    useToastStore.getState().clearToasts();
  });

  it('starts sign-in when a signed-out user clicks Share', () => {
    render(<DeepShareControl workspaceRootPaths={['/workspace']} targetReference="design-1" />);

    const button = screen.getByRole('button', { name: 'Share' });
    expect(button).not.toBeDisabled();

    fireEvent.click(button);

    expect(startSignIn).toHaveBeenCalledOnce();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('keeps conversation review through a parent redraw with equivalent workspace roots', async () => {
    signInForReview();
    let finishReview!: (result: { ok: true; review: DeepShareReview }) => void;
    const pendingReview = new Promise<{ ok: true; review: DeepShareReview }>((resolve) => {
      finishReview = resolve;
    });
    platformMocks.preflightDeepShare
      .mockResolvedValueOnce({ ok: true, review: sequenceReview() })
      .mockReturnValueOnce(pendingReview);
    const view = render(
      <DeepShareControl workspaceRootPaths={['/workspace']} targetReference="sequence-1" />
    );
    await waitFor(() => expect(platformMocks.select).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await screen.findByRole('dialog', { name: 'Review Deep Share' });
    fireEvent.click(screen.getByLabelText('Include conversation Design notes'));
    expect(platformMocks.preflightDeepShare).toHaveBeenLastCalledWith({
      workspaceUuid: 'workspace-1',
      rootArtifactId: 'sequence-1',
      selectedArtifactIds: ['sequence-1'],
      selectedConversationIds: ['chat-1'],
    });

    view.rerender(
      <DeepShareControl workspaceRootPaths={['/workspace']} targetReference="sequence-1" />
    );
    expect(screen.getByRole('dialog', { name: 'Review Deep Share' })).toBeVisible();
    await act(async () => {
      finishReview({ ok: true, review: sequenceReview(true) });
      await pendingReview;
    });
    expect(screen.getByTestId('deep-share-chat-transcript')).toHaveTextContent(
      'Portable conclusion'
    );
    expect(screen.getByLabelText('Include conversation Design notes')).toBeChecked();
    expect(platformMocks.select).toHaveBeenCalledOnce();
    expect(platformMocks.publishDeepShare).not.toHaveBeenCalled();
  });

  it.each(['workspace', 'artifact', 'account', 'signed-out'] as const)(
    'does not reinstall private review after the %s context changes',
    async (changed) => {
      signInForReview();
      let finishReview!: (result: { ok: true; review: DeepShareReview }) => void;
      const pendingReview = new Promise<{ ok: true; review: DeepShareReview }>((resolve) => {
        finishReview = resolve;
      });
      platformMocks.preflightDeepShare.mockReturnValueOnce(pendingReview);
      const view = render(
        <DeepShareControl workspaceRootPaths={['/workspace']} targetReference="sequence-1" />
      );
      await waitFor(() => expect(platformMocks.select).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole('button', { name: 'Share' }));
      await waitFor(() => expect(platformMocks.preflightDeepShare).toHaveBeenCalledOnce());
      if (changed === 'account')
        await act(async () => {
          signInForReview('account-2');
        });
      else if (changed === 'signed-out')
        await act(async () => {
          useAuthStore.setState({ state: { status: 'signed-out' } });
        });
      else
        view.rerender(
          <DeepShareControl
            workspaceRootPaths={[changed === 'workspace' ? '/other' : '/workspace']}
            targetReference={changed === 'artifact' ? 'sequence-2' : 'sequence-1'}
          />
        );
      await act(async () => {
        finishReview({ ok: true, review: sequenceReview(true) });
        await pendingReview;
      });
      expect(screen.queryByRole('dialog', { name: 'Review Deep Share' })).not.toBeInTheDocument();
      expect(screen.queryByText('Portable conclusion')).not.toBeInTheDocument();
      expect(platformMocks.publishDeepShare).not.toHaveBeenCalled();
      expect(platformMocks.writeClipboardText).not.toHaveBeenCalled();
    }
  );

  it('materializes an open design, enables backup with consent, and opens review', async () => {
    const ensureTarget = vi.fn().mockResolvedValue(undefined);
    const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    useAuthStore.setState({
      state: {
        status: 'signed-in',
        session: {
          accountId: 'account-1',
          email: 'scientist@example.com',
          displayName: 'Scientist',
        },
      },
    });
    platformMocks.select.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        repo_uuid: 'workspace-1',
        artifact_id: 'design-1',
        artifact_type: 'design',
        file_path: '/workspace/design-1.wpdesign.json',
        file_kind: 'waypoint-design',
      },
    ]);
    platformMocks.preflightDeepShare
      .mockResolvedValueOnce({
        ok: false,
        code: 'WORKSPACE_NOT_READY',
        message: 'Turn on cloud sync for an active managed workspace before sharing.',
      })
      .mockResolvedValueOnce({
        ok: true,
        review: {
          workspace: {
            uuid: 'workspace-1',
            name: 'Project',
            remoteWorkspaceId: 'remote-1',
          },
          rootArtifactId: 'design-1',
          rootArtifact: { id: 'design-1', type: 'design', name: 'Assembly' },
          manifest: {
            schemaVersion: 1,
            bundleId: 'bundle-1',
            rootArtifactId: 'design-1',
            artifacts: [{ id: 'design-1', type: 'design', name: 'Assembly' }],
            relationships: [],
            files: [],
            conversations: [],
            omissions: [],
          },
          files: [],
          chats: [],
          conversationCandidates: [],
          digest: 'a'.repeat(64),
        },
      });
    platformMocks.setEnabled.mockResolvedValue({ ok: true });
    platformMocks.publishDeepShare.mockResolvedValue({
      ok: true,
      url: 'https://dnaforge.com/share/share-token',
      versionNumber: 1,
    });
    platformMocks.writeClipboardText.mockResolvedValue(undefined);

    render(
      <>
        <DeepShareControl
          workspaceRootPaths={['/workspace']}
          targetReference="design-1"
          ensureTarget={ensureTarget}
        />
        <ConfirmDialogHost />
      </>
    );

    await waitFor(() => expect(platformMocks.select).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    const consentDialog = await screen.findByRole('dialog', {
      name: 'Enable cloud backup to share?',
    });
    expect(consentDialog).toHaveAttribute('data-testid', 'confirm-dialog');
    expect(nativeConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Enable & continue' }));

    await screen.findByRole('dialog', { name: 'Review Deep Share' });
    expect(ensureTarget).toHaveBeenCalledOnce();
    expect(platformMocks.setEnabled).toHaveBeenCalledWith('workspace-1', true);
    expect(platformMocks.preflightDeepShare).toHaveBeenCalledTimes(2);
    expect(useToastStore.getState().toasts).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Publish & copy link' }));
    await waitFor(() =>
      expect(platformMocks.writeClipboardText).toHaveBeenCalledWith(
        'https://dnaforge.com/share/share-token'
      )
    );
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        message: 'Deep Share published and link copied. Version 1.',
        type: 'success',
      }),
    ]);
    nativeConfirm.mockRestore();
  });

  it('retains the immutable published result when Copy fails, locks review, and retries without another publication', async () => {
    signInForReview();
    platformMocks.preflightDeepShare.mockResolvedValue({ ok: true, review: sequenceReview() });
    platformMocks.publishDeepShare.mockResolvedValue({
      ok: true,
      url: 'https://example.invalid/PRIVATE_PUBLISHED_LINK',
      versionNumber: 1,
      versionId: 'version-1',
      shareId: 'share-1',
      shortId: 'short-1',
      versionContentSha256: 'b'.repeat(64),
      bundleId: 'bundle-1',
      bundleContentSha256: 'c'.repeat(64),
    });
    platformMocks.writeClipboardText
      .mockRejectedValueOnce(new Error('PRIVATE_COPY_ERROR'))
      .mockResolvedValue(undefined);
    render(<DeepShareControl workspaceRootPaths={['/workspace']} targetReference="sequence-1" />);
    await waitFor(() => expect(platformMocks.select).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Deep Share' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish & copy link' }));
    const retry = await within(dialog).findByRole('button', { name: 'Copy published link' });
    await waitFor(() => expect(retry).not.toBeDisabled());
    expect(dialog).toHaveTextContent('Version 1 is published');
    expect(dialog).toHaveTextContent('Copy failed');
    expect(dialog).not.toHaveTextContent('PRIVATE_COPY_ERROR');
    expect(
      within(dialog).getByRole('checkbox', { name: 'Include conversation Design notes' })
    ).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Review Deep Share' })).toBeNull()
    );
    expect(platformMocks.publishDeepShare).toHaveBeenCalledTimes(1);
    expect(platformMocks.publishDeepShare).toHaveBeenCalledWith(
      expect.objectContaining({ reviewedDigest: 'a'.repeat(64) })
    );
    expect(platformMocks.preflightDeepShare).toHaveBeenCalledTimes(1);
    expect(platformMocks.writeClipboardText.mock.calls.map(([text]) => text)).toEqual([
      'https://example.invalid/PRIVATE_PUBLISHED_LINK',
      'https://example.invalid/PRIVATE_PUBLISHED_LINK',
    ]);
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: 'Deep Share published and link copied. Version 1.' }),
    ]);
  });

  it('closing a published review retains a Copy-only entry and does not cancel or republish it', async () => {
    signInForReview();
    platformMocks.preflightDeepShare.mockResolvedValue({ ok: true, review: sequenceReview() });
    platformMocks.publishDeepShare.mockResolvedValue({
      ok: true,
      url: 'https://example.invalid/LINK',
      versionNumber: 2,
    });
    platformMocks.writeClipboardText
      .mockRejectedValueOnce(new Error('copy refused'))
      .mockRejectedValueOnce(new Error('PRIVATE_COPY_ERROR'))
      .mockResolvedValue(undefined);
    render(<DeepShareControl workspaceRootPaths={['/workspace']} targetReference="sequence-1" />);
    await waitFor(() => expect(platformMocks.select).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Deep Share' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish & copy link' }));
    const close = await within(dialog).findByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).not.toBeDisabled());
    fireEvent.click(close);
    const retry = await screen.findByRole('button', { name: 'Copy published link' });
    expect(platformMocks.cancelDeepShare).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() => expect(platformMocks.writeClipboardText).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(retry).toBeEnabled());
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        message: 'Deep Share published, but Copy failed. Use Copy published link to retry.',
      }),
    ]);
    fireEvent.click(retry);
    await waitFor(() => expect(platformMocks.writeClipboardText).toHaveBeenCalledTimes(3));
    expect(platformMocks.publishDeepShare).toHaveBeenCalledTimes(1);
    expect(platformMocks.preflightDeepShare).toHaveBeenCalledTimes(1);
  });

  it('retires a failed-copy link when the signed-in account changes without signing out', async () => {
    signInForReview();
    platformMocks.preflightDeepShare.mockResolvedValue({ ok: true, review: sequenceReview() });
    platformMocks.publishDeepShare.mockResolvedValue({
      ok: true,
      url: 'https://example.invalid/ACCOUNT_A',
      versionNumber: 1,
    });
    platformMocks.writeClipboardText.mockRejectedValueOnce(new Error('copy refused'));
    render(<DeepShareControl workspaceRootPaths={['/workspace']} targetReference="sequence-1" />);
    await waitFor(() => expect(platformMocks.select).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Deep Share' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish & copy link' }));
    const retry = await within(dialog).findByRole('button', { name: 'Copy published link' });
    await waitFor(() => expect(retry).not.toBeDisabled());
    act(() => signInForReview('account-2'));
    await waitFor(() => expect(platformMocks.select).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Copy published link' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const nextReview = await screen.findByRole('dialog', { name: 'Review Deep Share' });
    expect(within(nextReview).getByRole('button', { name: 'Publish & copy link' })).toBeEnabled();
    expect(platformMocks.publishDeepShare).toHaveBeenCalledTimes(1);
    expect(platformMocks.writeClipboardText).toHaveBeenCalledTimes(1);
  });

  it('does not copy or adopt a publication completed after the account changes', async () => {
    signInForReview();
    platformMocks.preflightDeepShare.mockResolvedValue({ ok: true, review: sequenceReview() });
    let finish: ((result: { ok: true; url: string; versionNumber: number }) => void) | undefined;
    platformMocks.publishDeepShare.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    render(<DeepShareControl workspaceRootPaths={['/workspace']} targetReference="sequence-1" />);
    await waitFor(() => expect(platformMocks.select).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review Deep Share' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish & copy link' }));
    await waitFor(() => expect(platformMocks.publishDeepShare).toHaveBeenCalledOnce());
    act(() => signInForReview('account-2'));
    await act(async () => {
      if (!finish) throw new Error('Publication did not start');
      finish({ ok: true, url: 'https://example.invalid/OLD_ACCOUNT', versionNumber: 1 });
    });
    expect(platformMocks.writeClipboardText).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Copy published link' })).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
