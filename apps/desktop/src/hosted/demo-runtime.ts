import { mergeWorkspaceSessionFiles } from '@waypoint/domain-services';
import { workspaceSyncManifestHashInput } from '@waypoint/share-bundle/protocol';
import {
  HostedWorkspaceApiError,
  requireHostedMutationAccountId,
  sha256Hex,
  type HostedManifestDetail,
  type HostedManifestFile,
  type HostedWorkspaceHistory,
  type HostedWorkspaceIndex,
  type HostedWorkspacePublishResult,
} from './api';
import { DEMO_SESSIONS_DIRECTORY, type DemoStore } from './demo-store';
import type { HostedWorkspaceRuntimeDependencies } from './runtime';

interface DemoVersionRecord {
  id: string;
  versionNumber: number;
  contentSha256: string;
  createdAt: string;
  publishKey: string;
  files: HostedManifestFile[];
}

interface DemoWorkspaceRecord {
  workspaceId: string;
  clientWorkspaceId: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  versions: { id: string; versionNumber: number }[];
}

interface DemoIndexRecord {
  schemaVersion: 1;
  workspaces: DemoWorkspaceRecord[];
}

export interface DemoSessionRuntime extends HostedWorkspaceRuntimeDependencies {
  readonly accountId: string;
  readonly sessionId: string;
  readBlob(contentSha256: string): Promise<Uint8Array>;
  latestFiles(workspaceId: string): Promise<HostedManifestFile[]>;
  listWorkspaces(): Promise<DemoWorkspaceRecord[]>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function demoAccountId(sessionId: string): string {
  return `demo-session:${sessionId}`;
}

export function createDemoSessionRuntime(args: {
  store: DemoStore;
  sessionId: string;
  now?: () => Date;
  newId?: () => string;
}): DemoSessionRuntime {
  const { store, sessionId } = args;
  const now = args.now ?? (() => new Date());
  const newId = args.newId ?? (() => crypto.randomUUID());
  const accountId = demoAccountId(sessionId);
  const root = [DEMO_SESSIONS_DIRECTORY, sessionId];
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  const readJson = async <T>(path: readonly string[]): Promise<T | null> => {
    const bytes = await store.read([...root, ...path]);
    return bytes ? (JSON.parse(decoder.decode(bytes)) as T) : null;
  };
  const writeJson = (path: readonly string[], value: unknown) =>
    store.write([...root, ...path], encoder.encode(JSON.stringify(value)));
  const readIndex = async (): Promise<DemoIndexRecord> =>
    (await readJson<DemoIndexRecord>(['index.json'])) ?? { schemaVersion: 1, workspaces: [] };
  const requireAccount = (expected?: string) => {
    if (expected !== undefined && expected !== accountId) {
      throw new HostedWorkspaceApiError(409, 'account_changed', 'The demo session changed.');
    }
  };
  const requireWorkspace = (index: DemoIndexRecord, workspaceId: string) => {
    const workspace = index.workspaces.find((entry) => entry.workspaceId === workspaceId);
    if (!workspace) throw new HostedWorkspaceApiError(404, 'NOT_FOUND', 'Project not found.');
    return workspace;
  };
  const readVersion = async (workspaceId: string, versionNumber: number) => {
    const version = await readJson<DemoVersionRecord>([
      'versions',
      workspaceId,
      `${versionNumber}.json`,
    ]);
    if (!version) throw new HostedWorkspaceApiError(404, 'NOT_FOUND', 'Version not found.');
    return version;
  };
  const versionById = async (workspace: DemoWorkspaceRecord, versionId: string) => {
    const entry = workspace.versions.find((candidate) => candidate.id === versionId);
    if (!entry) throw new HostedWorkspaceApiError(404, 'NOT_FOUND', 'Version not found.');
    return readVersion(workspace.workspaceId, entry.versionNumber);
  };
  const latestVersion = async (workspace: DemoWorkspaceRecord) => {
    const latest = workspace.versions[workspace.versions.length - 1];
    return latest ? readVersion(workspace.workspaceId, latest.versionNumber) : null;
  };
  const manifestSha256 = (files: readonly HostedManifestFile[]) =>
    sha256Hex(encoder.encode(workspaceSyncManifestHashInput({ schemaVersion: 1, files })));
  const readBlob = async (contentSha256: string) => {
    const bytes = await store.read([...root, 'blobs', contentSha256]);
    if (!bytes || (await sha256Hex(bytes)) !== contentSha256) {
      throw new HostedWorkspaceApiError(404, 'NOT_FOUND', 'File content is unavailable.');
    }
    return bytes;
  };

  const publish = (input: {
    workspaceId: string;
    baseVersionId: string | null;
    files: readonly HostedManifestFile[];
    scope: string;
    blobs?: readonly { contentSha256: string; bytes: Uint8Array }[];
  }) =>
    exclusive(async (): Promise<HostedWorkspacePublishResult> => {
      const index = await readIndex();
      const workspace = requireWorkspace(index, input.workspaceId);
      const latest = await latestVersion(workspace);
      const fingerprint = await sha256Hex(
        encoder.encode(
          JSON.stringify(
            input.files.map(({ path, resourceId, contentSha256 }) => [
              path,
              resourceId,
              contentSha256,
            ])
          )
        )
      );
      const publishKey = [input.baseVersionId ?? 'initial', input.scope, fingerprint].join(':');
      for (const entry of [...workspace.versions].reverse()) {
        const prior = await readVersion(workspace.workspaceId, entry.versionNumber);
        if (prior.publishKey === publishKey) return toPublishResult(prior);
      }
      if ((latest?.id ?? null) !== input.baseVersionId) {
        throw new HostedWorkspaceApiError(
          409,
          'SYNC_CONFLICT',
          'This project changed in another tab. Reload to see the latest version.'
        );
      }
      const resourceIds = new Map(
        (latest?.files ?? []).map((file) => [file.path, file.resourceId])
      );
      const files = input.files.map((file) => ({
        resourceId: file.resourceId ?? resourceIds.get(file.path) ?? newId(),
        path: file.path,
        contentSha256: file.contentSha256,
        sizeBytes: file.sizeBytes,
        contentType: file.contentType,
      }));
      for (const blob of input.blobs ?? []) {
        if (!(await store.read([...root, 'blobs', blob.contentSha256]))) {
          await store.write([...root, 'blobs', blob.contentSha256], blob.bytes);
        }
      }
      for (const file of files) await readBlob(file.contentSha256);
      const contentSha256 = await manifestSha256(files);
      if (latest && latest.contentSha256 === contentSha256) return toPublishResult(latest);
      const version: DemoVersionRecord = {
        id: newId(),
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        contentSha256,
        createdAt: now().toISOString(),
        publishKey,
        files,
      };
      await writeJson(
        ['versions', workspace.workspaceId, `${version.versionNumber}.json`],
        version
      );
      workspace.versions.push({ id: version.id, versionNumber: version.versionNumber });
      workspace.updatedAt = version.createdAt;
      await writeJson(['index.json'], index);
      return toPublishResult(version);
    });

  return {
    accountId,
    sessionId,
    readBlob,
    async latestFiles(workspaceId) {
      const workspace = requireWorkspace(await readIndex(), workspaceId);
      return (await latestVersion(workspace))?.files ?? [];
    },
    async listWorkspaces() {
      return (await readIndex()).workspaces;
    },

    async loadIndex(expectedAccountId): Promise<HostedWorkspaceIndex> {
      requireAccount(expectedAccountId);
      const index = await readIndex();
      return {
        account: { id: accountId, email: '', displayName: 'Demo visitor' },
        workspaces: await Promise.all(
          index.workspaces.map(async (workspace) => {
            const latest = await latestVersion(workspace);
            return {
              workspaceId: workspace.workspaceId,
              clientWorkspaceId: workspace.clientWorkspaceId,
              displayName: workspace.displayName,
              ownerDisplayName: 'You',
              access: { role: 'owner' as const },
              latest: {
                versionId: latest?.id ?? null,
                versionNumber: latest?.versionNumber ?? 0,
                contentSha256: latest?.contentSha256 ?? null,
              },
              storageBytesUsed: (latest?.files ?? []).reduce(
                (sum, file) => sum + file.sizeBytes,
                0
              ),
              versionCount: workspace.versions.length,
              updatedAt: workspace.updatedAt,
            };
          })
        ),
      };
    },

    createWorkspace(displayName, expectedAccountId) {
      requireAccount(expectedAccountId);
      return exclusive(async () => {
        const index = await readIndex();
        const createdAt = now().toISOString();
        const workspace: DemoWorkspaceRecord = {
          workspaceId: newId(),
          clientWorkspaceId: newId(),
          displayName: displayName.trim().slice(0, 160) || 'Untitled project',
          createdAt,
          updatedAt: createdAt,
          versions: [],
        };
        index.workspaces.push(workspace);
        await writeJson(['index.json'], index);
        return { workspaceId: workspace.workspaceId };
      });
    },

    async loadManifest(workspaceId, versionId, expectedAccountId): Promise<HostedManifestDetail> {
      requireAccount(expectedAccountId);
      const version = await versionById(
        requireWorkspace(await readIndex(), workspaceId),
        versionId
      );
      return {
        workspaceId,
        version: {
          id: version.id,
          versionNumber: version.versionNumber,
          contentSha256: version.contentSha256,
          createdAt: version.createdAt,
        },
        manifest: { schemaVersion: 1, files: version.files.map((file) => ({ ...file })) },
        resourceIdentities: version.files.map((file) => ({
          path: file.path,
          resourceId: file.resourceId!,
        })),
      };
    },

    async loadHistory(workspaceId): Promise<HostedWorkspaceHistory> {
      const workspace = requireWorkspace(await readIndex(), workspaceId);
      const versions = await Promise.all(
        [...workspace.versions]
          .reverse()
          .map((entry) => readVersion(workspaceId, entry.versionNumber))
      );
      return {
        workspaceId,
        versions: versions.map((version) => ({
          id: version.id,
          versionNumber: version.versionNumber,
          representation: 'manifest_v1' as const,
          manifestSchemaVersion: 1,
          contentSha256: version.contentSha256,
          sizeBytes: version.files.reduce((sum, file) => sum + file.sizeBytes, 0),
          fileCount: version.files.length,
          createdAt: version.createdAt,
          finalizedAt: version.createdAt,
          createdBy: { accountId, email: null, displayName: 'You' },
        })),
        nextBeforeVersionNumber: null,
      };
    },

    async downloadFile({ workspaceId, versionId, file }) {
      const version = await versionById(
        requireWorkspace(await readIndex(), workspaceId),
        versionId
      );
      const accepted = version.files.find((candidate) => candidate.path === file.path);
      if (!accepted || accepted.contentSha256 !== file.contentSha256) {
        throw new HostedWorkspaceApiError(404, 'NOT_FOUND', 'File not found in this version.');
      }
      return readBlob(accepted.contentSha256);
    },

    async publishFiles(input) {
      requireAccount(requireHostedMutationAccountId(input.expectedAccountId));
      if (input.files.length === 0 && (input.removePaths?.length ?? 0) === 0) {
        throw new HostedWorkspaceApiError(400, 'BAD_REQUEST', 'At least one file is required.');
      }
      const blobs = await Promise.all(
        input.files.map(async (file) => ({
          ...file,
          contentSha256: await sha256Hex(file.bytes),
          sizeBytes: file.bytes.byteLength,
        }))
      );
      input.onProgress?.(
        0,
        blobs.reduce((sum, file) => sum + file.sizeBytes, 0)
      );
      const files = mergeWorkspaceSessionFiles(
        input.baseFiles.map((file) => ({
          resourceId: null,
          ...file,
          contentRevision: `sha256:${file.contentSha256}`,
        })),
        blobs.map((file) => ({
          ...(file.resourceId !== undefined ? { resourceId: file.resourceId } : {}),
          path: file.path,
          contentRevision: `sha256:${file.contentSha256}`,
          contentSha256: file.contentSha256,
          sizeBytes: file.sizeBytes,
          contentType: file.contentType,
        })),
        { removePaths: input.removePaths }
      ).map(({ resourceId, path, contentSha256, sizeBytes, contentType }) => ({
        ...(resourceId ? { resourceId } : {}),
        path,
        contentSha256: contentSha256!,
        sizeBytes,
        contentType,
      }));
      const result = await publish({
        workspaceId: input.workspaceId,
        baseVersionId: input.baseVersionId,
        files,
        scope: input.operationId ?? 'commit',
        blobs: blobs.map(({ contentSha256, bytes }) => ({ contentSha256, bytes })),
      });
      const total = blobs.reduce((sum, file) => sum + file.sizeBytes, 0);
      input.onProgress?.(total, total);
      return result;
    },

    async restoreVersion({ workspaceId, baseVersionId, revisionId, expectedAccountId }) {
      requireAccount(requireHostedMutationAccountId(expectedAccountId));
      const workspace = requireWorkspace(await readIndex(), workspaceId);
      const historical = await versionById(workspace, revisionId);
      return publish({
        workspaceId,
        baseVersionId,
        files: historical.files,
        scope: `restore:${revisionId}`,
      });
    },
  };
}

function toPublishResult(version: DemoVersionRecord): HostedWorkspacePublishResult {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    contentSha256: version.contentSha256,
    files: version.files.map((file) => ({ ...file })),
  };
}
