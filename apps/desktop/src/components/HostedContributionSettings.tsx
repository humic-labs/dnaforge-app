import { toUserMessage } from '@waypoint/user-messages';
import { useEffect } from 'react';
import { useHostedContributionStore } from '../stores/hosted-contribution-store';
import { useAuthStore } from '../stores/auth-store';

export function HostedContributionSettings() {
  const { state, hydrated } = useAuthStore();
  const accountId = state.status === 'signed-in' ? state.session?.accountId : null;
  const sessionId = state.status === 'signed-in' ? state.session?.desktopSessionId : null;
  const signedIn = hydrated && state.status === 'signed-in';
  const { policy, enabled, error, setSession, refresh, setEnabled, retry } =
    useHostedContributionStore();
  const sessionKey = signedIn && accountId && sessionId ? `${accountId}:${sessionId}` : null;
  const current = useHostedContributionStore((store) => store.sessionKey === sessionKey);

  useEffect(() => {
    setSession(
      signedIn && accountId && sessionId ? { accountId, desktopSessionId: sessionId } : null
    );
    void refresh();
  }, [signedIn, accountId, sessionId, setSession, refresh]);

  if (!signedIn) return null;
  return (
    <div className="space-y-2" data-testid="hosted-contribution-settings">
      <label className="flex items-start gap-2 text-xs text-fg">
        <input
          type="checkbox"
          checked={current && enabled === true}
          disabled={!current || !policy?.choice_offered}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
          className="mt-0.5 accent-accent"
        />
        <span>
          <span className="font-medium">Contribute AI workflows to research</span>
          <span className="mt-1 block text-[11px] leading-4 text-fg-muted">
            Allow DNAForge and approved research partners to use AI requests, responses, tool
            activity, and content accessed in those workflows for AI training and evaluation. On by
            default for eligible accounts; you can turn it off. DNAForge agent remains available
            when this is off.
          </span>
        </span>
      </label>
      {current && policy && !policy.choice_offered && (
        <p className="text-[11px] text-fg-muted">Your account plan manages this setting.</p>
      )}
      {current && policy && (
        <p className="text-[11px] leading-4 text-fg-muted">
          Turning this off stops new research collection. Previously granted rights remain.{' '}
          <a
            href={policy.legal_challenge.terms_url}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline"
          >
            Terms
          </a>
          {' · '}
          <a
            href={policy.legal_challenge.privacy_url}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline"
          >
            Privacy
          </a>
        </p>
      )}
      {current && error && (
        <div role="alert" className="text-xs text-error">
          {toUserMessage(error, 'operation.failed')}{' '}
          <button type="button" onClick={retry} className="underline">
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
