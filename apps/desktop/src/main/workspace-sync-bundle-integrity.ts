import { createHash } from 'node:crypto';

import {
  validateWorkspaceSyncBundle,
  workspaceSyncBundleHashInput,
  type WorkspaceSyncBundle,
} from '@waypoint/share-bundle';
import { isWorkspaceSyncRemoteUuid } from './workspace-sync-remote-id';

export interface DesktopSyncVersionAuthor {
  accountId: string;
  email: string | null;
  displayName: string | null;
}

export interface DesktopSyncLatestBundleEnvelope {
  workspaceId: string;
  version: {
    id: string;
    versionNumber: number;
    contentSha256: string;
    sizeBytes: number;
    fileCount: number;
    createdAt: string;
    createdBy?: DesktopSyncVersionAuthor | null;
  };
  bundle: unknown;
}

export function parseDesktopSyncVersionAuthor(value: unknown): DesktopSyncVersionAuthor | null {
  if (!isRecord(value) || typeof value.accountId !== 'string' || !value.accountId) return null;
  return {
    accountId: value.accountId,
    email: typeof value.email === 'string' ? value.email : null,
    displayName: typeof value.displayName === 'string' ? value.displayName : null,
  };
}

export type ValidatedDesktopSyncLatestBundleEnvelope = Omit<
  DesktopSyncLatestBundleEnvelope,
  'bundle'
> & { bundle: WorkspaceSyncBundle };

const validatedLatestEnvelopes = new WeakSet<object>();

export function assertValidDesktopSyncLatestBundle(latest: unknown): WorkspaceSyncBundle {
  if (!isDesktopSyncLatestBundleEnvelope(latest)) {
    throw new Error('Latest cloud bundle response has an invalid envelope.');
  }
  if (validatedLatestEnvelopes.has(latest)) return latest.bundle as WorkspaceSyncBundle;

  const parsed = validateWorkspaceSyncBundle(latest.bundle);
  if (!parsed.ok) {
    throw new Error(`Latest cloud bundle is invalid: ${parsed.errors.join('; ')}`);
  }

  const contentSha256 = createHash('sha256')
    .update(workspaceSyncBundleHashInput(parsed.bundle))
    .digest('hex');
  if (parsed.bundle.provenance.contentSha256 !== contentSha256) {
    throw new Error('Latest cloud bundle provenance hash does not match its bytes.');
  }
  if (latest.version.contentSha256 !== contentSha256) {
    throw new Error('Latest cloud bundle hash does not match its version metadata.');
  }
  if (latest.version.fileCount !== parsed.bundle.files.length) {
    throw new Error('Latest cloud bundle file count does not match its version metadata.');
  }
  const sizeBytes =
    parsed.bundle.schemaVersion === 3
      ? parsed.bundle.files.reduce((total, file) => total + file.sizeBytes, 0)
      : Buffer.byteLength(JSON.stringify(latest.bundle), 'utf8');
  if (latest.version.sizeBytes !== sizeBytes) {
    throw new Error('Latest cloud bundle size does not match its version metadata.');
  }

  return parsed.bundle;
}

export function validateDesktopSyncLatestBundleEnvelope(
  latest: unknown
): ValidatedDesktopSyncLatestBundleEnvelope {
  const bundle = assertValidDesktopSyncLatestBundle(latest);
  return { ...(latest as DesktopSyncLatestBundleEnvelope), bundle };
}

export function markDesktopSyncLatestBundleValidated(
  latest: ValidatedDesktopSyncLatestBundleEnvelope
): void {
  validatedLatestEnvelopes.add(latest);
}

function isDesktopSyncLatestBundleEnvelope(
  value: unknown
): value is DesktopSyncLatestBundleEnvelope {
  if (
    !isRecord(value) ||
    !isWorkspaceSyncRemoteUuid(value.workspaceId) ||
    !isRecord(value.version)
  ) {
    return false;
  }
  const version = value.version;
  return (
    isWorkspaceSyncRemoteUuid(version.id) &&
    isPositiveInteger(version.versionNumber) &&
    typeof version.contentSha256 === 'string' &&
    isNonNegativeInteger(version.sizeBytes) &&
    isNonNegativeInteger(version.fileCount) &&
    typeof version.createdAt === 'string' &&
    (version.createdBy === undefined ||
      version.createdBy === null ||
      parseDesktopSyncVersionAuthor(version.createdBy) !== null) &&
    'bundle' in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
