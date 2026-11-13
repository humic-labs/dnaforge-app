import type {
  WorkspaceSessionAdapter,
  WorkspaceSessionPublicationCondition,
  WorkspaceSessionFile,
  WorkspaceSessionSnapshot,
  WorkspaceSessionWorkspace,
} from '@waypoint/domain-services';
import { workspaceSyncManifestHashInput } from '@waypoint/share-bundle/protocol';
import {
  createHostedWorkspace,
  downloadHostedFile,
  loadHostedManifest,
  loadHostedWorkspaceHistory,
  loadHostedWorkspaceIndex,
  publishHostedWorkspaceFiles,
  restoreHostedWorkspaceVersion,
  requireHostedMutationAccountId,
  sha256Hex,
  HostedWorkspaceApiError,
  type HostedManifestFile,
  type HostedWorkspaceIndex,
  type HostedWorkspacePublishResult,
} from './api';
import { retainHostedRecoveryCandidate } from './recovery-api';

export interface HostedWorkspaceRuntimeDependencies {
  loadIndex(expectedAccountId?: string): Promise<HostedWorkspaceIndex>;
  createWorkspace(
    displayName: string,
    expectedAccountId?: string
  ): Promise<{ workspaceId: string }>;
  loadManifest: typeof loadHostedManifest;
  loadHistory: typeof loadHostedWorkspaceHistory;
  downloadFile: typeof downloadHostedFile;
  publishFiles(
    input: {
      workspaceId: string;
      baseVersionId: string | null;
      baseFiles: readonly HostedManifestFile[];
      files: readonly {
        path: string;
        bytes: Uint8Array;
        contentType: string;
        resourceId?: string | null;
      }[];
      removePaths?: readonly string[];
      onProgress?: (sent: number, total: number) => void;
      expectedAccountId?: string;
      operationId?: string;
      publicationCondition?: WorkspaceSessionPublicationCondition;
    },
    retainedFiles?: readonly HostedManifestFile[]
  ): Promise<HostedWorkspacePublishResult>;
  restoreVersion: typeof restoreHostedWorkspaceVersion;
  retainCandidate?: typeof retainHostedRecoveryCandidate;
}

export const DEFAULT_DEPENDENCIES: HostedWorkspaceRuntimeDependencies = {
  loadIndex: loadHostedWorkspaceIndex,
  createWorkspace: createHostedWorkspace,
  loadManifest: loadHostedManifest,
  loadHistory: loadHostedWorkspaceHistory,
  downloadFile: downloadHostedFile,
  publishFiles: publishHostedWorkspaceFiles,
  restoreVersion: restoreHostedWorkspaceVersion,
  retainCandidate: retainHostedRecoveryCandidate,
};

export function createHostedWorkspaceRuntime(
  dependencies: HostedWorkspaceRuntimeDependencies = DEFAULT_DEPENDENCIES
): WorkspaceSessionAdapter {
  const retainedInputs = new Map<
    string,
    { files: readonly HostedManifestFile[]; expiresAt: number }
  >();
  const inputKey = (accountId: string, snapshot: WorkspaceSessionSnapshot, operationId?: string) =>
    operationId
      ? JSON.stringify([accountId, snapshot.workspaceId, snapshot.revisionId, operationId])
      : null;
  return {
    descriptor: {
      kind: 'hosted-browser',
      authority: 'dnaforge-manifest-revisions',
      identityFidelity: 'stable-resource-id',
      capabilities: {
        createWorkspace: true,
        multiFile: true,
        write: true,
        rename: true,
        move: true,
        delete: true,
        watch: true,
        history: true,
        restore: true,
      },
    },

    async listWorkspaces() {
      const index = await dependencies.loadIndex();
      return {
        principal: {
          id: index.account.id,
          label: index.account.displayName || index.account.email,
          ...(index.account.displayName ? { secondaryLabel: index.account.email } : {}),
        },
        workspaces: index.workspaces.map(toWorkspace),
      };
    },

    async createWorkspace(displayName, expectedAccountId) {
      const accountId = requireHostedMutationAccountId(expectedAccountId);
      const created = await dependencies.createWorkspace(displayName, accountId);
      const index = await dependencies.loadIndex(accountId);
      if (index.account.id !== accountId) {
        throw new HostedWorkspaceApiError(
          409,
          'account_changed',
          'The account changed while creating the project.'
        );
      }
      const workspace = index.workspaces.find(
        (candidate) => candidate.workspaceId === created.workspaceId
      );
      if (!workspace)
        throw new Error('Created project was missing from the hosted workspace index.');
      return toWorkspace(workspace);
    },

    async loadWorkspace(workspace) {
      if (!workspace.latestRevisionId) {
        return {
          workspaceId: workspace.workspaceId,
          revisionId: null,
          revisionNumber: 0,
          files: [],
        };
      }
      const detail = await dependencies.loadManifest(
        workspace.workspaceId,
        workspace.latestRevisionId
      );
      return {
        workspaceId: detail.workspaceId,
        revisionId: detail.version.id,
        revisionNumber: detail.version.versionNumber,
        files: detail.manifest.files.map(toSessionFile),
      };
    },

    async readFile({ snapshot, file }) {
      if (!snapshot.revisionId) throw new Error('Project has no accepted revision.');
      return dependencies.downloadFile({
        workspaceId: snapshot.workspaceId,
        versionId: snapshot.revisionId,
        file: toHostedFile(file),
      });
    },

    async commit({
      snapshot,
      writes,
      removePaths,
      onProgress,
      operationId,
      expectedAccountId,
      publicationCondition,
    }) {
      const accountId = requireHostedMutationAccountId(expectedAccountId);
      const input = {
        workspaceId: snapshot.workspaceId,
        baseVersionId: snapshot.revisionId,
        baseFiles: snapshot.files.map(toHostedFile),
        files: writes.map(({ path, bytes, contentType, resourceId }) => ({
          path,
          bytes,
          contentType,
          ...(resourceId !== undefined ? { resourceId } : {}),
        })),
        removePaths,
        onProgress,
        expectedAccountId: accountId,
        operationId,
        ...(publicationCondition ? { publicationCondition } : {}),
      };
      const key = inputKey(accountId, snapshot, operationId);
      const retained = key ? retainedInputs.get(key) : undefined;
      const accepted =
        retained && retained.expiresAt > Date.now()
          ? await dependencies.publishFiles(input, retained.files)
          : await dependencies.publishFiles(input);
      if (key) retainedInputs.delete(key);
      const confirmed = await snapshotFromPublication(snapshot.workspaceId, accepted);
      if (confirmed) return confirmed;
      const verified = await dependencies.loadManifest(
        snapshot.workspaceId,
        accepted.id,
        accountId
      );
      return {
        workspaceId: snapshot.workspaceId,
        revisionId: verified.version.id,
        revisionNumber: verified.version.versionNumber,
        files: verified.manifest.files.map(toSessionFile),
      };
    },

    ...(dependencies.retainCandidate
      ? {
          async retainRecoveryCandidate({
            snapshot,
            writes,
            removePaths,
            operationId,
            expectedAccountId,
          }: Parameters<NonNullable<WorkspaceSessionAdapter['retainRecoveryCandidate']>>[0]) {
            const accountId = requireHostedMutationAccountId(expectedAccountId);
            let prepared: readonly HostedManifestFile[] | undefined;
            const candidate = await dependencies.retainCandidate!({
              workspaceId: snapshot.workspaceId,
              baseVersionId: snapshot.revisionId,
              baseFiles: snapshot.files.map(toHostedFile),
              files: writes,
              removePaths,
              operationId,
              expectedAccountId: accountId,
              onPrepared: (files) => {
                prepared = files.map((file) => ({ ...file }));
              },
            });
            const key = inputKey(accountId, snapshot, operationId);
            if (key && prepared) {
              retainedInputs.delete(key);
              retainedInputs.set(key, {
                files: prepared,
                expiresAt: Date.parse(candidate.expiresAt),
              });
              while (retainedInputs.size > 8)
                retainedInputs.delete(retainedInputs.keys().next().value!);
            }
            return candidate;
          },
        }
      : {}),

    async listHistory(workspace) {
      const history = await dependencies.loadHistory(workspace.workspaceId);
      return history.versions
        .filter((revision) => revision.representation === 'manifest_v1')
        .map((revision) => ({
          revisionId: revision.id,
          revisionNumber: revision.versionNumber,
          createdAt: revision.createdAt,
          fileCount: revision.fileCount,
          sizeBytes: revision.sizeBytes,
          ...(revision.createdBy
            ? {
                createdByLabel:
                  revision.createdBy.displayName ||
                  revision.createdBy.email ||
                  revision.createdBy.accountId,
              }
            : {}),
        }));
    },

    async restoreRevision({ snapshot, revisionId, expectedAccountId }) {
      const accountId = requireHostedMutationAccountId(expectedAccountId);
      const accepted = await dependencies.restoreVersion({
        workspaceId: snapshot.workspaceId,
        baseVersionId: snapshot.revisionId,
        revisionId,
        expectedAccountId: accountId,
      });
      const verified = await dependencies.loadManifest(
        snapshot.workspaceId,
        accepted.id,
        accountId
      );
      return {
        workspaceId: snapshot.workspaceId,
        revisionId: verified.version.id,
        revisionNumber: verified.version.versionNumber,
        files: verified.manifest.files.map(toSessionFile),
      };
    },
  };
}

async function snapshotFromPublication(
  workspaceId: string,
  accepted: HostedWorkspacePublishResult
): Promise<WorkspaceSessionSnapshot | null> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  if (
    !uuid.test(accepted.id) ||
    !Number.isSafeInteger(accepted.versionNumber) ||
    accepted.versionNumber < 1 ||
    accepted.files.some((file) => !file.resourceId || !uuid.test(file.resourceId)) ||
    new Set(accepted.files.map((file) => file.resourceId)).size !== accepted.files.length ||
    new Set(accepted.files.map((file) => file.path)).size !== accepted.files.length
  )
    return null;
  const manifestSha256 = await sha256Hex(
    new TextEncoder().encode(
      workspaceSyncManifestHashInput({ schemaVersion: 1, files: accepted.files })
    )
  );
  if (manifestSha256 !== accepted.contentSha256) return null;
  return {
    workspaceId,
    revisionId: accepted.id,
    revisionNumber: accepted.versionNumber,
    files: accepted.files.map(toSessionFile),
  };
}

function toWorkspace(
  workspace: HostedWorkspaceIndex['workspaces'][number]
): WorkspaceSessionWorkspace {
  return {
    workspaceId: workspace.workspaceId,
    clientWorkspaceId: workspace.clientWorkspaceId,
    displayName: workspace.displayName,
    latestRevisionId: workspace.latest.versionId,
    latestRevisionNumber: workspace.latest.versionNumber,
    versionCount: workspace.versionCount,
    updatedAt: workspace.updatedAt,
    metadata: {
      role: workspace.access.role,
      ownerDisplayName: workspace.ownerDisplayName,
      storageBytesUsed: workspace.storageBytesUsed,
    },
  };
}

function toSessionFile(file: HostedManifestFile): WorkspaceSessionFile {
  return {
    resourceId: file.resourceId ?? null,
    ...file,
    contentRevision: `sha256:${file.contentSha256}`,
  };
}

function toHostedFile(file: WorkspaceSessionFile): HostedManifestFile {
  if (!file.contentSha256) {
    throw new Error(`Hosted file is missing its SHA-256 integrity claim: ${file.path}.`);
  }
  return {
    ...(file.resourceId ? { resourceId: file.resourceId } : {}),
    path: file.path,
    contentSha256: file.contentSha256,
    sizeBytes: file.sizeBytes,
    contentType: file.contentType,
  };
}

export function emptyHostedSnapshot(workspaceId: string): WorkspaceSessionSnapshot {
  return { workspaceId, revisionId: null, revisionNumber: 0, files: [] };
}
