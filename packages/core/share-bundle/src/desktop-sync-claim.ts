const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DesktopSyncClaimStatus = 'created' | 'reused';
export type DesktopSyncClaimOwnerKind = 'personal' | 'org';

export type DesktopSyncClaimOwner =
  | { kind: 'personal'; accountId: string }
  | { kind: 'org'; orgId: string };

export interface DesktopSyncClaimResponse {
  status: DesktopSyncClaimStatus;
  workspaceId: string;
  clientWorkspaceId: string;
  ownerKind: DesktopSyncClaimOwnerKind;
  owner: DesktopSyncClaimOwner;
  claimedBy: { accountId: string };

  scientificHistoryFormats?: readonly number[];
}

export class DesktopSyncClaimResponseError extends Error {
  constructor(message: string) {
    super(`Workspace claim response ${message}`);
    this.name = 'DesktopSyncClaimResponseError';
  }
}

export function isDesktopSyncUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value) return null;
  return trimmed;
}

function parseOwner(value: unknown): DesktopSyncClaimOwner {
  if (!isRecord(value)) throw new DesktopSyncClaimResponseError('is missing its owner.');
  if (value.kind === 'personal') {
    const accountId = identifier(value.accountId);
    if (!accountId) {
      throw new DesktopSyncClaimResponseError('personal owner is missing an account id.');
    }
    if ('orgId' in value && value.orgId !== null && value.orgId !== undefined) {
      throw new DesktopSyncClaimResponseError('personal owner must not carry an org id.');
    }
    return { kind: 'personal', accountId };
  }
  if (value.kind === 'org') {
    const orgId = identifier(value.orgId);
    if (!orgId) throw new DesktopSyncClaimResponseError('org owner is missing an org id.');
    return { kind: 'org', orgId };
  }
  throw new DesktopSyncClaimResponseError('owner kind is not personal or org.');
}

export function parseDesktopSyncClaimResponse(value: unknown): DesktopSyncClaimResponse {
  if (!isRecord(value)) throw new DesktopSyncClaimResponseError('must be an object.');
  if (value.status !== 'created' && value.status !== 'reused') {
    throw new DesktopSyncClaimResponseError('status must be created or reused.');
  }
  if (!isDesktopSyncUuid(value.workspaceId)) {
    throw new DesktopSyncClaimResponseError('workspace id must be a UUID.');
  }
  const clientWorkspaceId = identifier(value.clientWorkspaceId);
  if (!clientWorkspaceId) {
    throw new DesktopSyncClaimResponseError('is missing the client workspace id.');
  }
  const owner = parseOwner(value.owner);
  if (value.ownerKind !== owner.kind) {
    throw new DesktopSyncClaimResponseError('owner kind disagrees with its owner.');
  }
  if (!isRecord(value.claimedBy)) {
    throw new DesktopSyncClaimResponseError('is missing the confirmed claimant.');
  }
  const claimantAccountId = identifier(value.claimedBy.accountId);
  if (!claimantAccountId) {
    throw new DesktopSyncClaimResponseError('claimant is missing an account id.');
  }
  if (
    value.scientificHistoryFormats !== undefined &&
    (!Array.isArray(value.scientificHistoryFormats) ||
      value.scientificHistoryFormats.length > 16 ||
      value.scientificHistoryFormats.some(
        (format) => !Number.isSafeInteger(format) || format < 1
      ) ||
      new Set(value.scientificHistoryFormats).size !== value.scientificHistoryFormats.length)
  )
    throw new DesktopSyncClaimResponseError('scientific history formats are invalid.');
  return {
    status: value.status,
    workspaceId: value.workspaceId,
    clientWorkspaceId,
    ownerKind: owner.kind,
    owner,
    claimedBy: { accountId: claimantAccountId },
    ...(value.scientificHistoryFormats !== undefined
      ? { scientificHistoryFormats: [...(value.scientificHistoryFormats as number[])] }
      : {}),
  };
}
