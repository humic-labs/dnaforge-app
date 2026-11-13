import type {
  HostedCodexTurnIdentity,
  HostedCodexTurnStartRequest,
} from '../../shared/hosted-codex-ipc';
import { MAX_HOSTED_WHOLE_REQUEST_BYTES } from '@waypoint/hosted-ai-contract';
import { parseAgentPermissions } from '../../shared/agent-permissions';

const HOSTED_CODEX_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export function parseHostedCodexIdentity(value: unknown): HostedCodexTurnIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  for (const key of ['workflowId', 'runId', 'turnId'] as const) {
    const item = candidate[key];
    if (
      typeof item !== 'string' ||
      item.length < 1 ||
      item.length > 256 ||
      !HOSTED_CODEX_ID.test(item)
    ) {
      return null;
    }
  }
  return {
    workflowId: candidate.workflowId as string,
    runId: candidate.runId as string,
    turnId: candidate.turnId as string,
  };
}

export function parseHostedCodexTurnStartRequest(
  value: unknown
): HostedCodexTurnStartRequest | null {
  const identity = parseHostedCodexIdentity(value);
  if (!identity || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== (candidate.permissions === undefined ? 9 : 10) ||
    (candidate.permissions !== undefined && !parseAgentPermissions(candidate.permissions)) ||
    (candidate.tier !== 'auto' && candidate.tier !== 'deep') ||
    typeof candidate.developerInstructions !== 'string' ||
    candidate.developerInstructions.trim().length === 0 ||
    typeof candidate.userMessage !== 'string' ||
    candidate.userMessage.trim().length === 0 ||
    (candidate.priorConversationContext !== null &&
      typeof candidate.priorConversationContext !== 'string') ||
    Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_HOSTED_WHOLE_REQUEST_BYTES ||
    typeof candidate.workspaceOpen !== 'boolean' ||
    !Array.isArray(candidate.stagedReferenceIds) ||
    candidate.stagedReferenceIds.length > 256 ||
    !candidate.stagedReferenceIds.every(
      (item) =>
        typeof item === 'string' &&
        item.length >= 1 &&
        item.length <= 256 &&
        HOSTED_CODEX_ID.test(item)
    )
  ) {
    return null;
  }
  return {
    ...identity,
    tier: candidate.tier,
    developerInstructions: candidate.developerInstructions,
    userMessage: candidate.userMessage,
    priorConversationContext: candidate.priorConversationContext,
    workspaceOpen: candidate.workspaceOpen,
    stagedReferenceIds: candidate.stagedReferenceIds,
    ...(candidate.permissions !== undefined
      ? { permissions: parseAgentPermissions(candidate.permissions) }
      : {}),
  } as HostedCodexTurnStartRequest;
}
