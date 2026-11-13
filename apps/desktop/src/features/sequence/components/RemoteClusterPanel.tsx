import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { platform } from '../../../platform';
import { Button, UI_FIELD_CLASS } from '../../../components/ui';
import type {
  RemoteAlignmentConnectRequestV1,
  RemoteDirectoryEntryV1,
  RemoteDirectoryListingV1,
  RemoteEndpointProfileV1,
  RemoteExplorerClosedEventV1,
  RemoteExplorerSessionV1,
} from '../../../shared/remote-genomics-ipc';
import { RecentRemoteEndpoints } from './RecentRemoteEndpoints';
import { SshTerminalLogin } from './SshTerminalLogin';
import { remoteSshErrorMessage as errorMessage } from '../../../shared/remote-ssh-error-message';

let explorerRequestSequence = 0;

function nextExplorerRequestId(): string {
  explorerRequestSequence += 1;
  return `remote-explorer-${Date.now()}-${explorerRequestSequence}`;
}

export interface RemoteClusterPanelProps {
  readonly assemblyDisplayName: string;
  readonly recentEndpoints: readonly RemoteEndpointProfileV1[];
  readonly initial?: Partial<RemoteAlignmentConnectRequestV1>;
  readonly busy: boolean;
  readonly connecting?: boolean;
  readonly onCancelConnection?: () => void;
  readonly notice?: { readonly kind: 'success' | 'warn' | 'error'; readonly text: string } | null;
  readonly submitLabel: string;
  readonly onSubmit: (request: RemoteAlignmentConnectRequestV1) => Promise<void>;
  readonly onRefreshEndpoints?: () => Promise<void>;
  readonly onManageHosts?: () => void;
}

export function RemoteClusterPanel({
  assemblyDisplayName,
  recentEndpoints,
  initial,
  busy,
  connecting = false,
  onCancelConnection,
  notice,
  submitLabel,
  onSubmit,
  onRefreshEndpoints,
  onManageHosts,
}: RemoteClusterPanelProps) {
  const [target, setTarget] = useState(initial?.target ?? '');
  const [alignmentPath, setAlignmentPath] = useState(initial?.alignmentPath ?? '');
  const [indexPath, setIndexPath] = useState(initial?.indexPath ?? '');
  const [signalPath, setSignalPath] = useState(initial?.signalPath ?? '');
  const localReadsSupported = !navigator.platform.toLowerCase().startsWith('win');
  const [clusterCompute, setClusterCompute] = useState(
    !localReadsSupported || Boolean(initial?.tileServerReceiptPath)
  );
  const [tileServerReceiptPath, setTileServerReceiptPath] = useState(
    initial?.tileServerReceiptPath ?? ''
  );
  const [directoryPath, setDirectoryPath] = useState('');
  const [session, setSession] = useState<RemoteExplorerSessionV1 | null>(null);
  const [listing, setListing] = useState<RemoteDirectoryListingV1 | null>(null);
  const [testing, setTesting] = useState(false);
  const [testCancelled, setTestCancelled] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [browserClosedReason, setBrowserClosedReason] = useState<
    RemoteExplorerClosedEventV1['reason'] | null
  >(null);
  const [listingBusy, setListingBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [explorerError, setExplorerError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const sessionRef = useRef<RemoteExplorerSessionV1 | null>(null);
  const pendingOpenRef = useRef<string | null>(null);
  const closedSessionsRef = useRef(new Map<string, RemoteExplorerClosedEventV1['reason']>());
  const generationRef = useRef(0);

  useEffect(() => {
    const unsubscribe = platform().remoteGenomics?.subscribeExplorerClosed?.((event) => {
      if (pendingOpenRef.current || sessionRef.current?.sessionId === event.sessionId) {
        closedSessionsRef.current.set(event.sessionId, event.reason);
      }
      if (sessionRef.current?.sessionId !== event.sessionId) return;
      generationRef.current += 1;
      sessionRef.current = null;
      pendingOpenRef.current = null;
      setSession(null);
      setListing(null);
      setTesting(false);
      setDisconnecting(false);
      setListingBusy(false);
      setExplorerError(null);
      setBrowserClosedReason(event.reason);
    });
    return () => {
      unsubscribe?.();
      generationRef.current += 1;
      const api =
        pendingOpenRef.current || sessionRef.current ? platform().remoteGenomics : undefined;
      if (pendingOpenRef.current) {
        void api?.cancelExplorerOpen(pendingOpenRef.current).catch(() => undefined);
      }
      if (sessionRef.current) {
        void api?.closeExplorer(sessionRef.current.sessionId).catch(() => undefined);
      }
    };
  }, []);

  const closeSession = (): void => {
    generationRef.current += 1;
    const api =
      pendingOpenRef.current || sessionRef.current ? platform().remoteGenomics : undefined;
    if (pendingOpenRef.current) {
      void api?.cancelExplorerOpen(pendingOpenRef.current).catch(() => undefined);
      pendingOpenRef.current = null;
    }
    if (sessionRef.current) {
      void api?.closeExplorer(sessionRef.current.sessionId).catch(() => undefined);
      sessionRef.current = null;
    }
    setSession(null);
    setListing(null);
    setTesting(false);
    setTestCancelled(false);
    setDisconnecting(false);
    setBrowserClosedReason(null);
    setListingBusy(false);
    setExplorerError(null);
  };

  const changeTarget = (next: string): void => {
    if (next !== target) {
      closeSession();
    }
    setTarget(next);
  };

  const disconnectBrowser = async (): Promise<void> => {
    const connection = sessionRef.current;
    const api = platform().remoteGenomics;
    if (!connection || !api || disconnecting) return;
    const generation = ++generationRef.current;
    setDisconnecting(true);
    setExplorerError(null);
    try {
      await api.closeExplorer(connection.sessionId);
      if (generation !== generationRef.current) return;
      sessionRef.current = null;
      setSession(null);
      setListing(null);
      setBrowserClosedReason('disconnected');
    } catch (error) {
      if (generation === generationRef.current)
        setExplorerError(toUserMessage(errorMessage(error), 'remote.browserCloseFailed'));
    } finally {
      if (generation === generationRef.current) {
        setDisconnecting(false);
        setListingBusy(false);
      }
    }
  };

  const browse = async (connection: RemoteExplorerSessionV1, path: string): Promise<void> => {
    const api = platform().remoteGenomics;
    if (!api) return;
    const generation = ++generationRef.current;
    setListingBusy(true);
    setExplorerError(null);
    try {
      const next = await api.listRemoteDirectory(connection.sessionId, path);
      if (generation !== generationRef.current) return;
      setDirectoryPath(next.path);
      setListing(next);
    } catch (error) {
      if (generation === generationRef.current)
        setExplorerError(toUserMessage(errorMessage(error), 'remote.connectionFailed'));
    } finally {
      if (generation === generationRef.current) setListingBusy(false);
    }
  };

  const connectBrowser = async (): Promise<void> => {
    const api = platform().remoteGenomics;
    if (!api) {
      setExplorerError(
        userMessage('failure.remote-cluster-connections-are-available-only-in-the-desktop-app')
      );
      return;
    }
    closeSession();
    closedSessionsRef.current.clear();
    const requestId = nextExplorerRequestId();
    pendingOpenRef.current = requestId;
    const generation = generationRef.current;
    setTesting(true);
    setExplorerError(null);
    try {
      const opened = await api.openExplorer({ requestId, target: target.trim() });
      if (generation !== generationRef.current) {
        await api.closeExplorer(opened.sessionId).catch(() => undefined);
        return;
      }
      const closedReason = closedSessionsRef.current.get(opened.sessionId);
      if (closedReason) {
        setBrowserClosedReason(closedReason);
        return;
      }
      sessionRef.current = opened;
      setSession(opened);
      setDirectoryPath(opened.homePath);
      void onRefreshEndpoints?.().catch(() => undefined);
      await browse(opened, opened.homePath);
    } catch (error) {
      if (generation === generationRef.current)
        setExplorerError(toUserMessage(errorMessage(error), 'remote.connectionFailed'));
    } finally {
      if (pendingOpenRef.current === requestId) {
        pendingOpenRef.current = null;
        setTesting(false);
      }
    }
  };

  const selectEntry = (entry: RemoteDirectoryEntryV1): void => {
    if (entry.kind === 'directory') {
      if (session) void browse(session, entry.path);
      return;
    }
    if (entry.kind === 'alignment') {
      setAlignmentPath(entry.path);
      setIndexPath('');
      setSignalPath('');
    } else if (entry.kind === 'index') {
      setIndexPath(entry.path);
    } else {
      setSignalPath(entry.path);
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!target.trim() || !alignmentPath.trim() || submitting || busy || testing) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const connection = sessionRef.current;
      await onSubmit({
        target: target.trim(),
        ...(connection?.target === target.trim() &&
        !closedSessionsRef.current.has(connection.sessionId)
          ? { explorerSessionId: connection.sessionId }
          : {}),
        alignmentPath: alignmentPath.trim(),
        ...(indexPath.trim() ? { indexPath: indexPath.trim() } : {}),
        ...(signalPath.trim() ? { signalPath: signalPath.trim() } : {}),
        ...(clusterCompute ? { tileServerReceiptPath: tileServerReceiptPath.trim() } : {}),
      });
    } catch (error) {
      setSubmitError(toUserMessage(errorMessage(error), 'remote.connectionFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const disabled = busy || submitting || disconnecting;
  return (
    <div
      className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5"
      data-testid="add-track-remote-panel"
    >
      <div className="rounded-lg border border-border bg-bg-subtle p-3">
        <div className="text-sm font-semibold text-fg">Connect to a cluster</div>
        <p className="mt-1 text-xs text-fg-muted">
          Use the SSH alias or user@host from your institution’s supported setup. Complete login in
          your terminal before connecting here. Remote file browsing and viewing also need Python 3
          and permitted SSH port forwarding. The BAM or CRAM must be indexed and match the open{' '}
          {assemblyDisplayName} reference. DNAForge reads only the byte ranges needed by the view.
        </p>
      </div>
      {recentEndpoints.length > 0 ? (
        <RecentRemoteEndpoints
          endpoints={recentEndpoints}
          disabled={disabled}
          onSelect={changeTarget}
          onRefresh={onRefreshEndpoints}
        />
      ) : null}
      <div>
        <label className="block text-xs font-medium text-fg" htmlFor="remote-ssh-target">
          SSH target
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id="remote-ssh-target"
            disabled={disabled}
            required
            value={target}
            onChange={(event) => changeTarget(event.target.value)}
            placeholder="lab-hpc or user@login.example.edu"
            autoComplete="off"
            className={`${UI_FIELD_CLASS} flex-1 font-mono`}
          />
        </div>
        <div className="mt-3">
          <SshTerminalLogin target={target} onManageHosts={onManageHosts} />
        </div>
        <div className="mt-3 flex gap-2">
          <Button
            type="button"
            disabled={disabled || testing || !target.trim()}
            onClick={() => void connectBrowser()}
          >
            {testing ? 'Connecting…' : 'Connect file browser'}
          </Button>
        </div>
        {testing ? (
          <div className="mt-2">
            <Button
              type="button"
              onClick={() => {
                closeSession();
                setTestCancelled(true);
              }}
            >
              Cancel file browser connection
            </Button>
          </div>
        ) : null}
        {testCancelled ? (
          <div role="status" className="mt-2 text-xs text-fg-muted">
            File browser connection cancelled.
          </div>
        ) : null}
        {session ? (
          <div role="status" className="mt-2 text-xs text-emerald-700">
            File access verified for {session.target} ({session.platform}). SSH forwarding and
            Python 3 were verified.
          </div>
        ) : null}
        {session ? (
          <div className="mt-2">
            <Button
              type="button"
              disabled={disabled || testing}
              onClick={() => void disconnectBrowser()}
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect file browser'}
            </Button>
          </div>
        ) : null}
        {browserClosedReason ? (
          <div role="status" className="mt-2 text-xs text-fg-muted">
            {browserClosedReason === 'disconnected'
              ? 'File browser disconnected. Entered paths and attached tracks are kept.'
              : browserClosedReason === 'idle'
                ? 'File browser connection expired after inactivity. Reconnect the file browser or attach using the entered paths.'
                : 'File browser connection was lost. Reconnect the file browser or attach using the entered paths.'}
          </div>
        ) : null}
        {explorerError ? (
          <div role="alert" className="mt-2 text-xs text-danger">
            {toUserMessage(explorerError, 'remote.connectionFailed')}
          </div>
        ) : null}
      </div>
      {session ? (
        <div className="rounded-lg border border-border p-3" data-testid="remote-directory-browser">
          <div className="text-xs font-medium text-fg">Browse remote files</div>
          <div className="mt-2 flex gap-2">
            <input
              aria-label="Remote directory"
              disabled={disabled || listingBusy}
              value={directoryPath}
              onChange={(event) => setDirectoryPath(event.target.value)}
              className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg"
            />
            <button
              type="button"
              disabled={disabled || listingBusy}
              onClick={() => void browse(session, directoryPath)}
              className="rounded border border-border px-2 text-xs text-fg disabled:opacity-50"
            >
              Open folder
            </button>
          </div>
          {listing ? (
            <>
              <div className="mt-2 max-h-52 space-y-0.5 overflow-y-auto rounded border border-border bg-bg p-1">
                {listing.parentPath ? (
                  <button
                    type="button"
                    disabled={disabled || listingBusy}
                    onClick={() => void browse(session, listing.parentPath!)}
                    className="block w-full rounded px-2 py-1 text-left font-mono text-xs text-fg hover:bg-bg-muted"
                  >
                    ../ Up one folder
                  </button>
                ) : null}
                {listing.entries.map((entry) => (
                  <button
                    key={`${entry.kind}:${entry.path}`}
                    type="button"
                    disabled={disabled || listingBusy}
                    onClick={() => selectEntry(entry)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-fg hover:bg-bg-muted"
                    aria-label={`${entry.kind === 'directory' ? 'Open folder' : `Use ${entry.kind}`} ${entry.name}`}
                  >
                    <span className="w-16 shrink-0 text-fg-muted">{entry.kind}</span>
                    <span className="min-w-0 truncate font-mono">{entry.name}</span>
                  </button>
                ))}
                {listing.entries.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-fg-muted">
                    No folders, BAM/CRAM files, indexes, or BigWigs here.
                  </div>
                ) : null}
              </div>
              {listing.truncated ? (
                <p className="mt-1 text-xs text-amber-700">
                  This folder has more entries. Enter a narrower folder path to continue.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      <form onSubmit={(event) => void submit(event)} className="space-y-3">
        <fieldset disabled={disabled} className="space-y-2 text-xs text-fg">
          <legend className="mb-2 font-medium">Read calculation</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="remote-read-compute"
              checked={!clusterCompute}
              disabled={!localReadsSupported}
              onChange={() => setClusterCompute(false)}
            />
            Compute reads on this computer
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="remote-read-compute"
              checked={clusterCompute}
              onChange={() => setClusterCompute(true)}
            />
            Compute reads on cluster
          </label>
          {!localReadsSupported ? (
            <p className="text-fg-muted">
              Windows read tracks require the Linux compute service on your allocated cluster node.
              File browsing and SSH login remain separate. Ask your cluster administrator for the
              service connection file, then enter its path below.
            </p>
          ) : null}
          {clusterCompute ? (
            <div>
              <label htmlFor="remote-tile-server-receipt" className="block font-medium">
                Remote tile server receipt
              </label>
              <input
                id="remote-tile-server-receipt"
                required
                value={tileServerReceiptPath}
                onChange={(event) => setTileServerReceiptPath(event.target.value)}
                placeholder="/home/user/.dnaforge-hpc/connection.json"
                autoComplete="off"
                className={`${UI_FIELD_CLASS} mt-1 font-mono`}
              />
              <p className="mt-1 text-fg-muted">
                Start the DNAForge tile server on your allocated compute node. Enter its connection
                receipt path on this SSH host; reads and coverage are calculated there.
              </p>
            </div>
          ) : null}
        </fieldset>
        <div>
          <label className="block text-xs font-medium text-fg" htmlFor="remote-bam-path">
            Remote alignment path
          </label>
          <input
            id="remote-bam-path"
            disabled={disabled}
            required
            value={alignmentPath}
            onChange={(event) => setAlignmentPath(event.target.value)}
            placeholder="/project/run/sample.bam"
            autoComplete="off"
            className={`${UI_FIELD_CLASS} mt-1 font-mono`}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-fg" htmlFor="remote-index-path">
            Remote index path
          </label>
          <input
            id="remote-index-path"
            disabled={disabled}
            value={indexPath}
            onChange={(event) => setIndexPath(event.target.value)}
            placeholder="Optional — discover .bai, .csi, or .crai beside the alignment"
            autoComplete="off"
            className={`${UI_FIELD_CLASS} mt-1 font-mono`}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-fg" htmlFor="remote-signal-path">
            Remote BigWig path
          </label>
          <input
            id="remote-signal-path"
            disabled={disabled}
            value={signalPath}
            onChange={(event) => setSignalPath(event.target.value)}
            placeholder="Optional — nf-core bigwig/ sibling is used when present"
            autoComplete="off"
            className={`${UI_FIELD_CLASS} mt-1 font-mono`}
          />
        </div>
        {notice ? (
          <div
            role={notice.kind === 'error' ? 'alert' : 'status'}
            className={`text-xs ${notice.kind === 'error' ? 'text-danger' : 'text-fg-muted'}`}
          >
            {notice.text}
          </div>
        ) : null}
        {submitError && notice?.kind !== 'error' && submitError !== notice?.text ? (
          <div role="alert" className="text-xs text-danger">
            {toUserMessage(submitError, 'remote.connectionFailed')}
          </div>
        ) : null}
        <Button
          variant="primary"
          type="submit"
          disabled={disabled || testing || !target.trim() || !alignmentPath.trim()}
        >
          {submitting || busy ? 'Connecting…' : submitLabel}
        </Button>
        {connecting && onCancelConnection ? (
          <span className="ml-2 inline-block">
            <Button type="button" onClick={onCancelConnection}>
              Cancel connection
            </Button>
          </span>
        ) : null}
      </form>
      <p className="text-[11px] text-fg-subtle">
        OpenSSH controls aliases, keys, jump hosts, and host trust. Authentication stays with your
        institution’s supported procedure; DNAForge does not collect login answers.
      </p>
    </div>
  );
}
