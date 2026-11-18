import { publicAgentApprovalRule } from '../../shared/agent-approval';
import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useState } from 'react';

import { platform } from '../../platform';
import type { AgentAlwaysAllowRuleShape } from '../../shared/agent-runtime-ipc';
import { Switch } from '../../components/ui/controls';

export function AlwaysAllowList() {
  const [rules, setRules] = useState<AgentAlwaysAllowRuleShape[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback(async (load: () => Promise<AgentAlwaysAllowRuleShape[]>) => {
    try {
      setRules(await load());
      setError(null);
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.the-always-allowed-list-is-unavailable'));
    }
  }, []);

  useEffect(() => {
    void apply(() => platform().agentSession.listAlwaysAllowRules());
  }, [apply]);

  return (
    <div data-testid="agent-always-allow-list">
      <h3 className="text-sm font-medium text-fg">Always allowed</h3>
      <p className="mt-1 text-[11px] leading-4 text-fg-subtle">
        Requests you chose “Always allow” for. They apply in every chat and project. Switch one off
        to be asked again.
      </p>
      {error ? (
        <p className="mt-2 text-[11px] text-error">{toUserMessage(error, 'assistant.failed')}</p>
      ) : null}
      {rules && rules.length === 0 ? (
        <p className="mt-2 text-xs text-fg-muted" data-testid="agent-always-allow-empty">
          Nothing yet.
        </p>
      ) : null}
      {rules && rules.length > 0 ? (
        <ul className="mt-2 divide-y divide-border rounded-md border border-border">
          {rules.map((rule) => (
            <li
              key={rule.key}
              className="flex items-center gap-3 px-3 py-2"
              data-testid="agent-always-allow-rule"
            >
              <span
                className={`min-w-0 flex-1 truncate text-xs ${rule.enabled ? 'text-fg' : 'text-fg-muted'}`}
              >
                {publicAgentApprovalRule(rule).label}
              </span>
              <Switch
                label={`Always allow ${publicAgentApprovalRule(rule).label}`}
                checked={rule.enabled}
                onChange={(enabled) =>
                  void apply(() =>
                    platform().agentSession.setAlwaysAllowRuleEnabled(rule.key, enabled)
                  )
                }
              />
              <button
                type="button"
                className="text-[11px] text-fg-muted wp-interactive"
                onClick={() =>
                  void apply(() => platform().agentSession.removeAlwaysAllowRule(rule.key))
                }
                aria-label={`Remove ${publicAgentApprovalRule(rule).label}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
