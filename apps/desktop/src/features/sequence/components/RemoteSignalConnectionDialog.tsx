import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useState } from 'react';
import { Button, TextField, UI_MODAL_LAYER_CLASS } from '../../../components/ui';

import { SshTerminalLogin } from './SshTerminalLogin';

import type {
  RemoteSignalConnectRequestV1,
  RemoteSignalLocatorV1,
} from '../../../shared/remote-genomics-ipc';
import { isRemoteSshTarget } from '../../../shared/remote-ssh-target';
import type { RemotePileupConnectionState } from '../pileup-source';
import type { BamTrackImportNotice } from './useBamTrackImport';

const STATE_LABELS: Record<RemotePileupConnectionState['state'], string> = {
  connecting: 'Connecting',
  online: 'Connected',
  retrying: 'Reconnecting',
  'needs-authentication': 'Authentication needed',
  blocked: 'Connection needs repair',
};

export function RemoteSignalConnectionDialog({
  trackLabel,
  locator,
  connection,
  admissionError,
  busy,
  connecting,
  onCancelConnection,
  notice,
  onRetry,
  onSave,
  onRemove,
  onClose,
}: {
  readonly trackLabel: string;
  readonly locator: RemoteSignalLocatorV1;
  readonly connection?: RemotePileupConnectionState;
  readonly admissionError?: string;
  readonly busy: boolean;
  readonly connecting: boolean;
  readonly onCancelConnection: () => void;
  readonly notice: BamTrackImportNotice | null;
  readonly onRetry: () => Promise<void>;
  readonly onSave: (request: RemoteSignalConnectRequestV1) => Promise<void>;
  readonly onRemove: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState(locator.target);
  const [signalPath, setSignalPath] = useState(locator.signalPath);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setError(null);
    try {
      await action();
      return true;
    } catch (failure) {
      setError(toUserMessage(failure, 'tracks.loadFailed'));
      return false;
    }
  };
  return (
    <div
      className={`fixed inset-0 ${UI_MODAL_LAYER_CLASS} flex items-center justify-center bg-black/50 p-4`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Connection details for ${trackLabel}`}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-fg">{trackLabel}</h2>
            <p className="mt-0.5 text-xs text-fg-muted">Remote connection and source</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close connection details"
            className="rounded border border-border px-2.5 py-1 text-xs text-fg"
          >
            Close
          </button>
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto p-5 text-sm text-fg">
          <div
            role={
              (admissionError && !admissionError.startsWith('Opening')) || connection?.lastFailure
                ? 'alert'
                : 'status'
            }
            className="rounded border border-border bg-bg-subtle p-3"
          >
            <div className="font-medium">
              {connection
                ? STATE_LABELS[connection.state]
                : admissionError?.startsWith('Opening')
                  ? 'Connecting'
                  : 'Not connected'}
            </div>
            {admissionError || connection?.lastFailure ? (
              <p className="mt-1 text-xs text-danger">
                {toUserMessage(connection?.lastFailure, 'tracks.loadFailed')}
              </p>
            ) : null}
          </div>
          <SshTerminalLogin target={editing ? target : locator.target} onManageHosts={onClose} />
          {editing ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const host = target.trim();
                const path = signalPath.trim();
                if (!isRemoteSshTarget(host) || !path.startsWith('/') || path.includes('\0')) {
                  setError(
                    userMessage('failure.enter-a-valid-ssh-target-and-an-absolute-bigwig-path')
                  );
                  return;
                }
                void run(() => onSave({ target: host, signalPath: path })).then((saved) => {
                  if (saved) setEditing(false);
                });
              }}
            >
              <label className="block text-xs text-fg-muted">
                SSH target
                <div className="mt-1">
                  <TextField
                    monospace
                    aria-label="SSH target"
                    value={target}
                    disabled={busy}
                    onChange={(event) => setTarget(event.target.value)}
                  />
                </div>
              </label>
              <label className="block text-xs text-fg-muted">
                BigWig path
                <div className="mt-1">
                  <TextField
                    monospace
                    aria-label="BigWig path"
                    value={signalPath}
                    disabled={busy}
                    onChange={(event) => setSignalPath(event.target.value)}
                  />
                </div>
              </label>
              <p className="text-xs text-fg-muted">
                The signal will be checked against this view&apos;s reference before the source
                changes.
              </p>
              <Button variant="primary" type="submit" disabled={busy}>
                {busy ? 'Connecting…' : 'Save and reconnect'}
              </Button>
              <span className="ml-2 inline-block">
                <Button type="button" disabled={busy} onClick={() => setEditing(false)}>
                  Cancel edit
                </Button>
              </span>
            </form>
          ) : (
            <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
              <dt className="text-fg-muted">SSH target</dt>
              <dd className="min-w-0 break-all font-mono">{locator.target}</dd>
              <dt className="text-fg-muted">BigWig</dt>
              <dd className="min-w-0 break-all font-mono">{locator.signalPath}</dd>
            </dl>
          )}
          {error || notice ? (
            <div
              role={error || notice?.kind === 'error' ? 'alert' : 'status'}
              className="text-xs text-fg-muted"
            >
              {error != null
                ? toUserMessage(error, 'tracks.loadFailed')
                : toUserMessage(notice?.text, 'tracks.loadFailed')}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            {!editing ? (
              <>
                <Button type="button" disabled={busy} onClick={() => void run(onRetry)}>
                  Reconnect
                </Button>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setTarget(locator.target);
                    setSignalPath(locator.signalPath);
                    setEditing(true);
                  }}
                >
                  Edit source…
                </Button>
              </>
            ) : null}
            {connecting ? (
              <Button type="button" onClick={onCancelConnection}>
                Cancel connection
              </Button>
            ) : null}
            <span className="ml-auto">
              <Button variant="danger" type="button" onClick={() => void onRemove()}>
                Remove track…
              </Button>
            </span>
          </div>
          <p className="text-[11px] text-fg-muted">
            After completing your institution’s login procedure, use Reconnect. Your source and view
            settings are kept when authentication is unavailable.
          </p>
        </div>
      </div>
    </div>
  );
}
