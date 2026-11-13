import { userMessage } from '@waypoint/user-messages';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostedWorkspaceApiError, createHostedWorkspaceShare } from './api';
import { HostedShareDialog } from './HostedShareDialog';
import { HostedWorkspaceChrome } from './HostedWorkspaceChrome';

const displayedSession = vi.hoisted(() => ({ principal: { id: 'alice' } }));

vi.mock('./controller', () => ({
  hostedWorkspaceSessionController: {
    subscribe: () => () => {},
    getState: () => displayedSession,
  },
  hostedDurableSync: {
    subscribe: () => () => {},
    getRevision: () => 0,
    getStatus: () => undefined,
  },
}));
vi.mock('./HostedHistoryPanel', () => ({ HostedHistoryPanel: () => null }));
vi.mock('./HostedSyncStatus', () => ({ HostedSyncStatus: () => null }));
vi.mock('./BrowserWorkspaceReadPanel', () => ({ BrowserWorkspaceReadPanel: () => null }));

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, createHostedWorkspaceShare: vi.fn() };
});

const createShareMock = vi.mocked(createHostedWorkspaceShare);

afterEach(() => {
  createShareMock.mockReset();
  vi.unstubAllGlobals();
});

const props = {
  expectedAccountId: 'alice',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  revisionId: '22222222-2222-4222-8222-222222222222',
  revisionNumber: 3,
  workspaceName: 'Plasmid project',
  onClose: vi.fn(),
};

function success() {
  return {
    workspaceId: props.workspaceId,
    revisionPolicy: 'pinned_version' as const,
    pinnedVersion: {
      id: props.revisionId,
      versionNumber: props.revisionNumber,
      contentSha256: 'a'.repeat(64),
      sizeBytes: 42,
      fileCount: 1,
      createdAt: '2026-09-30T00:00:00Z',
    },
    share: {
      id: 'share-1',
      shortId: 'share12345',
      linkToken: 'opaque-token',
      url: 'https://dnaforge.com/d/share12345#token=opaque-token',
      scopeMode: 'anyone-with-link' as const,
      displayLabel: 'Plasmid project',
      expiresAt: null,
      createdAt: '2026-09-30T00:01:00Z',
    },
    short_id: 'share12345',
    link_token: 'opaque-token',
    url: 'https://dnaforge.com/d/share12345#token=opaque-token',
  };
}

describe('HostedShareDialog', () => {
  it('publishes under the account displayed by the real workspace chrome', async () => {
    createShareMock.mockResolvedValue(success());
    render(
      <HostedWorkspaceChrome
        fileInputRef={{ current: null }}
        historyOpen={false}
        onHistoryToggle={vi.fn()}
        onImport={vi.fn()}
        onSignOut={vi.fn()}
        onHistoryClose={vi.fn()}
        onRestored={vi.fn()}
        status={null}
        browserReadOpen={false}
        browserReadTarget={null}
        versionId={props.revisionId}
        onBrowserReadClose={vi.fn()}
        shareOpen
        shareTarget={props}
        onShareClose={vi.fn()}
        onShareCreated={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('hosted-share-publish'));

    await waitFor(() =>
      expect(createShareMock).toHaveBeenCalledWith(
        expect.objectContaining({ expectedAccountId: displayedSession.principal.id })
      )
    );
  });

  it('cannot publish without the account displayed by the initiating screen', () => {
    render(<HostedShareDialog {...props} expectedAccountId={undefined} />);
    expect(screen.getByTestId('hosted-share-publish')).toBeDisabled();
    fireEvent.click(screen.getByTestId('hosted-share-publish'));
    expect(createShareMock).not.toHaveBeenCalled();
  });

  it('does not publish a late Alice link into a dialog for Bob', async () => {
    let resolve!: (value: ReturnType<typeof success>) => void;
    createShareMock.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    const onCreated = vi.fn();
    const view = render(<HostedShareDialog {...props} onCreated={onCreated} />);
    fireEvent.click(screen.getByTestId('hosted-share-publish'));
    expect(createShareMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAccountId: 'alice' })
    );
    view.rerender(<HostedShareDialog {...props} expectedAccountId="bob" onCreated={onCreated} />);
    resolve(success());
    await waitFor(() =>
      expect(screen.getByTestId('hosted-share-publish')).not.toHaveTextContent('Publishing')
    );
    expect(screen.queryByTestId('hosted-share-url')).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
  });
  it('cannot publish an older accepted revision while the current draft is pending', () => {
    render(<HostedShareDialog {...props} blockedReason={userMessage('sharing.syncRequired')} />);
    expect(screen.getByTestId('hosted-share-publish')).toBeDisabled();
    fireEvent.click(screen.getByTestId('hosted-share-publish'));
    expect(createShareMock).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(userMessage('sharing.syncRequired'));
  });
  it('requires an explicit public warning before pinning and exposes the URL', async () => {
    createShareMock.mockResolvedValue(success());
    const onCreated = vi.fn();
    render(<HostedShareDialog {...props} onCreated={onCreated} />);

    expect(screen.getByTestId('hosted-share-warning')).toHaveTextContent(
      'Anyone who receives this link can view the exact files'
    );
    fireEvent.change(screen.getByTestId('hosted-share-label'), {
      target: { value: 'Tweet review' },
    });
    fireEvent.click(screen.getByTestId('hosted-share-publish'));

    await waitFor(() => expect(screen.getByTestId('hosted-share-url')).toHaveValue(success().url));
    expect(createShareMock).toHaveBeenCalledWith({
      expectedAccountId: props.expectedAccountId,
      workspaceId: props.workspaceId,
      expectedLatestVersionId: props.revisionId,
      displayLabel: 'Tweet review',
    });
    expect(onCreated).toHaveBeenCalledWith('Pinned public link created.');
    expect(screen.getByRole('link', { name: 'Open preview' })).toHaveAttribute(
      'href',
      success().url
    );
  });

  it('does not hide a stale-revision refusal', async () => {
    createShareMock.mockRejectedValue(
      new HostedWorkspaceApiError(409, 'SYNC_CONFLICT', 'This project changed in another session.')
    );
    render(<HostedShareDialog {...props} />);

    fireEvent.click(screen.getByTestId('hosted-share-publish'));

    await waitFor(() =>
      expect(screen.getByTestId('hosted-share-error')).toHaveTextContent(
        userMessage('failure.could-not-publish-the-sequence-link')
      )
    );
    expect(screen.queryByTestId('hosted-share-url')).toBeNull();
  });

  it('uses the browser clipboard only after the share exists', async () => {
    createShareMock.mockResolvedValue(success());
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<HostedShareDialog {...props} />);

    fireEvent.click(screen.getByTestId('hosted-share-publish'));
    await waitFor(() => expect(screen.getByTestId('hosted-share-copy')).toBeVisible());
    fireEvent.click(screen.getByTestId('hosted-share-copy'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(success().url));
    expect(screen.getByTestId('hosted-share-message')).toHaveTextContent('Link copied');
  });
});
