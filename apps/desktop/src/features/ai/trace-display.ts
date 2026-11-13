import type { AgentTraceEventShape } from '../../platform';

const DIAGNOSTIC_TRACE_KINDS = new Set(['assistant_text', 'lifecycle', 'result', 'unknown']);
const DIAGNOSTIC_PROVIDER_EVENTS = new Set(['thread.started', 'turn.started', 'turn.completed']);

export function isChatVisibleAgentTraceEvent(event: AgentTraceEventShape): boolean {
  if (event.display.visibility === 'chat') return true;
  if (event.display.visibility === 'diagnostic') return false;
  if (DIAGNOSTIC_PROVIDER_EVENTS.has(event.providerEventType)) return false;
  return !DIAGNOSTIC_TRACE_KINDS.has(event.display.kind);
}
