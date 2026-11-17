import type { WebContents } from 'electron';
import { notebookContract } from '../../shared/ipc/notebook.contract';
import { handleGroup, sendRendererIpc } from '../../shared/ipc-contract';
import type { NativeNotebookWorkingCopyOwner } from '../notebook-document-owner';
import { NativeDocumentCommandError } from '../../shared/native-document-error';
import type { MarkdownNotebookImporter } from '../markdown-notebook-import';
import { observeNotebookCommand } from '../notebook-operation-telemetry';
import {
  withManagedWorkspaceMutationLock,
  resolveHeadCommit,
  commitOwnedPathsIfDirty,
} from '../workspace-git';
import { assertSafePath } from './path-allowlist';

export function registerNotebookOwnerHandlers(
  owner: NativeNotebookWorkingCopyOwner,
  getTarget: () => WebContents | null,
  markdownImporter: MarkdownNotebookImporter,
  flushClients?: () => Promise<void>,
  onLegacyDraftMigrationCompleted?: () => void
): () => void {
  handleGroup(notebookContract, {
    migrateLegacyProjectFiles: async (event, request) => {
      const sender = getTarget();
      if (!sender || sender.isDestroyed() || event.sender !== sender)
        throw new Error('The notebook client changed.');
      if (!flushClients)
        throw new Error('The notebook editing client cannot be settled for migration.');
      await flushClients();
      if (sender.isDestroyed() || getTarget() !== sender)
        throw new Error('The notebook client changed.');
      const root = await assertSafePath(request.workspaceRoot, { requireAbsolute: true });
      const expectedHead = await resolveHeadCommit(root);
      const result = await owner.migrateLegacyProjectFiles(root);
      return withManagedWorkspaceMutationLock(root, async () => {
        if (expectedHead && result.mutatedGitFiles.length) {
          const before = await resolveHeadCommit(root);
          await commitOwnedPathsIfDirty(root, 'Migrate legacy notebook files', {
            paths: result.mutatedGitFiles,
            forceInclude: result.mutatedGitFiles,
            expectedHead,
            expectedContentSha256: result.expectedContentSha256,
          });
          result.gitChanged = before !== (await resolveHeadCommit(root));
        }
        return result;
      });
    },
    resolveResourceReference: async (event, request) => {
      const sender = getTarget();
      if (!sender || sender.isDestroyed() || event.sender !== sender)
        throw new Error('The notebook client changed.');
      return owner.resolveResourceReference(request);
    },
    inspectConflict: async (event, documentId) => {
      const sender = getTarget();
      if (!sender || sender.isDestroyed() || event.sender !== sender)
        throw new Error('The notebook client changed.');
      return owner.inspectConflict(documentId);
    },
    resolveConflict: async (event, request) => {
      const sender = getTarget();
      if (!sender || sender.isDestroyed() || event.sender !== sender)
        throw new Error('The notebook client changed.');
      return owner.resolveConflict(request);
    },
    adoptMarkdown: async (event, request) => {
      const sender = getTarget();
      if (!sender || sender.isDestroyed() || event.sender !== sender)
        throw new Error('The notebook client changed.');
      return markdownImporter.adopt(request);
    },
    create: async (event, request) => {
      const sender = getTarget();
      if (!sender || sender.isDestroyed() || event.sender !== sender)
        throw new NativeDocumentCommandError(
          'NOTEBOOK_RENDERER_CHANGED',
          'The notebook editing client changed.',
          false
        );
      try {
        return {
          status: 'created' as const,
          snapshot: await observeNotebookCommand('create', () => owner.create(request)),
        };
      } catch (error) {
        return {
          status: 'failed' as const,
          code: error instanceof NativeDocumentCommandError ? error.code : 'NOTEBOOK_CREATE_FAILED',
          message: error instanceof Error ? error.message : String(error),
          stateChanged:
            error instanceof NativeDocumentCommandError ? error.stateChanged : ('unknown' as const),
          partialEffects: error instanceof NativeDocumentCommandError ? error.partialEffects : [],
        };
      }
    },
    completeLegacyDraftMigration: async (event, pendingIds) => {
      const sender = getTarget();
      if (!sender || sender.isDestroyed() || event.sender !== sender)
        throw new Error('The notebook editing client changed.');
      await owner.completeLegacyMigration(pendingIds);
      onLegacyDraftMigrationCompleted?.();
    },
    execute: async (event, request) => {
      const sender = getTarget();
      if (!sender || sender.isDestroyed() || event.sender !== sender)
        throw new NativeDocumentCommandError(
          'NOTEBOOK_RENDERER_CHANGED',
          'The notebook editing client changed.',
          false
        );
      return observeNotebookCommand(request.operation.kind, () => owner.execute(request));
    },
  });
  return owner.subscribe((snapshot) => {
    const target = getTarget();
    if (target && !target.isDestroyed()) sendRendererIpc(target, 'notebook:changed', snapshot);
  });
}
