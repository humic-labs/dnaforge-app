import { toUserMessage, userMessage, type UserVisibleText } from '@waypoint/user-messages';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, TextField, UI_CARD_CLASS, UI_MODAL_LAYER_CLASS } from '../ui';
import { CloseIcon } from '../icons';
import {
  getAllProviderMetas,
  getDefaultModel,
  getProviderMeta,
  type ProviderName,
} from '../../features/ai/providers';
import { useAISettingsStore } from '../../features/ai/settings';
import { fetchProviderModels } from '../../features/ai/modelDiscovery';
import { useAgentCliAuthFlow } from '../../features/ai/hooks/useAgentCliAuthFlow';
import { CliInstallInstructions } from '../../features/ai/CliInstallInstructions';
import { AGENT_TRANSPORT_LABELS } from '../../features/ai/agent-cli-labels';
import {
  isHostedRouteBlockedBySignIn,
  isHostedRouteOptionReady,
} from '../../features/ai/hosted-availability';
import type { AgentTransport } from '../../platform';

const KEY_CONSOLE_URLS: Partial<Record<ProviderName, string>> = {
  anthropic: 'console.anthropic.com/settings/keys',
  openai: 'platform.openai.com/api-keys',
  google: 'aistudio.google.com/apikey',
  xai: 'console.x.ai',
  deepseek: 'platform.deepseek.com/api_keys',
};

const SUBSCRIPTION_TRANSPORTS: readonly AgentTransport[] = [
  'claude-agent-sdk',
  'codex-sdk',
  'grok-acp',
];

type Selection =
  | { kind: 'api'; provider: ProviderName }
  | { kind: 'cli'; transport: AgentTransport };

export interface ConnectAiHostedRouteOption {
  id: string;
  label: string;
  detail: UserVisibleText;
  readiness: string;
  readinessLabel: string | null;
  active: boolean;
  selection: { kind: string };
}

interface ConnectAiModalProps {
  open: boolean;
  onClose: () => void;
  hostedBrowserOnly?: boolean;
  hostedRouteOptions?: readonly ConnectAiHostedRouteOption[];
}

export function ConnectAiModal({
  open,
  onClose,
  hostedRouteOptions = [],
  hostedBrowserOnly = false,
}: ConnectAiModalProps) {
  const {
    providerStatuses,
    agentDetection,
    cliExecutablePathOverrides,
    setApiKey,
    setAssistantRoute,
    refreshAgentDetection,
  } = useAISettingsStore();
  const { authenticatingTransport, authResult, runAgentAuth } = useAgentCliAuthFlow({
    refreshAgentDetection,
  });
  const providers = getAllProviderMetas();

  const installOS =
    (window as { electronAPI?: { platform?: string } }).electronAPI?.platform ?? 'darwin';

  const [selection, setSelection] = useState<Selection | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (open) {
      setSelection(null);
      setKeyDraft('');
      setError(null);
      setSaving(false);
      if (!hostedBrowserOnly) void refreshAgentDetection();
    }
  }, [hostedBrowserOnly, open, refreshAgentDetection]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const back = useCallback(() => {
    setSelection(null);
    setKeyDraft('');
    setError(null);
  }, []);

  const chooseLane = useCallback((next: Selection) => {
    setError(null);
    setSelection(next);
  }, []);

  const connectApiKey = useCallback(
    async (provider: ProviderName) => {
      if (saving) return;
      const key = keyDraft.trim();
      if (!key) {
        setError(userMessage('failure.enter-a-key-to-connect'));
        return;
      }
      setSaving(true);
      setError(null);
      try {
        const discovery = await fetchProviderModels(provider, key);
        if (!openRef.current) return;
        if (discovery.error || discovery.models.length === 0) {
          setError(
            discovery.error != null
              ? toUserMessage(
                  discovery.error,
                  'failure.that-key-didn-t-work-double-check-it-and-try-again'
                )
              : userMessage('failure.that-key-didn-t-work-double-check-it-and-try-again')
          );
          return;
        }
        const preferred = getDefaultModel(provider);
        const model = discovery.models.includes(preferred) ? preferred : discovery.models[0];
        await setApiKey(provider, key);
        if (!openRef.current) return;
        await setAssistantRoute({ kind: 'provider', provider, model });
        onClose();
      } catch (err) {
        setError(toUserMessage(err, 'failure.could-not-connect'));
      } finally {
        setSaving(false);
      }
    },
    [saving, keyDraft, setApiKey, setAssistantRoute, onClose]
  );

  const connectHosted = useCallback(
    async (option: ConnectAiHostedRouteOption) => {
      if (saving || !isHostedRouteOptionReady(option)) return;
      setSaving(true);
      setError(null);
      try {
        await setAssistantRoute(option.selection as never);
        if (!openRef.current) return;
        onClose();
      } catch (err) {
        setError(toUserMessage(err, 'failure.could-not-connect'));
      } finally {
        setSaving(false);
      }
    },
    [saving, setAssistantRoute, onClose]
  );

  const connectCli = useCallback(
    async (transport: AgentTransport) => {
      setError(null);
      const executablePath = cliExecutablePathOverrides?.[transport];
      const result = executablePath
        ? await runAgentAuth(transport, executablePath)
        : await runAgentAuth(transport);
      if (!openRef.current) return;
      if (result.ok && result.status === 'completed') {
        await setAssistantRoute({ kind: 'cli', transport });
        onClose();
        return;
      }
      setError(
        result.error != null
          ? toUserMessage(result.error, 'failure.sign-in-did-not-complete-try-again')
          : userMessage('failure.sign-in-did-not-complete-try-again')
      );
    },
    [cliExecutablePathOverrides, runAgentAuth, setAssistantRoute, onClose]
  );

  if (!open) return null;

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      data-testid="connect-ai-modal-backdrop"
      className={`fixed inset-0 ${UI_MODAL_LAYER_CLASS} flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm`}
      onClick={onBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Connect AI"
    >
      <div
        data-testid="connect-ai-modal"
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-xl border border-border bg-bg shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            {selection && (
              <button
                type="button"
                onClick={back}
                disabled={saving}
                className="text-fg-subtle hover:text-fg disabled:opacity-50"
                aria-label="Back"
                data-testid="connect-ai-back"
              >
                ←
              </button>
            )}
            <h2 className="text-sm font-medium text-fg">
              {selection?.kind === 'api'
                ? `Connect ${getProviderLabel(selection.provider)}`
                : selection?.kind === 'cli'
                  ? `Connect ${AGENT_TRANSPORT_LABELS[selection.transport]}`
                  : 'Connect AI'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-subtle hover:text-fg"
            aria-label="Close"
            data-testid="connect-ai-close"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="overflow-y-auto p-4">
          {selection === null && (
            <div className="flex flex-col gap-4">
              {hostedRouteOptions.length > 0 && (
                <section data-testid="connect-ai-hosted-section">
                  <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-fg-subtle">
                    Use DNAForge AI
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {hostedRouteOptions.map((option) => {
                      const ready = isHostedRouteOptionReady(option);
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => void connectHosted(option)}
                          disabled={!ready || saving}
                          aria-current={option.active ? 'true' : undefined}
                          className={`${UI_CARD_CLASS} text-left text-xs font-medium text-fg transition-colors hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60`}
                          data-testid={`connect-ai-hosted-${option.id}`}
                        >
                          {option.label}
                          <span className="mt-0.5 block text-[10px] font-normal text-fg-subtle">
                            {ready
                              ? toUserMessage(option.detail, 'operation.failed')
                              : toUserMessage(
                                  option.readinessLabel ?? option.detail,
                                  'operation.failed'
                                )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {error && (
                    <span
                      className="mt-2 block text-[11px] text-error"
                      data-testid="connect-ai-error"
                    >
                      {toUserMessage(error, 'operation.failed')}
                    </span>
                  )}
                  {hostedRouteOptions.some(isHostedRouteBlockedBySignIn) && (
                    <p
                      className="mt-2 text-[11px] text-fg-subtle"
                      data-testid="connect-ai-hosted-signin-hint"
                    >
                      Sign in to DNAForge from the account button at the bottom of the activity bar
                      to use DNAForge AI.
                    </p>
                  )}
                </section>
              )}
              {!hostedBrowserOnly && (
                <>
                  <section>
                    <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-fg-subtle">
                      Use a subscription
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {SUBSCRIPTION_TRANSPORTS.map((transport) => (
                        <button
                          key={transport}
                          type="button"
                          onClick={() => chooseLane({ kind: 'cli', transport })}
                          className={`${UI_CARD_CLASS} text-left text-xs font-medium text-fg transition-colors hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
                          data-testid={`connect-ai-cli-${transport}`}
                        >
                          {AGENT_TRANSPORT_LABELS[transport]}
                          <span className="mt-0.5 block text-[10px] font-normal text-fg-subtle">
                            Sign in — free with your plan
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section>
                    <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-fg-subtle">
                      Use an API key
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {providers.map((p) => (
                        <button
                          key={p.name}
                          type="button"
                          onClick={() => chooseLane({ kind: 'api', provider: p.name })}
                          className={`${UI_CARD_CLASS} flex items-center justify-between text-left text-xs font-medium text-fg transition-colors hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
                          data-testid={`connect-ai-provider-${p.name}`}
                        >
                          {p.label}
                          {providerStatuses[p.name]?.isConfigured && (
                            <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                              Connected
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </section>
                </>
              )}
            </div>
          )}

          {selection?.kind === 'api' && (
            <div className="flex flex-col gap-2">
              <TextField
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void connectApiKey(selection.provider);
                  }
                }}
                placeholder={getProviderPlaceholder(selection.provider)}
                aria-label={`${getProviderLabel(selection.provider)} API key`}
                autoFocus
                disabled={saving}
                data-testid="connect-ai-key-input"
              />
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-fg-subtle">
                  {KEY_CONSOLE_URLS[selection.provider]
                    ? `Get a key at ${KEY_CONSOLE_URLS[selection.provider]}`
                    : 'Endpoint details are managed in Settings → AI.'}
                </span>
                <Button
                  type="button"
                  onClick={() => void connectApiKey(selection.provider)}
                  disabled={saving}
                  variant="primary"
                  data-testid="connect-ai-key-save"
                >
                  {saving ? 'Connecting…' : 'Connect'}
                </Button>
              </div>
              {error && (
                <span className="text-[11px] text-error" data-testid="connect-ai-error">
                  {toUserMessage(error, 'operation.failed')}
                </span>
              )}
            </div>
          )}

          {selection?.kind === 'cli' &&
            (() => {
              const det =
                selection.transport === 'codex-sdk'
                  ? agentDetection?.codex
                  : selection.transport === 'grok-acp'
                    ? agentDetection?.grok
                    : agentDetection?.claudeCode;
              if (!det) {
                return (
                  <p className="text-xs text-fg-muted" data-testid="connect-ai-cli-checking">
                    Checking for {AGENT_TRANSPORT_LABELS[selection.transport]}…
                  </p>
                );
              }
              if (det.cli === 'missing') {
                return (
                  <CliInstallInstructions
                    transport={selection.transport}
                    os={installOS}
                    searchedDirs={det.searchedDirs}
                    onRecheck={refreshAgentDetection}
                  />
                );
              }
              const cliError =
                error ??
                (authResult && !authResult.ok && authResult.transport === selection.transport
                  ? (authResult.error ?? 'Sign-in failed.')
                  : null);
              return (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-fg-muted">
                    Opens {AGENT_TRANSPORT_LABELS[selection.transport]} sign-in in your browser and
                    connects your existing subscription.
                  </p>
                  <div>
                    <Button
                      type="button"
                      onClick={() => void connectCli(selection.transport)}
                      disabled={authenticatingTransport === selection.transport}
                      variant="primary"
                      data-testid="connect-ai-cli-signin"
                    >
                      {authenticatingTransport === selection.transport ? 'Signing in…' : 'Sign in'}
                    </Button>
                  </div>
                  {cliError && (
                    <span className="text-[11px] text-error" data-testid="connect-ai-error">
                      {toUserMessage(cliError, 'operation.failed')}
                    </span>
                  )}
                </div>
              );
            })()}
        </div>
      </div>
    </div>
  );
}

function getProviderLabel(provider: ProviderName): string {
  try {
    return getProviderMeta(provider).label;
  } catch {
    return provider;
  }
}

function getProviderPlaceholder(provider: ProviderName): string {
  try {
    return getProviderMeta(provider).credential.placeholder;
  } catch {
    return 'Paste an API key';
  }
}
