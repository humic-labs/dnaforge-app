import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';

import {
  SETTINGS_DANGER_BUTTON_CLASS,
  SETTINGS_SECONDARY_BUTTON_CLASS,
  SETTINGS_LIST_CLASS,
  SettingsNotice,
  SettingsSubsectionHeader,
} from '../../components/SettingsSubsection';
import { describeComputeFailure, type ComputeProviderSummary } from '../../shared/compute-ipc';
import { AddComputeEndpointDialog } from './AddComputeEndpointDialog';
import { ComputeJobsPanel } from './ComputeJobsPanel';
import { useComputeStore } from './store';

const PROVIDER_DISPLAY_ORDER: Record<string, number> = {
  boltz: 0,
  'nvidia-nim': 1,
  tamarind: 2,
  subseq: 3,
};

function formatWhen(iso: string | null): string {
  if (!iso) return 'Not verified';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

function driverLabel(driver: string): string {
  switch (driver) {
    case 'mcp-tool-map':
      return 'MCP';
    case 'nvcf':
      return 'NVCF';
    case 'legacy-rest':
      return 'REST';
    case 'http-job':
      return 'Async HTTP';
    default:
      return driver;
  }
}

function ProviderCard({ provider }: { provider: ComputeProviderSummary }) {
  const openConnectDialog = useComputeStore((s) => s.openConnectDialog);
  const test = useComputeStore((s) => s.test);
  const disconnect = useComputeStore((s) => s.disconnect);
  const removeCustomProvider = useComputeStore((s) => s.removeCustomProvider);
  const [busy, setBusy] = useState<'test' | 'disconnect' | 'remove' | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  async function runTest() {
    setBusy('test');
    setNotice(null);
    try {
      const result = await test(provider.id);
      setNotice(
        result.ok
          ? { tone: 'ok', text: `Connection works. ${result.toolCount} tools available.` }
          : {
              tone: 'error',
              text: describeComputeFailure(result.kind, provider.displayName),
            }
      );
    } catch {
      setNotice({ tone: 'error', text: 'Could not test this connection. Try again.' });
    } finally {
      setBusy(null);
    }
  }

  async function runDisconnect() {
    setBusy('disconnect');
    setNotice(null);
    try {
      await disconnect(provider.id);
      setNotice({ tone: 'ok', text: 'Connection removed.' });
    } catch {
      setNotice({ tone: 'error', text: 'Could not disconnect. Try again.' });
    } finally {
      setBusy(null);
    }
  }

  async function runRemove() {
    setBusy('remove');
    setNotice(null);
    try {
      const result = await removeCustomProvider(provider.id);
      if (!result.ok) {
        setNotice({ tone: 'error', text: toUserMessage(result, 'service.unavailable') });
        setConfirmingRemove(false);
      }
    } catch (error) {
      setNotice({ tone: 'error', text: toUserMessage(error, 'service.unavailable') });
      setConfirmingRemove(false);
    } finally {
      setBusy(null);
    }
  }

  const status = !provider.hasBinding
    ? { label: 'Coming soon', tone: 'text-fg-subtle' }
    : provider.connected
      ? { label: 'Connected', tone: 'text-accent' }
      : { label: 'Not connected', tone: 'text-fg-muted' };

  return (
    <div
      className="px-4 py-4"
      role="group"
      data-settings-target={`compute-provider-${provider.id}`}
      tabIndex={-1}
      aria-label={provider.displayName}
      data-testid={`compute-provider-card-${provider.id}`}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h4 className="text-sm font-semibold text-fg">{provider.displayName}</h4>
            <span
              className={`text-[11px] font-medium ${status.tone}`}
              data-testid="compute-provider-status"
            >
              {status.label}
            </span>
          </div>
        </div>
        {provider.hasBinding && (
          <button
            type="button"
            className={`${SETTINGS_SECONDARY_BUTTON_CLASS} shrink-0`}
            onClick={() => (provider.connected ? void runTest() : openConnectDialog(provider.id))}
            disabled={busy !== null}
          >
            {busy === 'test' ? 'Testing…' : provider.connected ? 'Test connection' : 'Connect'}
          </button>
        )}
      </div>
      <details className="mt-2 text-xs text-fg-muted">
        <summary className="w-fit cursor-pointer text-fg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          {provider.connected ? 'Manage connection' : 'Details'}
        </summary>
        <div className="mt-3 space-y-3" data-testid="compute-provider-details">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-fg-subtle">Connection</dt>
            <dd>{provider.transport === 'mcp' ? 'Provider MCP server' : 'Provider API'}</dd>
            <dt className="text-fg-subtle">Protocol</dt>
            <dd data-testid="compute-provider-driver">{driverLabel(provider.driver)}</dd>
            <dt className="text-fg-subtle">Authentication</dt>
            <dd>{provider.authScheme === 'oauth' ? 'Provider sign-in' : 'API key'}</dd>
            {provider.connected && (
              <>
                <dt className="text-fg-subtle">Credential</dt>
                <dd>Stored securely on this device</dd>
                <dt className="text-fg-subtle">Last verified</dt>
                <dd>{formatWhen(provider.lastVerifiedAt)}</dd>
              </>
            )}
          </dl>
          <p className="max-w-3xl text-xs leading-5">{provider.disclosure}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
            <a
              className="text-fg-link hover:underline"
              href={provider.docsUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Documentation
            </a>
            <a
              className="text-fg-link hover:underline"
              href={provider.termsUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Terms
            </a>
            <a
              className="text-fg-link hover:underline"
              href={provider.privacyUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Privacy
            </a>
          </div>
          {provider.hasBinding && provider.connected && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={SETTINGS_SECONDARY_BUTTON_CLASS}
                onClick={() => openConnectDialog(provider.id)}
                disabled={busy !== null}
              >
                Replace key
              </button>
              <button
                type="button"
                className={SETTINGS_DANGER_BUTTON_CLASS}
                onClick={() => void runDisconnect()}
                disabled={busy !== null}
              >
                {busy === 'disconnect' ? 'Removing…' : 'Disconnect'}
              </button>
            </div>
          )}
          {provider.custom && !confirmingRemove && (
            <button
              type="button"
              className={SETTINGS_DANGER_BUTTON_CLASS}
              onClick={() => setConfirmingRemove(true)}
              disabled={busy !== null}
            >
              Remove endpoint
            </button>
          )}
          {provider.custom && confirmingRemove && (
            <div className="rounded-md border border-danger/30 bg-danger/5 p-2">
              <p className="mb-2 max-w-40 text-[11px] leading-4 text-fg-muted">
                Remove this endpoint and its stored key?
              </p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className={SETTINGS_DANGER_BUTTON_CLASS}
                  onClick={() => void runRemove()}
                  disabled={busy !== null}
                >
                  {busy === 'remove' ? 'Removing…' : 'Confirm remove'}
                </button>
                <button
                  type="button"
                  className={SETTINGS_SECONDARY_BUTTON_CLASS}
                  onClick={() => setConfirmingRemove(false)}
                  disabled={busy !== null}
                >
                  Keep
                </button>
              </div>
            </div>
          )}
        </div>
      </details>
      {notice && (
        <div className="mt-3">
          <SettingsNotice
            tone={notice.tone === 'error' ? 'error' : 'success'}
            testId="compute-provider-notice"
          >
            {notice.text}
          </SettingsNotice>
        </div>
      )}
    </div>
  );
}

export function ComputeIntegrationsSection() {
  const providers = useComputeStore((s) => s.providers);
  const loading = useComputeStore((s) => s.loading);
  const loadError = useComputeStore((s) => s.loadError);
  const refresh = useComputeStore((s) => s.refresh);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!loadError || providers.length > 0) return;
    let attempts = 0;
    const handle = setInterval(() => {
      attempts += 1;
      if (attempts > 20) {
        clearInterval(handle);
        return;
      }
      void refresh();
    }, 3_000);
    return () => clearInterval(handle);
  }, [loadError, providers.length, refresh]);

  const connectedCount = providers.filter((provider) => provider.connected).length;
  const connectable = providers.filter((provider) => provider.hasBinding).length;

  return (
    <div className="space-y-5" data-testid="compute-integrations">
      <section className="space-y-3" aria-labelledby="integrations-compute-heading">
        <SettingsSubsectionHeader
          headingId="integrations-compute-heading"
          title="Compute providers"
          trailing={
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-fg-subtle" data-testid="compute-connected-count">
                {connectedCount} of {connectable} connected
              </span>
              <button
                type="button"
                className={SETTINGS_SECONDARY_BUTTON_CLASS}
                onClick={() => setAddOpen(true)}
              >
                Add endpoint
              </button>
            </div>
          }
        />
        {loadError && (
          <SettingsNotice tone="error">
            {toUserMessage(loadError, 'service.unavailable')}
          </SettingsNotice>
        )}
        {loading && providers.length === 0 && (
          <p className="text-xs text-fg-subtle">Loading providers…</p>
        )}
        {providers.length > 0 && (
          <div className={SETTINGS_LIST_CLASS}>
            {[...providers]
              .sort(
                (a, b) =>
                  (PROVIDER_DISPLAY_ORDER[a.id] ?? Number.MAX_SAFE_INTEGER) -
                  (PROVIDER_DISPLAY_ORDER[b.id] ?? Number.MAX_SAFE_INTEGER)
              )
              .map((provider) => (
                <ProviderCard key={provider.id} provider={provider} />
              ))}
          </div>
        )}
      </section>

      <AddComputeEndpointDialog open={addOpen} onClose={() => setAddOpen(false)} />

      {}
      <section className="pt-4">
        <ComputeJobsPanel />
      </section>
    </div>
  );
}
