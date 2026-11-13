import { useAgentUserInputStore } from './agent-user-input-store';
import { useDestructiveConfirmStore } from './destructive-confirm-store';

export function AgentWaitingBadge() {
  const waiting = useDestructiveConfirmStore(
    (state) => state.request !== null && state.request !== undefined
  );
  const asking = useAgentUserInputStore(
    (state) => state.request !== null && state.request !== undefined
  );
  if (!waiting && !asking) return null;
  return (
    <span
      role="status"
      aria-label="An agent is waiting for your answer"
      title="An agent is waiting for your answer"
      className="ml-1 inline-block h-2 w-2 flex-shrink-0 rounded-full bg-amber-500"
      data-testid="agent-waiting-badge"
    />
  );
}
