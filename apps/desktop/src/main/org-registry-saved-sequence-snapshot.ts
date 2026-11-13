import { createHash } from 'node:crypto';
import { decodeBundleFileContent } from '@waypoint/share-bundle';
import {
  parseSequencePackageDocument,
  sequencePackageRootForMetaPath,
} from '../db/sequence-package';
import { createDesktopSyncClient, type DesktopSyncClient } from './desktop-sync-client';
import { listWorkspaceSyncHistory } from './workspace-sync-history';
import { createWorkspaceSyncProjectsClient } from './workspace-sync-projects';
import { assertValidDesktopSyncLatestBundle } from './workspace-sync-bundle-integrity';
import {
  assertOrganizationSavedSequenceSnapshot,
  savedSequenceRequiredFiles,
  savedSequenceUnavailable,
  type OrganizationSavedSequenceSnapshot,
  type SavedSequenceReview,
} from './org-registry-saved-sequence-snapshot-contract';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export async function readOrganizationSavedSequenceSnapshot(
  review: SavedSequenceReview,
  suppliedClient: DesktopSyncClient = createDesktopSyncClient()
): Promise<OrganizationSavedSequenceSnapshot> {
  const canonical = review.canonical;
  const fields = canonical.fields;
  const association = record(fields) ? fields._managedSequenceSnapshot : null;
  if (
    review.binding.authority !== 'sequence_package' ||
    !record(fields) ||
    fields._managedSequenceProjectionVersion !== 3 ||
    !record(association) ||
    association.version !== 1 ||
    typeof association.markerSha256 !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(association.markerSha256) ||
    typeof canonical.id !== 'string' ||
    typeof canonical.homeWorkspaceId !== 'string' ||
    typeof canonical.schemaRevisionId !== 'string'
  )
    throw savedSequenceUnavailable();
  const markerSha256 = association.markerSha256.slice(7);
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
      if (expected !== accountId) throw new Error('The saved sequence request changed accounts.');
      await suppliedClient.assertAccount?.(accountId);
    },
  };
  const home = canonical.homeWorkspaceId;
  const projects = createWorkspaceSyncProjectsClient(client);
  let beforeVersionNumber: number | undefined;
  do {
    const history = await listWorkspaceSyncHistory(
      home,
      { limit: 50, ...(beforeVersionNumber === undefined ? {} : { beforeVersionNumber }) },
      client
    );
    for (const version of history.versions) {
      type SourceFile = {
        path: string;
        sha256: string;
        sizeBytes: number;
        read(): Promise<Uint8Array>;
      };
      let files: SourceFile[];
      if (version.representation === 'manifest_v1') {
        const detail = await projects.downloadManifestVersion!(home, version.id);
        if (detail.version.contentSha256 !== version.contentSha256)
          throw new Error('The saved project manifest changed.');
        files = detail.manifest.files.map((file) => ({
          path: file.path,
          sha256: file.contentSha256,
          sizeBytes: file.sizeBytes,
          read: async () => {
            const response = await projects.downloadManifestFile!(home, version.id, file);
            if (!response.ok || !response.body)
              throw new Error('The saved sequence member download is incomplete.');
            const reader = response.body.getReader(),
              chunks: Uint8Array[] = [];
            let count = 0;
            try {
              for (;;) {
                const part = await reader.read();
                if (part.done) break;
                count += part.value.byteLength;
                if (count > file.sizeBytes)
                  throw new Error('The saved sequence member exceeds its authenticated length.');
                chunks.push(part.value);
              }
            } finally {
              await reader.cancel();
              reader.releaseLock();
            }
            return Buffer.concat(chunks);
          },
        }));
      } else {
        const detail = await projects.downloadVersion!(home, version.id);
        if (detail.version.contentSha256 !== version.contentSha256)
          throw new Error('The saved project bundle changed.');
        files = assertValidDesktopSyncLatestBundle(detail).files.map((file) => ({
          path: file.relativePath,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
          read: async () => decodeBundleFileContent(file),
        }));
      }
      const read = async (file: SourceFile) => {
        const bytes = await file.read();
        await client.assertAccount?.(accountId);
        if (bytes.byteLength !== file.sizeBytes || hash(bytes) !== file.sha256)
          throw new Error(
            'The saved sequence failed its authenticated file digest or length check.'
          );
        return bytes;
      };
      const markers = files.filter(
        (file) => file.sha256 === markerSha256 && sequencePackageRootForMetaPath(file.path)
      );
      if (markers.length > 1)
        throw savedSequenceUnavailable(
          'The saved sequence identity appears in multiple packages in its home version.'
        );
      if (!markers.length) continue;
      const marker = markers[0];
      const markerContent = new TextDecoder('utf-8', { fatal: true }).decode(await read(marker));
      const document = parseSequencePackageDocument(markerContent);
      const root = sequencePackageRootForMetaPath(marker.path)!;
      const required = savedSequenceRequiredFiles(document);
      const selected = [...required].map(([path, digest]) => ({
        path,
        file: files.find((file) => file.path === `${root}/${path}` && file.sha256 === digest),
      }));
      if (selected.some((item) => !item.file)) continue;
      let productContent: string | undefined;
      const members: OrganizationSavedSequenceSnapshot['members'] = [];
      for (const { path, file } of selected) {
        const bytes = await read(file!);
        if (path === document.product.file)
          productContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        else
          members.push({
            path,
            contentSha256: file!.sha256,
            contentBase64: Buffer.from(bytes).toString('base64'),
          });
      }
      if (productContent === undefined) throw savedSequenceUnavailable();
      const snapshot: OrganizationSavedSequenceSnapshot = {
        schema: 'dnaforge.organization-saved-sequence.v1',
        accountId,
        orgId: review.scope.orgId,
        entityId: canonical.id,
        homeWorkspaceId: home,
        schemaRevisionId: canonical.schemaRevisionId,
        organizationRevision: canonical.revision,
        projectVersionId: version.id,
        projectVersionSha256: version.contentSha256,
        markerRelativePath: marker.path,
        markerContent,
        markerSha256,
        productContent,
        productSha256: required.get(document.product.file)!,
        members,
      };
      return assertOrganizationSavedSequenceSnapshot(snapshot, review);
    }
    beforeVersionNumber = history.nextBeforeVersionNumber ?? undefined;
  } while (beforeVersionNumber !== undefined);
  throw savedSequenceUnavailable();
}
