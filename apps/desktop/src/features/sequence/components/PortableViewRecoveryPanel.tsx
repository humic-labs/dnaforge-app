import { MenuNativeSelect } from '@waypoint/ui-components';
import { toUserMessage } from '@waypoint/user-messages';
import { useState, type FormEvent } from 'react';
import { Button, UI_FIELD_CLASS } from '../../../components/ui';

import type { PortableGenomeViewTrack } from '@waypoint/genome-data';

import {
  GENOME_SOURCE_CREDENTIAL_V1,
  type GenomeSourceCredentialInput,
  type GenomeSourceCredentialKind,
} from '../../../shared/genome-source-credentials';
import {
  portableRequestLocators,
  type PortableTrackResolution,
} from '../portable-genome-view-restore';

export interface PortableCredentialPrompt {
  readonly trackId: string;
  readonly authRef: string;
  readonly kinds: ReadonlyArray<GenomeSourceCredentialKind>;
}

export interface PortableViewRecoveryPanelProps {
  readonly viewName: string;
  readonly resolutions: ReadonlyArray<PortableTrackResolution>;
  readonly skippedTrackIds: ReadonlySet<string>;
  readonly relinkedTrackIds: ReadonlySet<string>;
  readonly acceptChangedData: boolean;
  readonly requireEveryTrack: boolean;
  readonly busy: boolean;
  readonly credentialPrompt: PortableCredentialPrompt | null;
  readonly error: string | null;
  readonly onRelink: (trackId: string) => void;
  readonly onConnect: (trackId: string, authRef: string) => void;
  readonly onSubmitCredential: (credential: GenomeSourceCredentialInput) => void;
  readonly onCancelCredential: () => void;
  readonly onToggleSkip: (trackId: string) => void;
  readonly onToggleAcceptChangedData: () => void;
  readonly onToggleRequireEveryTrack: () => void;
  readonly onOpen: () => void;
  readonly onCancel: () => void;
}

export function credentialKindsForAuthRef(
  track: PortableGenomeViewTrack,
  authRef: string
): ReadonlyArray<GenomeSourceCredentialKind> {
  if (track.source.kind !== 'admitted-source') return [];
  const kinds = new Set<GenomeSourceCredentialKind>();
  for (const [, locator] of portableRequestLocators(track.source.request)) {
    if (!('authRef' in locator) || locator.authRef !== authRef) continue;
    if (locator.kind === 's3') kinds.add('aws-sigv4');
    else if (locator.kind === 'gcs') kinds.add('gcs-oauth');
    else {
      kinds.add('http-bearer');
      kinds.add('http-basic');
      kinds.add('http-header');
    }
  }
  return [...kinds];
}

function fileName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

export function PortableViewRecoveryPanel({
  viewName,
  resolutions,
  skippedTrackIds,
  relinkedTrackIds,
  acceptChangedData,
  requireEveryTrack,
  busy,
  credentialPrompt,
  error,
  onRelink,
  onConnect,
  onSubmitCredential,
  onCancelCredential,
  onToggleSkip,
  onToggleAcceptChangedData,
  onToggleRequireEveryTrack,
  onOpen,
  onCancel,
}: PortableViewRecoveryPanelProps) {
  const unresolved = resolutions.filter(
    (resolution) => resolution.status !== 'ready' && !skippedTrackIds.has(resolution.track.trackId)
  );
  const readyCount = resolutions.filter(
    (resolution) => resolution.status === 'ready' && !skippedTrackIds.has(resolution.track.trackId)
  ).length;
  const canOpen = !busy && unresolved.length === 0 && readyCount > 0;
  return (
    <section
      aria-labelledby="portable-view-recovery-heading"
      data-testid="portable-view-recovery"
      className="flex-shrink-0 space-y-3 border-b border-border bg-bg-subtle/40 px-5 py-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="portable-view-recovery-heading" className="text-sm font-semibold text-fg">
          Restore {viewName}
        </h3>
        <span className="text-xs text-fg-muted">
          {readyCount} of {resolutions.length} tracks ready
        </span>
      </div>
      <p className="text-xs text-fg-muted">
        Some sources in this saved view are not available on this computer as saved. Locate moved
        files, connect the credentials the view refers to, or skip a track. DNAForge restores only
        what you decide here and reports the result.
      </p>
      <ul aria-label="Saved tracks" className="space-y-1.5">
        {resolutions.map((resolution) => {
          const { track } = resolution;
          const skipped = skippedTrackIds.has(track.trackId);
          const relinked = relinkedTrackIds.has(track.trackId);
          return (
            <li
              key={track.trackId}
              data-testid={`portable-view-track-${track.trackId}`}
              data-status={skipped ? 'skipped' : resolution.status}
              className="flex flex-wrap items-start gap-2 rounded border border-border bg-bg px-3 py-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-fg">{track.label}</div>
                <div className="text-fg-muted">
                  {skipped
                    ? 'Skipped. It will not be restored.'
                    : resolution.status === 'ready'
                      ? relinked
                        ? 'Relinked. Ready to restore.'
                        : 'Ready to restore as saved.'
                      : resolution.status === 'relink-required'
                        ? `Missing on this computer: ${resolution.missing
                            .map((missing) => `${fileName(missing.path)} (${missing.role})`)
                            .join(', ')}`
                        : resolution.status === 'credential-required'
                          ? `Needs the saved credential ${resolution.authRefs.join(', ')}, which is not connected here.`
                          : resolution.reason}
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                {!skipped && resolution.status === 'relink-required' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRelink(track.trackId)}
                    className="rounded border border-border px-2 py-1 font-medium text-fg wp-interactive disabled:opacity-50"
                  >
                    Locate file…
                  </button>
                ) : null}
                {!skipped && resolution.status === 'credential-required'
                  ? resolution.authRefs.map((authRef) => (
                      <button
                        key={authRef}
                        type="button"
                        disabled={busy}
                        onClick={() => onConnect(track.trackId, authRef)}
                        className="rounded border border-border px-2 py-1 font-medium text-fg wp-interactive disabled:opacity-50"
                      >
                        Connect {authRef}
                      </button>
                    ))
                  : null}
                {resolution.status !== 'ready' || skipped ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onToggleSkip(track.trackId)}
                    className="rounded border border-border px-2 py-1 text-fg-muted wp-interactive disabled:opacity-50"
                  >
                    {skipped ? 'Restore instead' : 'Skip'}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {credentialPrompt ? (
        <PortableCredentialForm
          prompt={credentialPrompt}
          busy={busy}
          onSubmit={onSubmitCredential}
          onCancel={onCancelCredential}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-4 text-xs text-fg">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={requireEveryTrack}
            disabled={busy}
            onChange={onToggleRequireEveryTrack}
          />
          Open only if every remaining track restores
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={acceptChangedData}
            disabled={busy}
            onChange={onToggleAcceptChangedData}
          />
          Accept tracks whose data changed since this view was saved
        </label>
      </div>
      {error ? (
        <p role="alert" className="rounded border border-red-300 px-3 py-2 text-xs text-red-700">
          {toUserMessage(error, 'tracks.loadFailed')}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          variant="primary"
          type="button"
          data-testid="portable-view-recovery-open"
          disabled={!canOpen}
          onClick={onOpen}
        >
          {busy ? 'Restoring…' : 'Open view'}
        </Button>
        <Button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

function PortableCredentialForm({
  prompt,
  busy,
  onSubmit,
  onCancel,
}: {
  prompt: PortableCredentialPrompt;
  busy: boolean;
  onSubmit: (credential: GenomeSourceCredentialInput) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<GenomeSourceCredentialKind>(prompt.kinds[0] ?? 'http-bearer');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [headerName, setHeaderName] = useState('');
  const [headerValue, setHeaderValue] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const inputClass = `${UI_FIELD_CLASS} mt-1 font-mono`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const base = { contract: GENOME_SOURCE_CREDENTIAL_V1, authRef: prompt.authRef } as const;
    switch (kind) {
      case 'http-bearer':
        onSubmit({ ...base, kind, token });
        return;
      case 'http-basic':
        onSubmit({ ...base, kind, username, password });
        return;
      case 'http-header':
        onSubmit({ ...base, kind, headerName, headerValue });
        return;
      case 'aws-sigv4':
        onSubmit({
          ...base,
          kind,
          accessKeyId,
          secretAccessKey,
          ...(sessionToken ? { sessionToken } : {}),
        });
        return;
      case 'gcs-oauth':
        onSubmit({ ...base, kind, accessToken });
    }
  };
  return (
    <form
      onSubmit={submit}
      aria-label={`Connect ${prompt.authRef}`}
      className="space-y-2 rounded border border-border bg-bg p-3 text-xs"
    >
      <p className="text-fg-muted">
        Enter the credential this view refers to as{' '}
        <span className="font-mono">{prompt.authRef}</span>. It is stored in this computer&apos;s
        keychain and never written into the view.
      </p>
      {prompt.kinds.length > 1 ? (
        <label className="block font-medium text-fg" htmlFor="portable-credential-kind">
          Credential type
          <span className="block min-w-0 w-full mt-1">
            <MenuNativeSelect
              density="form"
              id="portable-credential-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as GenomeSourceCredentialKind)}
            >
              {prompt.kinds.includes('http-bearer') ? (
                <option value="http-bearer">Bearer token</option>
              ) : null}
              {prompt.kinds.includes('http-basic') ? (
                <option value="http-basic">Username and password</option>
              ) : null}
              {prompt.kinds.includes('http-header') ? (
                <option value="http-header">Custom request header</option>
              ) : null}
            </MenuNativeSelect>
          </span>
        </label>
      ) : null}
      {kind === 'http-bearer' ? (
        <label className="block font-medium text-fg" htmlFor="portable-credential-token">
          Bearer token
          <input
            id="portable-credential-token"
            type="password"
            required
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className={inputClass}
          />
        </label>
      ) : null}
      {kind === 'http-basic' ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="block font-medium text-fg" htmlFor="portable-credential-username">
            Username
            <input
              id="portable-credential-username"
              required
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block font-medium text-fg" htmlFor="portable-credential-password">
            Password
            <input
              id="portable-credential-password"
              type="password"
              required
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClass}
            />
          </label>
        </div>
      ) : null}
      {kind === 'http-header' ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="block font-medium text-fg" htmlFor="portable-credential-header-name">
            Header name
            <input
              id="portable-credential-header-name"
              required
              autoComplete="off"
              value={headerName}
              onChange={(event) => setHeaderName(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block font-medium text-fg" htmlFor="portable-credential-header-value">
            Header value
            <input
              id="portable-credential-header-value"
              type="password"
              required
              autoComplete="off"
              value={headerValue}
              onChange={(event) => setHeaderValue(event.target.value)}
              className={inputClass}
            />
          </label>
        </div>
      ) : null}
      {kind === 'aws-sigv4' ? (
        <div className="space-y-2">
          <label className="block font-medium text-fg" htmlFor="portable-credential-aws-key">
            AWS access key ID
            <input
              id="portable-credential-aws-key"
              required
              autoComplete="off"
              value={accessKeyId}
              onChange={(event) => setAccessKeyId(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block font-medium text-fg" htmlFor="portable-credential-aws-secret">
            AWS secret access key
            <input
              id="portable-credential-aws-secret"
              type="password"
              required
              autoComplete="off"
              value={secretAccessKey}
              onChange={(event) => setSecretAccessKey(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block font-medium text-fg" htmlFor="portable-credential-aws-session">
            AWS session token (optional)
            <input
              id="portable-credential-aws-session"
              type="password"
              autoComplete="off"
              value={sessionToken}
              onChange={(event) => setSessionToken(event.target.value)}
              className={inputClass}
            />
          </label>
        </div>
      ) : null}
      {kind === 'gcs-oauth' ? (
        <label className="block font-medium text-fg" htmlFor="portable-credential-gcs-token">
          GCS OAuth access token
          <input
            id="portable-credential-gcs-token"
            type="password"
            required
            autoComplete="off"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
            className={inputClass}
          />
        </label>
      ) : null}
      <div className="flex gap-2">
        <Button variant="primary" type="submit" disabled={busy}>
          Save and connect
        </Button>
        <Button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
