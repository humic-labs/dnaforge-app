import {
  mergeWorkspaceSessionFiles,
  type WorkspaceSessionAdapter,
  type WorkspaceSessionFile,
  type WorkspaceSessionSnapshot,
  type WorkspaceSessionWorkspace,
} from '@waypoint/domain-services';
import { platform, type PlatformBridge } from '../../platform';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  nativeWorkspaceEntityPrimaryFile,
  parseNativeWorkspaceManifest,
} from '../../shared/native-workspace-manifest';
import type { ManagedHeadFile } from '../../shared/workspace-git-types';
import {
  HOSTED_RESOURCE_BINDINGS_PATH,
  parseHostedResourceBindings,
} from '../../shared/hosted-resource-bindings';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { readAcceptedScientificFile } from '../../services/read-accepted-scientific-file';
import { isDeveloperImportSourcePath } from '../../shared/developer-import-sources';

const PROTECTED_TOP_LEVEL = new Set(['.git', '.dnaforge', '.forge', '.waypoint']);

export interface ElectronWorkspaceRuntimeDependencies {
  listRoots(): readonly { path: string; name: string }[];
  createRoot(displayName: string): Promise<{ path: string; name: string }>;
  indexHead(
    rootPath: string,
    preserveRelPaths: readonly string[]
  ): Promise<{
    headCommit: string | null;
    files: readonly ManagedHeadFile[];
  }>;
  readFileBounded(path: string, maxBytes: number): Promise<Uint8Array>;
  readAcceptedFile?(
    rootPath: string,
    relativePath: string,
    maxBytes: number
  ): Promise<{ bytes: Uint8Array; resourceId: string } | null>;
  readTextFile(path: string): Promise<string>;
  fileExists(path: string): Promise<boolean>;
  beginMutation(rootPath: string): Promise<string>;
  endMutation(token: string): Promise<void>;
  writeTextFileAtomic(input: {
    workspaceRoot: string;
    path: string;
    content: string;
    mode: 'create' | 'replace';
    expectedContentHash?: string;
    mutationToken: string;
    artifactNoun: string;
  }): Promise<{ path: string; contentHash: string }>;
}

export function createElectronWorkspaceRuntime(
  dependencies: ElectronWorkspaceRuntimeDependencies = defaultDependencies()
): WorkspaceSessionAdapter {
  return {
    descriptor: {
      kind: 'electron',
      authority: 'local-working-copy',

      identityFidelity: 'path-placement-only',
      capabilities: {
        createWorkspace: true,
        multiFile: true,
        write: true,
        rename: false,
        move: false,
        delete: false,
        watch: false,
        history: false,
        restore: false,
      },
    },

    async listWorkspaces() {
      return {
        workspaces: dependencies.listRoots().map(toWorkspace),
      };
    },

    async createWorkspace(displayName) {
      const root = await dependencies.createRoot(displayName);
      return toWorkspace(root);
    },

    async loadWorkspace(workspace) {
      return loadElectronSnapshot(dependencies, workspace);
    },

    async readFile({ snapshot, file }) {
      const maxBytes = Math.max(1, file.sizeBytes);
      const accepted = await dependencies.readAcceptedFile?.(
        snapshot.workspaceId,
        file.path,
        maxBytes
      );
      if (accepted && file.resourceId && accepted.resourceId !== file.resourceId)
        throw new Error(
          `Accepted project file identity changed before it could be opened: ${file.path}.`
        );
      const bytes =
        accepted?.bytes ??
        (await dependencies.readFileBounded(
          joinWorkspacePath(snapshot.workspaceId, file.path),
          maxBytes
        ));
      if (bytes.byteLength !== file.sizeBytes) {
        throw new Error(`Local file size changed before it could be opened: ${file.path}.`);
      }
      const revision = `git-blob:${await gitBlobOid(bytes)}`;
      if (revision !== file.contentRevision) {
        throw new Error(`Local file changed before it could be opened: ${file.path}.`);
      }
      return bytes;
    },

    async commit({ snapshot, writes, onProgress }) {
      if (writes.length === 0) throw new Error('At least one file write is required.');
      const rootPath = snapshot.workspaceId;
      const current = await loadElectronSnapshot(dependencies, workspaceFromSnapshot(snapshot));
      if (current.revisionId !== snapshot.revisionId) {
        throw new Error('LOCAL_WORKSPACE_CONFLICT: files changed after this project was opened.');
      }

      const pending = await Promise.all(
        writes.map(async (write) => ({
          ...write,
          contentSha256: await sha256Hex(write.bytes),
          sizeBytes: write.bytes.byteLength,
        }))
      );
      mergeWorkspaceSessionFiles(
        snapshot.files,
        pending.map(({ resourceId, path, contentSha256, sizeBytes, contentType }) => ({
          resourceId,
          path,
          contentRevision: `sha256:${contentSha256}`,
          contentSha256,
          sizeBytes,
          contentType,
        }))
      );

      const totalBytes = pending.reduce((total, write) => total + write.sizeBytes, 0);
      const expectedHashes = new Map<string, string>();
      for (const write of pending) {
        const existing = snapshot.files.find((file) => file.path === write.path);
        if (!existing) continue;
        const currentBytes = await dependencies.readFileBounded(
          joinWorkspacePath(rootPath, write.path),
          Math.max(1, existing.sizeBytes)
        );
        if (
          currentBytes.byteLength !== existing.sizeBytes ||
          `git-blob:${await gitBlobOid(currentBytes)}` !== existing.contentRevision
        ) {
          throw new Error(`LOCAL_WORKSPACE_CONFLICT: ${write.path} changed after it was opened.`);
        }
        expectedHashes.set(write.path, await sha256Hex(currentBytes));
      }
      let sentBytes = 0;
      const token = await dependencies.beginMutation(rootPath);
      try {
        for (const write of pending) {
          const existing = snapshot.files.find((file) => file.path === write.path);
          const content = decodeTextWrite(write.bytes, write.contentType, write.path);
          const expectedContentHash = expectedHashes.get(write.path);
          await dependencies.writeTextFileAtomic({
            workspaceRoot: rootPath,
            path: joinWorkspacePath(rootPath, write.path),
            content,
            mode: existing ? 'replace' : 'create',
            ...(expectedContentHash ? { expectedContentHash } : {}),
            mutationToken: token,
            artifactNoun: 'workspace file',
          });
          sentBytes += write.sizeBytes;
          onProgress?.(sentBytes, totalBytes);
        }
      } finally {
        await dependencies.endMutation(token);
      }
      return loadElectronSnapshot(dependencies, workspaceFromSnapshot(snapshot));
    },
  };
}

async function loadElectronSnapshot(
  dependencies: ElectronWorkspaceRuntimeDependencies,
  workspace: WorkspaceSessionWorkspace
): Promise<WorkspaceSessionSnapshot> {
  const rootPath = workspace.workspaceId;
  const resourceIds = await loadResourceIds(dependencies, rootPath);

  const head = await dependencies.indexHead(rootPath, [...resourceIds.keys()]);

  const visible = head.files.filter((file) => {
    const path = normalizeRelativePath(file.relPath);
    return isVisiblePath(path) || resourceIds.has(path);
  });
  const files = await Promise.all(
    visible.map((file): WorkspaceSessionFile => {
      const path = normalizeRelativePath(file.relPath);
      return {
        resourceId: resourceIds.get(path) ?? null,
        path,
        contentRevision: `git-blob:${normalizeGitOid(file.oid)}`,
        contentSha256: null,
        sizeBytes: file.sizeBytes,
        contentType: contentTypeForPath(path),
      };
    })
  );
  const sorted = mergeWorkspaceSessionFiles([], files);
  return {
    workspaceId: rootPath,
    revisionId: await snapshotFingerprint(head.headCommit, sorted),
    revisionNumber: 0,
    files: sorted,
  };
}

async function loadResourceIds(
  dependencies: ElectronWorkspaceRuntimeDependencies,
  rootPath: string
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const manifestPath = joinWorkspacePath(rootPath, NATIVE_WORKSPACE_MANIFEST_PATH);
  if (await dependencies.fileExists(manifestPath)) {
    const manifest = parseNativeWorkspaceManifest(await dependencies.readTextFile(manifestPath));
    for (const entity of manifest.entities) {
      const primaryPath = nativeWorkspaceEntityPrimaryFile(entity);
      if (primaryPath) ids.set(normalizeRelativePath(primaryPath), entity.id);
    }
  }
  const hostedBindingsPath = joinWorkspacePath(rootPath, HOSTED_RESOURCE_BINDINGS_PATH);
  if (await dependencies.fileExists(hostedBindingsPath)) {
    const bindings = parseHostedResourceBindings(
      await dependencies.readTextFile(hostedBindingsPath)
    );
    for (const resource of bindings.resources) {
      const path = normalizeRelativePath(resource.path);
      const existing = ids.get(path);
      if (existing && existing !== resource.resourceId) {
        throw new Error(`Workspace resource identity conflicts at ${path}.`);
      }
      ids.set(path, resource.resourceId);
    }
  }
  return ids;
}

function defaultDependencies(): ElectronWorkspaceRuntimeDependencies {
  const currentPlatform = (): PlatformBridge => platform();
  return {
    listRoots: () =>
      useWorkspaceStore
        .getState()
        .folders.filter((folder) => !isDeveloperImportSourcePath(folder.path))
        .map(({ path, name }) => ({ path, name })),
    createRoot: async (displayName) => {
      const created = await currentPlatform().workspace.createEmptyWorkspace({ name: displayName });
      useWorkspaceStore.getState().addFolder(created.rootPath, created.displayName);
      return { path: created.rootPath, name: created.displayName };
    },
    indexHead: async (rootPath, preserveRelPaths) =>
      currentPlatform().workspace.indexManagedCatalogHead({
        repoPath: rootPath,
        preserveRelPaths: [...preserveRelPaths],
        healWorkingTree: false,
      }),
    readFileBounded: (path, maxBytes) => currentPlatform().fs.readFileBounded(path, maxBytes),
    readAcceptedFile: readAcceptedScientificFile,
    readTextFile: (path) => currentPlatform().fs.readTextFile(path),
    fileExists: (path) => currentPlatform().fs.exists(path),
    beginMutation: (rootPath) => currentPlatform().fs.beginWorkspaceMutation(rootPath),
    endMutation: (token) => currentPlatform().fs.endWorkspaceMutation(token),
    writeTextFileAtomic: (input) => currentPlatform().fs.writeWorkspaceTextFileAtomic(input),
  };
}

function toWorkspace(root: { path: string; name: string }): WorkspaceSessionWorkspace {
  return {
    workspaceId: root.path,
    displayName: root.name,
    latestRevisionId: null,
    latestRevisionNumber: 0,
    metadata: { localPath: root.path },
  };
}

function workspaceFromSnapshot(snapshot: WorkspaceSessionSnapshot): WorkspaceSessionWorkspace {
  return {
    workspaceId: snapshot.workspaceId,
    displayName: snapshot.workspaceId.split('/').filter(Boolean).pop() ?? snapshot.workspaceId,
    latestRevisionId: snapshot.revisionId,
    latestRevisionNumber: snapshot.revisionNumber,
  };
}

function joinWorkspacePath(rootPath: string, relativePath: string): string {
  return `${rootPath.replace(/[\\/]+$/u, '')}/${normalizeRelativePath(relativePath)}`;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function isVisiblePath(path: string): boolean {
  const normalized = normalizeRelativePath(path);
  const topLevel = normalized.split('/')[0]?.toLocaleLowerCase('en-US');
  return Boolean(topLevel) && !PROTECTED_TOP_LEVEL.has(topLevel);
}

function normalizeGitOid(value: string): string {
  const normalized = value.toLocaleLowerCase('en-US');
  if (!/^[a-f0-9]{40}$/u.test(normalized)) throw new Error('Local Git blob ID was invalid.');
  return normalized;
}

function contentTypeForPath(path: string): string {
  if (/\.(?:gb|gbk|gbff|genbank)$/iu.test(path)) return 'application/genbank';
  if (/\.(?:fa|fna|fas|fasta)$/iu.test(path)) return 'text/fasta';
  if (/\.json$/iu.test(path)) return 'application/json';
  if (/\.(?:md|markdown)$/iu.test(path)) return 'text/markdown';
  if (/\.(?:txt|csv|tsv)$/iu.test(path)) return 'text/plain';
  return 'application/octet-stream';
}

function decodeTextWrite(bytes: Uint8Array, contentType: string, path: string): string {
  if (
    !contentType.startsWith('text/') &&
    contentType !== 'application/json' &&
    contentType !== 'application/genbank'
  ) {
    throw new Error(`Atomic replacement for binary local files is not supported yet: ${path}.`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Local text file is not valid UTF-8: ${path}.`);
  }
}

async function snapshotFingerprint(
  headCommit: string | null,
  files: readonly WorkspaceSessionFile[]
): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        headCommit,
        files: files.map(
          ({ resourceId, path, contentRevision, contentSha256, sizeBytes, contentType }) => ({
            resourceId,
            path,
            contentRevision,
            contentSha256,
            sizeBytes,
            contentType,
          })
        ),
      })
    )
  );
}

async function gitBlobOid(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const framed = new Uint8Array(header.byteLength + bytes.byteLength);
  framed.set(header);
  framed.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest('SHA-1', framed);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
