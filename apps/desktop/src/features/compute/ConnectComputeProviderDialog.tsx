import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_SECONDARY_BUTTON_CLASS,
  SettingsInput,
  SettingsButton,
  SettingsNotice,
} from '../../components/SettingsSubsection';

import {
  describeComputeFailure,
  type ComputeFailureKind,
  type ComputeProviderSummary,
} from '../../shared/compute-ipc';
import { selectProvider, useComputeStore } from './store';

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

export function ConnectComputeProviderDialog() {
  const open = useComputeStore((s) => s.connectDialog.open);
  const dialogProviderId = useComputeStore((s) => s.connectDialog.providerId);
  const providers = useComputeStore((s) => s.providers);
  const loading = useComputeStore((s) => s.loading);
  const loadError = useComputeStore((s) => s.loadError);
  const close = useComputeStore((s) => s.closeConnectDialog);
  const connect = useComputeStore((s) => s.connect);
  const refresh = useComputeStore((s) => s.refresh);

  const [pickedId, setPickedId] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ kind: ComputeFailureKind } | null>(null);
  const [success, setSuccess] = useState<{ toolCount: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setPickedId(dialogProviderId);
    setKeyDraft('');
    setFailure(null);
    setSuccess(null);
    void refresh();
  }, [open, dialogProviderId, refresh]);

  if (!open) return null;

  const provider = selectProvider(useComputeStore.getState(), pickedId);
  const connectable = providers.filter((p) => p.hasBinding);

  async function submit(p: ComputeProviderSummary) {
    setSaving(true);
    setFailure(null);
    try {
      const result = await connect(p.id, keyDraft);
      if (result.ok) {
        setSuccess({ toolCount: result.toolCount });
        setKeyDraft('');
      } else {
        setFailure({ kind: result.kind });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Connect a compute provider"
      data-testid="connect-compute-dialog"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) close();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-border bg-bg shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            {provider && !dialogProviderId && (
              <button
                type="button"
                onClick={() => setPickedId(null)}
                disabled={saving}
                className="text-fg-subtle hover:text-fg disabled:opacity-50"
                aria-label="Back"
              >
                ←
              </button>
            )}
            <h2 className="text-sm font-medium text-fg">
              {provider ? `Connect ${provider.displayName}` : 'Connect a compute provider'}
            </h2>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={saving}
            className="text-fg-subtle hover:text-fg disabled:opacity-50"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {!provider ? (
            <div className="space-y-2" data-testid="connect-compute-picker">
              <p className="text-xs text-fg-muted">
                A compute provider runs protein and molecule models for you, under your own account.
                Pick one to connect.
              </p>
              {loading && providers.length === 0 && (
                <p className="text-xs text-fg-subtle">Loading providers…</p>
              )}
              {loadError && (
                <SettingsNotice tone="error">
                  {toUserMessage(loadError, 'operation.failed')}
                </SettingsNotice>
              )}
              {connectable.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPickedId(p.id)}
                  className={`${SETTINGS_SECONDARY_BUTTON_CLASS} flex w-full items-center justify-between`}
                  data-testid={`connect-compute-pick-${p.id}`}
                >
                  <span>{p.displayName}</span>
                  {p.connected && (
                    <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                      Connected
                    </span>
                  )}
                </button>
              ))}
              {!loading && connectable.length === 0 && !loadError && (
                <p className="text-xs text-fg-subtle">No providers are available yet.</p>
              )}
            </div>
          ) : success ? (
            <div className="space-y-3" data-testid="connect-compute-success">
              <p className="text-sm text-fg">
                {provider.displayName} is connected. It reported {success.toolCount} available{' '}
                {success.toolCount === 1 ? 'tool' : 'tools'}.
              </p>
              <p className="text-xs text-fg-muted">
                Your key is stored in the OS keychain. You can test, replace, or disconnect it under
                Settings → Integrations.
              </p>
              <SettingsButton variant="primary" onClick={close}>
                Done
              </SettingsButton>
            </div>
          ) : (
            <div className="space-y-4">
              <section
                className={`space-y-2 ${SETTINGS_CARD_CLASS}`}
                data-testid="connect-compute-disclosure"
              >
                <h3 className="text-xs font-semibold text-fg">Before you connect</h3>
                <p className="text-xs leading-5 text-fg-muted">{provider.disclosure}</p>
                <p className="text-xs leading-5 text-fg-muted">{provider.retentionNote}</p>
                <dl className="grid grid-cols-[auto,minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px] text-fg-subtle">
                  <dt>Credential destination</dt>
                  <dd className="break-all font-mono text-fg" data-testid="compute-endpoint-url">
                    {provider.endpointUrl}
                  </dd>
                  <dt>Read-only verification</dt>
                  <dd className="break-all font-mono text-fg" data-testid="compute-verify-target">
                    {provider.verifyTarget}
                  </dd>
                  <dt>Credential header</dt>
                  <dd className="font-mono text-fg" data-testid="compute-credential-header">
                    {provider.credentialHeader ?? 'OAuth token exchange'}
                  </dd>
                </dl>
                <p className="text-xs text-fg-subtle">
                  <ExternalLink href={provider.termsUrl}>Terms</ExternalLink>
                  {' · '}
                  <ExternalLink href={provider.privacyUrl}>Privacy</ExternalLink>
                  {' · '}
                  <ExternalLink href={provider.docsUrl}>Docs</ExternalLink>
                </p>
              </section>

              {provider.authScheme === 'oauth' ? (
                <p className="text-xs text-fg-muted">
                  Sign-in for {provider.displayName} is not available yet.
                </p>
              ) : (
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-fg" htmlFor="compute-key-input">
                    {provider.displayName} API key
                  </label>
                  <SettingsInput
                    id="compute-key-input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && keyDraft.trim() && !saving) {
                        e.preventDefault();
                        void submit(provider);
                      }
                    }}
                    placeholder={`Paste your ${provider.displayName} key`}
                    disabled={saving}
                    data-testid="connect-compute-key-input"
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-fg-subtle">
                      Stored in the OS keychain. Verified with a read-only call before saving.
                    </span>
                    {provider.keyPageUrl && (
                      <ExternalLink href={provider.keyPageUrl}>Get a key</ExternalLink>
                    )}
                  </div>
                </div>
              )}

              {failure && (
                <SettingsNotice tone="error" testId="connect-compute-failure">
                  <span className="block font-medium">
                    {describeComputeFailure(failure.kind, provider.displayName)}
                  </span>
                </SettingsNotice>
              )}

              {provider.authScheme !== 'oauth' && (
                <div className="flex justify-end gap-2">
                  <SettingsButton onClick={close} disabled={saving}>
                    Cancel
                  </SettingsButton>
                  <SettingsButton
                    variant="primary"
                    onClick={() => void submit(provider)}
                    disabled={saving || !keyDraft.trim()}
                    data-testid="connect-compute-submit"
                  >
                    {saving ? 'Verifying…' : provider.connected ? 'Replace key' : 'Connect'}
                  </SettingsButton>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
