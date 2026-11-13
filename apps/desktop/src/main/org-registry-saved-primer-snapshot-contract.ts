import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import { isWorkspaceSyncRemoteUuid } from './workspace-sync-remote-id';
import { parsePrimerArtifact, serializePrimerArtifact } from '../shared/primers/primer-artifact';
import { primerArtifactRegistryProjection } from '../shared/primers/primer-artifact-projection';
import type { OrgRegistryRecordReview } from './org-registry-record-sync';

const hash = (content: string | Uint8Array) => createHash('sha256').update(content).digest('hex');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface OrganizationSavedPrimerSnapshot {
  schema: 'dnaforge.organization-saved-primer.v1';
  accountId: string;
  orgId: string;
  entityId: string;
  homeWorkspaceId: string;
  schemaRevisionId: string;
  organizationRevision: number;
  projectVersionId: string;
  projectVersionSha256: string;
  relativePath: string;
  contentSha256: string;
  content: string;
}

export function matchesOrganizationSavedPrimer(
  content: string,
  review: OrgRegistryRecordReview
): boolean {
  let artifact;
  try {
    artifact = parsePrimerArtifact(content);
  } catch {
    return false;
  }
  const canonical = review.canonical;
  const bases = artifact.sequence.bases.replace(/\s/g, '');
  const projected = primerArtifactRegistryProjection(
    artifact,
    {
      mode: 'inline',
      bases,
      topology: 'linear',
      length: bases.length,
      contentHash: `sha256:${hash(bases)}`,
    },
    hash(serializePrimerArtifact(artifact))
  );
  return (
    artifact.id === canonical.id &&
    artifact.registry.entityId === canonical.id &&
    artifact.registry.kind === canonical.kind &&
    artifact.name === canonical.name &&
    artifact.sequence.contentHash === hash(bases) &&
    projected.registrationStatus === canonical.registrationStatus &&
    projected.domainStatus === canonical.domainStatus &&
    Boolean(artifact.entity?.state?.archived) === (canonical.archivedAt != null) &&
    isDeepStrictEqual(projected.fields, canonical.fields)
  );
}

export function assertOrganizationSavedPrimerSnapshot(
  snapshot: unknown,
  review: OrgRegistryRecordReview
): asserts snapshot is OrganizationSavedPrimerSnapshot {
  const canonical = review.canonical;
  const fields = canonical.fields;
  const artifact = record(fields) ? fields.artifact : null;
  if (
    !record(snapshot) ||
    snapshot.schema !== 'dnaforge.organization-saved-primer.v1' ||
    snapshot.accountId !== review.scope.accountId ||
    snapshot.orgId !== review.scope.orgId ||
    snapshot.entityId !== canonical.id ||
    snapshot.homeWorkspaceId !== canonical.homeWorkspaceId ||
    snapshot.schemaRevisionId !== canonical.schemaRevisionId ||
    snapshot.organizationRevision !== canonical.revision ||
    !record(artifact) ||
    typeof snapshot.relativePath !== 'string' ||
    snapshot.relativePath !== artifact.relativePath ||
    !isSafeWorkspaceRelativePath(snapshot.relativePath) ||
    typeof snapshot.projectVersionSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(snapshot.projectVersionSha256) ||
    typeof snapshot.projectVersionId !== 'string' ||
    !isWorkspaceSyncRemoteUuid(snapshot.projectVersionId) ||
    typeof snapshot.content !== 'string' ||
    hash(snapshot.content) !== snapshot.contentSha256 ||
    !matchesOrganizationSavedPrimer(snapshot.content, review)
  ) {
    throw Object.assign(
      new Error('The downloaded primer does not match the exact reviewed organization version.'),
      { code: 'REVIEW_CHANGED' }
    );
  }
}
