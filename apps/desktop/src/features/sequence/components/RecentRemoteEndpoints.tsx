import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import { Button, TextField } from '../../../components/ui';

import { platform } from '../../../platform';
import type { RemoteEndpointProfileV1 } from '../../../shared/remote-genomics-ipc';

export function RecentRemoteEndpoints({
  endpoints,
  disabled,
  onSelect,
  onRefresh,
}: {
  readonly endpoints: readonly RemoteEndpointProfileV1[];
  readonly disabled: boolean;
  readonly onSelect: (target: string) => void;
  readonly onRefresh?: () => Promise<void>;
}) {
  const [profiles, setProfiles] = useState(endpoints);
  const [action, setAction] = useState<{
    kind: 'rename' | 'forget';
    profile: RemoteEndpointProfileV1;
  } | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setProfiles(endpoints), [endpoints]);
  const locked = disabled || saving;
  const actionFailureKey =
    action?.kind === 'forget' ? 'remote.connectionForgetFailed' : 'remote.connectionRenameFailed';

  const apply = async (): Promise<void> => {
    if (!action || locked) return;
    setSaving(true);
    setError(null);
    try {
      const api = platform().remoteGenomics;
      if (!api) throw new Error('Recent SSH connections are available only in the desktop app.');
      if (action.kind === 'rename') {
        const updated = await api.renameEndpoint(action.profile.endpointId, name.trim());
        if (!updated) throw new Error('This recent connection has already been removed.');
        if (
          updated.endpointId !== action.profile.endpointId ||
          updated.target !== action.profile.target
        ) {
          throw new Error(
            'The connection identity changed. Refresh the recent list before trying again.'
          );
        }
        setProfiles((current) =>
          current.map((profile) => (profile.endpointId === updated.endpointId ? updated : profile))
        );
      } else {
        await api.forgetEndpoint(action.profile.endpointId);
        setProfiles((current) =>
          current.filter((profile) => profile.endpointId !== action.profile.endpointId)
        );
      }
      setAction(null);
      await onRefresh?.().catch(() => undefined);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(
        toUserMessage(
          message.replace(/^Error invoking remote method '[^']+':\s*(?:\w+:\s*)?/u, ''),
          actionFailureKey
        )
      );
    } finally {
      setSaving(false);
    }
  };

  if (profiles.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-medium text-fg">Recent endpoints</div>
      <div className="mt-2 space-y-2">
        {profiles.map((profile) => (
          <div
            key={profile.endpointId}
            className="flex flex-wrap items-center gap-2 rounded border border-border p-2"
          >
            <button
              type="button"
              disabled={locked}
              onClick={() => onSelect(profile.target)}
              className="min-w-0 flex-1 rounded px-1 py-1 text-left text-xs text-fg hover:bg-bg-muted disabled:opacity-50"
            >
              <span className="font-medium">{profile.displayName}</span>{' '}
              <span className="font-mono text-fg-muted">{profile.target}</span>
            </button>
            <button
              type="button"
              disabled={locked}
              aria-label={`Rename ${profile.displayName}`}
              onClick={() => {
                setAction({ kind: 'rename', profile });
                setName(profile.displayName);
                setError(null);
              }}
              className="rounded border border-border px-2 py-1 text-xs text-fg disabled:opacity-50"
            >
              Rename
            </button>
            <button
              type="button"
              disabled={locked}
              aria-label={`Forget ${profile.displayName}`}
              onClick={() => {
                setAction({ kind: 'forget', profile });
                setError(null);
              }}
              className="rounded border border-border px-2 py-1 text-xs text-fg disabled:opacity-50"
            >
              Forget
            </button>
          </div>
        ))}
      </div>
      {action ? (
        <div className="mt-2 space-y-2 rounded border border-border bg-bg-subtle p-3">
          {action.kind === 'rename' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void apply();
              }}
              className="space-y-2"
            >
              <label className="block text-xs text-fg">
                Connection name
                <div className="mt-1">
                  <TextField
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={200}
                    disabled={locked}
                  />
                </div>
              </label>
              <Button variant="primary" type="submit" disabled={locked || !name.trim()}>
                Save connection name
              </Button>
              <span className="ml-2 inline-block">
                <Button type="button" disabled={locked} onClick={() => setAction(null)}>
                  Cancel naming
                </Button>
              </span>
            </form>
          ) : (
            <div>
              <p className="text-xs text-fg">
                Forget {action.profile.displayName} from recent connections?
              </p>
              <p className="mt-1 text-xs text-fg-muted">
                Saved tracks and active connections remain available. Connecting to this target
                again adds it back to the list.
              </p>
              <div className="mt-2 flex gap-2">
                <Button type="button" disabled={locked} onClick={() => void apply()}>
                  Forget recent connection
                </Button>
                <Button type="button" disabled={locked} onClick={() => setAction(null)}>
                  Keep recent connection
                </Button>
              </div>
            </div>
          )}
          {error ? (
            <div role="alert" className="text-xs text-danger">
              {toUserMessage(error, actionFailureKey)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
