import { HOSTED_NATIVE_TOOL_DEFINITIONS } from '@waypoint/hosted-ai-contract';
import { ALLOWED_RENDERER_TOOLS } from '../../agent-bridge/public/renderer-tools';
import { useChatStore } from '../hooks/useChat';
import { observeWorkflowAction, type ScientificWorkflow } from '../../../lib/workflow-telemetry';
import type { ChatTurnSummary, ConversationState } from './chat-store-types';
import type { ChatMessage } from './chat-types';
import { toCanonicalHostedToolName } from './hosted-policy-tools';

const APP_TOOL_NAMES = new Set<string>([
  ...Object.values(ALLOWED_RENDERER_TOOLS).map((definition) => definition.name),
  ...HOSTED_NATIVE_TOOL_DEFINITIONS.map((definition) => definition.name),
]);

const CLI_BUILTIN_TOOL_NAMES = new Set([
  'bash',
  'read',
  'write',
  'edit',
  'multiedit',
  'grep',
  'glob',
  'ls',
  'webfetch',
  'websearch',
  'todowrite',
  'task',
  'notebookedit',
  'shell',
  'apply_patch',
]);

const SAFE_TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function agentToolTelemetryName(rawName: string | undefined): string {
  if (!rawName) return 'unknown_tool';
  const canonical = toCanonicalHostedToolName(rawName);
  const tail = canonical.includes('__') ? (canonical.split('__').pop() ?? canonical) : canonical;
  if (APP_TOOL_NAMES.has(tail) && SAFE_TOOL_NAME_RE.test(tail)) return tail;
  const builtin = tail.toLowerCase();
  if (CLI_BUILTIN_TOOL_NAMES.has(builtin)) return `cli_${builtin}`;
  return 'external_tool';
}

function toolCallFailed(message: ChatMessage): boolean {
  try {
    const parsed: unknown = JSON.parse(message.content);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { isError?: unknown }).isError === true
    );
  } catch {
    return false;
  }
}

function workflowForTurn(turn: ChatTurnSummary | undefined): ScientificWorkflow {
  if (turn?.routeKind === 'hosted') return 'hosted_ai';
  if (turn?.routeKind === 'cli' && turn.transport === 'codex-sdk') return 'local_codex';
  if (turn?.routeKind === 'cli' && turn.transport === 'claude-agent-sdk') return 'local_claude';
  if (turn?.routeKind === 'cli' && turn.transport === 'grok-acp') return 'local_grok';
  return 'ask_ai';
}

function toolMessages(
  conversations: Map<string, ConversationState & { turns: Record<string, ChatTurnSummary> }>
): { key: string; message: ChatMessage; turn: ChatTurnSummary | undefined }[] {
  const found: { key: string; message: ChatMessage; turn: ChatTurnSummary | undefined }[] = [];
  for (const conversation of conversations.values()) {
    for (const message of conversation.messages ?? []) {
      if (message.role !== 'tool') continue;
      found.push({
        key: `${message.turnId ?? ''}:${message.toolCallId ?? message.id}`,
        message,
        turn: message.turnId ? conversation.turns[message.turnId] : undefined,
      });
    }
  }
  return found;
}

export function installAgentToolCallTelemetry(): () => void {
  const seen = new Set(toolMessages(useChatStore.getState()._convStates).map(({ key }) => key));
  return useChatStore.subscribe((state) => {
    for (const { key, message, turn } of toolMessages(state._convStates)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const failed = toolCallFailed(message);
      observeWorkflowAction({
        workflow: workflowForTurn(turn),
        action: 'tool_call',
        phase: 'result',
        status: failed ? 'failed' : 'completed',
        success: !failed,
        agentToolName: agentToolTelemetryName(message.toolName),
        ...(failed ? { errorClass: 'tool_failed' } : {}),
        ...(turn?.id ? { parentActionId: turn.id } : {}),
      });
    }
  });
}
