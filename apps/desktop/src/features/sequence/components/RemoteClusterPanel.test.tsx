import { userMessage } from '@waypoint/user-messages';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RemoteDirectoryListingV1,
  RemoteEndpointProfileV1,
  RemoteExplorerClosedEventV1,
  RemoteExplorerSessionV1,
} from '../../../shared/remote-genomics-ipc';
import { RemoteClusterPanel } from './RemoteClusterPanel';

const api = vi.hoisted(() => ({
  openExplorer: vi.fn(),
  listRemoteDirectory: vi.fn(),
  closeExplorer: vi.fn(async () => true),
  cancelExplorerOpen: vi.fn(async () => true),
  subscribeExplorerClosed: vi.fn(),
  renameEndpoint: vi.fn(),
  forgetEndpoint: vi.fn(),
}));

const writeClipboard = vi.hoisted(() => vi.fn(async (_text: string) => undefined));
const explorerClosedListeners = new Set<(event: RemoteExplorerClosedEventV1) => void>();

function notifyExplorerClosed(event: RemoteExplorerClosedEventV1): void {
  for (const listener of explorerClosedListeners) listener(event);
}

vi.mock('../../../platform', () => ({
  platform: () => ({ remoteGenomics: api, clipboard: { writeText: writeClipboard } }),
}));

const session: RemoteExplorerSessionV1 = {
  sessionId: 'explorer-1',
  target: 'lab-hpc',
  platform: 'linux',
  homePath: '/home/researcher',
  connectedAt: 1,
};

const recentProfile: RemoteEndpointProfileV1 = {
  endpointId: 'endpoint-1234',
  displayName: 'Lab HPC',
  target: 'lab-hpc',
  lastConnectedAt: 200,
  observedPlatform: 'linux',
  lastFailure: null,
};

function renderPanel(
  onSubmit = vi.fn(async () => undefined),
  recentEndpoints: readonly RemoteEndpointProfileV1[] = []
) {
  return {
    ...render(
      <RemoteClusterPanel
        assemblyDisplayName="GRCh38"
        recentEndpoints={recentEndpoints}
        busy={false}
        submitLabel="Connect and attach"
        onSubmit={onSubmit}
      />
    ),
    onSubmit,
  };
}

it('offers supported Linux cluster computation on Windows and disables local decoding', () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'platform');
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
  try {
    renderPanel();
    expect(
      screen.getByRole('radio', { name: 'Compute reads on cluster', exact: true })
    ).toBeChecked();
    expect(
      screen.getByRole('radio', { name: 'Compute reads on this computer', exact: true })
    ).toBeDisabled();
    expect(screen.getByText(/Windows read tracks require the Linux compute service/)).toBeVisible();
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'platform', descriptor);
    else delete (navigator as unknown as { platform?: string }).platform;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  writeClipboard.mockReset().mockResolvedValue(undefined);
  api.renameEndpoint.mockReset();
  api.forgetEndpoint.mockReset();
  explorerClosedListeners.clear();
  api.subscribeExplorerClosed.mockImplementation(
    (listener: (event: RemoteExplorerClosedEventV1) => void) => {
      explorerClosedListeners.add(listener);
      return () => {
        explorerClosedListeners.delete(listener);
      };
    }
  );
  api.openExplorer.mockResolvedValue(session);
  api.listRemoteDirectory.mockResolvedValue({
    path: session.homePath,
    parentPath: '/home',
    entries: [],
    truncated: false,
  });
});

describe('remote connection panel', () => {
  it('routes authentication to standalone Remote hosts without starting a data connection', () => {
    renderPanel();
    const navigate = vi.fn();
    window.addEventListener('dnaforge:open-remote-hosts', navigate);
    fireEvent.click(screen.getByRole('button', { name: 'Manage Remote hosts' }));
    expect(navigate).toHaveBeenCalledOnce();
    expect(api.openExplorer).not.toHaveBeenCalled();
    window.removeEventListener('dnaforge:open-remote-hosts', navigate);
  });
  it('submits the private server receipt only when cluster computation is selected', async () => {
    const panel = renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.change(screen.getByLabelText('Remote alignment path'), {
      target: { value: '/run/tumor.bam' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Compute reads on cluster', exact: true }));
    fireEvent.change(screen.getByLabelText('Remote tile server receipt'), {
      target: { value: '/home/researcher/.dnaforge-hpc/connection.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect and attach' }));
    await waitFor(() =>
      expect(panel.onSubmit).toHaveBeenLastCalledWith({
        target: 'lab-hpc',
        alignmentPath: '/run/tumor.bam',
        tileServerReceiptPath: '/home/researcher/.dnaforge-hpc/connection.json',
      })
    );
    fireEvent.click(
      screen.getByRole('radio', { name: 'Compute reads on this computer', exact: true })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect and attach' }));
    await waitFor(() =>
      expect(panel.onSubmit).toHaveBeenLastCalledWith({
        target: 'lab-hpc',
        alignmentPath: '/run/tumor.bam',
      })
    );
  });

  it.each(['idle', 'connection-lost'] as const)(
    'discards a %s browser descriptor while preserving the paths for a fresh attachment',
    async (reason) => {
      const panel = renderPanel();
      fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
      for (const [label, path] of [
        ['Remote alignment path', '/run/tumor.bam'],
        ['Remote index path', '/run/tumor.bam.bai'],
        ['Remote BigWig path', '/run/tumor.bigWig'],
      ]) {
        fireEvent.change(screen.getByLabelText(label), { target: { value: path } });
      }
      fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
      await screen.findByTestId('remote-directory-browser');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Connect file browser' })).toBeEnabled()
      );
      act(() => notifyExplorerClosed({ sessionId: 'another-browser', reason }));
      expect(screen.getByText(/File access verified/u)).toBeInTheDocument();
      act(() => notifyExplorerClosed({ sessionId: session.sessionId, reason }));
      expect(screen.queryByText(/File access verified/u)).not.toBeInTheDocument();
      expect(screen.queryByTestId('remote-directory-browser')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(
        reason === 'idle' ? 'expired' : 'was lost'
      );
      expect(screen.getByRole('status')).toHaveTextContent('Reconnect');
      expect(screen.getByLabelText('Remote alignment path')).toHaveValue('/run/tumor.bam');
      expect(screen.getByLabelText('Remote index path')).toHaveValue('/run/tumor.bam.bai');
      expect(screen.getByLabelText('Remote BigWig path')).toHaveValue('/run/tumor.bigWig');
      fireEvent.click(screen.getByRole('button', { name: 'Connect and attach' }));
      await waitFor(() =>
        expect(panel.onSubmit).toHaveBeenCalledWith({
          target: 'lab-hpc',
          alignmentPath: '/run/tumor.bam',
          indexPath: '/run/tumor.bam.bai',
          signalPath: '/run/tumor.bigWig',
        })
      );
    }
  );

  it('rejects a descriptor that closed before its connection response arrived', async () => {
    let complete!: (value: RemoteExplorerSessionV1) => void;
    api.openExplorer.mockReturnValueOnce(
      new Promise<RemoteExplorerSessionV1>((resolve) => {
        complete = resolve;
      })
    );
    const panel = renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.change(screen.getByLabelText('Remote alignment path'), {
      target: { value: '/run/tumor.bam' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    act(() => notifyExplorerClosed({ sessionId: session.sessionId, reason: 'connection-lost' }));
    await act(async () => complete(session));
    expect(screen.queryByText(/File access verified/u)).not.toBeInTheDocument();
    expect(api.listRemoteDirectory).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('was lost');
    expect(screen.getByRole('button', { name: 'Connect file browser' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect and attach' }));
    await waitFor(() =>
      expect(panel.onSubmit).toHaveBeenCalledWith({
        target: 'lab-hpc',
        alignmentPath: '/run/tumor.bam',
      })
    );
  });

  it('invalidates a pending folder listing on closure and ignores its late failure', async () => {
    let failListing!: (error: Error) => void;
    api.listRemoteDirectory.mockReturnValueOnce(
      new Promise<RemoteDirectoryListingV1>((_resolve, reject) => {
        failListing = reject;
      })
    );
    renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.change(screen.getByLabelText('Remote alignment path'), {
      target: { value: '/run/tumor.bam' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    await screen.findByTestId('remote-directory-browser');
    act(() => notifyExplorerClosed({ sessionId: session.sessionId, reason: 'idle' }));
    expect(screen.getByRole('button', { name: 'Connect file browser' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Connect and attach' })).toBeEnabled();
    expect(screen.queryByTestId('remote-directory-browser')).not.toBeInTheDocument();
    api.openExplorer.mockResolvedValueOnce({ ...session, sessionId: 'explorer-2' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    await screen.findByTestId('remote-directory-browser');
    await act(async () => failListing(new Error('Old listing failed after expiry.')));
    expect(screen.getByText(/File access verified/u)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('finishes a disconnect when the close event precedes its RPC response', async () => {
    let finishDisconnect!: () => void;
    api.closeExplorer.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishDisconnect = () => resolve(true);
      })
    );
    renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    await screen.findByTestId('remote-directory-browser');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect file browser' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect file browser' }));
    act(() => notifyExplorerClosed({ sessionId: session.sessionId, reason: 'disconnected' }));
    expect(screen.getByRole('status')).toHaveTextContent('File browser disconnected');
    expect(screen.getByRole('button', { name: 'Connect file browser' })).toBeEnabled();
    api.openExplorer.mockResolvedValueOnce({ ...session, sessionId: 'explorer-2' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    await screen.findByTestId('remote-directory-browser');
    await act(async () => finishDisconnect());
    expect(screen.getByText(/File access verified/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect file browser' })).toBeEnabled();
  });

  it('copies a terminal command for the chosen host without opening a data connection', async () => {
    renderPanel();
    const copy = screen.getByRole('button', { name: 'Copy SSH command' });
    expect(copy).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Remote alignment path'), {
      target: { value: '/run/tumor.bam' },
    });
    for (const target of ['lab-hpc', 'researcher@login.example.edu', 'researcher@[::1]']) {
      fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: target } });
      fireEvent.click(copy);
      await waitFor(() => expect(writeClipboard).toHaveBeenLastCalledWith(`ssh "${target}"`));
      expect(await screen.findByRole('status')).toHaveTextContent('SSH command copied');
    }
    expect(api.openExplorer).not.toHaveBeenCalled();
    expect(api.closeExplorer).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Remote alignment path')).toHaveValue('/run/tumor.bam');
    for (const target of ['-oProxyCommand=id', 'host;whoami', 'host$(whoami)', 'lab hpc']) {
      fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: target } });
      expect(copy).toBeDisabled();
      expect(screen.queryByText(/SSH command copied/u)).not.toBeInTheDocument();
    }
    expect(writeClipboard).toHaveBeenCalledTimes(3);
  });

  it('keeps the terminal command available after a data prerequisite fails', async () => {
    api.openExplorer.mockRejectedValueOnce(new Error('Python 3 is not available on this host.'));
    renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Python 3 is not available');
    expect(screen.queryByText(/File access verified/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy SSH command' }));
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('ssh "lab-hpc"'));
    expect(screen.getByLabelText('SSH target')).toHaveValue('lab-hpc');
    expect(api.openExplorer).toHaveBeenCalledOnce();
  });

  it('shows the actionable tunnel failure without Electron method or error-class names', async () => {
    api.openExplorer.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'remoteGenomics:openExplorer': RemoteGenomicsError: SSH connected, but its private local port forward could not be started. Retry the connection."
      )
    );
    renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('SSH connected, but its private local port forward');
    expect(alert).not.toHaveTextContent('remoteGenomics:openExplorer');
    expect(alert).not.toHaveTextContent('RemoteGenomicsError');
    expect(screen.getByRole('button', { name: 'Connect file browser' })).toBeEnabled();
  });

  it('does not report a stale terminal command as copied after the host changes', async () => {
    let finish!: () => void;
    writeClipboard.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy SSH command' }));
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'other-hpc' } });
    await act(async () => finish());
    expect(screen.queryByText(/SSH command copied/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy SSH command' }));
    await waitFor(() => expect(writeClipboard).toHaveBeenLastCalledWith('ssh "other-hpc"'));
    expect(await screen.findByRole('status')).toHaveTextContent('SSH command copied');
  });

  it('shows a terminal command copy failure instead of claiming it was copied', async () => {
    writeClipboard.mockRejectedValueOnce(new Error('Clipboard access denied.'));
    renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy SSH command' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(userMessage('operation.failed'));
    expect(screen.queryByText(/SSH command copied/u)).not.toBeInTheDocument();
    expect(api.openExplorer).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Copy SSH command' })).toBeEnabled();
  });

  it('disconnects only the file browser and preserves selected paths', async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    for (const [label, path] of [
      ['Remote alignment path', '/run/tumor.bam'],
      ['Remote index path', '/run/tumor.bam.bai'],
      ['Remote BigWig path', '/run/tumor.bigWig'],
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: path } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    await screen.findByTestId('remote-directory-browser');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect file browser' }));
    await waitFor(() => expect(api.closeExplorer).toHaveBeenCalledWith(session.sessionId));
    await waitFor(() =>
      expect(screen.queryByTestId('remote-directory-browser')).not.toBeInTheDocument()
    );
    expect(screen.getByRole('status')).toHaveTextContent('File browser disconnected');
    expect(screen.getByLabelText('Remote alignment path')).toHaveValue('/run/tumor.bam');
    expect(screen.getByLabelText('Remote index path')).toHaveValue('/run/tumor.bam.bai');
    expect(screen.getByLabelText('Remote BigWig path')).toHaveValue('/run/tumor.bigWig');
    expect(screen.getByRole('button', { name: 'Connect and attach' })).toBeEnabled();
    expect(api.cancelExplorerOpen).not.toHaveBeenCalled();
  });

  it('retains the file browser when disconnect fails and allows retry', async () => {
    api.closeExplorer.mockRejectedValueOnce(new Error('Could not close the file browser.'));
    renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    await screen.findByTestId('remote-directory-browser');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect file browser' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not close');
    expect(screen.getByTestId('remote-directory-browser')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect file browser' }));
    await waitFor(() =>
      expect(screen.queryByTestId('remote-directory-browser')).not.toBeInTheDocument()
    );
    expect(api.closeExplorer).toHaveBeenCalledTimes(2);
  });

  it('preserves a recent connection and the edited name when naming fails', async () => {
    api.renameEndpoint.mockRejectedValue(new Error('The connection name could not be saved.'));
    renderPanel(undefined, [recentProfile]);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Lab HPC' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Connection name' }), {
      target: { value: 'Research data' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection name' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved');
    expect(screen.getByRole('textbox', { name: 'Connection name' })).toHaveValue('Research data');
    expect(screen.getByRole('button', { name: 'Lab HPC lab-hpc', exact: true })).toBeEnabled();
    expect(api.forgetEndpoint).not.toHaveBeenCalled();
  });

  it('renames and forgets a recent connection without changing its SSH target or cancelling exploration', async () => {
    api.renameEndpoint.mockResolvedValue({ ...recentProfile, displayName: 'Lab data µ' });
    api.forgetEndpoint.mockResolvedValue(true);
    renderPanel(undefined, [recentProfile]);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Lab HPC' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Connection name' }), {
      target: { value: 'Lab data µ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection name' }));
    await waitFor(() =>
      expect(api.renameEndpoint).toHaveBeenCalledWith(recentProfile.endpointId, 'Lab data µ')
    );
    fireEvent.click(await screen.findByRole('button', { name: /Lab data µ.*lab-hpc/u }));
    expect(screen.getByLabelText('SSH target')).toHaveValue('lab-hpc');
    fireEvent.click(screen.getByRole('button', { name: 'Forget Lab data µ' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep recent connection' }));
    expect(api.forgetEndpoint).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Forget Lab data µ' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forget recent connection' }));
    await waitFor(() => expect(api.forgetEndpoint).toHaveBeenCalledWith(recentProfile.endpointId));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Lab data µ.*lab-hpc/u })).not.toBeInTheDocument()
    );
    expect(screen.getByLabelText('SSH target')).toHaveValue('lab-hpc');
    expect(api.closeExplorer).not.toHaveBeenCalled();
    expect(api.cancelExplorerOpen).not.toHaveBeenCalled();
  });

  it('cancels a silent connection test and ignores its late result without losing entered paths', async () => {
    let complete!: (value: RemoteExplorerSessionV1) => void;
    api.openExplorer.mockReturnValueOnce(
      new Promise<RemoteExplorerSessionV1>((resolve) => {
        complete = resolve;
      })
    );
    renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.change(screen.getByLabelText('Remote alignment path'), {
      target: { value: '/run/tumor.bam' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    expect(screen.getByRole('button', { name: 'Connect and attach' })).toBeDisabled();
    const requestId = api.openExplorer.mock.calls[0][0].requestId;
    fireEvent.click(screen.getByRole('button', { name: 'Cancel file browser connection' }));
    expect(api.cancelExplorerOpen).toHaveBeenCalledWith(requestId);
    expect(screen.getByRole('button', { name: 'Connect file browser' })).toBeEnabled();
    expect(screen.getByLabelText('Remote alignment path')).toHaveValue('/run/tumor.bam');
    await act(async () => complete(session));
    expect(api.closeExplorer).toHaveBeenCalledWith(session.sessionId);
    expect(api.listRemoteDirectory).not.toHaveBeenCalled();
    expect(screen.queryByTestId('remote-directory-browser')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    await waitFor(() => expect(api.listRemoteDirectory).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Connect and attach' })).toBeEnabled();
  });

  it('keeps the source and browser fixed while the selected alignment is attaching', async () => {
    let complete!: () => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    renderPanel(onSubmit);
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.change(screen.getByLabelText('Remote alignment path'), {
      target: { value: '/run/tumor.bam' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    await waitFor(() => expect(api.listRemoteDirectory).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect file browser' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect and attach' }));
    for (const label of [
      'SSH target',
      'Remote alignment path',
      'Remote index path',
      'Remote BigWig path',
      'Remote directory',
    ]) {
      expect(screen.getByRole('textbox', { name: label })).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'Open folder', exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: '../ Up one folder' })).toBeDisabled();
    await act(async () => complete());
    expect(screen.getByLabelText('SSH target')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open folder', exact: true })).toBeEnabled();
  });

  it('waits for the initial folder before accepting a new directory path', async () => {
    let finishInitial!: (listing: RemoteDirectoryListingV1) => void;
    let finishRequested!: (listing: RemoteDirectoryListingV1) => void;
    api.listRemoteDirectory
      .mockReturnValueOnce(
        new Promise<RemoteDirectoryListingV1>((resolve) => {
          finishInitial = resolve;
        })
      )
      .mockReturnValueOnce(
        new Promise<RemoteDirectoryListingV1>((resolve) => {
          finishRequested = resolve;
        })
      );
    renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    await screen.findByTestId('remote-directory-browser');
    const directory = screen.getByRole('textbox', { name: 'Remote directory' });
    expect(directory).toBeDisabled();
    await act(async () =>
      finishInitial({ path: session.homePath, parentPath: '/home', entries: [], truncated: false })
    );
    expect(directory).toBeEnabled();
    fireEvent.change(directory, { target: { value: '/data/run 42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open folder', exact: true }));
    expect(api.listRemoteDirectory).toHaveBeenLastCalledWith(session.sessionId, '/data/run 42');
    expect(directory).toBeDisabled();
    await act(async () =>
      finishRequested({ path: '/data/run 42', parentPath: '/data', entries: [], truncated: false })
    );
    expect(directory).toBeEnabled();
    expect(directory).toHaveValue('/data/run 42');
  });

  it('finishes its connection test after the initial directory listing and allows another test', async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));

    await waitFor(() =>
      expect(api.listRemoteDirectory).toHaveBeenCalledWith(session.sessionId, session.homePath)
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect file browser' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    await waitFor(() => expect(api.openExplorer).toHaveBeenCalledTimes(2));
    expect(api.closeExplorer).toHaveBeenCalledWith(session.sessionId);
  });

  it('closes a late connection result when its panel is dismissed', async () => {
    let complete!: (value: RemoteExplorerSessionV1) => void;
    api.openExplorer.mockReturnValue(
      new Promise<RemoteExplorerSessionV1>((resolve) => {
        complete = resolve;
      })
    );
    const panel = renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    const requestId = api.openExplorer.mock.calls[0][0].requestId;
    panel.unmount();
    expect(api.cancelExplorerOpen).toHaveBeenCalledWith(requestId);
    await act(async () => complete(session));
    expect(api.closeExplorer).toHaveBeenCalledWith(session.sessionId);
    expect(api.listRemoteDirectory).not.toHaveBeenCalled();
  });

  it('passes selected UTF-8 file paths exactly and clears the prior index when another alignment is selected', async () => {
    const root = '/data/run 42/µ samples';
    api.listRemoteDirectory.mockResolvedValue({
      path: root,
      parentPath: '/data/run 42',
      truncated: false,
      entries: [
        { name: 'tumor.bam', path: root + '/tumor.bam', kind: 'alignment' },
        { name: 'tumor.bam.bai', path: root + '/tumor.bam.bai', kind: 'index' },
        { name: 'normal.bam', path: root + '/normal.bam', kind: 'alignment' },
      ],
    });
    const panel = renderPanel();
    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'lab-hpc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect file browser' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use alignment tumor.bam' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect file browser' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use index tumor.bam.bai' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect and attach' }));
    await waitFor(() =>
      expect(panel.onSubmit).toHaveBeenCalledWith({
        target: 'lab-hpc',
        explorerSessionId: session.sessionId,
        alignmentPath: root + '/tumor.bam',
        indexPath: root + '/tumor.bam.bai',
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use alignment normal.bam' }));
    expect(screen.getByLabelText('Remote index path')).toHaveValue('');
  });
});
