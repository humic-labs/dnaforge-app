import { open, readFile, readdir, rmdir, lstat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { shell } from 'electron';
import {
  defineBlob,
  parseResourceId,
  parseWorkspacePath,
  parseWorkspaceVersionId,
  listWorkspaceResources,
  type BlobHash,
  type BlobRef,
  type WorkspacePath,
} from '@waypoint/workspace-revisions';
import {
  canonicalWorkspacePath,
  writeWorkspaceBinaryFileAtomicInMain,
} from './primer-artifact-files';
import { syncDirectory } from './fs-durability';
import {
  ScientificObjectStore,
  type ScientificMaterializationFile,
  type ScientificMaterializationManifest,
} from './scientific-object-store';

export type ScientificMaterializationResult =
  | { readonly kind: 'complete'; readonly completedVersions: readonly string[] }
  | {
      readonly kind: 'blocked';
      readonly completedVersions: readonly string[];
      readonly versionId: string;
      readonly error: string;
    };

export async function materializeScientificWorkspace(
  store: ScientificObjectStore,
  options: {
    readonly afterFile?: (path: WorkspacePath) => void;
    readonly beforePublish?: () => void;
  } = {}
): Promise<ScientificMaterializationResult> {
  const completedVersions: string[] = [];
  const root = store.workspaceRoot();
  for (const job of store.pendingMaterializations()) {
    let progress: WorkspacePath[] = [];
    try {
      const manifest = parseManifest(job.manifest_json);
      store.validateMaterialization(job, manifest);
      const persisted: unknown = JSON.parse(job.progress_json);
      if (
        !Array.isArray(persisted) ||
        persisted.some(
          (path) => typeof path !== 'string' || !manifest.files.some((file) => file.path === path)
        )
      )
        throw new Error('Scientific file delivery progress is invalid.');
      progress = persisted as WorkspacePath[];
      const { graph } = store.read();
      const version = parseWorkspaceVersionId(job.version_id);
      const slots = version.ok ? listWorkspaceResources(graph, version.value) : null;
      if (!slots?.ok) throw new Error('Scientific deletion version is unavailable.');
      const tombstones = new Set(
        slots.value.filter((slot) => slot.tombstone).map((slot) => slot.resourceId)
      );
      await deliverTrashFiles(
        root,
        manifest.files.filter((file) => file.blob === null && tombstones.has(file.resourceId)),
        progress,
        async (path) => {
          options.afterFile?.(path);
          progress.push(path);
          store.recordMaterialization(job.version_id, 'pending', progress, null);
        }
      );
      for (const file of manifest.files) {
        if (progress.includes(file.path)) continue;
        const { root: canonicalRoot, candidate } = await canonicalWorkspacePath({
          workspaceRoot: root,
          path: resolve(root, file.path),
          allowMissing: true,
          artifactNoun: 'scientific object',
        });
        const current = await existingHash(candidate);
        if (file.blob === null) {
          if (current !== null) {
            if (current !== file.expectedHash)
              throw new Error(`Unsubmitted working change at ${file.path}`);
            options.beforePublish?.();
            await unlink(candidate);
          }
          await syncExistingParent(candidate);
        } else {
          const bytes = store.readBlob(file.blob);
          if (!bytes) throw new Error(`Scientific blob unavailable: ${file.blob.hash}`);
          if (current === file.blob.hash) {
            options.beforePublish?.();
            await flushExistingFile(canonicalRoot, candidate, bytes, current);
          } else {
            if (current !== file.expectedHash)
              throw new Error(`Unsubmitted working change at ${file.path}`);
            await writeWorkspaceBinaryFileAtomicInMain(
              {
                workspaceRoot: canonicalRoot,
                path: candidate,
                content: bytes,
                artifactNoun: 'scientific object',
              },
              {
                durable: true,
                ...(options.beforePublish ? { beforePublish: options.beforePublish } : {}),
                mode: current === null ? 'create' : 'replace',
                ...(current === null
                  ? {}
                  : { expectedContentHash: current.slice('sha256:'.length) }),
              }
            );
          }
        }

        options.afterFile?.(file.path);
        progress.push(file.path);
        store.recordMaterialization(job.version_id, 'pending', progress, null);
      }

      for (const file of manifest.files)
        if (file.blob === null) await pruneEmptyParents(root, file.path);
      store.recordMaterialization(job.version_id, 'succeeded', progress, null);
      completedVersions.push(job.version_id);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      store.recordMaterialization(job.version_id, 'blocked', progress, error);
      return { kind: 'blocked', completedVersions, versionId: job.version_id, error };
    }
  }
  return { kind: 'complete', completedVersions };
}

async function deliverTrashFiles(
  root: string,
  files: readonly ScientificMaterializationFile[],
  progress: readonly WorkspacePath[],
  completed: (path: WorkspacePath) => Promise<void>
): Promise<void> {
  const pending = new Map<string, ScientificMaterializationFile>();
  let canonicalRoot = root;
  for (const file of files) {
    if (progress.includes(file.path)) continue;
    const canonical = await canonicalWorkspacePath({
      workspaceRoot: root,
      path: resolve(root, file.path),
      allowMissing: true,
    });
    canonicalRoot = canonical.root;
    const current = await existingHash(canonical.candidate);
    if (current !== null && current !== file.expectedHash)
      throw new Error(`Unsubmitted working change at ${file.path}`);
    if (current === null) await completed(file.path);
    else pending.set(canonical.candidate, file);
  }
  const containsOnlyRemovedFiles = async (directory: string): Promise<boolean> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (!(await containsOnlyRemovedFiles(path))) return false;
      } else {
        const file = pending.get(path);
        if (!entry.isFile() || !file || (await existingHash(path)) !== file.expectedHash)
          return false;
      }
    }
    return true;
  };
  while (pending.size) {
    const [path, file] = pending.entries().next().value!;
    let target = path;
    for (let parent = dirname(target); parent !== canonicalRoot; parent = dirname(parent)) {
      if (!(await containsOnlyRemovedFiles(parent))) break;
      target = parent;
    }

    const stat = await lstat(target);
    if (
      stat.isSymbolicLink() ||
      (stat.isDirectory()
        ? !(await containsOnlyRemovedFiles(target))
        : (await existingHash(target)) !== file.expectedHash)
    )
      throw new Error(`Unsubmitted working change at ${file.path}`);
    await shell.trashItem(target);
    await syncExistingParent(target);
    for (const [removedPath, removed] of [...pending]) {
      if (removedPath !== target && !removedPath.startsWith(`${target}/`)) continue;
      pending.delete(removedPath);
      await completed(removed.path);
    }
  }
}

async function pruneEmptyParents(root: string, path: WorkspacePath): Promise<void> {
  const canonical = await canonicalWorkspacePath({
    workspaceRoot: root,
    path: resolve(root, path),
    allowMissing: true,
  });
  let parent = dirname(canonical.candidate);
  while (parent !== canonical.root) {
    try {
      await rmdir(parent);
      await syncDirectory(dirname(parent));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return;
      if (code !== 'ENOENT') throw error;
    }
    const next = dirname(parent);
    if (next === parent) throw new Error('Scientific directory cleanup escaped its workspace.');
    parent = next;
  }
}

async function existingHash(path: string): Promise<BlobHash | null> {
  try {
    return defineBlob(await readFile(path)).hash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function flushExistingFile(
  root: string,
  path: string,
  content: Uint8Array,
  expected: BlobHash
): Promise<void> {
  try {
    const handle = await open(path, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw error;

    await writeWorkspaceBinaryFileAtomicInMain(
      {
        workspaceRoot: root,
        path,
        content,
        artifactNoun: 'scientific object',
      },
      { durable: true, mode: 'replace', expectedContentHash: expected.slice('sha256:'.length) }
    );
  }
}

async function syncExistingParent(path: string): Promise<void> {
  let parent = dirname(path);
  for (;;) {
    try {
      await syncDirectory(parent);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}

function parseManifest(text: string): ScientificMaterializationManifest {
  const input: unknown = JSON.parse(text);
  if (
    !input ||
    typeof input !== 'object' ||
    !('formatVersion' in input) ||
    input.formatVersion !== 1 ||
    !('files' in input) ||
    !Array.isArray(input.files) ||
    ('completeWorkspace' in input && input.completeWorkspace !== true)
  )
    throw new Error('Scientific file delivery manifest is invalid.');
  const paths = new Set<string>(),
    files: ScientificMaterializationFile[] = [];
  for (const raw of input.files) {
    if (!raw || typeof raw !== 'object')
      throw new Error('Scientific file delivery entry is invalid.');
    const value = raw as Record<string, unknown>;
    if (typeof value.path !== 'string' || typeof value.resourceId !== 'string')
      throw new Error('Scientific file delivery identity is invalid.');
    const path = parseWorkspacePath(value.path),
      id = parseResourceId(value.resourceId);
    if (!path.ok || !id.ok || paths.has(path.value))
      throw new Error('Scientific file delivery path is invalid.');
    paths.add(path.value);
    const expectedHash = value.expectedHash === null ? null : parseHash(value.expectedHash);
    let blob: BlobRef | null = null;
    if (value.blob !== null) {
      if (
        !value.blob ||
        typeof value.blob !== 'object' ||
        !('hash' in value.blob) ||
        !('byteLength' in value.blob) ||
        typeof value.blob.byteLength !== 'number' ||
        !Number.isSafeInteger(value.blob.byteLength) ||
        value.blob.byteLength < 0
      )
        throw new Error('Scientific file delivery blob is invalid.');
      blob = { hash: parseHash(value.blob.hash), byteLength: value.blob.byteLength };
    }
    files.push({ path: path.value, resourceId: id.value, expectedHash, blob });
  }
  const missingFiles: WorkspacePath[] = [];
  if ('missingFiles' in input) {
    if (!Array.isArray(input.missingFiles))
      throw new Error('Scientific missing-file repair is invalid.');
    for (const raw of input.missingFiles) {
      const path = typeof raw === 'string' ? parseWorkspacePath(raw) : null;
      if (
        !path?.ok ||
        missingFiles.includes(path.value) ||
        !files.some((file) => file.path === path.value && file.blob !== null)
      )
        throw new Error('Scientific missing-file repair is invalid.');
      missingFiles.push(path.value);
    }
  }
  return {
    formatVersion: 1,
    files,
    ...(missingFiles.length ? { missingFiles } : {}),
    ...('completeWorkspace' in input ? { completeWorkspace: true } : {}),
  };
}

function parseHash(value: unknown): BlobHash {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value))
    throw new Error('Scientific file delivery checksum is invalid.');
  return value as BlobHash;
}
