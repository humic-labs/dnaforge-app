import {
  parseAgentPermissions,
  resolveAgentPermissions,
  type AgentPermissionCatalog,
  type AgentPermissions,
  type ResolvedAgentPermissions,
} from '../../../shared/agent-permissions';
import type { ChatTurnSummary, ConversationState } from './chat-store-types';

function turnPermissions(turn: ChatTurnSummary): AgentPermissions | null {
  try {
    const parsed: unknown = JSON.parse(turn.routeSnapshotJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parseAgentPermissions((parsed as Record<string, unknown>).permissions)
      : null;
  } catch {
    return null;
  }
}

export function lastTurnPermissions(
  turns: Record<string, ChatTurnSummary>
): AgentPermissions | null {
  let latest: { startedAt: number; permissions: AgentPermissions } | null = null;
  for (const turn of Object.values(turns)) {
    const permissions = turnPermissions(turn);
    if (permissions && (!latest || turn.startedAt >= latest.startedAt)) {
      latest = { startedAt: turn.startedAt, permissions };
    }
  }
  return latest?.permissions ?? null;
}

export function chatPermissions(
  state: Pick<ConversationState, 'permissions' | 'turns'> | undefined,
  catalog: AgentPermissionCatalog,
  preferred?: AgentPermissions
): ResolvedAgentPermissions {
  return resolveAgentPermissions(
    catalog,
    preferred,
    lastTurnPermissions(state?.turns ?? {}),
    state?.permissions
  );
}

export function withPermissions(
  routeSnapshotJson: string,
  permissions: ResolvedAgentPermissions
): string {
  const parsed: unknown = JSON.parse(routeSnapshotJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return routeSnapshotJson;
  return JSON.stringify({ ...(parsed as Record<string, unknown>), permissions });
}
