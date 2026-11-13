import type { AgentTraceEventShape } from '../../platform';

const ACTIVITY_MESSAGE_TYPE = 'agent.activity';
const ACTIVITY_MESSAGE_VERSION = 1;

interface EncodedAgentActivityMessage {
  type: typeof ACTIVITY_MESSAGE_TYPE;
  version: typeof ACTIVITY_MESSAGE_VERSION;
  event: AgentTraceEventShape;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAgentTraceEventShape(value: unknown): value is AgentTraceEventShape {
  if (!isRecord(value)) return false;
  if (!isRecord(value.display)) return false;
  return (
    typeof value.transport === 'string' &&
    typeof value.sequence === 'number' &&
    typeof value.receivedAt === 'string' &&
    typeof value.providerEventType === 'string' &&
    typeof value.display.kind === 'string' &&
    typeof value.display.title === 'string'
  );
}

export function encodeAgentActivityMessage(event: AgentTraceEventShape): string {
  const payload: EncodedAgentActivityMessage = {
    type: ACTIVITY_MESSAGE_TYPE,
    version: ACTIVITY_MESSAGE_VERSION,
    event,
  };
  return JSON.stringify(payload);
}

export function decodeAgentActivityMessage(content: string): AgentTraceEventShape | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) return null;
    if (parsed.type !== ACTIVITY_MESSAGE_TYPE || parsed.version !== ACTIVITY_MESSAGE_VERSION) {
      return null;
    }
    return isAgentTraceEventShape(parsed.event) ? parsed.event : null;
  } catch {
    return null;
  }
}
