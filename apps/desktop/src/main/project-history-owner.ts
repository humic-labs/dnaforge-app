import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  projectHistoryRequestSchema,
  type ProjectHistoryEntry,
  type ProjectHistoryInspection,
  type ProjectHistoryRequest,
  type ProjectHistoryResult,
} from '../shared/project-history';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import { WORKSPACE_GIT_AUTHOR } from '../shared/workspace-git-author';
import { assertPhysicalWriteDestination } from './workspace-git/package-member-boundary';
import { withManagedWorkspaceMutationLock } from './workspace-git';
import { executeManagedGit } from './workspace-git/native';
import { writeTextFileAtomicInMain } from './text-file-atomic';
import { syncDirectory } from './fs-durability';

const reserved = new Set(['.git', '.forge', '.dnaforge', '.waypoint', '.waypoint-workspace']);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Git = typeof executeManagedGit;
type Row = { path: string; code: string; selection: string };
type Snapshot = { inspection: ProjectHistoryInspection; index: string; rows: Row[] };

function safePath(path: string): boolean {
  return (
    isSafeWorkspaceRelativePath(path) &&
    !path.includes('\0') &&
    !path.includes('\\') &&
    !path.startsWith(':') &&
    !reserved.has(path.split('/')[0] ?? '')
  );
}

function failure(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

async function fileIdentity(root: string, path: string): Promise<unknown> {
  const absolute = join(root, path);
  await assertPhysicalWriteDestination(root, absolute);
  const before = await lstat(absolute, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!before) return [path, 'missing'];
  if (!before.isFile() && !before.isSymbolicLink())
    return [path, 'non-file', before.mode.toString()];
  const digest = createHash('sha256');
  if (before.isSymbolicLink()) digest.update(await readlink(absolute));
  else for await (const chunk of createReadStream(absolute)) digest.update(chunk);
  const after = await lstat(absolute, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    failure('PROJECT_FILE_CHANGED', 'A file changed during inspection. Inspect again.');
  return [
    path,
    before.mode.toString(),
    before.dev.toString(),
    before.ino.toString(),
    before.size.toString(),
    before.mtimeNs.toString(),
    before.ctimeNs.toString(),
    digest.digest('hex'),
  ];
}

async function selectionPath(root: string, path: string): Promise<string> {
  let parent = dirname(join(root, path));
  while (parent !== root) {
    if (existsSync(join(parent, '.forge'))) return relative(root, parent).split(sep).join('/');
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return path;
}

function page(
  snapshot: ProjectHistoryInspection,
  offset = 0,
  limit = 100
): ProjectHistoryInspection {
  return {
    ...snapshot,
    entries: snapshot.entries.slice(offset, offset + limit),
    nextOffset: offset + limit < snapshot.entries.length ? offset + limit : null,
  };
}

export class ProjectHistoryOwner {
  constructor(private readonly git: Git = executeManagedGit) {}

  async run(
    input: ProjectHistoryRequest,
    assertCurrent: () => void,
    assertSaved?: (root: string, paths: readonly string[]) => Promise<void>
  ): Promise<ProjectHistoryResult> {
    let paths: string[] = [];
    let changed: boolean | 'unknown' = false;
    let commitOid: string | undefined;
    let operation: ProjectHistoryRequest['operation']['kind'] = input.operation.kind;
    try {
      const request = projectHistoryRequestSchema.parse(input);
      operation = request.operation.kind;
      if (!isAbsolute(request.workspaceRoot))
        failure('PROJECT_ROOT_REQUIRED', 'Choose an exact absolute project root.');
      assertCurrent();
      const root = await realpath(request.workspaceRoot);
      assertCurrent();
      return await withManagedWorkspaceMutationLock<ProjectHistoryResult>(root, async () => {
        const git = async (args: readonly string[]) => {
          assertCurrent();
          const result = await this.git(root, args);
          assertCurrent();
          return result;
        };
        const inspect = () => this.snapshot(root, git, assertCurrent);
        const initial = await inspect();
        const op = request.operation;
        if (op.kind === 'inspect')
          return {
            status: 'ok',
            operation,
            inspection: page(initial.inspection, op.offset, op.limit),
            stateChanged: false,
            paths,
            warnings: [],
          };
        if (initial.inspection.revision !== op.expectedRevision)
          failure(
            'STALE_PROJECT_HISTORY',
            'Project files, staging or HEAD changed. Inspect again.'
          );
        const mutate = async (args: readonly string[], confirmed?: () => void) => {
          assertCurrent();
          changed = 'unknown';
          const result = await this.git(root, args);
          changed = true;
          confirmed?.();
          assertCurrent();
          return result;
        };
        const mutateIndex = async (args: readonly string[], expected: Snapshot) => {
          const gitDirectory = (await git(['rev-parse', '--absolute-git-dir'])).trim();
          const indexPath = join(gitDirectory, 'index');
          const lockPath = `${indexPath}.lock`;
          const candidate = join(gitDirectory, `dnaforge-history-index-${randomUUID()}`);
          const lock = await open(lockPath, 'wx', 0o600);
          const identity = await lock.stat({ bigint: true });
          let candidateOwned = false;
          let lockClosed = false;
          const ownsLock = async () => {
            const current = await lstat(lockPath, { bigint: true }).catch(() => null);
            return current?.dev === identity.dev && current.ino === identity.ino;
          };
          try {
            assertCurrent();
            if ((await inspect()).inspection.revision !== expected.inspection.revision)
              failure('STALE_PROJECT_HISTORY', 'Project history changed before staging.');
            const original = await readFile(indexPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            });
            const empty = Buffer.alloc(12);
            empty.write('DIRC', 'ascii');
            empty.writeUInt32BE(2, 4);
            const candidateFile = await open(candidate, 'wx', 0o600);
            candidateOwned = true;
            try {
              await candidateFile.writeFile(
                original ?? Buffer.concat([empty, createHash('sha1').update(empty).digest()])
              );
            } finally {
              await candidateFile.close();
            }
            assertCurrent();
            await this.git(root, args, { indexFile: candidate });
            assertCurrent();
            if ((await inspect()).inspection.revision !== expected.inspection.revision)
              failure(
                'STALE_PROJECT_HISTORY',
                'Project files changed while preparing staging; the index is unchanged.'
              );
            const prepared = await readFile(candidate);
            const current = await readFile(indexPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            });
            if (original === null ? current !== null : !current?.equals(original))
              failure('STALE_PROJECT_HISTORY', 'The native index changed while preparing staging.');
            await lock.writeFile(prepared);
            await lock.sync();
            assertCurrent();
            if (!(await ownsLock()))
              failure('PROJECT_INDEX_LOCK_CHANGED', 'The staging lock changed ownership.');
            await lock.close();
            lockClosed = true;
            assertCurrent();
            await rename(lockPath, indexPath);
            changed = true;
            await syncDirectory(gitDirectory);
            assertCurrent();
          } finally {
            if (!lockClosed) await lock.close().catch(() => undefined);
            if (await ownsLock()) await unlink(lockPath);
            if (candidateOwned) await unlink(candidate).catch(() => undefined);
          }
        };
        if (op.kind === 'initialize') {
          if (initial.inspection.tracked)
            failure('PROJECT_ALREADY_TRACKED', 'The project already has a repository.');
          await mutate(['init']);
          const ignore = join(root, '.gitignore');
          if (!existsSync(ignore)) {
            await writeTextFileAtomicInMain(
              {
                path: ignore,
                content:
                  '*.bam\n*.sam\n*.bed\n*.vcf.gz\n.DS_Store\nThumbs.db\n.waypoint-workspace\n',
              },
              {
                beforePublish: () => {
                  assertCurrent();
                  if (existsSync(ignore))
                    failure('PROJECT_FILE_CHANGED', 'A .gitignore appeared during initialization.');
                },
              }
            );
            assertCurrent();
          }
        } else if (!initial.inspection.tracked)
          failure('PROJECT_NOT_TRACKED', 'Initialize this project before staging or committing.');
        let current = op.kind === 'initialize' ? await inspect() : initial;
        const selected =
          'paths' in op ? op.paths : current.inspection.entries.map((entry) => entry.path);
        paths = [...new Set(selected)].sort();
        if (!paths.length && op.kind !== 'initialize')
          failure('PROJECT_SELECTION_EMPTY', 'Select at least one changed file.');
        for (const path of paths) {
          if (!safePath(path) || !current.inspection.entries.some((entry) => entry.path === path))
            failure(
              'PROJECT_PATH_NOT_INSPECTED',
              'Select exact inspected files or whole native packages.'
            );
          await assertPhysicalWriteDestination(root, join(root, path));
          assertCurrent();
        }
        if (op.kind !== 'unstage') {
          await assertSaved?.(root, paths);
          assertCurrent();
        }
        if (op.kind === 'stage' || op.kind === 'save-all' || op.kind === 'initialize') {
          if (paths.length) await mutateIndex(['add', '--', ...paths], current);
          current = await inspect();
        } else if (op.kind === 'unstage') {
          await mutateIndex(
            current.inspection.head
              ? ['restore', '--staged', '--source=HEAD', '--', ...paths]
              : [
                  'update-index',
                  '--force-remove',
                  '--',
                  ...current.rows
                    .filter((row) => paths.includes(row.selection))
                    .map((row) => row.path),
                ],
            current
          );
          current = await inspect();
        }
        if (op.kind === 'commit' || op.kind === 'save-all' || op.kind === 'initialize') {
          const staged = current.inspection.entries
            .filter((entry) => entry.staged)
            .map((entry) => entry.path)
            .sort();
          if (
            current.inspection.protectedStagedPaths.length ||
            staged.join('\0') !== paths.join('\0')
          )
            failure(
              'PROJECT_INDEX_SELECTION_MISMATCH',
              'Selected paths must exactly match all staged entries; unstage unrelated content first.'
            );
          if (staged.length) {
            const tree = (await git(['write-tree'])).trim();
            const checkedIndex = await git(['ls-files', '--stage', '-z']);
            if (checkedIndex !== current.index)
              failure('STALE_PROJECT_HISTORY', 'The native index changed before commit.');
            const message =
              op.kind === 'initialize'
                ? 'Initial DNAForge tracking'
                : (op.message ?? `Save ${paths.length} file${paths.length === 1 ? '' : 's'}`);
            const oid = (
              await git([
                '-c',
                `user.name=${WORKSPACE_GIT_AUTHOR.name}`,
                '-c',
                `user.email=${WORKSPACE_GIT_AUTHOR.email}`,
                'commit-tree',
                tree,
                ...(current.inspection.head ? ['-p', current.inspection.head] : []),
                '-m',
                message,
              ])
            ).trim();
            if (!/^[a-f0-9]{40}$/u.test(oid))
              failure(
                'PROJECT_COMMIT_UNCONFIRMED',
                'Git did not return the prepared commit identity.'
              );
            const latest = await inspect();
            if (latest.inspection.revision !== current.inspection.revision)
              failure(
                'STALE_PROJECT_HISTORY',
                'Project files, staging or HEAD changed before commit.'
              );
            await mutate(
              [
                'update-ref',
                '-m',
                message,
                current.inspection.branch ?? 'HEAD',
                oid,
                current.inspection.head ?? '0000000000000000000000000000000000000000',
              ],
              () => {
                commitOid = oid;
              }
            );
            current = await inspect();
          }
        }
        return {
          status: 'ok',
          operation,
          inspection: page(current.inspection),
          stateChanged: Boolean(changed),
          paths,
          ...(commitOid ? { commitOid } : {}),
          warnings:
            commitOid && current.inspection.head !== commitOid
              ? ['The commit was saved to its inspected branch; the current checkout has changed.']
              : [],
        };
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return {
        status: 'failed',
        operation,
        code: /^([A-Z][A-Z0-9_]+):/u.exec(text)?.[1] ?? 'PROJECT_HISTORY_FAILED',
        error: text,
        stateChanged: changed,
        paths,
        ...(commitOid ? { commitOid } : {}),
      };
    }
  }

  private async snapshot(
    root: string,
    git: (args: readonly string[]) => Promise<string>,
    assertCurrent: () => void
  ): Promise<Snapshot> {
    const tracked = existsSync(join(root, '.git'));
    if (!tracked) {
      const files: unknown[] = [];
      const walk = async (path: string): Promise<void> => {
        const absolute = join(root, path);
        await assertPhysicalWriteDestination(root, absolute);
        const stat = await lstat(absolute, { bigint: true });
        if (stat.isDirectory()) {
          files.push([
            path,
            'directory',
            stat.dev.toString(),
            stat.ino.toString(),
            stat.mtimeNs.toString(),
            stat.ctimeNs.toString(),
          ]);
          for (const name of (await readdir(absolute)).sort())
            if (name !== '.git') await walk(`${path}/${name}`);
        } else files.push(await fileIdentity(root, path));
        assertCurrent();
      };
      for (const name of (await readdir(root)).sort()) if (safePath(name)) await walk(name);
      assertCurrent();
      return {
        inspection: {
          workspaceRoot: root,
          tracked: false,
          head: null,
          branch: null,
          revision: `project-history-v1:${hash([root, files])}`,
          entries: [],
          totalEntries: 0,
          nextOffset: null,
          protectedStagedPaths: [],
        },
        rows: [],
        index: '',
      };
    }
    const top = (await git(['rev-parse', '--show-toplevel'])).trim();
    if ((await realpath(top)) !== root)
      failure('PROJECT_ROOT_REQUIRED', 'The selected directory is not the exact repository root.');
    assertCurrent();
    let head: string | null;
    try {
      head = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'])).trim();
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 1)) throw error;
      head = null;
    }
    let branch: string | null;
    try {
      branch = (await git(['symbolic-ref', '--quiet', 'HEAD'])).trim();
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 1)) throw error;
      branch = null;
    }
    const index = await git(['ls-files', '--stage', '-z']);
    const status = await git([
      'status',
      '--porcelain=v1',
      '-z',
      '--no-renames',
      '--untracked-files=all',
    ]);
    const rows: Row[] = [];
    const identities: unknown[] = [];
    const entries = new Map<string, ProjectHistoryEntry>();
    const protectedStagedPaths: string[] = [];
    for (const raw of status.split('\0').filter(Boolean)) {
      const path = raw.slice(3),
        code = raw.slice(0, 2);
      const staged = code[0] !== ' ' && code[0] !== '?' && code[0] !== '!';
      if (!safePath(path)) {
        if (staged) protectedStagedPaths.push(path);
        continue;
      }
      const selection = await selectionPath(root, path);
      identities.push(await fileIdentity(root, path));
      assertCurrent();
      rows.push({ path, code, selection });
      const prior = entries.get(selection);
      entries.set(selection, {
        path: selection,
        status:
          code === '??'
            ? 'untracked'
            : code.includes('D')
              ? 'deleted'
              : code.includes('A')
                ? 'added'
                : 'modified',
        staged: staged || !!prior?.staged,
        unstaged: code[1] !== ' ' || !!prior?.unstaged,
        package: selection !== path || !!prior?.package,
      });
    }
    const values = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
    return {
      inspection: {
        workspaceRoot: root,
        tracked: true,
        head,
        branch,
        revision: `project-history-v1:${hash([root, head, branch, index, status, identities])}`,
        entries: values,
        totalEntries: values.length,
        nextOffset: null,
        protectedStagedPaths,
      },
      rows,
      index,
    };
  }
}

const projectHistory = new ProjectHistoryOwner();
export const runProjectHistory = (
  input: ProjectHistoryRequest,
  assertCurrent: () => void,
  assertSaved?: (root: string, paths: readonly string[]) => Promise<void>
) => projectHistory.run(input, assertCurrent, assertSaved);
