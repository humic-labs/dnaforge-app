import {
  customFetch,
  getListAgentGrantsAgentGrantsGetUrl,
  type ApiClientConfiguration,
  type listAgentGrantsAgentGrantsGetResponse,
} from '@waypoint/api-client';
import { hasRequiredCapabilities } from '../shared/capability-policy';
import { getApiUrl } from './config';
import { z } from 'zod';
export interface NativeAgentAuthority {
  identityId: string;
  capabilities: readonly string[];
}
const grantSnapshotSchema = z.object({
  ok: z.literal(true),
  grants: z.array(
    z.object({
      id: z.string().min(1),
      scopes: z.unknown(),
      revokedAt: z.string().nullable().optional(),
      expiresAt: z.string().nullable().optional(),
    })
  ),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().nullable().optional(),
});

export function createNativeAgentGrantInspector(
  fetch: NonNullable<ApiClientConfiguration['fetch']>,
  prefix = 'AGENT'
) {
  return async (identityId: string) => {
    if (!identityId.trim())
      throw new Error(`${prefix}_CAPABILITY_DENIED: An exact agent identity is required.`);
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      let snapshot: unknown;
      try {
        const response = await customFetch<listAgentGrantsAgentGrantsGetResponse>(
          getListAgentGrantsAgentGrantsGetUrl({ pageSize: 200, cursor: cursor ?? undefined }),
          { method: 'GET' },
          { baseUrl: getApiUrl(), fetch }
        );
        snapshot = response.data;
      } catch (error) {
        throw new Error(
          `${prefix}_GRANTS_UNAVAILABLE: Current agent access could not be inspected.`,
          { cause: error }
        );
      }
      const parsed = grantSnapshotSchema.safeParse(snapshot);
      if (!parsed.success)
        throw new Error(`${prefix}_GRANTS_UNAVAILABLE: Agent access returned an invalid snapshot.`);
      const body = parsed.data;
      const grant = body.grants.find((grant) => grant.id === identityId);
      if (grant) {
        const scopes = z.array(z.string()).safeParse(grant.scopes);
        return { ...grant, scopes: scopes.success ? scopes.data : null };
      }
      if (!body.hasMore || !body.nextCursor) return null;
      cursor = body.nextCursor;
    }
    throw new Error(
      `${prefix}_GRANTS_UNAVAILABLE: Exact grant inspection exceeded its bounded page limit.`
    );
  };
}

export function createNativeAgentGrantAuthorizer(
  fetch: NonNullable<ApiClientConfiguration['fetch']>,
  prefix = 'AGENT'
) {
  const inspectGrant = createNativeAgentGrantInspector(fetch, prefix);
  return async (agent: NativeAgentAuthority, required: readonly string[]): Promise<void> => {
    if (!agent.identityId?.trim() || !hasRequiredCapabilities(agent.capabilities, required))
      throw new Error(
        `${prefix}_CAPABILITY_DENIED: This caller does not hold the required current capabilities.`
      );
    const grant = await inspectGrant(agent.identityId);
    const expires = grant?.expiresAt ? Date.parse(grant.expiresAt) : undefined;
    if (
      !grant ||
      grant.revokedAt ||
      (expires !== undefined && (!Number.isFinite(expires) || expires <= Date.now())) ||
      !grant.scopes ||
      !hasRequiredCapabilities(grant.scopes, required)
    )
      throw new Error(
        `${prefix}_CAPABILITY_DENIED: This exact agent grant expired, was revoked or no longer holds the required capabilities.`
      );
  };
}
