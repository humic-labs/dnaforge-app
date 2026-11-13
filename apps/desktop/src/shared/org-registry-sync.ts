import { userMessage, type UserMessage } from '@waypoint/user-messages';
import type { LimsEntity, LimsRegistrySummary } from './lims';

export const ORGANIZATION_REGISTRY_OPERATIONS = [
  'schema.create',
  'schema.refine',
  'entity.create',
  'entity.update',
  'entity.archive',
  'entity.restore',
  'relationships.replace',
  'placement.add',
  'placement.remove',
] as const;

export type OrganizationRegistryOperation = (typeof ORGANIZATION_REGISTRY_OPERATIONS)[number];

export interface OrganizationRegistryChangedEvent {
  accountId: string;
  orgId: string;
}

export interface OrganizationRegistryConfigurationRequest {
  defaultPrefix: string;
  defaultPadWidth: number;
  schemes: Array<{ entityKind: string; prefix: string; padWidth: number }>;
}

export interface OrganizationRegistryMutationRequest {
  mutationId: string;
  operation: OrganizationRegistryOperation;
  payload: Record<string, unknown>;
}

export interface OrganizationRegistryRecordDetailsRequest {
  entityId: string;
  expectedAccessGeneration: string;
}

export type OrganizationRegistryLocalAvailability =
  | {
      status: 'available';
      workspaceId: number;
      workspaceUuid: string;
      homeWorkspaceId: string;

      summary: Pick<LimsRegistrySummary, 'id' | 'kind' | 'name' | 'archived' | 'representation'>;
    }
  | {
      status: 'unavailable';
      reason:
        | 'not_on_device'
        | 'home_mismatch'
        | 'project_unavailable'
        | 'no_saved_document'
        | 'source_unavailable';
      message: string;
    };

export function organizationRegistryUnavailableMessage(
  local: Extract<OrganizationRegistryLocalAvailability, { status: 'unavailable' }>
): UserMessage {
  switch (local.reason) {
    case 'not_on_device':
      return userMessage('registry.availability.not_on_device');
    case 'home_mismatch':
      return userMessage('registry.availability.home_mismatch');
    case 'project_unavailable':
      return userMessage('registry.availability.project_unavailable');
    case 'no_saved_document':
      return userMessage('registry.availability.no_saved_document');
    case 'source_unavailable':
      return userMessage('registry.availability.source_unavailable');
    default:
      return userMessage('failure.the-entity-could-not-be-opened');
  }
}

export interface OrganizationRegistryCachedRecordDetails {
  scope: {
    accountId: string;
    orgId: string;
    accessGeneration: string;
    cursor: number;
  };
  entity: Record<string, unknown> & {
    id: string;
    orgId: string;
    homeWorkspaceId: string;
    schemaId: string;
    schemaRevisionId: string;
  };
  schema: Record<string, unknown>;

  schemaRevision: Record<string, unknown>;
  relationships: Record<string, unknown>[];
  placements: Record<string, unknown>[];
}

export interface OrganizationRegistryRecordDetails extends OrganizationRegistryCachedRecordDetails {
  local: OrganizationRegistryLocalAvailability;
}

export type OrganizationRegistryRecordDetailsResult =
  | { ok: true; details: OrganizationRegistryRecordDetails }
  | OrganizationRegistryActionError;

export type OrganizationRegistryRecordSyncStatus = {
  orgId: string;
  entityId: string;
  homeWorkspaceId: string;
  acknowledgedRevision: number | null;
  baseRevision: number | null;
  baseProvenance: 'receipt' | 'reviewed_remote' | null;
  status:
    | 'claim_pending'
    | 'publication_pending'
    | 'queued'
    | 'conflict'
    | 'failed'
    | 'remote_changes'
    | 'synced';
  mutationId: string;
  message: string | null;

  pendingResolution?: OrganizationRegistrySavedRecordResolutionRequest | null;
};

export type OrganizationRegistryRecordSyncStatusResult =
  | {
      ok: true;
      accountId: string;
      status: OrganizationRegistryRecordSyncStatus | null;
    }
  | { ok: false; code: string; message: string };

export type OrganizationRegistrySavedRecordVersion = Pick<
  LimsEntity,
  'id' | 'name' | 'fields' | 'registrationStatus' | 'domainStatus'
> & { archived: boolean };

export interface OrganizationRegistrySavedRecordReview {
  accountId: string;
  orgId: string;
  entityId: string;
  sourceRevision: string;
  localEventSeq: number;
  organizationRevision: number;
  local: OrganizationRegistrySavedRecordVersion;
  organization: OrganizationRegistrySavedRecordVersion;
}

export type OrganizationRegistrySavedRecordReviewResult =
  | { ok: true; review: OrganizationRegistrySavedRecordReview }
  | OrganizationRegistryActionError;

export interface OrganizationRegistrySavedRecordResolutionRequest {
  entityId: string;
  resolutionId: string;
  choice: 'use_remote' | 'keep_saved';
  sourceRevision: string;
}

export type OrganizationRegistrySavedRecordResolutionResult =
  | { ok: true; entity: LimsEntity; replayed: boolean }
  | OrganizationRegistryActionError;

export interface OrganizationRegistryClaimPreparationRequest {
  entityId: string;
  schemaId: string;
  schemaRevisionId: string;
}

export interface PreparedOrganizationRegistryClaim {
  mutationId: string;
  sourceEntityId: string;
  sourceRegistryId: string | null;

  sourceRevision: string;
  homeWorkspaceId: string;
  homeProjectUuid: string;
  homeProjectName: string;
  payload: Record<string, unknown>;
}

export interface OrganizationRegistryClaimRequest extends OrganizationRegistryClaimPreparationRequest {
  mutationId: string;
  sourceRevision: string;
}

export type OrganizationRegistryConflictResolution = 'use_remote' | 'retry_against_latest';

export interface OrganizationRegistryConflictResolutionRequest {
  conflictId: string;
  resolution: OrganizationRegistryConflictResolution;
  replacementPayload?: Record<string, unknown>;
}

export interface OrganizationRegistrySyncStateView {
  cursor: number;
  accessGeneration: string | null;
  status: 'idle' | 'syncing' | 'ready' | 'error' | 'access_revoked';
  clientId: string;
  lastPullAt: number | null;
  lastPushAt: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface OrganizationRegistryPendingMutationView {
  mutationId: string;
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

export interface OrganizationRegistryConflictView {
  id: string;
  mutationId: string;
  operation: OrganizationRegistryOperation;
  localPayload: Record<string, unknown>;
  errorCode: string;
  errorMessage: string;
  details: Record<string, unknown> | null;
  status: 'open' | 'resolved' | 'discarded';
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface OrganizationRegistryView {
  orgId: string;
  state: OrganizationRegistrySyncStateView;
  idSchemes: Record<string, unknown>[];
  schemas: Record<string, unknown>[];
  schemaRevisions: Record<string, unknown>[];
  entities: Record<string, unknown>[];
  entityRevisions: Record<string, unknown>[];
  relationships: Record<string, unknown>[];
  placements: Record<string, unknown>[];
  pendingMutations: OrganizationRegistryPendingMutationView[];
  conflicts: OrganizationRegistryConflictView[];
}

export interface OrganizationRegistrySyncOutcome {
  status: 'ready' | 'error' | 'access_revoked' | 'not_configured';
  cursor: number;
  pendingCount: number;
  conflictCount: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface OrganizationRegistryReplicaHealthView {
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

export interface OrganizationRegistrySyncHealthView {
  orgId: string;
  cursor: number;
  entityCount: number;
  conflictCount: number;
  replicas: OrganizationRegistryReplicaHealthView[];
}

export interface OrganizationDeletionImpactView {
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

export interface OrganizationRegistryActionError {
  ok: false;
  code:
    | 'SIGNED_OUT'
    | 'INVALID_REQUEST'
    | 'NOT_IMPLEMENTED'
    | 'NOT_CONFIGURED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'REVIEW_CHANGED'
    | 'SYNC_ERROR';
  message: string;
}

export type OrganizationRegistryCachedOrganizationsResult =
  | { ok: true; accountId: string; organizationIds: string[] }
  | OrganizationRegistryActionError;

export type OrganizationRegistryReadResult =
  | { ok: true; registry: OrganizationRegistryView }
  | OrganizationRegistryActionError;

export type OrganizationRegistrySyncResult =
  | {
      ok: true;
      sync: OrganizationRegistrySyncOutcome;
      registry: OrganizationRegistryView;
    }
  | OrganizationRegistryActionError;

export type OrganizationRegistryMutationResult =
  | {
      ok: true;
      mutationId: string;
      sync: OrganizationRegistrySyncOutcome;
      registry: OrganizationRegistryView;
    }
  | OrganizationRegistryActionError;

export type OrganizationRegistryClaimPreparationResult =
  | { ok: true; claim: PreparedOrganizationRegistryClaim }
  | OrganizationRegistryActionError;

export type OrganizationRegistryClaimResult =
  | {
      ok: true;
      mutationId: string;
      registration: 'registered' | 'queued';
      sync: OrganizationRegistrySyncOutcome;
      registry: OrganizationRegistryView;
    }
  | OrganizationRegistryActionError;

export type OrganizationRegistryConfigurationResult =
  | { ok: true; cursor: number; registry: OrganizationRegistryView }
  | OrganizationRegistryActionError;

export type OrganizationRegistrySyncHealthResult =
  | { ok: true; health: OrganizationRegistrySyncHealthView }
  | OrganizationRegistryActionError;

export type OrganizationDeletionImpactResult =
  | { ok: true; impact: OrganizationDeletionImpactView }
  | OrganizationRegistryActionError;

export type OrganizationRegistryConflictResolutionResult =
  | { ok: true; registry: OrganizationRegistryView; mutationId?: string }
  | OrganizationRegistryActionError;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[A-Z][A-Z0-9-]{0,15}$/;
const KIND_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const OPERATIONS = new Set<string>(ORGANIZATION_REGISTRY_OPERATIONS);
const MAX_MUTATION_BYTES = 1024 * 1024;

export function parseOrganizationRegistryMutationRequest(
  value: unknown
): OrganizationRegistryMutationRequest {
  const record = requireRecord(value, 'Registry mutation must be an object.');
  const mutationId = requireUuid(record.mutationId, 'mutationId');
  if (typeof record.operation !== 'string' || !OPERATIONS.has(record.operation)) {
    throw new Error('operation must be a supported Registry operation.');
  }
  const payload = requireRecord(record.payload, 'payload must be an object.');
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_MUTATION_BYTES) {
    throw new Error('payload may not exceed 1 MiB.');
  }
  return {
    mutationId,
    operation: record.operation as OrganizationRegistryOperation,
    payload,
  };
}

export function parseOrganizationRegistryRecordSyncEntityId(value: unknown): string {
  return requireUuid(value, 'entityId');
}

export function parseOrganizationRegistrySavedRecordResolutionRequest(
  value: unknown
): OrganizationRegistrySavedRecordResolutionRequest {
  const record = requireRecord(value, 'Choose a reviewed saved record version.');
  if (
    Object.keys(record).some(
      (key) => !['entityId', 'resolutionId', 'choice', 'sourceRevision'].includes(key)
    ) ||
    (record.choice !== 'use_remote' && record.choice !== 'keep_saved') ||
    typeof record.sourceRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.sourceRevision)
  ) {
    throw new Error('The saved record choice must identify the exact reviewed versions.');
  }
  return {
    entityId: requireUuid(record.entityId, 'entityId'),
    resolutionId: requireUuid(record.resolutionId, 'resolutionId'),
    choice: record.choice,
    sourceRevision: record.sourceRevision,
  };
}

export function parseOrganizationRegistryRecordDetailsRequest(
  value: unknown
): OrganizationRegistryRecordDetailsRequest {
  const record = requireRecord(value, 'Registry Details must identify a record and access scope.');
  const generation = record.expectedAccessGeneration;
  if (
    typeof generation !== 'string' ||
    !generation ||
    generation.length > 256 ||
    generation.trim() !== generation
  ) {
    throw new Error('expectedAccessGeneration must identify the displayed Registry access scope.');
  }
  return {
    entityId: requireUuid(record.entityId, 'entityId'),
    expectedAccessGeneration: generation,
  };
}

export function parseOrganizationRegistryClaimPreparationRequest(
  value: unknown
): OrganizationRegistryClaimPreparationRequest {
  const record = requireRecord(value, 'Registry registration must identify a saved record.');
  return {
    entityId: requireUuid(record.entityId, 'entityId'),
    schemaId: requireUuid(record.schemaId, 'schemaId'),
    schemaRevisionId: requireUuid(record.schemaRevisionId, 'schemaRevisionId'),
  };
}

export function parseOrganizationRegistryClaimRequest(
  value: unknown
): OrganizationRegistryClaimRequest {
  const record = requireRecord(value, 'Registry registration must identify a saved record.');
  if (typeof record.sourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(record.sourceRevision)) {
    throw new Error('sourceRevision must identify the reviewed saved record.');
  }
  return {
    ...parseOrganizationRegistryClaimPreparationRequest(record),
    mutationId: requireUuid(record.mutationId, 'mutationId'),
    sourceRevision: record.sourceRevision,
  };
}

export function parseOrganizationRegistryConfigurationRequest(
  value: unknown
): OrganizationRegistryConfigurationRequest {
  const record = requireRecord(value, 'Registry configuration must be an object.');
  const defaultPrefix = requirePrefix(record.defaultPrefix, 'defaultPrefix');
  const defaultPadWidth = requirePadWidth(record.defaultPadWidth, 'defaultPadWidth');
  if (!Array.isArray(record.schemes) || record.schemes.length > 100) {
    throw new Error('schemes must contain at most 100 entries.');
  }
  const schemes = record.schemes.map((raw, index) => {
    const scheme = requireRecord(raw, `schemes[${index}] must be an object.`);
    if (typeof scheme.entityKind !== 'string' || !KIND_RE.test(scheme.entityKind)) {
      throw new Error(`schemes[${index}].entityKind is invalid.`);
    }
    return {
      entityKind: scheme.entityKind,
      prefix: requirePrefix(scheme.prefix, `schemes[${index}].prefix`),
      padWidth: requirePadWidth(scheme.padWidth, `schemes[${index}].padWidth`),
    };
  });
  if (new Set(schemes.map((scheme) => scheme.entityKind)).size !== schemes.length) {
    throw new Error('Each entity kind may have only one ID scheme.');
  }
  return { defaultPrefix, defaultPadWidth, schemes };
}

export function parseOrganizationRegistryConflictResolutionRequest(
  value: unknown
): OrganizationRegistryConflictResolutionRequest {
  const record = requireRecord(value, 'Registry conflict resolution must be an object.');
  const conflictId = requireUuid(record.conflictId, 'conflictId');
  if (record.resolution !== 'use_remote' && record.resolution !== 'retry_against_latest') {
    throw new Error('resolution must be use_remote or retry_against_latest.');
  }
  if (record.resolution === 'retry_against_latest') {
    return {
      conflictId,
      resolution: record.resolution,
      replacementPayload: requireRecord(
        record.replacementPayload,
        'replacementPayload is required when retrying a conflict.'
      ),
    };
  }
  return { conflictId, resolution: record.resolution };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`${label} must be a UUID.`);
  }
  return value;
}

function requirePrefix(value: unknown, label: string): string {
  if (typeof value !== 'string' || !PREFIX_RE.test(value)) {
    throw new Error(`${label} must be 1-16 uppercase letters, digits, or hyphens.`);
  }
  return value;
}

function requirePadWidth(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 2 || (value as number) > 12) {
    throw new Error(`${label} must be an integer from 2 through 12.`);
  }
  return value as number;
}
