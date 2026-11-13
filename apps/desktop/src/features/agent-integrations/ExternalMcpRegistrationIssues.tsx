import { useCallback, useEffect, useRef, useState } from 'react';
import { platform } from '../../platform';
import type { ExternalMcpRegistrationSnapshot } from '../../shared/external-mcp-registration';

export function ExternalMcpRegistrationIssues() {
  const [snapshot, setSnapshot] = useState<ExternalMcpRegistrationSnapshot | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retryAction = useRef<(() => void) | null>(null);

  useEffect(() => {
    let active = true;
    let request = 0;
    let refreshPending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const load = async (refresh = false): Promise<void> => {
      if (!active || refreshPending) return;
      const owner = ++request;
      cancelTimer();
      if (refresh) {
        refreshPending = true;
        setRetrying(true);
      }
      let nextDelay = 15_000;
      try {
        const next = await (refresh
          ? platform().agentSdk.refreshExternalMcpRegistration()
          : platform().agentSdk.getExternalMcpRegistration());
        if (!active || owner !== request) return;
        setSnapshot(next);
        nextDelay = next.state === 'pending' ? 1_000 : 15_000;
      } catch {
        if (active && owner === request)
          setSnapshot({ state: 'failed', launcher: null, clients: [] });
      } finally {
        if (active && owner === request) {
          refreshPending = false;
          setRetrying(false);
          timer = setTimeout(() => void load(), nextDelay);
        }
      }
    };
    retryAction.current = () => void load(true);
    void load();
    return () => {
      active = false;
      request += 1;
      retryAction.current = null;
      cancelTimer();
    };
  }, []);

  const retry = useCallback(() => retryAction.current?.(), []);

  const failures =
    snapshot?.clients.filter(({ status }) => status === 'failed' || status === 'name-conflict') ??
    [];
  if (snapshot?.state !== 'failed' && failures.length === 0) return null;

  return (
    <div
      className="mb-3 space-y-2 rounded border border-warning/30 p-3 text-xs"
      role="status"
      data-testid="external-app-registration-issues"
    >
      {snapshot?.state === 'failed' && <p>Could not check access for other AI apps.</p>}
      {failures.map(({ client, status }) => (
        <p key={client}>
          {status === 'name-conflict'
            ? `${client} already has a different tool server named dnaforge. Its settings were left unchanged.`
            : `Could not add DNAForge tools to ${client}.`}
        </p>
      ))}
      <button
        type="button"
        onClick={() => void retry()}
        disabled={retrying}
        className="rounded border border-border px-2 py-1 disabled:opacity-50"
      >
        {retrying ? 'Retrying…' : 'Retry connection'}
      </button>
    </div>
  );
}
