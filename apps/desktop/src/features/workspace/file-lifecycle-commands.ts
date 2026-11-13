import { userMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { captureWorkspaceSessionIntent } from '../workspace-session/public/electron-session';
import { isHostedBrowserRuntime } from '../../utils/environment';
import { platform } from '../../platform';
import { confirmDialog } from '../../components/confirm-dialog-store';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { reconcileWorkspaceAfterFilesChanged } from '../../services/workspace-operations';
import { markCatalogPathMissing } from '../../db/workspace-catalog';
import { assertWorkspaceDocumentsClean } from './workspace-document-guards';
import type {
  WorkspaceFileTrashRequest,
  WorkspaceFileTrashResult,
  FileTrashEntry,
} from '../../shared/workspace-file-trash';

type Mutation = Extract<WorkspaceFileTrashRequest, { kind: 'trash' | 'restore' | 'purge' }>;
export class FileLifecycleError extends Error {
  constructor(readonly receipt: Extract<WorkspaceFileTrashResult, { kind: 'failed' }>) {
    super(receipt.error);
    this.name = 'FileLifecycleError';
  }
}

export async function inspectFileLifecycle(workspaceRoot: string, path: string) {
  const result = await platform().shell.fileTrash({ kind: 'inspect', workspaceRoot, path });
  if (result.kind !== 'inspect') throw new Error('Native file inspection did not complete.');
  return result.source;
}

export async function listFileTrash(workspaceRoot: string, offset = 0) {
  const result = await platform().shell.fileTrash({
    kind: 'list',
    workspaceRoot,
    offset,
    limit: 50,
  });
  if (result.kind !== 'list') throw new Error('Native File Trash could not be read.');
  return result;
}

export async function mutateFileLifecycle(
  input: Mutation,
  signal?: AbortSignal
): Promise<WorkspaceFileTrashResult | null> {
  signal?.throwIfAborted();
  let restorePath: string | null = null;
  if (input.kind === 'purge' || input.kind === 'restore') {
    let offset = 0,
      entry: FileTrashEntry | undefined;
    for (;;) {
      const page = await listFileTrash(input.workspaceRoot, offset);
      entry = page.entries.find((entry) => entry.id === input.entryId);
      if (entry || page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    if (!entry || entry.revision !== input.expectedRevision)
      throw new FileLifecycleError({
        kind: 'failed',
        code: 'STALE_TRASH_ENTRY',
        error: 'Inspect the current Trash entry before changing it.',
        stateChanged: false,
        entryId: input.entryId,
      });
    if (input.kind === 'restore')
      restorePath = `${input.workspaceRoot.replace(/[\\/]+$/, '')}/${entry.originalPath}`;
    if (
      input.kind === 'purge' &&
      !(await confirmDialog({
        title: userMessage('dialog.delete-permanently'),
        message: userMessageWithValues('file.purgeConfirm', {
          path: userMessageValue(entry.originalPath),
          project: userMessageValue(input.workspaceRoot),
        }),
        confirmLabel: userMessage('dialog.delete-permanently'),
        cancelLabel: userMessage('dialog.cancel'),
        tone: 'danger',
        safeDefault: true,
        signal,
      }))
    )
      return null;
  }
  return withRendererWorkspaceMutation(input.workspaceRoot, async (mutationToken) => {
    signal?.throwIfAborted();
    const path = input.kind === 'trash' ? input.path : restorePath;
    if (path) {
      try {
        await assertWorkspaceDocumentsClean(path);
      } catch (error) {
        throw new FileLifecycleError({
          kind: 'failed',
          code: 'DIRTY_FILE_DRAFT',
          error: error instanceof Error ? error.message : String(error),
          stateChanged: false,
          path,
        });
      }
    }
    const result = await platform().shell.fileTrash({ ...input, mutationToken });
    if (result.kind === 'failed') throw new FileLifecycleError(result);
    if (result.kind === 'inspect' || result.kind === 'list')
      throw new Error('The native file operation did not complete.');
    if (result.kind === 'purge') return result;
    const warnings = [...result.warnings];
    if (result.kind === 'trash') {
      try {
        await markCatalogPathMissing(input.kind === 'trash' ? input.path : '', 'moved-to-trash');
      } catch {
        warnings.push('The file moved to Trash, but its catalog refresh failed.');
      }
    }
    try {
      await reconcileWorkspaceAfterFilesChanged({
        workspaceRoot: input.workspaceRoot,
        mutationToken,
        strict: true,
        notifyGitStatus: true,
      });
    } catch {
      warnings.push('The file operation completed, but the project display could not refresh.');
    }
    return { ...result, warnings };
  });
}

export async function trashWorkspaceFile(workspaceRoot: string, path: string) {
  const source = await inspectFileLifecycle(workspaceRoot, path);
  return mutateFileLifecycle({
    kind: 'trash',
    workspaceRoot,
    path,
    expectedRevision: source.revision,
  });
}

export async function deleteWorkspaceFile(
  workspaceRoot: string,
  path: string
): Promise<{ kind: 'trash' | 'version-delete'; warnings: string[] } | null> {
  if (!isHostedBrowserRuntime()) {
    const result = await trashWorkspaceFile(workspaceRoot, path);
    if (result === null) return null;
    if (result.kind !== 'trash') throw new Error('The file deletion did not complete.');
    return { kind: 'trash', warnings: result.warnings };
  }
  const assertIntentCurrent = captureWorkspaceSessionIntent();
  if (
    path === workspaceRoot ||
    !(await platform().fs.validateWorkspacePath({ workspaceRoot, path }))
  ) {
    throw new Error('Choose a file in the same mounted hosted project.');
  }
  assertIntentCurrent();
  await assertWorkspaceDocumentsClean(path);
  assertIntentCurrent();
  await platform().shell.trashItem(path);
  assertIntentCurrent();
  const warnings: string[] = [];
  try {
    await markCatalogPathMissing(path, 'deleted');
  } catch {
    warnings.push('The file was deleted, but its catalog refresh failed.');
  }
  try {
    await reconcileWorkspaceAfterFilesChanged({
      workspaceRoot,
      strict: true,
      notifyGitStatus: true,
    });
  } catch {
    warnings.push('The file was deleted, but the project display could not refresh.');
  }
  assertIntentCurrent();
  return { kind: 'version-delete', warnings };
}
