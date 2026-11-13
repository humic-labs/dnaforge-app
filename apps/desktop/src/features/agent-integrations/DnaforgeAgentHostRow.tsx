import { toUserMessage } from '@waypoint/user-messages';
import { useState } from 'react';
import {
  getAssistantRouteReadinessLabel,
  type HostedRouteReadiness,
} from '../ai/public/assistant-routes';
import {
  SETTINGS_FORM_WIDTH_CLASS,
  SETTINGS_SECONDARY_BUTTON_CLASS,
  SettingsSelect,
} from '../../components/SettingsSubsection';
import { DefaultRouteButton } from './DefaultRouteButton';

export function DnaforgeAgentHostRow({
  readiness,
  activeTier,
  onUse,
  onSignIn,
}: {
  readiness: HostedRouteReadiness;
  activeTier: 'auto' | 'deep' | null;
  onUse: (tier: 'auto' | 'deep') => Promise<void>;
  onSignIn: () => Promise<void>;
}) {
  const [tier, setTier] = useState<'auto' | 'deep'>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = readiness === 'ready';
  const selected = activeTier !== null;
  const act = async () => {
    setBusy(true);
    setError(null);
    try {
      if (readiness === 'needs-login') await onSignIn();
      else if (ready) await onUse(activeTier ?? tier);
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.dnaforge-agent-could-not-be-selected'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="min-w-0 py-4 pl-5"
      data-testid="dnaforge-agent-host"
      aria-current={selected ? 'true' : undefined}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3 text-lg font-semibold tracking-tight text-fg">
            DNAForge agent
            <span className={`text-xs font-medium ${ready ? 'text-success' : 'text-fg-muted'}`}>
              {ready ? 'Ready' : getAssistantRouteReadinessLabel(readiness)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {readiness === 'needs-login' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act()}
              className={SETTINGS_SECONDARY_BUTTON_CLASS}
            >
              {busy ? 'Connecting…' : 'Sign in'}
            </button>
          ) : (
            <DefaultRouteButton
              isDefault={selected}
              disabled={busy || !ready}
              onClick={() => void act()}
              testId="dnaforge-agent-default"
            />
          )}
        </div>
      </div>
      <div className={`mt-5 space-y-4 ${SETTINGS_FORM_WIDTH_CLASS}`}>
        <label className="grid gap-1.5 text-xs font-medium text-fg-muted">
          Mode
          <SettingsSelect
            ariaLabel="DNAForge agent mode"
            testId="dnaforge-agent-mode"
            value={activeTier ?? tier}
            disabled={busy || (selected && !ready)}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'deep', label: 'Deep' },
            ]}
            onValueChange={async (value) => {
              const next = value as 'auto' | 'deep';
              if (!selected) {
                setTier(next);
                return;
              }
              setBusy(true);
              setError(null);
              try {
                await onUse(next);
              } catch (cause) {
                setError(toUserMessage(cause, 'failure.could-not-change-mode'));
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-error">
          {toUserMessage(error, 'assistant.failed')}
        </p>
      )}
    </div>
  );
}
