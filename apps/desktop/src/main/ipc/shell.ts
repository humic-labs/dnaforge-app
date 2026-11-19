import { assertSafeWritablePath } from './path-allowlist';
import { savedFileSourceRequest } from '../../shared/saved-file-source-command';
import { runSavedFileSourceCommand } from '../saved-file-source-command';
import { nativeDocuments } from '../features/native-documents';
import { handleGroup, mainIpc } from '../../shared/ipc-contract';
import { app, clipboard, shell } from 'electron';
import { executeManagedGitProcess } from '../workspace-git/native';
import { join, resolve } from 'node:path';
import { assertAllowedGitInvocation } from './allowed-git-invocation';
import { WORKSPACE_GIT_AUTHOR } from '../../shared/workspace-git-author';
import { assertSafePath, getAllowedRoots, withSafeWritablePath } from './path-allowlist';
import { getDb } from './database';
import { assertSystemTrashAllowed, workspaceEntityOwnsPath } from '../saved-entity-file-retention';
import { trashAcceptedScientificPath } from '../scientific-resource-lifecycle';
import {
  withKnownWorkspacePathMutation,
  findKnownWorkspaceRoot,
} from '../workspace-sync-mutation-lease';
import {
  assertUnversionedRendererFilesystemMutationAllowed,
  assertWorkspaceFileTrashMutationAllowed,
  withDeclaredRendererWorkspaceMutation,
  withKnownRendererFilesystemMutation,
} from './workspace-mutation-authority';
import { assertKnownWorkspaceContentWritable } from '../workspace-content-write-access';
import { assertCommittedDatabaseReadAllowed } from '../workspace-sync-database-fence';
import { GitReadRequestOwner } from './git-read-request-owner';
import { readGitHeadFromAllowedRoots } from './git-read-path-canonicalizer';
import {
  resolveGitReadProcessGuardian,
  resolveGitReadWorkerPath,
} from './git-read-process-guardian';
import {
  GIT_READ_MAX_ACTIVE,
  GIT_READ_MAX_PATH_CODE_UNITS,
  GIT_READ_MAX_QUEUED,
} from './git-read-policy';
import { clipboardContract } from '../../shared/ipc/clipboard.contract';
import { shellContract } from '../../shared/ipc/shell.contract';
import { workspaceFileTrashRequestSchema } from '../../shared/workspace-file-trash';
import { runWorkspaceFileTrash } from '../workspace-file-trash';
import { projectHistoryRequestSchema } from '../../shared/project-history';

const MAX_GIT_BUFFER = 256 * 1024 * 1024;
const gitReadRequestOwner = new GitReadRequestOwner({
  maxActive: GIT_READ_MAX_ACTIVE,
  maxQueued: GIT_READ_MAX_QUEUED,
  timeoutMs: 30_000,

  hardKillGraceMs: 5_000,
});

export async function shutdownGitReadRequests(): Promise<void> {
  await gitReadRequestOwner.cancelAll();
}

function bindShellContentWrite(path: string): () => void {
  const db = getDb();
  assertCommittedDatabaseReadAllowed(db);
  const root = findKnownWorkspaceRoot(db, path);
  const assertCurrent = () => {
    assertCommittedDatabaseReadAllowed(db);
    const current = findKnownWorkspaceRoot(db, path);
    if (current !== root)
      throw new Error('The owning project changed while waiting for its shell operation.');
    if (current) assertKnownWorkspaceContentWritable(db, current);
  };
  assertCurrent();
  return assertCurrent;
}

export function registerShellHandlers(): void {
  handleGroup(clipboardContract, {
    writeText: async (_event, text: string): Promise<void> => {
      if (typeof text !== 'string') throw new Error('Clipboard text must be a string.');
      if (text.length > 1_000_000) throw new Error('Clipboard text is too large.');
      await clipboard.writeText(text);
    },
  });

  const ALLOWED_PROGRAMS = new Set(['git']);

  const FORBIDDEN_GIT_ARG = /^(-c|--exec-path|--upload-pack|--receive-pack)(=|$)|^ext::/i;
  handleGroup(shellContract, {
    savedFileSource: async (event, input) => {
      const req = savedFileSourceRequest.parse(input),
        db = getDb();
      if (req.workspaceRoot === null) {
        const root = join(app.getPath('userData'), 'Track views');
        if (req.operation.kind === 'restore')
          await assertSafeWritablePath(join(root, req.operation.destination), {
            requireAbsolute: true,
          });
        return runSavedFileSourceCommand(db, req, {
          root,
          workspaceId: null,
          assertCurrent: () => assertCommittedDatabaseReadAllowed(db),
        });
      }
      const root = await assertSafePath(req.workspaceRoot, { requireAbsolute: true }),
        scoped = { ...req, workspaceRoot: root };
      if (req.operation.kind === 'versions')
        return nativeDocuments.workspaceCommands.runFileSource(scoped);
      const dest = await assertSafeWritablePath(join(root, req.operation.destination), {
        requireAbsolute: true,
      });
      return nativeDocuments.workspaceCommands.runFileSource(scoped, (operation) =>
        withDeclaredRendererWorkspaceMutation({
          db,
          ownerId: event.sender.id,
          workspaceRoot: root,
          mutationPaths: [dest],
          fileWrite: true,
          operation,
        })
      );
    },
    projectHistory: async (event, input) => {
      const request = projectHistoryRequestSchema.parse(input);
      const root = await assertSafePath(request.workspaceRoot, { requireAbsolute: true });
      const scoped = { ...request, workspaceRoot: root };
      if (request.operation.kind === 'inspect')
        return nativeDocuments.workspaceCommands.runHistory(scoped);
      return nativeDocuments.workspaceCommands.runHistory(scoped, (operation) =>
        withDeclaredRendererWorkspaceMutation({
          db: getDb(),
          ownerId: event.sender.id,
          workspaceRoot: root,
          mutationPaths: [root],
          mutationToken: request.mutationToken,
          operation,
        })
      );
    },
    fileTrash: async (event, input) => {
      const request = workspaceFileTrashRequestSchema.parse(input);
      const root = await assertSafePath(request.workspaceRoot, { requireAbsolute: true });
      const db = getDb();
      assertCommittedDatabaseReadAllowed(db);
      if (findKnownWorkspaceRoot(db, root) !== root)
        throw new Error(
          'WORKSPACE_MUTATION_UNKNOWN_WORKSPACE: Choose an exact active project root.'
        );
      if (request.kind === 'inspect' || request.kind === 'list')
        return runWorkspaceFileTrash(request);
      const assertCurrent = bindShellContentWrite(root);
      return withDeclaredRendererWorkspaceMutation({
        db,
        ownerId: event.sender.id,
        workspaceRoot: root,
        mutationPaths: [root],
        mutationToken: request.mutationToken,
        operation: () =>
          runWorkspaceFileTrash(
            request,
            assertCurrent,
            nativeDocuments.fileDocuments,
            async (paths, contentPaths = paths) => {
              assertCurrent();
              await assertWorkspaceFileTrashMutationAllowed(
                db,
                event.sender.id,
                paths,
                contentPaths
              );
            },
            (path) => workspaceEntityOwnsPath(db, root, path)
          ),
      });
    },
    revealItemInDir: async (_event, path: string) => {
      await assertSafePath(path);
      shell.showItemInFolder(path);
    },
    trashItem: async (event, path: string, mutationToken?: string) => {
      return withSafeWritablePath(path, async (safePath) => {
        return nativeDocuments.fileDocuments.withCleanPaths([safePath], async () => {
          await nativeDocuments.fileDocuments.assertClean(safePath);
          const assertCurrent = bindShellContentWrite(safePath);
          if (
            await trashAcceptedScientificPath({
              db: getDb(),
              path: safePath,
              renderer: { ownerId: event.sender.id, ...(mutationToken ? { mutationToken } : {}) },
            })
          )
            return;
          return withKnownRendererFilesystemMutation({
            db: getDb(),
            ownerId: event.sender.id,
            paths: [safePath],
            mutationToken,
            operation: async () => {
              await assertSystemTrashAllowed(getDb(), safePath);
              assertCurrent();
              return shell.trashItem(safePath);
            },
          });
        });
      });
    },
    execute: async (
      event,
      program: string,
      args: string[],
      cwd: string,
      mutationToken?: string
    ): Promise<{ stdout: string; stderr: string; code: number }> => {
      if (!ALLOWED_PROGRAMS.has(program)) {
        throw new Error(`Program not allowed: ${program}`);
      }
      if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
        throw new Error('shell:execute requires string args');
      }
      if (args.some((a) => FORBIDDEN_GIT_ARG.test(a))) {
        throw new Error('shell:execute: disallowed git argument');
      }
      const access = assertAllowedGitInvocation(args, cwd);
      const executeGit = async (safeCwd: string, assertCurrent: () => void = () => {}) => {
        const gitArgs = [...(access === 'read' ? ['--no-optional-locks'] : []), ...args];
        const run = async (invocation: string[]) => {
          try {
            const result = await executeManagedGitProcess(safeCwd, invocation, {
              maxBuffer: MAX_GIT_BUFFER,
            });
            return { ...result, exitCode: 0 };
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number')
              throw error;
            return {
              stdout: 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '',
              stderr:
                'stderr' in error && typeof error.stderr === 'string'
                  ? error.stderr
                  : error.message,
              exitCode: error.code,
            };
          }
        };
        try {
          assertCurrent();
          let result = await run(gitArgs);

          if (
            args[0] === 'commit' &&
            result.exitCode !== 0 &&
            /(?:author|committer) identity unknown|unable to auto-detect email address|empty ident name.*not allowed/i.test(
              result.stderr
            )
          ) {
            assertCurrent();
            result = await run([
              '-c',
              `user.name=${WORKSPACE_GIT_AUTHOR.name}`,
              '-c',
              `user.email=${WORKSPACE_GIT_AUTHOR.email}`,
              ...gitArgs,
            ]);
          }
          return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { stdout: '', stderr: message, code: 127 };
        }
      };
      const pathOptions = {
        requireAbsolute: true,
        errorPrefix: 'shell:execute cwd',
      } as const;
      const withWorkspaceLease = (safeCwd: string, run: () => ReturnType<typeof executeGit>) => {
        if (mutationToken) {
          return withDeclaredRendererWorkspaceMutation({
            db: getDb(),
            ownerId: event.sender.id,
            workspaceRoot: safeCwd,
            mutationPaths: [safeCwd],
            mutationToken,
            operation: run,
          });
        }
        return withKnownWorkspacePathMutation(getDb(), [safeCwd], run);
      };
      if (access === 'read') {
        const safeCwd = await assertSafePath(cwd, pathOptions);
        const run = () => executeGit(safeCwd);
        return args.length === 1 && args[0] === '--version'
          ? run()
          : withWorkspaceLease(safeCwd, run);
      }
      return withSafeWritablePath(
        cwd,
        (safeCwd) => {
          const assertCurrent = bindShellContentWrite(safeCwd);
          const run = async (): Promise<{ stdout: string; stderr: string; code: number }> => {
            assertCurrent();
            if (args[0] === 'checkout') {
              const operand = args[2];
              if (typeof operand !== 'string')
                throw new Error('Git checkout requires its saved-file path.');
              await assertUnversionedRendererFilesystemMutationAllowed(getDb(), event.sender.id, [
                resolve(safeCwd, operand),
              ]);
            }
            return executeGit(safeCwd, assertCurrent);
          };
          return withWorkspaceLease(safeCwd, run);
        },
        pathOptions
      );
    },
    readGitHead: async (event, filePath: string, requestId: string): Promise<string | null> => {
      if (
        typeof filePath !== 'string' ||
        filePath.length === 0 ||
        filePath.length > GIT_READ_MAX_PATH_CODE_UNITS
      ) {
        throw new Error('shell:readGitHead file path is invalid or too large.');
      }
      return gitReadRequestOwner.run({
        sender: event.sender,
        requestId,
        execute: ({ signal, bindProcess }): Promise<string | null> =>
          readGitHeadFromAllowedRoots({
            filePath,
            allowedRoots: getAllowedRoots(),
            errorPrefix: 'shell:readGitHead file',
            control: { signal, bindProcess },
            workerScriptPath: app.isPackaged
              ? join(process.resourcesPath, 'git-read-worker.cjs')
              : resolveGitReadWorkerPath(app.getAppPath()),
            guardianExecutable: resolveGitReadProcessGuardian({
              appPath: app.getAppPath(),
              resourcesPath: process.resourcesPath,
              isPackaged: app.isPackaged,
              explicitPath: process.env.DNAFORGE_GIT_READ_GUARDIAN_PATH,
            }),
          }),
      });
    },
    cancelGitRead: async (event, requestId: string, closeGestureToken?: string): Promise<boolean> =>
      gitReadRequestOwner.cancel(event.sender.id, requestId, closeGestureToken),
  });

  mainIpc.handle('shell:getGitReadLifecycleSnapshot', async () => gitReadRequestOwner.snapshot());
}
