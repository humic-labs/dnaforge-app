import { createHash } from 'node:crypto';
import { decodeBundleFileContent } from '@waypoint/share-bundle';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import { createDesktopSyncClient, type DesktopSyncClient } from './desktop-sync-client';
import type { OrgRegistryRecordReview } from './org-registry-record-sync';
import { listWorkspaceSyncHistory } from './workspace-sync-history';
import { createWorkspaceSyncProjectsClient } from './workspace-sync-projects';
import { assertValidDesktopSyncLatestBundle } from './workspace-sync-bundle-integrity';
import {
  assertOrganizationSavedPrimerSnapshot,
  matchesOrganizationSavedPrimer,
  type OrganizationSavedPrimerSnapshot,
} from './org-registry-saved-primer-snapshot-contract';

const hash = (content: string | Uint8Array) => createHash('sha256').update(content).digest('hex');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function unavailable(): Error {
  return Object.assign(
    new Error(
      'The complete saved primer for this organization version is not available in its home project history yet. Sync the project that saved it, then review again.'
    ),
    { code: 'SAVED_VERSION_UNAVAILABLE' }
  );
}

export async function readOrganizationSavedPrimerSnapshot(
  review: OrgRegistryRecordReview,
  suppliedClient: DesktopSyncClient = createDesktopSyncClient()
): Promise<OrganizationSavedPrimerSnapshot> {
  if (review.binding.authority !== 'primer_artifact') throw unavailable();
  const canonical = review.canonical;
  const { id: entityId, homeWorkspaceId, schemaRevisionId } = canonical;
  const fields = canonical.fields;
  const artifact = record(fields) ? fields.artifact : null;
  if (
    typeof entityId !== 'string' ||
    typeof homeWorkspaceId !== 'string' ||
    typeof schemaRevisionId !== 'string' ||
    !record(artifact) ||
    typeof artifact.relativePath !== 'string' ||
    !isSafeWorkspaceRelativePath(artifact.relativePath) ||
    typeof artifact.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(artifact.contentHash)
  )
    throw unavailable();
  const relativePath = artifact.relativePath;
  const accountId = review.scope.accountId;
  const client: DesktopSyncClient = {
    requestJson: (path, options) =>
      suppliedClient.requestJson(path, { ...options, expectedAccountId: accountId }),
    requestStream: (path, options) =>
      suppliedClient.requestStream(path, { ...options, expectedAccountId: accountId }),
    getAccountId: async () => {
      await suppliedClient.assertAccount?.(accountId);
      return accountId;
    },
    assertAccount: async (expected) => {
      if (expected !== accountId) throw new Error('The saved-version request changed accounts.');
      await suppliedClient.assertAccount?.(accountId);
    },
  };
  const projects = createWorkspaceSyncProjectsClient(client);
  const seenHashes = new Set<string>();
  let beforeVersionNumber: number | undefined;
  do {
    const history = await listWorkspaceSyncHistory(
      homeWorkspaceId,
      { limit: 50, ...(beforeVersionNumber === undefined ? {} : { beforeVersionNumber }) },
      client
    );
    for (const version of history.versions) {
      let content: Uint8Array;
      if (version.representation === 'manifest_v1') {
        const detail = await projects.downloadManifestVersion!(homeWorkspaceId, version.id);
        if (detail.version.contentSha256 !== version.contentSha256)
          throw new Error('The saved project version changed while its manifest was read.');
        const file = detail.manifest.files.find((entry) => entry.path === relativePath);
        if (!file || seenHashes.has(file.contentSha256)) continue;
        const response = await projects.downloadManifestFile!(homeWorkspaceId, version.id, file);
        if (!response.ok || !response.body)
          throw new Error('The saved primer download did not return its complete file.');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let count = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            count += part.value.byteLength;
            if (count > file.sizeBytes)
              throw new Error('The saved primer exceeds its authenticated file length.');
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        content = Buffer.concat(chunks);
        if (count !== file.sizeBytes || hash(content) !== file.contentSha256)
          throw new Error('The saved primer failed its authenticated file digest or length check.');
        seenHashes.add(file.contentSha256);
      } else {
        const detail = await projects.downloadVersion!(homeWorkspaceId, version.id);
        if (detail.version.contentSha256 !== version.contentSha256)
          throw new Error('The saved project version changed while its bundle was read.');
        const bundle = assertValidDesktopSyncLatestBundle(detail);
        const file = bundle.files.find((entry) => entry.relativePath === relativePath);
        if (!file || seenHashes.has(file.sha256)) continue;
        content = decodeBundleFileContent(file);
        if (content.byteLength !== file.sizeBytes || hash(content) !== file.sha256)
          throw new Error(
            'The saved primer failed its authenticated bundle digest or length check.'
          );
        seenHashes.add(file.sha256);
      }
      await client.assertAccount?.(accountId);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      if (!matchesOrganizationSavedPrimer(text, review)) continue;
      const snapshot: OrganizationSavedPrimerSnapshot = {
        schema: 'dnaforge.organization-saved-primer.v1',
        accountId,
        orgId: review.scope.orgId,
        entityId,
        homeWorkspaceId,
        schemaRevisionId,
        organizationRevision: canonical.revision,
        projectVersionId: version.id,
        projectVersionSha256: version.contentSha256,
        relativePath,
        contentSha256: hash(content),
        content: text,
      };
      assertOrganizationSavedPrimerSnapshot(snapshot, review);
      return snapshot;
    }
    beforeVersionNumber = history.nextBeforeVersionNumber ?? undefined;
  } while (beforeVersionNumber !== undefined);
  throw unavailable();
}
