import {
  toUserMessage,
  userMessage,
  userMessageValue,
  userMessageWithValues,
  userToolLabel,
  type UserMessage,
  type UserMessageKey,
} from '@waypoint/user-messages';
import type { AgentTraceDisplayShape, AgentTraceToolCallShape } from './agent-runtime-ipc';
import {
  presentationToolNames,
  presentToolAction,
  type PublicActionDetail,
} from './agent-tool-presentation';

type FaultKind =
  | 'tool'
  | 'error'
  | 'notification'
  | 'permission_denial'
  | 'result'
  | 'unknown'
  | 'lifecycle';
type PublicFields = {
  title: UserMessage;
  status?: UserMessage;
  visibility?: 'chat' | 'diagnostic';
  details?: PublicActionDetail[];
  toolNames?: readonly string[];
};
export type PublicAgentTraceDisplay = PublicFields &
  (
    | { kind: FaultKind; text?: UserMessage }
    | { kind: Exclude<AgentTraceDisplayShape['kind'], FaultKind>; text?: string }
  );

const titles: Record<AgentTraceDisplayShape['kind'], UserMessageKey> = {
  assistant_text: 'assistant.trace.message',
  command: 'assistant.trace.command',
  error: 'assistant.trace.error',
  file_change: 'assistant.trace.fileChange',
  lifecycle: 'assistant.notice',
  notification: 'assistant.trace.notification',
  permission_denial: 'assistant.trace.permissionDenied',
  reasoning: 'assistant.trace.reasoning',
  result: 'assistant.trace.completed',
  todo: 'assistant.trace.plan',
  tool: 'assistant.action',
  unknown: 'assistant.notice',
  web_search: 'assistant.trace.search',
};
const statuses: Record<string, UserMessageKey> = {
  entered: 'assistant.trace.entered',
  awaiting_decision: 'assistant.trace.awaitingDecision',
  plan: 'assistant.trace.plan',
  plan_update: 'assistant.trace.plan',
  completed: 'assistant.trace.completed',
  succeeded: 'assistant.trace.completed',
  success: 'assistant.trace.completed',
  running: 'assistant.trace.running',
  in_progress: 'assistant.trace.running',
  started: 'assistant.trace.running',
  modified: 'assistant.trace.modified',
  requested: 'assistant.trace.requested',
  pending: 'assistant.trace.requested',
  waiting: 'assistant.trace.requested',
  failed: 'assistant.trace.failed',
  failure: 'assistant.trace.failed',
  error: 'assistant.trace.failed',
  denied: 'assistant.trace.failed',
  status_unavailable: 'assistant.trace.statusUnavailable',
};

export function publicAgentTraceDisplay(
  display: AgentTraceDisplayShape,
  toolCalls: readonly AgentTraceToolCallShape[] = []
): PublicAgentTraceDisplay {
  const title =
    display.kind === 'tool'
      ? userToolLabel(display.title)
      : toUserMessage(display.title, titles[display.kind] ?? 'assistant.notice');
  const statusKey = display.status
    ? (statuses[display.status.toLowerCase().replaceAll(' ', '_')] ??
      'assistant.trace.statusUnavailable')
    : undefined;
  const fields = {
    title,
    ...(statusKey ? { status: userMessage(statusKey) } : {}),
    ...(display.visibility ? { visibility: display.visibility } : {}),
  };
  switch (display.kind) {
    case 'tool': {
      const rememberedNames = presentationToolNames(display.toolNames);
      const toolNames = toolCalls.length
        ? presentationToolNames(toolCalls.map((call) => call.name))
        : rememberedNames.length
          ? rememberedNames
          : presentationToolNames(display.text);
      const calls = toolCalls.length
        ? toolCalls
        : toolNames.map((name) => ({
            name,
            status:
              statusKey === 'assistant.trace.completed'
                ? ('completed' as const)
                : statusKey === 'assistant.trace.failed'
                  ? ('failed' as const)
                  : statusKey === 'assistant.trace.requested'
                    ? ('requested' as const)
                    : ('running' as const),
          }));
      const actions = calls.map(presentToolAction);
      if (actions.length === 1) {
        const action = actions[0];
        return {
          ...fields,
          kind: 'tool',
          toolNames,
          title: action.title,
          status: action.status,
          ...(action.summary ? { text: action.summary } : {}),
          ...(action.details.length ? { details: action.details } : {}),
        };
      }
      if (actions.length > 1)
        return {
          ...fields,
          kind: 'tool',
          toolNames,
          title: userMessageWithValues('assistant.actionNamed', {
            action: userMessageValue(actions.map((action) => action.title).join(', ')),
          }),
          text: userMessageWithValues('assistant.actionSummary', {
            detail: userMessageValue(
              actions.map((action) => action.summary ?? action.title).join(' · ')
            ),
          }),
          details: actions.flatMap((action) => action.details).slice(0, 16),
        };
      return {
        ...fields,
        kind: display.kind,
      };
    }
    case 'error':
      return {
        ...fields,
        kind: display.kind,
        text: toUserMessage(display.text, 'assistant.failed'),
      };
    case 'permission_denial':
      return {
        ...fields,
        kind: display.kind,
        text: userMessage('assistant.trace.permissionDetail'),
      };
    case 'notification':
      return {
        ...fields,
        kind: display.kind,
        text: toUserMessage(display.text, 'assistant.notice'),
      };
    case 'result':
    case 'unknown':
    case 'lifecycle':
      return { ...fields, kind: display.kind };
    default:
      return { ...fields, kind: display.kind, text: display.text };
  }
}
