import { manifest } from '@waypoint/codex-app-server-contract';

export const EXPECTED_SERVER_NOTIFICATIONS: readonly string[] = [
  'remoteControl/status/changed',
  'thread/started',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'account/rateLimits/updated',
  'thread/compacted',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'error',
  'warning',
];

export const PINNED_PROTOCOL_NOTIFICATIONS: readonly string[] =
  manifest.upstreamProtocolMethods.notification;

export const ANSWERABLE_SERVER_REQUESTS: readonly string[] = [
  'item/tool/call',
  'item/tool/requestUserInput',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
];

export const REFUSED_SERVER_REQUESTS: Readonly<Record<string, string>> = {
  execCommandApproval: 'this runtime never runs commands for the model',
  applyPatchApproval: 'patches are applied through the product tool surface, not the model',
  'mcpServer/elicitation/request': 'MCP servers are not exposed to the Hosted runtime',
  'account/chatgptAuthTokens/refresh':
    'this runtime authenticates through the Hosted gateway and holds no ChatGPT tokens',
  'attestation/generate': 'attestation is not part of the Hosted contract',
  'currentTime/read': 'this runtime does not answer clock reads for the model',
};

export interface DynamicToolCallParams {
  readonly callId: string;
  readonly tool: string;
  readonly arguments: unknown;
  readonly threadId: string;
  readonly turnId: string;
  readonly namespace?: string | null;
}

export function isDynamicToolCallParams(value: unknown): value is DynamicToolCallParams {
  if (value === null || typeof value !== 'object') return false;
  const params = value as Record<string, unknown>;
  return (
    typeof params.callId === 'string' &&
    typeof params.tool === 'string' &&
    typeof params.threadId === 'string' &&
    typeof params.turnId === 'string' &&
    'arguments' in params
  );
}
