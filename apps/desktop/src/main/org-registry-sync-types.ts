import type { OrganizationRegistryOperation } from '../shared/org-registry-sync';

export interface OrgRegistryRemoteMutationReceipt {
  status: 'applied' | 'replayed';
  eventSeq: number;
  mutationId: string;
  accessGeneration: string;
  entityId?: string;
  homeWorkspaceId?: string;
  entity?: Record<string, unknown>;
  placement?: Record<string, unknown>;
  schema?: Record<string, unknown>;
  schemaRevision?: Record<string, unknown>;
}

export interface OrgRegistryMutationRow {
  mutationId: string;
  orgId: string;
  accountId: string;
  clientId: string;
  operation: OrganizationRegistryOperation;
  payload: Record<string, unknown>;
  status: 'pending' | 'sending' | 'retry_wait' | 'conflict' | 'failed';
  attemptCount: number;
  nextAttemptAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}
