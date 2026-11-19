import type { NativeFileDocumentOwner } from './file-document-owner';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { isSavedEntityMember } from '../shared/catalog-file-kind';
import {
  retainedEntityMessage,
  workspaceFileTrashRequestSchema,
  type FileTrashEntry,
  type WorkspaceFileTrashRequest,
  type WorkspaceFileTrashResult,
} from '../shared/workspace-file-trash';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import { assertPhysicalPackageMember } from './workspace-git/package-member-boundary';
import { createKeyedMutex } from './workspace-git/keyed-mutex';
import { syncDirectory } from './fs-durability';
import { writeTextFileAtomicInMain } from './text-file-atomic';

const exclusive = createKeyedMutex();
const reserved = new Set(['.git', '.forge', '.dnaforge', '.waypoint']);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const legacyRecordSchema = z
  .object({
    schema: z.literal('dnaforge.file-trash.v1'),
    id: z.string().uuid(),
    workspaceRoot: z.string(),
    originalPath: z.string(),
    trashedAt: z.string().datetime(),
    type: z.enum(['file', 'directory']),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const recordSchema = z.discriminatedUnion('schema', [
  legacyRecordSchema,
  legacyRecordSchema
    .extend({
      schema: z.literal('dnaforge.file-trash.v2'),
      purgeEligible: z.boolean(),
    })
    .strict(),
]);

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function workspaceMoveTreeDigest(
  path: string,
  normalizeHash?: (relative: string, sha: string) => string
): Promise<string> {
  return (await snapshot(path, true, undefined, normalizeHash)).contentDigest;
}

async function snapshot(
  path: string,
  hashContent: boolean,
  originalPath?: string,
  normalizeHash?: (relative: string, sha: string) => string
) {
  let containsSavedEntity = false;
  const content: unknown[] = [],
    stats: unknown[] = [];
  let size = 0;
  let contentHash: string | null = null;
  const walk = async (candidate: string, name: string): Promise<void> => {
    if (originalPath && isSavedEntityMember(join(originalPath, name))) containsSavedEntity = true;
    const before = await lstat(candidate, { bigint: true });
    if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory()))
      throw new Error(
        'UNSUPPORTED_FILE: Trash accepts physical files and directories, without symbolic links.'
      );
    if (basename(candidate) === '.git')
      throw new Error('NESTED_PROJECT: Use the project lifecycle for a project.');
    const type = before.isFile() ? 'file' : 'directory';
    const identity = [
      name,
      type,
      before.dev.toString(),
      before.ino.toString(),
      before.mode.toString(),
      before.size.toString(),
      before.mtimeNs.toString(),
      before.ctimeNs.toString(),
    ];
    stats.push(identity);
    if (before.isDirectory()) {
      content.push([name, type, before.mode.toString()]);
      for (const child of (await readdir(candidate)).sort())
        await walk(join(candidate, child), name ? `${name}/${child}` : child);
    } else {
      size += Number(before.size);
      if (hashContent) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(candidate)) hash.update(chunk);
        const hashed = hash.digest('hex');
        content.push([name, type, before.mode.toString(), normalizeHash?.(name, hashed) ?? hashed]);
        if (!name) contentHash = `sha256:${hashed}`;
      }
    }
    const after = await lstat(candidate, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('FILE_CHANGED: A file changed during inspection. Inspect it again.');
  };
  await walk(path, '');
  return {
    containsSavedEntity,
    contentDigest: digest(content),
    contentHash,
    statDigest: digest(stats),
    size,
    type: (await lstat(path)).isDirectory() ? ('directory' as const) : ('file' as const),
  };
}

async function sourcePath(workspaceRoot: string, input: string) {
  const lexicalRoot = resolve(workspaceRoot);
  const lexicalPath = isAbsolute(input) ? resolve(input) : resolve(lexicalRoot, input);
  const member = relative(lexicalRoot, lexicalPath).split(sep).join('/');
  if (!isSafeWorkspaceRelativePath(member) || member.split('/').some((part) => reserved.has(part)))
    throw new Error(
      'INTERNAL_PROJECT_PATH: Choose an individual workspace entry outside project metadata.'
    );
  await assertPhysicalPackageMember(lexicalRoot, lexicalPath);
  for (let parent = dirname(lexicalPath); parent !== lexicalRoot; parent = dirname(parent)) {
    if (await exists(join(parent, '.forge')))
      throw new Error('PACKAGE_MEMBER: Move the whole native package to Trash.');
  }
  return { root: await realpath(lexicalRoot), path: await realpath(lexicalPath), member };
}

async function storeRoot(root: string, create: boolean) {
  const git = join(root, '.git');
  const gitStat = await lstat(git);
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink())
    throw new Error(
      'NATIVE_PROJECT_REQUIRED: File Trash needs a native project with its own Git directory.'
    );
  const store = join(git, 'dnaforge-file-trash');
  if (create) {
    try {
      await mkdir(store, { mode: 0o700 });
      await syncDirectory(git);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  if (!(await exists(store))) return null;
  const stat = await lstat(store);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('INVALID_TRASH_STORE');
  await assertPhysicalPackageMember(root, store);
  return store;
}

export async function hasWorkspaceFileTrashPayloads(root: string): Promise<boolean> {
  if (!(await exists(join(root, '.git', 'dnaforge-file-trash')))) return false;
  const store = await storeRoot(root, false);
  if (!store) return false;
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !z.string().uuid().safeParse(entry.name).success ||
      (await exists(join(store, entry.name, 'payload')))
    )
      return true;
  }
  return false;
}

async function inspectEntry(root: string, store: string, id: string) {
  const directory = join(store, z.string().uuid().parse(id));
  await assertPhysicalPackageMember(root, directory);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('INVALID_TRASH_ENTRY');
  const recordPath = join(directory, 'record.json');
  await assertPhysicalPackageMember(directory, recordPath);
  const record = recordSchema.parse(JSON.parse(await readFile(recordPath, 'utf8')));
  if (
    record.id !== id ||
    record.workspaceRoot !== root ||
    !isSafeWorkspaceRelativePath(record.originalPath) ||
    record.originalPath.split('/').some((part) => reserved.has(part))
  )
    throw new Error('INVALID_TRASH_RECEIPT');
  const payload = join(directory, 'payload');
  await assertPhysicalPackageMember(directory, payload);
  const state = await snapshot(payload, false);
  if (state.type !== record.type) throw new Error('INVALID_TRASH_PAYLOAD');
  const deletionStarted = await exists(join(directory, 'purging'));
  const entry: FileTrashEntry = {
    id,
    originalPath: record.originalPath,
    type: record.type,
    size: state.size,
    trashedAt: record.trashedAt,
    deletionStarted,
    revision: `file-trash-entry-v1:${digest({ record, stat: state.statDigest, deletionStarted })}`,
  };
  return { directory, record, payload, entry };
}

async function writeJournal(path: string, content: string) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function restoreWithoutOverwrite(
  payload: string,
  destination: string,
  type: 'file' | 'directory'
) {
  if (await exists(destination))
    throw new Error(
      'DESTINATION_EXISTS: The original name is occupied. Rename that entry before restoring.'
    );
  if (type === 'file') {
    try {
      await link(payload, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('DESTINATION_EXISTS: The original name is occupied.');
      throw error;
    }
    await unlink(payload);
    return;
  }
  await mkdir(destination);
  const claim = await lstat(destination);
  try {
    const current = await lstat(destination);
    if (current.dev !== claim.dev || current.ino !== claim.ino)
      throw new Error('DESTINATION_CHANGED');
    await rename(payload, destination);
  } catch (error) {
    const current = await lstat(destination).catch(() => null);
    if (current?.dev === claim.dev && current.ino === claim.ino)
      await rmdir(destination).catch(() => {});
    throw error;
  }
}

export async function runWorkspaceFileTrash(
  input: WorkspaceFileTrashRequest,
  assertCurrent: () => void = () => {},
  documents?: Pick<NativeFileDocumentOwner, 'assertClean' | 'withCleanPaths'>,
  assertMutationAllowed: (
    paths: readonly string[],
    contentPaths?: readonly string[]
  ) => void | Promise<void> = () => {},
  entityOwnsPath?: (originalPath: string) => boolean
): Promise<WorkspaceFileTrashResult> {
  const request = workspaceFileTrashRequestSchema.parse(input);
  if (!isAbsolute(request.workspaceRoot)) throw new Error('Project root must be absolute.');
  const root = await realpath(request.workspaceRoot);
  let mutationStarted = false,
    preparedEntryId: string | undefined;
  const run = () =>
    exclusive<WorkspaceFileTrashResult>(root, async () => {
      if (request.kind === 'inspect' || request.kind === 'trash') {
        const source = await sourcePath(request.workspaceRoot, request.path);
        const state = await snapshot(source.path, true, source.member);
        const revision = `file-trash-source-v1:${digest({ root, path: source.member, stat: state.statDigest, digest: state.contentDigest })}`;
        if (request.kind === 'inspect')
          return {
            kind: 'inspect',
            source: {
              path: source.member,
              type: state.type,
              size: state.size,
              contentHash: state.contentHash,
              revision,
            },
          };
        if (request.expectedRevision !== revision)
          throw new Error(
            'STALE_FILE: The source changed. Inspect it again before moving it to Trash.'
          );
        await documents?.assertClean(source.path);
        await assertMutationAllowed([source.path]);
        assertCurrent();
        if (state.containsSavedEntity || entityOwnsPath?.(source.path))
          throw new Error(retainedEntityMessage);
        if (!entityOwnsPath)
          throw new Error(
            'RETENTION_UNVERIFIED: The saved entity owner is required before moving a file to Trash.'
          );
        const store = (await storeRoot(root, true))!;
        const id = randomUUID(),
          directory = join(store, id);
        preparedEntryId = id;
        await mkdir(directory, { mode: 0o700 });
        await syncDirectory(store);
        const record = {
          schema: 'dnaforge.file-trash.v2',
          purgeEligible: true,
          id,
          workspaceRoot: root,
          originalPath: source.member,
          trashedAt: new Date().toISOString(),
          type: state.type,
          contentDigest: state.contentDigest,
        };
        try {
          await writeJournal(join(directory, 'record.json'), JSON.stringify(record));
          await assertMutationAllowed([source.path]);
          const rechecked = await snapshot(source.path, false, source.member);
          if (rechecked.containsSavedEntity || entityOwnsPath(source.path))
            throw new Error(retainedEntityMessage);
          if (rechecked.statDigest !== state.statDigest)
            throw new Error('STALE_FILE: The source changed before moving to Trash.');
          assertCurrent();
          await rename(source.path, join(directory, 'payload'));
          mutationStarted = true;
        } catch (error) {
          if (await exists(join(directory, 'payload'))) mutationStarted = true;
          else {
            if (await exists(join(directory, 'record.json')))
              await unlink(join(directory, 'record.json'));
            await rmdir(directory);
            await syncDirectory(store);
            preparedEntryId = undefined;
          }
          throw error;
        }
        const warnings: string[] = [];
        try {
          const moved = await snapshot(join(directory, 'payload'), true);
          if (moved.contentDigest !== record.contentDigest) {
            await writeTextFileAtomicInMain({
              path: join(directory, 'record.json'),
              content: JSON.stringify({
                ...record,
                purgeEligible: false,
                contentDigest: moved.contentDigest,
              }),
            });
            warnings.push(
              'The source changed while moving. Its newer bytes are retained in this Trash entry.'
            );
          }
        } catch (error) {
          return {
            kind: 'failed',
            code: 'TRASH_CONTENT_VERIFICATION_FAILED',
            error: String(error),
            stateChanged: true,
            entryId: id,
            path: source.member,
          };
        }
        try {
          await syncDirectory(dirname(source.path));
          await syncDirectory(directory);
        } catch {
          warnings.push(
            'The file moved to Trash, but its directory sync failed. Keep this recovery entry.'
          );
        }
        try {
          return {
            kind: 'trash',
            changed: true,
            entry: (await inspectEntry(root, store, id)).entry,
            warnings,
          };
        } catch (error) {
          return {
            kind: 'failed',
            code: 'TRASH_RECEIPT_FAILED',
            error: String(error),
            stateChanged: true,
            entryId: id,
            path: source.member,
          };
        }
      }

      const store = await storeRoot(root, false);
      if (request.kind === 'list') {
        if (!store) return { kind: 'list', entries: [], errors: [], nextOffset: null };
        const names = (await readdir(store))
          .filter((name) => z.string().uuid().safeParse(name).success)
          .sort();
        const entries: FileTrashEntry[] = [],
          errors: Array<{ entryId: string; error: string }> = [];
        for (const id of names.slice(request.offset, request.offset + request.limit)) {
          try {
            if (!(await exists(join(store, id, 'payload')))) continue;
            entries.push((await inspectEntry(root, store, id)).entry);
          } catch (error) {
            errors.push({ entryId: id, error: String(error) });
          }
        }
        return {
          kind: 'list',
          entries,
          errors,
          nextOffset:
            request.offset + request.limit < names.length ? request.offset + request.limit : null,
        };
      }
      if (!store) throw new Error('TRASH_ENTRY_NOT_FOUND');
      const current = await inspectEntry(root, store, request.entryId);
      if (current.entry.revision !== request.expectedRevision)
        throw new Error('STALE_TRASH_ENTRY: Inspect the current Trash entry before changing it.');
      const contentPaths = [join(root, current.record.originalPath)];
      const mutationPaths = [current.payload, ...contentPaths];
      if (request.kind === 'restore') {
        if ((await snapshot(current.payload, true)).contentDigest !== current.record.contentDigest)
          throw new Error(
            'TRASH_CONTENT_CHANGED: The complete original bytes are no longer present. The recovery entry is retained.'
          );
        const destination = join(root, current.record.originalPath);
        await documents?.assertClean(destination);
        await assertPhysicalPackageMember(root, destination);
        const parent = await lstat(dirname(destination));
        if (!parent.isDirectory() || parent.isSymbolicLink())
          throw new Error('RESTORE_PARENT_MISSING: Restore the parent folder first.');
        await assertMutationAllowed(mutationPaths, contentPaths);
        assertCurrent();
        mutationStarted = true;
        try {
          await restoreWithoutOverwrite(current.payload, destination, current.record.type);
        } catch (error) {
          if (
            (await exists(destination)) &&
            (await exists(current.payload)) &&
            (await lstat(destination)).ino === (await lstat(current.payload)).ino
          )
            return {
              kind: 'failed',
              code: 'RESTORE_PARTIAL',
              error: String(error),
              stateChanged: true,
              entryId: request.entryId,
              path: current.record.originalPath,
            };
          throw error;
        }
        const warnings: string[] = [];
        try {
          await syncDirectory(dirname(destination));
          await syncDirectory(current.directory);
        } catch {
          warnings.push('The file was restored, but its directory sync failed.');
        }
        return {
          kind: 'restore',
          changed: true,
          entryId: request.entryId,
          path: current.record.originalPath,
          warnings,
        };
      }
      await assertMutationAllowed(mutationPaths, contentPaths);
      const payloadState = await snapshot(current.payload, true, current.record.originalPath);
      if (payloadState.containsSavedEntity || entityOwnsPath?.(contentPaths[0]))
        throw new Error(retainedEntityMessage);
      if (
        !entityOwnsPath ||
        current.record.schema !== 'dnaforge.file-trash.v2' ||
        !current.record.purgeEligible
      )
        throw new Error(
          'RETENTION_UNVERIFIED: This Trash entry has no verified deletion eligibility. Keep its contents or restore it.'
        );
      if (payloadState.contentDigest !== current.record.contentDigest)
        throw new Error(
          'RETENTION_UNVERIFIED: The contents of this Trash entry have changed. Keep the recovery entry.'
        );
      assertCurrent();
      mutationStarted = true;
      try {
        if (!current.entry.deletionStarted)
          await writeJournal(join(current.directory, 'purging'), new Date().toISOString());
        await assertMutationAllowed(mutationPaths, contentPaths);
        if (entityOwnsPath(contentPaths[0])) throw new Error(retainedEntityMessage);
        assertCurrent();
        await rm(current.payload, { recursive: true });
        await syncDirectory(current.directory);
        return { kind: 'purge', changed: true, entryId: request.entryId, warnings: [] };
      } catch (error) {
        return {
          kind: 'failed',
          code: 'PURGE_INCOMPLETE',
          error: String(error),
          stateChanged: 'unknown',
          entryId: request.entryId,
        };
      }
    });
  const protect = async () => {
    let path: string | undefined;
    if (request.kind === 'trash')
      path = (await sourcePath(request.workspaceRoot, request.path)).path;
    else if (request.kind === 'restore') {
      const store = await storeRoot(root, false);
      if (!store) throw new Error('TRASH_ENTRY_NOT_FOUND');
      path = join(root, (await inspectEntry(root, store, request.entryId)).record.originalPath);
    }
    return documents && path ? documents.withCleanPaths([path], run) : run();
  };
  return protect().catch((error) => {
    if (request.kind === 'inspect' || request.kind === 'list') throw error;
    const message = error instanceof Error ? error.message : String(error);
    const code = /^[A-Z_]+(?=:|$)/.exec(message)?.[0] ?? 'FILE_LIFECYCLE_FAILED';
    const unchanged = [
      'STALE_FILE',
      'STALE_TRASH_ENTRY',
      'DESTINATION_EXISTS',
      'PACKAGE_MEMBER',
      'INTERNAL_PROJECT_PATH',
      'TRASH_CONTENT_CHANGED',
      'NATIVE_PROJECT_REQUIRED',
    ].includes(code);
    return {
      kind: 'failed' as const,
      code,
      error: message,
      stateChanged: !mutationStarted || unchanged ? false : ('unknown' as const),
      entryId: 'entryId' in request ? request.entryId : preparedEntryId,
    };
  });
}
