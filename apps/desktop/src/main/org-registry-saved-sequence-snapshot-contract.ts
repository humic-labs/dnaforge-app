import { computeChecksum } from '@waypoint/sequence-utils';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  parseSequencePackageDocument,
  SEQUENCE_PACKAGE_FORMAT_VERSION,
  sequencePackageRootForMetaPath,
  type SequencePackageDocument,
} from '../db/sequence-package';
import { readSequenceProductSummary } from '../db/entity-substrate/sequence-product-summary-runtime';
import { projectManagedSequenceRegistry } from '../shared/managed-sequence-registry-projection';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import { MAX_WORKSPACE_BINARY_WRITE_BYTES } from '../shared/workspace-file-atomic';
import { isWorkspaceSyncRemoteUuid } from './workspace-sync-remote-id';
import type { OrgRegistryRecordReview } from './org-registry-record-sync';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export type SavedSequenceReview = Pick<OrgRegistryRecordReview, 'scope' | 'canonical'> & {
  binding: Pick<OrgRegistryRecordReview['binding'], 'authority'>;
};

export interface OrganizationSavedSequenceSnapshot {
  schema: 'dnaforge.organization-saved-sequence.v1';
  accountId: string;
  orgId: string;
  entityId: string;
  homeWorkspaceId: string;
  schemaRevisionId: string;
  organizationRevision: number;
  projectVersionId: string;
  projectVersionSha256: string;
  markerRelativePath: string;
  markerContent: string;
  markerSha256: string;
  productContent: string;
  productSha256: string;
  members: Array<{ path: string; contentSha256: string; contentBase64: string }>;
}

export function savedSequenceUnavailable(message?: string): Error {
  return Object.assign(
    new Error(
      message ??
        'The complete saved sequence for this organization version is not available in its home project history yet. Sync the project that saved it, then review again.'
    ),
    { code: 'SAVED_VERSION_UNAVAILABLE' }
  );
}

export function savedSequenceRequiredFiles(document: SequencePackageDocument): Map<string, string> {
  const files = new Map<string, string>();
  const add = (path: string, sha256: string | undefined | null) => {
    if (!isSafeWorkspaceRelativePath(path) || !sha256 || !/^sha256:[a-f0-9]{64}$/.test(sha256))
      throw savedSequenceUnavailable(
        'This saved sequence contains a member without verified saved bytes.'
      );
    const expected = sha256.slice(7);
    if (files.has(path) && files.get(path) !== expected)
      throw savedSequenceUnavailable(
        'This saved sequence assigns conflicting digests to one member.'
      );
    files.set(path, expected);
  };
  add(document.product.file, document.product.genBankChecksum);
  for (const revision of document.versionHistory.revisions)
    add(revision.productSnapshot.path, revision.productSnapshot.sha256);
  for (const attachments of [
    document.userAttachments,
    ...document.versionHistory.revisions.map((revision) => revision.state.userAttachments ?? {}),
  ]) {
    for (const attachment of Object.values(attachments)) {
      const member = document.members.find((member) => member.id === attachment.memberId);
      if (!member || member.replaceable)
        throw savedSequenceUnavailable('A saved attachment has no immutable owning member.');
      add(member.path, attachment.sha256);
    }
  }
  for (const run of document.evidenceRuns ?? []) {
    for (const artifact of [
      run.reference.artifact,
      ...run.queries.map((query) => query.artifact),
      ...(run.result ? [run.result] : []),
      ...(run.states ?? []).map((state) => state.artifact),
    ])
      add(artifact.path, artifact.sha256);
  }
  const primers = document.assembly?.primers;
  if (primers?.csv) add(primers.csv, primers.csvChecksum);
  if (primers?.fasta) add(primers.fasta, primers.fastaChecksum);
  for (const accepted of [
    document.assembly?.accepted,
    ...(document.assembly?.history ?? []),
    ...document.versionHistory.revisions.map((revision) => revision.state.acceptedAssembly),
  ]) {
    if (!record(accepted?.artifacts)) continue;
    const artifacts = accepted.artifacts;
    for (const format of ['Csv', 'Fasta']) {
      const path = artifacts[`primer${format}Path`];
      const checksum = artifacts[`primer${format}Checksum`];
      if (path === undefined && checksum === undefined) continue;
      const member = document.members.find((member) => member.path === path);
      if (
        typeof path !== 'string' ||
        typeof checksum !== 'string' ||
        !member ||
        member.role !== 'primer-export' ||
        member.replaceable
      )
        throw savedSequenceUnavailable(
          'An accepted assembly primer export has no verified immutable owning member.'
        );
      add(path, checksum);
    }
  }
  for (const member of document.members) {
    const digest =
      member.role === 'alignment' && !member.replaceable
        ? member.path.match(/^contents\/alignment-history-([a-f0-9]{64})\.json$/)?.[1]
        : undefined;
    if (digest) add(member.path, `sha256:${digest}`);
  }
  const declared = new Set(document.members.map((member) => member.path));
  if (
    document.members.some((member) => !files.has(member.path)) ||
    [...files.keys()].some((path) => path !== document.product.file && !declared.has(path))
  )
    throw savedSequenceUnavailable(
      'This saved sequence contains a member without verified saved bytes.'
    );
  const head = document.versionHistory.revisions.find(
    (revision) => revision.id === document.versionHistory.headId
  );
  if (!head || head.productSnapshot.sha256 !== document.product.genBankChecksum)
    throw savedSequenceUnavailable('This saved sequence has no verified current history value.');
  return files;
}

export async function assertOrganizationSavedSequenceSnapshot(
  value: unknown,
  review: SavedSequenceReview
): Promise<OrganizationSavedSequenceSnapshot> {
  const canonical = review.canonical;
  const fields = canonical.fields;
  const association = record(fields) ? fields._managedSequenceSnapshot : null;
  if (
    !record(value) ||
    value.schema !== 'dnaforge.organization-saved-sequence.v1' ||
    review.binding.authority !== 'sequence_package' ||
    typeof value.accountId !== 'string' ||
    typeof value.orgId !== 'string' ||
    typeof value.entityId !== 'string' ||
    typeof value.homeWorkspaceId !== 'string' ||
    typeof value.schemaRevisionId !== 'string' ||
    typeof value.organizationRevision !== 'number' ||
    value.accountId !== review.scope.accountId ||
    value.orgId !== review.scope.orgId ||
    value.entityId !== canonical.id ||
    value.homeWorkspaceId !== canonical.homeWorkspaceId ||
    value.schemaRevisionId !== canonical.schemaRevisionId ||
    value.organizationRevision !== canonical.revision ||
    !record(fields) ||
    fields._managedSequenceProjectionVersion !== 3 ||
    !record(association) ||
    association.version !== 1 ||
    typeof value.markerContent !== 'string' ||
    !digest(value.markerSha256) ||
    hash(value.markerContent) !== value.markerSha256 ||
    association.markerSha256 !== `sha256:${value.markerSha256}` ||
    typeof value.productContent !== 'string' ||
    !digest(value.productSha256) ||
    hash(value.productContent) !== value.productSha256 ||
    !digest(value.projectVersionSha256) ||
    typeof value.projectVersionId !== 'string' ||
    !isWorkspaceSyncRemoteUuid(value.projectVersionId) ||
    typeof value.markerRelativePath !== 'string' ||
    !isSafeWorkspaceRelativePath(value.markerRelativePath) ||
    !sequencePackageRootForMetaPath(value.markerRelativePath) ||
    !Array.isArray(value.members)
  )
    throw Object.assign(
      new Error('The downloaded sequence does not match the exact reviewed organization version.'),
      { code: 'REVIEW_CHANGED' }
    );
  const raw: unknown = JSON.parse(value.markerContent);
  if (!record(raw) || raw.formatVersion !== SEQUENCE_PACKAGE_FORMAT_VERSION)
    throw savedSequenceUnavailable(
      'The saved sequence format requires its supported migration before restoration.'
    );
  const document = parseSequencePackageDocument(value.markerContent);
  if ((document.entity.lifecycle?.archived ?? false) !== (canonical.archivedAt != null))
    throw Object.assign(
      new Error('The saved sequence archive state differs from the reviewed organization version.'),
      { code: 'REVIEW_CHANGED' }
    );
  const required = savedSequenceRequiredFiles(document);
  if (required.get(document.product.file) !== value.productSha256)
    throw new Error('The saved sequence product does not match its complete marker.');
  const summary = await readSequenceProductSummary(value.productContent);
  if (
    document.product.sequenceChecksum &&
    document.product.sequenceChecksum !==
      (await computeChecksum(
        parseSequenceFileAsDocument(value.productContent, document.product.file).sequence.sequence
      ))
  )
    throw new Error('The saved sequence bases do not match its complete marker.');
  const projection = await projectManagedSequenceRegistry(
    document,
    summary,
    3,
    value.markerContent
  );
  if (
    document.id !== canonical.id ||
    projection.kind !== canonical.kind ||
    projection.name !== canonical.name ||
    projection.registrationStatus !== canonical.registrationStatus ||
    projection.domainStatus !== canonical.domainStatus ||
    !isDeepStrictEqual(projection.fields, canonical.fields)
  )
    throw Object.assign(
      new Error('The downloaded sequence does not match the complete reviewed Registry value.'),
      { code: 'REVIEW_CHANGED' }
    );
  const observed = new Set<string>();
  const members: OrganizationSavedSequenceSnapshot['members'] = [];
  for (const member of value.members) {
    if (
      !record(member) ||
      typeof member.path !== 'string' ||
      member.path === document.product.file ||
      observed.has(member.path) ||
      !digest(member.contentSha256) ||
      required.get(member.path) !== member.contentSha256 ||
      typeof member.contentBase64 !== 'string'
    )
      throw new Error('The saved sequence member set does not match its complete marker.');
    const bytes = Buffer.from(member.contentBase64, 'base64');
    if (
      bytes.toString('base64') !== member.contentBase64 ||
      bytes.byteLength > MAX_WORKSPACE_BINARY_WRITE_BYTES ||
      hash(bytes) !== member.contentSha256
    )
      throw new Error('The saved sequence member failed its complete digest or size check.');
    observed.add(member.path);
    members.push({
      path: member.path,
      contentSha256: member.contentSha256,
      contentBase64: member.contentBase64,
    });
  }
  if (observed.size !== required.size - 1)
    throw new Error('The saved sequence is missing a required member.');
  return {
    schema: value.schema,
    accountId: value.accountId,
    orgId: value.orgId,
    entityId: value.entityId,
    homeWorkspaceId: value.homeWorkspaceId,
    schemaRevisionId: value.schemaRevisionId,
    organizationRevision: value.organizationRevision,
    projectVersionId: value.projectVersionId,
    projectVersionSha256: value.projectVersionSha256,
    markerRelativePath: value.markerRelativePath,
    markerContent: value.markerContent,
    markerSha256: value.markerSha256,
    productContent: value.productContent,
    productSha256: value.productSha256,
    members,
  };
}
