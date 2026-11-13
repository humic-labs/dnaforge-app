import type { DesktopSyncClient } from './desktop-sync-client';
import { createDesktopSyncClient } from './desktop-sync-client';
import {
  requireOrgRegistryAccessGeneration,
  type OrgRegistryOperation,
  type OrgRegistryAccessReset,
  type OrgRegistryRemoteMutationReceipt,
} from './org-registry-sync-cache';
import type {
  OrganizationRegistryRemoteClient,
  OrganizationRegistryRemoteEventPage,
} from './org-registry-sync-worker';
import {
  REGISTRY_SNAPSHOT_PAGE_BYTES,
  REGISTRY_SNAPSHOT_PAGE_RECORDS,
  type OrganizationRegistrySnapshotPage,
} from './org-registry-snapshot-cache';

export interface OrganizationRegistryReplicaHealth {
  clientId: string;
  accountId: string;
  accountName: string;
  lastEventSeq: number;
  lagEvents: number;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastErrorCode: string | null;
  conflictCount: number;
  updatedAt: string;
}

export interface OrganizationRegistrySyncHealth {
  orgId: string;
  cursor: number;
  entityCount: number;
  conflictCount: number;
  replicas: OrganizationRegistryReplicaHealth[];
}

export interface OrganizationRegistryDeletionImpact {
  orgId: string;
  projectCount: number;
  archivedProjectCount: number;
  registryEntityCount: number;
  archivedRegistryEntityCount: number;
  registrySchemaCount: number;
  registryReplicaCount: number;
  syncStorageObjectCount: number;
  syncStorageReservationCount: number;
  canDelete: boolean;
}

export interface OrganizationRegistryConfiguration {
  defaultPrefix: string;
  defaultPadWidth: number;
  schemes: Array<{ entityKind: string; prefix: string; padWidth: number }>;
}

export interface OrganizationRegistryClient extends OrganizationRegistryRemoteClient {
  configure(
    input: OrganizationRegistryConfiguration & { orgId: string; accountId: string }
  ): Promise<{ status: 'configured'; cursor: number }>;
  getSyncHealth(input: {
    orgId: string;
    accountId: string;
  }): Promise<OrganizationRegistrySyncHealth>;
  getDeletionImpact(input: {
    orgId: string;
    accountId: string;
  }): Promise<OrganizationRegistryDeletionImpact>;
}

export function createOrganizationRegistryClient(
  client: DesktopSyncClient = createDesktopSyncClient()
): OrganizationRegistryClient {
  const registryPath = (orgId: string): string =>
    `/api/desktop-sync/organizations/${encodeURIComponent(orgId)}/registry`;

  return {
    getSnapshotPage: async (input) => {
      const query = new URLSearchParams({
        format: 'paged-v2',
        clientId: input.clientId,
        snapshotId: input.snapshotId,
        after: String(input.after),
        limit: String(input.limit),
      });
      if (input.accessGeneration !== null) query.set('accessGeneration', input.accessGeneration);
      const response = await client.requestJson<unknown>(`${registryPath(input.orgId)}?${query}`, {
        method: 'GET',
        expectedAccountId: input.accountId,
        maxResponseBytes: REGISTRY_SNAPSHOT_PAGE_BYTES,
      });
      const record = requireRecord(response);
      const reset = parseAccessReset(record);
      if (reset) return reset;
      if (record.format !== 'paged-v2')
        throw new Error('Registry requires scoped paged-v2 synchronization.');
      return parseSnapshotPage(record);
    },
    acknowledgeSnapshot: async (input) => {
      const response = await client.requestJson<unknown>(
        `${registryPath(input.orgId)}/snapshot-ack`,
        {
          method: 'POST',
          expectedAccountId: input.accountId,
          maxResponseBytes: 4096,
          body: {
            format: 'paged-v2',
            clientId: input.clientId,
            snapshotId: input.snapshotId,
            cursor: input.cursor,
            accessGeneration: input.accessGeneration,
          },
        }
      );
      const record = requireRecord(response);
      const reset = parseAccessReset(record);
      if (reset) return reset;
      if (
        record.accessGeneration !== input.accessGeneration ||
        record.status !== 'acknowledged' ||
        record.snapshotId !== input.snapshotId ||
        record.cursor !== input.cursor
      )
        throw new Error('Registry snapshot acknowledgement mismatch.');
      return {
        status: 'acknowledged' as const,
        snapshotId: input.snapshotId,
        cursor: input.cursor,
        accessGeneration: input.accessGeneration,
      };
    },
    getEvents: async (input) => {
      const response = await client.requestJson<unknown>(
        `${registryPath(input.orgId)}/events?format=paged-v2&after=${input.after}&limit=${input.limit}&clientId=${encodeURIComponent(input.clientId)}&accessGeneration=${encodeURIComponent(input.accessGeneration)}`,
        {
          method: 'GET',
          expectedAccountId: input.accountId,
          maxResponseBytes: REGISTRY_SNAPSHOT_PAGE_BYTES,
        }
      );
      return parseAccessReset(requireRecord(response)) ?? parseEventPage(response);
    },
    applyMutation: async (input) => {
      const response = await client.requestJson<unknown>(registryPath(input.orgId), {
        method: 'POST',
        expectedAccountId: input.accountId,
        idempotencyKey: input.mutationId,
        body: {
          format: 'paged-v2',
          accessGeneration: input.accessGeneration,
          clientId: input.clientId,
          mutationId: input.mutationId,
          operation: input.operation,
          payload: input.payload,
        },
      });
      const reset = parseAccessReset(requireRecord(response));
      if (reset) return reset;
      const receipt = parseMutationResponse(response);
      if (
        receipt.mutationId !== input.mutationId ||
        receipt.accessGeneration !== input.accessGeneration
      )
        throw new Error('Registry mutation response does not match its request.');
      return receipt;
    },
    configure: async (input) => {
      const response = await client.requestJson<unknown>(
        `${registryPath(input.orgId)}/configuration`,
        {
          method: 'PUT',
          expectedAccountId: input.accountId,
          body: {
            defaultPrefix: input.defaultPrefix,
            defaultPadWidth: input.defaultPadWidth,
            schemes: input.schemes,
          },
        }
      );
      return parseConfigurationResponse(response);
    },
    getSyncHealth: async (input) => {
      const response = await client.requestJson<unknown>(
        `${registryPath(input.orgId)}/sync-health`,
        { method: 'GET', expectedAccountId: input.accountId }
      );
      return parseSyncHealth(response);
    },
    getDeletionImpact: async (input) => {
      const response = await client.requestJson<unknown>(
        `/api/desktop-sync/organizations/${encodeURIComponent(input.orgId)}/deletion-impact`,
        { method: 'GET', expectedAccountId: input.accountId }
      );
      return parseDeletionImpact(response);
    },
  };
}

function parseSnapshotPage(record: Record<string, unknown>): OrganizationRegistrySnapshotPage {
  const kinds = [
    'id_scheme',
    'schema',
    'schema_revision',
    'entity',
    'entity_revision',
    'relationship',
    'placement',
  ];
  if (
    !Array.isArray(record.records) ||
    record.records.length > REGISTRY_SNAPSHOT_PAGE_RECORDS ||
    typeof record.hasMore !== 'boolean'
  )
    throw new Error('Invalid Registry snapshot page.');
  return {
    format: 'paged-v2',
    accessGeneration: requireOrgRegistryAccessGeneration(record.accessGeneration),
    orgId: requireText(record.orgId),
    snapshotId: requireText(record.snapshotId),
    cursor: requireCount(record.cursor),
    totalRecords: requireCount(record.totalRecords),
    expiresAt: requirePositiveCount(record.expiresAt),
    after: requireCount(record.after),
    nextAfter: requireCount(record.nextAfter),
    hasMore: record.hasMore,
    records: record.records.map((raw) => {
      const item = requireRecord(raw);
      const type = requireText(item.recordType);
      if (!kinds.includes(type)) throw new Error('Invalid Registry snapshot record type.');
      return {
        ordinal: requirePositiveCount(item.ordinal),
        recordType: type as OrganizationRegistrySnapshotPage['records'][number]['recordType'],
        recordId: requireText(item.recordId),
        payload: requireRecord(item.payload),
      };
    }),
  };
}

function parseAccessReset(record: Record<string, unknown>): OrgRegistryAccessReset | null {
  if (record.status !== 'reset_required') return null;
  if (
    record.reason !== 'access_changed' ||
    Object.keys(record).some((key) => !['status', 'reason', 'accessGeneration'].includes(key))
  )
    throw new Error('Invalid Registry access reset.');
  return {
    status: 'reset_required',
    reason: 'access_changed',
    accessGeneration: requireOrgRegistryAccessGeneration(record.accessGeneration),
  };
}

function parseEventPage(value: unknown): OrganizationRegistryRemoteEventPage {
  try {
    const record = requireRecord(value);
    const nextCursor = requireCount(record.nextCursor);
    const currentCursor = requireCount(record.currentCursor);
    if (nextCursor > currentCursor || typeof record.hasMore !== 'boolean') throw new Error();
    const rawEvents = Array.isArray(record.events)
      ? record.events
      : (() => {
          throw new Error();
        })();
    const events = rawEvents.map((raw) => {
      const event = requireRecord(raw);
      if (
        event.eventType === 'scope.filtered' &&
        (Object.keys(event).some((key) => !['eventSeq', 'eventType', 'payload'].includes(key)) ||
          Object.keys(requireRecord(event.payload)).length !== 0)
      )
        throw new Error();
      return {
        eventSeq: requirePositiveCount(event.eventSeq),
        eventType: requireText(event.eventType),
        payload: requireRecord(event.payload),
      };
    });
    return {
      accessGeneration: requireOrgRegistryAccessGeneration(record.accessGeneration),
      events,
      nextCursor,
      currentCursor,
      hasMore: record.hasMore,
    };
  } catch {
    throw new Error('Desktop sync returned an invalid Registry event page.');
  }
}

function parseMutationResponse(value: unknown): OrgRegistryRemoteMutationReceipt {
  try {
    const record = requireRecord(value);
    if (record.status !== 'applied' && record.status !== 'replayed') throw new Error();
    const result: OrgRegistryRemoteMutationReceipt = {
      status: record.status,
      eventSeq: requirePositiveCount(record.eventSeq),
      mutationId: requireText(record.mutationId),
      accessGeneration: requireOrgRegistryAccessGeneration(record.accessGeneration),
    };
    for (const key of ['entityId', 'homeWorkspaceId'] as const)
      if (record[key] !== undefined) result[key] = requireText(record[key]);
    for (const key of ['entity', 'placement', 'schema', 'schemaRevision'] as const)
      if (record[key] !== undefined) result[key] = requireRecord(record[key]);
    return result;
  } catch {
    throw new Error('Desktop sync returned an invalid Registry mutation response.');
  }
}

function parseConfigurationResponse(value: unknown): { status: 'configured'; cursor: number } {
  try {
    const record = requireRecord(value);
    if (record.status !== 'configured') throw new Error();
    return { status: record.status, cursor: requirePositiveCount(record.cursor) };
  } catch {
    throw new Error('Desktop sync returned an invalid Registry configuration response.');
  }
}

function parseSyncHealth(value: unknown): OrganizationRegistrySyncHealth {
  try {
    const record = requireRecord(value);
    const rawReplicas = Array.isArray(record.replicas)
      ? record.replicas
      : (() => {
          throw new Error();
        })();
    return {
      orgId: requireText(record.orgId),
      cursor: requireCount(record.cursor),
      entityCount: requireCount(record.entityCount),
      conflictCount: requireCount(record.conflictCount),
      replicas: rawReplicas.map((raw) => {
        const replica = requireRecord(raw);
        return {
          clientId: requireText(replica.clientId),
          accountId: requireText(replica.accountId),
          accountName: requireText(replica.accountName),
          lastEventSeq: requireCount(replica.lastEventSeq),
          lagEvents: requireCount(replica.lagEvents),
          lastPushAt: requireNullableText(replica.lastPushAt),
          lastPullAt: requireNullableText(replica.lastPullAt),
          lastErrorCode: requireNullableText(replica.lastErrorCode),
          conflictCount: requireCount(replica.conflictCount),
          updatedAt: requireText(replica.updatedAt),
        };
      }),
    };
  } catch {
    throw new Error('Desktop sync returned invalid Registry sync health.');
  }
}

function parseDeletionImpact(value: unknown): OrganizationRegistryDeletionImpact {
  try {
    const record = requireRecord(value);
    if (typeof record.canDelete !== 'boolean') throw new Error();
    return {
      orgId: requireText(record.orgId),
      projectCount: requireCount(record.projectCount),
      archivedProjectCount: requireCount(record.archivedProjectCount),
      registryEntityCount: requireCount(record.registryEntityCount),
      archivedRegistryEntityCount: requireCount(record.archivedRegistryEntityCount),
      registrySchemaCount: requireCount(record.registrySchemaCount),
      registryReplicaCount: requireCount(record.registryReplicaCount),
      syncStorageObjectCount: requireCount(record.syncStorageObjectCount),
      syncStorageReservationCount: requireCount(record.syncStorageReservationCount),
      canDelete: record.canDelete,
    };
  } catch {
    throw new Error('Desktop sync returned invalid organization deletion impact.');
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

function requireText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error();
  return value;
}

function requireNullableText(value: unknown): string | null {
  if (value === null) return null;
  return requireText(value);
}

function requireCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error();
  return value as number;
}

function requirePositiveCount(value: unknown): number {
  const parsed = requireCount(value);
  if (parsed === 0) throw new Error();
  return parsed;
}

export type { OrgRegistryOperation };
