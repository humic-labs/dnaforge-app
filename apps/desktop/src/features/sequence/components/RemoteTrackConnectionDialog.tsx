import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../../presentation/PresentationSurface';
import { toUserMessage } from '@waypoint/user-messages';
import { useState } from 'react';
import { Button, UI_MODAL_LAYER_CLASS } from '../../../components/ui';

import type {
  RemoteAlignmentConnectRequestV1,
  RemoteAlignmentLocatorV1,
  RemoteEndpointProfileV1,
} from '../../../shared/remote-genomics-ipc';
import type { RemotePileupConnectionState } from '../pileup-source';
import type { BamTrackImportNotice } from './useBamTrackImport';
import { RemoteClusterPanel } from './RemoteClusterPanel';
import { SshTerminalLogin } from './SshTerminalLogin';

const STATE_LABELS: Record<RemotePileupConnectionState['state'], string> = {
  connecting: 'Connecting',
  online: 'Connected',
  retrying: 'Reconnecting',
  'needs-authentication': 'Authentication needed',
  blocked: 'Connection needs repair',
};

export function RemoteTrackConnectionDialog({
  trackLabel,
  locator,
  connection,
  assemblyDisplayName,
  endpoints,
  onRefreshEndpoints,
  busy,
  connecting = false,
  onCancelConnection,
  notice,
  onRetry,
  onSave,
  onRemove,
  onClose,
}: {
  readonly trackLabel: string;
  readonly locator: RemoteAlignmentLocatorV1;
  readonly connection?: RemotePileupConnectionState;
  readonly assemblyDisplayName: string;
  readonly endpoints: readonly RemoteEndpointProfileV1[];
  readonly onRefreshEndpoints?: () => Promise<void>;
  readonly busy: boolean;
  readonly connecting?: boolean;
  readonly onCancelConnection?: () => void;
  readonly notice: BamTrackImportNotice | null;
  readonly onRetry: () => Promise<void>;
  readonly onSave: (request: RemoteAlignmentConnectRequestV1) => Promise<void>;
  readonly onRemove: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const presentationOverlay = usePresentationOverlay('modal');

  const [editing, setEditing] = useState(false);
  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className={`fixed inset-0 ${UI_MODAL_LAYER_CLASS} flex items-center justify-center bg-black/50 p-4`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
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
          {editing ? (
            <RemoteClusterPanel
              onManageHosts={onClose}
              assemblyDisplayName={assemblyDisplayName}
              recentEndpoints={endpoints}
              onRefreshEndpoints={onRefreshEndpoints}
              initial={locator}
              busy={busy}
              connecting={connecting}
              onCancelConnection={onCancelConnection}
              notice={notice}
              submitLabel="Save and reconnect"
              onSubmit={async (request) => {
                await onSave(request);
                setEditing(false);
              }}
            />
          ) : (
            <div className="min-h-0 space-y-4 overflow-y-auto p-5 text-sm text-fg">
              <div role="status" className="rounded border border-border bg-bg-subtle p-3">
                <div className="font-medium">
                  {connection ? STATE_LABELS[connection.state] : 'Not connected'}
                </div>
                {connection?.updatedAt ? (
                  <div className="mt-0.5 text-xs text-fg-muted">
                    Last checked {new Date(connection.updatedAt).toLocaleString()}
                  </div>
                ) : null}
                {connection?.lastFailure ? (
                  <p className="mt-1 text-xs text-danger">
                    {toUserMessage(connection.lastFailure, 'tracks.loadFailed')}
                  </p>
                ) : null}
              </div>
              <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                <dt className="text-fg-muted">SSH target</dt>
                <dd className="min-w-0 break-all font-mono">{locator.target}</dd>
                <dt className="text-fg-muted">Alignment</dt>
                <dd className="min-w-0 break-all font-mono">{locator.alignmentPath}</dd>
                <dt className="text-fg-muted">Index</dt>
                <dd className="min-w-0 break-all font-mono">{locator.indexPath}</dd>
                {locator.signalPath ? (
                  <>
                    <dt className="text-fg-muted">BigWig</dt>
                    <dd className="min-w-0 break-all font-mono">{locator.signalPath}</dd>
                  </>
                ) : null}
              </dl>
              {notice ? (
                <div
                  role={notice.kind === 'error' ? 'alert' : 'status'}
                  className={`text-xs ${notice.kind === 'error' ? 'text-danger' : 'text-fg-muted'}`}
                >
                  {notice.text}
                </div>
              ) : null}
              <SshTerminalLogin target={locator.target} onManageHosts={onClose} />
              <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                <Button type="button" disabled={busy} onClick={() => void onRetry()}>
                  Reconnect
                </Button>
                {connecting && onCancelConnection ? (
                  <Button type="button" onClick={onCancelConnection}>
                    Cancel connection
                  </Button>
                ) : null}
                <Button type="button" disabled={busy} onClick={() => setEditing(true)}>
                  Edit source…
                </Button>
                <span className="ml-auto">
                  <Button
                    variant="danger"
                    type="button"
                    disabled={busy}
                    onClick={() => void onRemove()}
                  >
                    Remove track…
                  </Button>
                </span>
              </div>
            </div>
          )}
        </div>
      </PresentationScopeContext.Provider>
    </div>
  );
}
