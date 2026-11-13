import type {
  WorkspaceSessionController,
  WorkspaceSessionFile,
  WorkspaceSessionSnapshot,
} from '@waypoint/domain-services';
import { parseResourcePath } from '@waypoint/workspace-revisions';
import { computeChecksum } from '@waypoint/sequence-utils';
import { SEQUENCE_PACKAGE_METADATA_TRANSACTION_NAME } from '../db/sequence-package-contract';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import {
  prepareSequenceMetadataEdit,
  resolvePublishedSequenceMetadataRevision,
  stableSequencePackageRequestJson,
} from '../db/sequence-package-metadata-edit';
import {
  prepareSequencePackageRevision,
  verifySequencePackageSnapshot,
} from '../db/sequence-package-versioning';
import type {
  SequenceMetadataRevisionRequest,
  SequenceMetadataRevisionResult,
} from '../shared/sequence-package-revision';
import type { FilesystemStat } from '../shared/filesystem-stat';
import type { WorkspacePathValidationInput } from '../shared/workspace-file-atomic';
import {
  assertTextFileAtomicWriteInput,
  type TextFileAtomicWriteInput,
} from '../shared/text-file-atomic';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import type {
  WorkspaceListChildrenRequest,
  WorkspaceListChildrenResult,
} from '../shared/workspace-browser-types';
import { hostedWorkspaceSessionController, initializeHostedWorkspaceSession } from './controller';
import { emitHostedFileChanged } from './events';
import { HostedWorkspaceApiError } from './api';
import { HostedCapabilityError } from './errors';
import { HOSTED_FS_ROOT, hostedAbsolutePath, parseHostedFsPath } from './paths';

const GENBANK_CONTENT_TYPE = 'application/genbank';

export { HostedCapabilityError };

const INACTIVE_PEEK_ATTEMPTS = 4;

export function createHostedVirtualFs(
  controller: WorkspaceSessionController = hostedWorkspaceSessionController
) {
  const pendingWrites = new Map<
    string,
    {
      accountId: string;
      workspaceId: string;
      path: string;
      bytes: Uint8Array;
      contentType: string;
      resourceId?: string | null;
    }
  >();
  const pendingDeletes = new Map<string, symbol>();
  const watchedFiles = new Map<string, string>();
  let unsubscribeSnapshot: (() => void) | null = null;
  const mutationDepths = new Map<string, number>();
  const mutationLeases = new Map<string, string>();
  const stagedBases = new Map<string, string>();
  const inactivePeeks = new Map<string, Promise<WorkspaceSessionSnapshot>>();
  let flushTail: Promise<void> = Promise.resolve();
  function writeKey(accountId: string, workspaceId: string, relativePath: string): string {
    return `${accountId}:${workspaceId}:${relativePath}`;
  }

  function parseWriteKey(key: string): { accountId: string; workspaceId: string; path: string } {
    const accountColon = key.indexOf(':');
    const workspaceColon = key.indexOf(':', accountColon + 1);
    return {
      accountId: key.slice(0, accountColon),
      workspaceId: key.slice(accountColon + 1, workspaceColon),
      path: key.slice(workspaceColon + 1),
    };
  }
  function assertActor(accountId: string): void {
    if (controller.getState().principal?.id !== accountId) {
      throw new Error(
        'The signed-in account changed. The original staged draft has not been published.'
      );
    }
  }

  async function captureActor(): Promise<string> {
    if (!controller.getState().principal) {
      if (controller === hostedWorkspaceSessionController) {
        await initializeHostedWorkspaceSession();
      } else {
        await controller.initialize();
      }
    }
    const accountId = controller.getState().principal?.id;
    if (!accountId) throw new Error('Sign in before accessing a hosted project.');
    return accountId;
  }

  function mutationDepth(accountId: string): number {
    return mutationDepths.get(accountId) ?? 0;
  }

  function snapshotFingerprint(files: readonly WorkspaceSessionFile[]): string {
    return JSON.stringify(
      [...files]
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
        .map((file) => [
          file.path,
          file.resourceId,
          file.contentRevision,
          file.contentSha256,
          file.sizeBytes,
          file.contentType,
        ])
    );
  }

  function stageBase(accountId: string, workspaceId: string): void {
    const key = writeKey(accountId, workspaceId, '');
    if (!stagedBases.has(key)) {
      const snapshot = controller.getState().snapshot;
      if (snapshot?.workspaceId !== workspaceId) throw new Error('Hosted project is not loaded.');
      stagedBases.set(key, snapshotFingerprint(snapshot.files));
    }
  }

  async function ensureWorkspace(workspaceId: string, accountId: string): Promise<void> {
    assertActor(accountId);
    const state = controller.getState();
    if (!state.workspaces.some((workspace) => workspace.workspaceId === workspaceId)) {
      if (controller === hostedWorkspaceSessionController) {
        await initializeHostedWorkspaceSession(workspaceId);
      } else {
        await controller.initialize(workspaceId);
      }
      assertActor(accountId);
    }
    if (controller.getState().activeWorkspaceId !== workspaceId) {
      await controller.selectWorkspace(workspaceId);
      assertActor(accountId);
    }
  }

  async function inactiveSnapshot(
    workspaceId: string,
    accountId: string
  ): Promise<WorkspaceSessionSnapshot | null> {
    assertActor(accountId);
    if (
      !controller.getState().workspaces.some((workspace) => workspace.workspaceId === workspaceId)
    ) {
      if (controller === hostedWorkspaceSessionController) {
        await initializeHostedWorkspaceSession(workspaceId);
      } else {
        await controller.initialize(workspaceId);
      }
      assertActor(accountId);
    }
    const state = controller.getState();
    if (state.activeWorkspaceId === workspaceId && state.snapshot?.workspaceId === workspaceId)
      return null;
    const key = `${accountId}:${workspaceId}`;
    let pending = inactivePeeks.get(key);
    if (!pending) {
      pending = peekUntilIndexSettles(workspaceId, accountId).finally(() => {
        if (inactivePeeks.get(key) === pending) inactivePeeks.delete(key);
      });
      inactivePeeks.set(key, pending);
    }
    const snapshot = await pending;
    assertActor(accountId);
    return snapshot;
  }

  async function peekUntilIndexSettles(
    workspaceId: string,
    accountId: string
  ): Promise<WorkspaceSessionSnapshot> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await controller.peekWorkspace(workspaceId);
      } catch (error) {
        const indexRefreshedMidRead =
          error instanceof HostedWorkspaceApiError &&
          error.status === 401 &&
          error.code === 'account_changed' &&
          controller.getState().principal?.id === accountId;
        if (!indexRefreshedMidRead || attempt >= INACTIVE_PEEK_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 200));
      }
    }
  }

  async function readableFiles(
    workspaceId: string,
    expectedAccountId?: string
  ): Promise<readonly WorkspaceSessionFile[]> {
    const accountId = expectedAccountId ?? (await captureActor());
    const peeked = await inactiveSnapshot(workspaceId, accountId);
    if (!peeked) return snapshotFiles(workspaceId, accountId);
    return withPendingChanges(peeked.files, workspaceId, accountId);
  }

  async function snapshotFiles(
    workspaceId: string,
    expectedAccountId?: string
  ): Promise<readonly WorkspaceSessionFile[]> {
    const accountId = expectedAccountId ?? (await captureActor());
    await ensureWorkspace(workspaceId, accountId);
    assertActor(accountId);
    const snapshot = controller.getState().snapshot;
    if (!snapshot || snapshot.workspaceId !== workspaceId)
      throw new Error('Hosted project is not loaded.');
    return withPendingChanges(snapshot.files, workspaceId, accountId);
  }

  function withPendingChanges(
    files: readonly WorkspaceSessionFile[],
    workspaceId: string,
    accountId: string
  ): WorkspaceSessionFile[] {
    const byPath = new Map(files.map((file) => [file.path, file]));
    for (const deleted of pendingDeletes.keys()) {
      const prefix = `${accountId}:${workspaceId}:`;
      if (!deleted.startsWith(prefix)) continue;
      byPath.delete(deleted.slice(prefix.length));
    }
    for (const write of pendingWrites.values()) {
      if (write.accountId !== accountId || write.workspaceId !== workspaceId) continue;
      byPath.set(write.path, {
        resourceId: write.resourceId ?? byPath.get(write.path)?.resourceId ?? null,
        path: write.path,
        contentRevision: `pending:${write.path}`,
        contentSha256: null,
        sizeBytes: write.bytes.byteLength,
        contentType: write.contentType,
      });
    }
    return [...byPath.values()];
  }

  async function validateWorkspacePath(input: WorkspacePathValidationInput): Promise<boolean> {
    const root = parseHostedFsPath(input.workspaceRoot);
    const target = parseHostedFsPath(input.path);
    if (!root?.workspaceId || target?.workspaceId !== root.workspaceId) return false;
    for (const [absolute, parsed] of [
      [input.workspaceRoot, root],
      [input.path, target],
    ] as const) {
      if (hostedAbsolutePath(root.workspaceId, parsed.relativePath) !== absolute) return false;
      if (parsed.relativePath) {
        const portable = parseResourcePath(parsed.relativePath);
        if (!portable.ok || portable.value !== parsed.relativePath) return false;
      }
    }
    if (
      root.relativePath &&
      target.relativePath !== root.relativePath &&
      !target.relativePath.startsWith(`${root.relativePath}/`)
    )
      return false;
    const files = await readableFiles(root.workspaceId);
    const present = (path: string) =>
      !path || files.some((file) => file.path === path || file.path.startsWith(`${path}/`));
    return (
      present(root.relativePath) && (input.allowMissing === true || present(target.relativePath))
    );
  }

  function childrenOf(
    files: readonly WorkspaceSessionFile[],
    parentRelativePath: string,
    workspaceId: string
  ): WorkspaceListChildrenResult['entries'] {
    const prefix = parentRelativePath ? `${parentRelativePath}/` : '';
    const directories = new Set<string>();
    const entries: WorkspaceListChildrenResult['entries'] = [];
    for (const file of files) {
      if (prefix && !file.path.startsWith(prefix)) continue;
      const rest = prefix ? file.path.slice(prefix.length) : file.path;
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({
          kind: 'filesystem',
          entryId: `filesystem:${hostedAbsolutePath(workspaceId, file.path)}`,
          name: rest,
          path: hostedAbsolutePath(workspaceId, file.path),
          isDirectory: false,
          isFile: true,
        });
        continue;
      }
      const directoryName = rest.slice(0, slash);
      if (directories.has(directoryName)) continue;
      directories.add(directoryName);
      const directoryPath = hostedAbsolutePath(
        workspaceId,
        prefix ? `${parentRelativePath}/${directoryName}` : directoryName
      );
      entries.push({
        kind: 'filesystem',
        entryId: `filesystem:${directoryPath}`,
        name: directoryName,
        path: directoryPath,
        isDirectory: true,
        isFile: false,
      });
    }
    return entries;
  }

  async function listChildren(
    request: WorkspaceListChildrenRequest
  ): Promise<WorkspaceListChildrenResult> {
    const parsed = parseHostedFsPath(
      request.parentRelativePath
        ? `${request.workspaceRoot.replace(/\/+$/u, '')}/${request.parentRelativePath}`
        : request.workspaceRoot
    );
    if (!parsed) {
      throw new HostedCapabilityError(`workspace.listChildren:${request.workspaceRoot}`);
    }
    if (!parsed.workspaceId) {
      const accountId = controller.getState().principal?.id;
      if (controller === hostedWorkspaceSessionController) {
        await initializeHostedWorkspaceSession();
      } else {
        await controller.initialize();
      }
      if (accountId) assertActor(accountId);
      const { workspaces } = controller.getState();
      return {
        workspaceId: 0,
        parentRelativePath: request.parentRelativePath,
        entries: workspaces.map((workspace) => ({
          kind: 'filesystem' as const,
          entryId: `filesystem:${hostedAbsolutePath(workspace.workspaceId)}`,
          name: workspace.displayName,
          path: hostedAbsolutePath(workspace.workspaceId),
          isDirectory: true,
          isFile: false,
        })),
        partialError: null,
      };
    }
    const files = await readableFiles(parsed.workspaceId);
    return {
      workspaceId: 0,
      parentRelativePath: request.parentRelativePath,
      entries: childrenOf(files, parsed.relativePath, parsed.workspaceId),
      partialError: null,
    };
  }

  async function readDir(path: string) {
    const listed = await listChildren({
      workspaceRoot: path,
      parentRelativePath: '',
    });
    return listed.entries
      .filter((entry) => entry.kind === 'filesystem')
      .map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
        isFile: entry.isFile,
      }));
  }

  function checkReadSize(path: string, sizeBytes: number, maxBytes?: number): void {
    if (maxBytes !== undefined && sizeBytes > maxBytes) {
      throw Object.assign(
        new Error(
          `File exceeds bounded read limit (${sizeBytes} bytes > ${maxBytes} bytes): ${path}`
        ),
        { name: 'BoundedFileReadLimitError', sizeBytes, maxBytes, path }
      );
    }
  }

  async function readFile(path: string, maxBytes?: number): Promise<Uint8Array> {
    const parsed = parseHostedFsPath(path);
    if (!parsed?.workspaceId || !parsed.relativePath) {
      throw new HostedCapabilityError(`fs.readFile:${path}`);
    }
    const accountId = await captureActor();
    assertActor(accountId);
    const key = writeKey(accountId, parsed.workspaceId, parsed.relativePath);
    const pending = pendingWrites.get(key);
    if (pending) {
      checkReadSize(path, pending.bytes.byteLength, maxBytes);
      return pending.bytes.slice();
    }
    const peeked = await inactiveSnapshot(parsed.workspaceId, accountId);
    if (peeked) {
      const file = pendingDeletes.has(key)
        ? undefined
        : peeked.files.find((candidate) => candidate.path === parsed.relativePath);
      if (!file) {
        throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), {
          code: 'ENOENT',
          path,
        });
      }
      checkReadSize(path, file.sizeBytes, maxBytes);
      const bytes = await controller.peekFile(peeked, file);
      assertActor(accountId);
      checkReadSize(path, bytes.byteLength, maxBytes);
      return bytes;
    }
    await ensureWorkspace(parsed.workspaceId, accountId);
    assertActor(accountId);
    const snapshot = controller.getState().snapshot;
    if (
      pendingDeletes.has(key) ||
      (snapshot?.workspaceId === parsed.workspaceId &&
        !snapshot.files.some((file) => file.path === parsed.relativePath))
    ) {
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), {
        code: 'ENOENT',
        path,
      });
    }
    const file = snapshot?.files.find((candidate) => candidate.path === parsed.relativePath);
    if (file) checkReadSize(path, file.sizeBytes, maxBytes);
    const opened = await controller.openFile(parsed.relativePath);
    assertActor(accountId);
    checkReadSize(path, opened.bytes.byteLength, maxBytes);
    return opened.bytes;
  }

  async function readFileBounded(path: string, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > HARD_CAP_BYTES) {
      throw new Error(`maxBytes must be between 1 and ${HARD_CAP_BYTES}.`);
    }
    return readFile(path, maxBytes);
  }

  async function readTextFile(path: string): Promise<string> {
    return new TextDecoder().decode(await readFile(path));
  }

  async function sha256File(path: string): Promise<string> {
    const bytes = await readFile(path, HARD_CAP_BYTES);
    return computeChecksum(bytes.slice().buffer);
  }

  async function exists(path: string): Promise<boolean> {
    const parsed = parseHostedFsPath(path);
    if (!parsed) return false;
    if (!parsed.workspaceId) return path === HOSTED_FS_ROOT;
    const files = await readableFiles(parsed.workspaceId);
    if (!parsed.relativePath) return true;
    return files.some(
      (file) => file.path === parsed.relativePath || file.path.startsWith(`${parsed.relativePath}/`)
    );
  }

  async function stat(path: string): Promise<FilesystemStat> {
    const parsed = parseHostedFsPath(path);
    if (!parsed?.workspaceId) {
      throw new HostedCapabilityError(`fs.stat:${path}`);
    }
    const files = await readableFiles(parsed.workspaceId);
    if (!parsed.relativePath) {
      return directoryStat(
        path,
        files.reduce((sum, file) => sum + file.sizeBytes, 0)
      );
    }
    const file = files.find((candidate) => candidate.path === parsed.relativePath);
    if (file) return fileStat(path, file.sizeBytes);
    if (files.some((candidate) => candidate.path.startsWith(`${parsed.relativePath}/`))) {
      return directoryStat(path, 0);
    }
    throw new HostedCapabilityError(`fs.stat:${path}`);
  }

  async function writeBytes(
    path: string,
    bytes: Uint8Array,
    contentType?: string,
    resourceId?: string | null,
    expectedAccountId?: string
  ): Promise<void> {
    const parsed = parseHostedFsPath(path);
    if (!parsed?.workspaceId || !parsed.relativePath) {
      throw new HostedCapabilityError(`fs.writeTextFile:${path}`);
    }
    const accountId = expectedAccountId ?? (await captureActor());
    const immutableBytes = bytes.slice();
    const batching = mutationDepth(accountId) > 0;
    if (batching) await ensureWorkspace(parsed.workspaceId, accountId);
    const snapshot = batching
      ? controller.getState().snapshot
      : await controller.peekWorkspace(parsed.workspaceId);
    assertActor(accountId);
    const key = writeKey(accountId, parsed.workspaceId, parsed.relativePath);
    pendingDeletes.delete(key);
    const pending = pendingWrites.get(key);
    const committed = snapshot?.files.find((file) => file.path === parsed.relativePath);
    const write = {
      accountId,
      workspaceId: parsed.workspaceId,
      path: parsed.relativePath,
      bytes: immutableBytes,
      contentType:
        contentType ??
        pending?.contentType ??
        committed?.contentType ??
        contentTypeForPath(parsed.relativePath),
      ...(resourceId !== undefined ? { resourceId } : {}),
    };
    if (batching) {
      stageBase(accountId, parsed.workspaceId);
      pendingWrites.set(key, write);
      return;
    }
    await controller.commitWorkspaceFiles({
      workspaceId: parsed.workspaceId,
      writes: [write],
      expectedAccountId: accountId,
    });
    assertActor(accountId);
  }

  async function writeTextFile(path: string, content: string): Promise<void> {
    await writeBytes(path, new TextEncoder().encode(content));
  }

  function assertNoPendingMutation(accountId: string) {
    if (
      mutationDepth(accountId) > 0 ||
      [...pendingWrites.values()].some((write) => write.accountId === accountId) ||
      [...pendingDeletes.keys()].some((key) => parseWriteKey(key).accountId === accountId)
    )
      throw new Error('Finish the pending project mutation before changing this file.');
  }

  async function withAtomicFileMutation(
    path: string,
    operation: (input: {
      accountId: string;
      workspaceId: string;
      relativePath: string;
      base: WorkspaceSessionSnapshot;
    }) => Promise<void>
  ): Promise<void> {
    const parsed = parseHostedFsPath(path);
    const portable = parsed && parseResourcePath(parsed.relativePath);
    if (
      !parsed?.workspaceId ||
      !parsed.relativePath ||
      !portable ||
      !portable.ok ||
      portable.value !== parsed.relativePath ||
      hostedAbsolutePath(parsed.workspaceId, parsed.relativePath) !== path
    )
      throw new HostedCapabilityError(`fs.atomicMutation:${path}`);
    const workspaceId = parsed.workspaceId;
    const accountId = await captureActor();
    const pending = flushTail.then(async () => {
      assertActor(accountId);
      assertNoPendingMutation(accountId);
      await ensureWorkspace(workspaceId, accountId);
      assertActor(accountId);
      assertNoPendingMutation(accountId);
      const base = controller.getState().snapshot;
      if (!base || base.workspaceId !== workspaceId)
        throw new Error('The project changed before the file edit.');
      await operation({ accountId, workspaceId, relativePath: parsed.relativePath, base });
      assertActor(accountId);
    });
    flushTail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  async function writeTextFileAtomic(input: TextFileAtomicWriteInput): Promise<void> {
    assertTextFileAtomicWriteInput(input);
    return withAtomicFileMutation(input.path, async ({ accountId, relativePath, base }) => {
      const existing = base.files.find((file) => file.path === relativePath);
      if (
        base.files.some(
          (file) =>
            file.path.startsWith(`${relativePath}/`) || relativePath.startsWith(`${file.path}/`)
        )
      ) {
        throw new Error('Refusing to replace a non-regular text file.');
      }
      const currentHash = existing
        ? await computeChecksum((await readFile(input.path)).slice().buffer)
        : null;
      assertActor(accountId);
      assertNoPendingMutation(accountId);
      if (controller.getState().snapshot !== base)
        throw new Error('The project changed before the prepared file edit.');
      if (input.expectedContentHash !== undefined && currentHash !== input.expectedContentHash) {
        throw new Error('FILE_CHANGED: The file changed. Reopen it before saving.');
      }
      await controller.commit(
        [
          {
            path: relativePath,
            bytes: new TextEncoder().encode(input.content),
            contentType: existing?.contentType ?? contentTypeForPath(relativePath),
            ...(existing ? { resourceId: existing.resourceId } : {}),
          },
        ],
        undefined,
        undefined,
        undefined,
        base
      );
    });
  }

  async function removeFileAtomic(path: string): Promise<void> {
    return withAtomicFileMutation(path, async ({ relativePath, base }) => {
      const sources = base.files.filter(
        (file) => file.path === relativePath || file.path.startsWith(`${relativePath}/`)
      );
      if (sources.length === 0)
        throw new Error('The file changed before deletion. Reopen the project before deleting.');
      await controller.commit(
        [],
        undefined,
        sources.map((file) => file.path),
        undefined,
        base
      );
    });
  }

  async function rename(
    oldPath: string,
    newPath: string,
    _mutationToken?: string,
    options: { readonly noClobber?: boolean } = {}
  ): Promise<void> {
    await relocate(oldPath, newPath, options.noClobber ?? false);
  }

  async function move(sourcePath: string, destinationDir: string): Promise<{ destPath: string }> {
    const source = parseHostedFsPath(sourcePath);
    const directory = parseHostedFsPath(destinationDir);
    if (
      !source?.workspaceId ||
      !source.relativePath ||
      directory?.workspaceId !== source.workspaceId
    ) {
      throw new HostedCapabilityError(`fs.move:${sourcePath}`);
    }
    const name = source.relativePath.split('/').pop()!;
    const destPath = hostedAbsolutePath(
      source.workspaceId,
      [directory.relativePath, name].filter(Boolean).join('/')
    );
    if (parseHostedFsPath(destPath)!.relativePath === source.relativePath) {
      throw new Error('MOVE_NOOP: the source is already in that directory.');
    }
    await relocate(sourcePath, destPath, true);
    return { destPath };
  }

  async function relocate(oldPath: string, newPath: string, noClobber: boolean): Promise<void> {
    const from = parseHostedFsPath(oldPath);
    const to = parseHostedFsPath(newPath);
    if (!from?.workspaceId || !from.relativePath || !to?.workspaceId || !to.relativePath) {
      throw new HostedCapabilityError(`fs.rename:${oldPath}`);
    }
    if (from.workspaceId !== to.workspaceId) {
      throw new HostedCapabilityError(`fs.rename:${oldPath}`);
    }
    if (from.relativePath === to.relativePath) return;
    if (to.relativePath.startsWith(`${from.relativePath}/`)) {
      throw new Error('MOVE_INVALID: a directory cannot be moved into itself.');
    }
    const accountId = await captureActor();
    const files = await snapshotFiles(from.workspaceId, accountId);
    assertActor(accountId);
    const sources = files.filter(
      (file) => file.path === from.relativePath || file.path.startsWith(`${from.relativePath}/`)
    );
    if (sources.length === 0) {
      throw new HostedCapabilityError(`fs.rename:${oldPath}`);
    }
    const destOccupied = files.some((file) => {
      if (file.path === from.relativePath || file.path.startsWith(`${from.relativePath}/`)) {
        return false;
      }
      if (file.path === to.relativePath) return noClobber;
      return file.path.startsWith(`${to.relativePath}/`);
    });
    if (destOccupied) {
      if (noClobber) throw new Error('MOVE_EXISTS: the destination already exists.');
      throw new HostedCapabilityError(`fs.rename:${newPath}`);
    }
    const originalFiles = snapshotFingerprint(files);
    const ownMutation = mutationDepth(accountId) === 0;
    if (ownMutation) mutationDepths.set(accountId, 1);
    try {
      const sourceBytes = new Map<string, Uint8Array>();
      for (const source of sources) {
        const pending = pendingWrites.get(writeKey(accountId, from.workspaceId, source.path));
        sourceBytes.set(
          source.path,
          pending?.bytes ?? (await readFile(hostedAbsolutePath(from.workspaceId, source.path)))
        );
        assertActor(accountId);
      }
      if (
        noClobber &&
        snapshotFingerprint(await snapshotFiles(from.workspaceId, accountId)) !== originalFiles
      ) {
        throw new Error('The project changed before the move. Retry with the current files.');
      }
      for (const source of sources) {
        const destRelative =
          source.path === from.relativePath
            ? to.relativePath
            : `${to.relativePath}${source.path.slice(from.relativePath.length)}`;
        assertActor(accountId);
        const fromKey = writeKey(accountId, from.workspaceId, source.path);
        const pending = pendingWrites.get(fromKey);
        const bytes = sourceBytes.get(source.path)!;
        assertActor(accountId);
        const contentType = pending?.contentType ?? source.contentType;
        const resourceId = pending?.resourceId ?? source.resourceId;
        stageBase(accountId, from.workspaceId);
        pendingWrites.delete(fromKey);
        pendingDeletes.set(fromKey, Symbol());
        await writeBytes(
          hostedAbsolutePath(from.workspaceId, destRelative),
          bytes,
          contentType,
          resourceId,
          accountId
        );
      }
    } finally {
      if (ownMutation) {
        mutationDepths.set(accountId, Math.max(0, mutationDepth(accountId) - 1));
        if (mutationDepth(accountId) === 0) await flushPending(accountId);
      }
    }
  }

  function flushPending(accountId: string): Promise<void> {
    const pending = flushTail.then(() => flushCurrentPending(accountId));
    flushTail = pending.catch(() => undefined);
    return pending;
  }

  async function flushCurrentPending(accountId: string): Promise<void> {
    assertActor(accountId);
    if (mutationDepth(accountId) > 0) return;
    if (pendingWrites.size === 0 && pendingDeletes.size === 0) return;
    const writes = [...pendingWrites.values()].filter((write) => write.accountId === accountId);
    const deletes = [...pendingDeletes.entries()].filter(
      ([key]) => parseWriteKey(key).accountId === accountId
    );
    const workspaceIds = new Set([
      ...writes.map((write) => write.workspaceId),
      ...deletes.map(([key]) => parseWriteKey(key).workspaceId),
    ]);
    for (const workspaceId of workspaceIds) {
      const batchWrites = writes.filter((write) => write.workspaceId === workspaceId);
      const batchDeletes = deletes.filter(
        ([key]) => parseWriteKey(key).workspaceId === workspaceId
      );
      await ensureWorkspace(workspaceId, accountId);
      assertActor(accountId);
      const baseKey = writeKey(accountId, workspaceId, '');
      if (
        stagedBases.get(baseKey) !==
        snapshotFingerprint(controller.getState().snapshot?.files ?? [])
      ) {
        throw new Error(
          'This project changed after the batch began. The original staged draft has not been published.'
        );
      }
      const saved = await controller.commit(
        batchWrites,
        undefined,
        batchDeletes.map(([key]) => parseWriteKey(key).path)
      );
      assertActor(accountId);
      for (const write of batchWrites) {
        const key = writeKey(accountId, workspaceId, write.path);
        if (pendingWrites.get(key) === write) pendingWrites.delete(key);
      }
      for (const [key, generation] of batchDeletes) {
        if (pendingDeletes.get(key) === generation) pendingDeletes.delete(key);
      }
      if (
        [...pendingWrites.values()].some(
          (write) => write.accountId === accountId && write.workspaceId === workspaceId
        ) ||
        [...pendingDeletes.keys()].some((key) => {
          const parsed = parseWriteKey(key);
          return parsed.accountId === accountId && parsed.workspaceId === workspaceId;
        })
      ) {
        stagedBases.set(baseKey, snapshotFingerprint(saved.files));
      } else {
        stagedBases.delete(baseKey);
      }
    }
  }

  function fileFingerprint(workspaceId: string, relativePath: string): string {
    const snapshot = controller.getState().snapshot;
    if (snapshot?.workspaceId === workspaceId) {
      const file = snapshot.files.find((candidate) => candidate.path === relativePath);
      if (file) {
        return `${file.contentRevision}:${file.contentSha256 ?? ''}:${file.sizeBytes}`;
      }
    }
    const accountId = controller.getState().principal?.id;
    const pending = accountId
      ? pendingWrites.get(writeKey(accountId, workspaceId, relativePath))
      : undefined;
    if (pending) return `pending:${pending.bytes.byteLength}`;
    return 'missing';
  }

  function notifyWatchedFiles(): void {
    for (const [absolutePath, previous] of watchedFiles) {
      const parsed = parseHostedFsPath(absolutePath);
      if (!parsed?.workspaceId || !parsed.relativePath) continue;
      const next = fileFingerprint(parsed.workspaceId, parsed.relativePath);
      if (next === previous) continue;
      watchedFiles.set(absolutePath, next);
      emitHostedFileChanged(absolutePath);
    }
  }

  function ensureSnapshotWatch(): void {
    if (unsubscribeSnapshot) return;
    unsubscribeSnapshot = controller.subscribe(notifyWatchedFiles);
  }

  async function watchFile(path: string): Promise<void> {
    const parsed = parseHostedFsPath(path);
    if (!parsed?.workspaceId || !parsed.relativePath) return;
    watchedFiles.set(path, fileFingerprint(parsed.workspaceId, parsed.relativePath));
    ensureSnapshotWatch();
  }

  async function unwatchFile(path: string): Promise<void> {
    watchedFiles.delete(path);
    if (watchedFiles.size === 0 && unsubscribeSnapshot) {
      unsubscribeSnapshot();
      unsubscribeSnapshot = null;
    }
  }

  async function removeFile(path: string, options: { atomic?: boolean } = {}): Promise<void> {
    if (options.atomic) return removeFileAtomic(path);
    const parsed = parseHostedFsPath(path);
    if (!parsed?.workspaceId || !parsed.relativePath) {
      throw new HostedCapabilityError(`fs.removeFile:${path}`);
    }
    const accountId = await captureActor();
    const files = await snapshotFiles(parsed.workspaceId, accountId);
    assertActor(accountId);
    const sources = files.filter(
      (file) => file.path === parsed.relativePath || file.path.startsWith(`${parsed.relativePath}/`)
    );
    if (sources.length === 0) return;
    stageBase(accountId, parsed.workspaceId);
    for (const source of sources) {
      const key = writeKey(accountId, parsed.workspaceId, source.path);
      pendingWrites.delete(key);
      pendingDeletes.set(key, Symbol());
    }
    if (mutationDepth(accountId) === 0) await flushPending(accountId);
  }

  async function publishSequenceMetadataRevision(
    request: SequenceMetadataRevisionRequest
  ): Promise<SequenceMetadataRevisionResult> {
    const accountId = await captureActor();
    const pending = flushTail.then(async () => {
      assertActor(accountId);
      const root = parseHostedFsPath(request.document.packageRoot);
      if (
        request.document.kind !== 'managed-sequence' ||
        !request.document.packageId ||
        !root?.workspaceId ||
        !root.relativePath ||
        !/^sha256:[a-f0-9]{64}$/.test(request.expectedMarkerSha256) ||
        !request.operationId ||
        request.operationId.length > 256
      ) {
        throw new Error('Sequence metadata revision request is invalid.');
      }
      if (mutationDepth(accountId) > 0)
        throw new Error('Finish the pending project mutation before editing metadata.');
      await flushCurrentPending(accountId);
      await ensureWorkspace(root.workspaceId, accountId);
      const paths = sequencePackagePaths(request.document.packageRoot);
      if (
        !(await validateWorkspacePath({
          workspaceRoot: hostedAbsolutePath(root.workspaceId),
          path: paths.metaPath,
        }))
      ) {
        throw new Error('Sequence metadata package path is not canonical or available.');
      }
      assertActor(accountId);
      const base = controller.getState().snapshot!;
      const baseFingerprint = snapshotFingerprint(base.files);
      const markerContent = await readTextFile(paths.metaPath);
      assertActor(accountId);
      const current = parseSequencePackageDocument(markerContent);
      if (current.id !== request.document.packageId)
        throw new Error('Sequence metadata package identity changed.');
      const revisionId = `metadata-update:${request.operationId}`;
      const requestFingerprint = await computeChecksum(stableSequencePackageRequestJson(request));
      assertActor(accountId);
      const previousResult = resolvePublishedSequenceMetadataRevision({
        current,
        markerContent,
        revisionId,
        requestFingerprint,
      });
      if (previousResult) return previousResult;
      if ((await computeChecksum(markerContent)) !== request.expectedMarkerSha256) {
        throw new Error('Sequence metadata changed after it was opened. Reopen and retry.');
      }
      for (const journalPath of [
        paths.revisionJournalPath,
        `${request.document.packageRoot}/.forge/${SEQUENCE_PACKAGE_METADATA_TRANSACTION_NAME}`,
      ]) {
        if (await exists(journalPath)) {
          const journal = JSON.parse(await readTextFile(journalPath));
          if (journal.state !== 'complete' && journal.state !== 'aborted')
            throw new Error('Sequence package has an unsettled native transaction.');
        }
      }
      const productPath = sequencePackagePaths(request.document.packageRoot, {
        productFile: current.product.file,
      }).productPath;
      const beforeProduct = await readTextFile(productPath);
      const head = current.versionHistory.revisions.find(
        (revision) => revision.id === current.versionHistory.headId
      );
      if (head) {
        await verifySequencePackageSnapshot({
          revision: head,
          content: await readTextFile(
            fromPackageRelative(head.productSnapshot.path, request.document.packageRoot)
          ),
        });
      }
      const edit = await prepareSequenceMetadataEdit({
        current,
        proposed: request.proposed,
        beforeProduct,
        productPath,
      });
      assertActor(accountId);
      if (!edit.changed)
        return {
          updatedMarkerContent: markerContent,
          revisionId: null,
          productChanged: false,
          snapshotPaths: [],
        };
      const prepared = await prepareSequencePackageRevision({
        current,
        currentProductContent: beforeProduct,
        next: edit.next,
        nextProductContent: edit.afterProduct,
        kind: 'metadata-update',
        operationId: revisionId,
        revisionId,
        requestFingerprint,
        adoptedRevisionId: `adopted-before:${request.operationId}`,
      });
      const updatedMarkerContent = serializeSequencePackageDocument(prepared.document);
      const snapshotPaths = prepared.snapshots.map((snapshot) =>
        fromPackageRelative(snapshot.path, request.document.packageRoot)
      );
      for (const [index, snapshot] of prepared.snapshots.entries()) {
        if (
          (await exists(snapshotPaths[index])) &&
          (await readTextFile(snapshotPaths[index])) !== snapshot.content
        ) {
          throw new Error(
            'An immutable sequence snapshot has different bytes. No revision was published.'
          );
        }
      }
      const contents = [
        ...prepared.snapshots.map((snapshot, index) => ({
          path: snapshotPaths[index],
          content: snapshot.content,
        })),
        ...(edit.productChanged ? [{ path: productPath, content: edit.afterProduct }] : []),
        { path: paths.metaPath, content: updatedMarkerContent },
      ];
      const writes = contents.map(({ path, content }) => {
        const relativePath = parseHostedFsPath(path)!.relativePath;
        const existing = base.files.find((file) => file.path === relativePath);
        return {
          path: relativePath,
          bytes: new TextEncoder().encode(content),
          contentType:
            existing?.contentType ??
            (path.endsWith('.json') ? 'application/json' : GENBANK_CONTENT_TYPE),
          resourceId: existing?.resourceId,
        };
      });
      assertActor(accountId);
      if (
        controller.getState().snapshot?.workspaceId !== root.workspaceId ||
        snapshotFingerprint(controller.getState().snapshot!.files) !== baseFingerprint ||
        [...pendingWrites.values()].some(
          (write) => write.accountId === accountId && write.workspaceId === root.workspaceId
        ) ||
        [...pendingDeletes.keys()].some((key) => {
          const owner = parseWriteKey(key);
          return owner.accountId === accountId && owner.workspaceId === root.workspaceId;
        })
      ) {
        throw new Error(
          'This project changed after the metadata edit was prepared. Reopen and retry.'
        );
      }
      await controller.commit(writes, undefined, undefined, undefined, base);
      assertActor(accountId);
      return {
        updatedMarkerContent,
        revisionId,
        productChanged: edit.productChanged,
        snapshotPaths,
      };
    });
    flushTail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  return {
    getCatalogSourceSnapshot(): WorkspaceSessionSnapshot | null {
      const state = controller.getState();
      if (
        !state.principal ||
        !state.snapshot ||
        state.snapshot.workspaceId !== state.activeWorkspaceId
      )
        return null;
      return {
        ...state.snapshot,
        files: withPendingChanges(
          state.snapshot.files,
          state.snapshot.workspaceId,
          state.principal.id
        ),
      };
    },
    listChildren,
    readDir,
    readFile,
    readFileBounded,
    validateWorkspacePath,
    readTextFile,
    sha256File,
    exists,
    stat,
    writeTextFile,
    writeTextFileAtomic,
    rename,
    move,
    removeFile,
    saveSequenceDocument: async () => ({ status: 'unbound' as const }),
    publishSequenceMetadataRevision,
    publishAcceptedAssemblyRevision: async () => {
      throw new Error('Accepted assembly revisions require the desktop app.');
    },
    previewSequenceRestore: async () => {
      throw new Error('Sequence Restore requires the desktop app.');
    },
    applySequenceRestore: async () => {
      throw new Error('Sequence Restore requires the desktop app.');
    },
    publishSequenceAlignmentHistory: async () => {
      throw new Error('Native alignment history requires the desktop app.');
    },
    prepareSequenceEvidenceRun: async () => {
      throw new Error('Sequence evidence requires the desktop app.');
    },
    activateSequenceEvidenceRun: async () => {
      throw new Error('Sequence evidence requires the desktop app.');
    },
    completeSequenceEvidenceRun: async () => {
      throw new Error('Sequence evidence requires the desktop app.');
    },
    failSequenceEvidenceRun: async () => {
      throw new Error('Sequence evidence requires the desktop app.');
    },
    appendSequenceEvidenceState: async () => {
      throw new Error('Sequence evidence requires the desktop app.');
    },
    mkdir: async () => undefined,
    watchFile,
    unwatchFile,
    writeWorkspaceTextFileAtomic: async (input: { path: string; content: string }) => {
      await writeTextFile(input.path, input.content);
      return { path: input.path, contentHash: '' };
    },
    writeWorkspaceBinaryFileAtomic: async (input: { path: string; content: Uint8Array }) => {
      await writeBytes(input.path, input.content);
      return { path: input.path, contentHash: '' };
    },
    beginWorkspaceMutation: async (_workspaceRoot?: string, parentToken?: string) => {
      const accountId = await captureActor();
      assertActor(accountId);
      if (parentToken && mutationLeases.get(parentToken) !== accountId) {
        throw new Error('The signed-in account changed before the nested mutation.');
      }
      const token = `hosted-workspace-mutation:${crypto.randomUUID()}`;
      mutationLeases.set(token, accountId);
      mutationDepths.set(accountId, mutationDepth(accountId) + 1);
      return token;
    },
    endWorkspaceMutation: async (token?: string) => {
      const accountId = await captureActor();
      const ownedToken =
        token ??
        [...mutationLeases.entries()].reverse().find(([, owner]) => owner === accountId)?.[0];
      if (!ownedToken || mutationLeases.get(ownedToken) !== accountId) {
        throw new Error('The signed-in account changed before the staged mutation could finish.');
      }
      assertActor(accountId);
      mutationDepths.set(accountId, Math.max(0, mutationDepth(accountId) - 1));
      try {
        await flushPending(accountId);
        mutationLeases.delete(ownedToken);
      } catch (error) {
        mutationDepths.set(accountId, mutationDepth(accountId) + 1);
        throw error;
      }
    },
  };
}

function contentTypeForPath(path: string): string {
  if (/\.(?:gb|gbk|gbff|genbank)$/iu.test(path)) return GENBANK_CONTENT_TYPE;
  const filename = path.split('/').pop()?.toLowerCase() ?? '';
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : '';
  const contentTypes: Record<string, string> = {
    txt: 'text/plain',
    text: 'text/plain',
    log: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    xml: 'application/xml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    mjs: 'text/javascript',
    ts: 'text/typescript',
  };
  return contentTypes[extension] ?? 'application/octet-stream';
}

function fileStat(path: string, size: number): FilesystemStat {
  return {
    canonicalPath: path,
    size,
    isFile: true,
    isDirectory: false,
    mtime: 0,
    ctime: 0,
    mtimeNs: '0',
    ctimeNs: '0',
  };
}

function directoryStat(path: string, size: number): FilesystemStat {
  return {
    canonicalPath: path,
    size,
    isFile: false,
    isDirectory: true,
    mtime: 0,
    ctime: 0,
    mtimeNs: '0',
    ctimeNs: '0',
  };
}
