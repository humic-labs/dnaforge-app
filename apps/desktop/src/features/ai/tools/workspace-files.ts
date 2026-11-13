export { workspaceFilesOutputSchema } from './workspace-edit-output-schemas';
import { z } from 'zod';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { platform } from '../../../platform';
import { createFolderArtifact } from '../../../components/folder-create';
import { relocateRegistryFile } from '../../workspace/public/relocate-registry-file';
import { recordWorkspaceArtifactFileRenameInProjectMemory } from '../../../db/workspace-artifacts';
import { withRendererWorkspaceMutation } from '../../../services/workspace-mutation-transaction';
import { reconcileWorkspaceAfterFilesChanged } from '../../../services/workspace-operations';
import { assertWorkspaceDocumentsClean } from '../../workspace/public/workspace-document-guards';
import { resolveWorkspaceEntry, inspectWorkspaceEntry } from './workspace-entry';
import { listFileTrash, mutateFileLifecycle, FileLifecycleError } from '../../workspace/public/file-lifecycle-commands';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';

const path = z.string().min(1).describe('Exact project-qualified path or admitted absolute path.');
export const workspaceFilesSchema = z
  .object({
    operation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('inspect'), path }).strict(),
      z.object({ kind: z.literal('create-folder'), path }).strict(),
      z.object({ kind: z.literal('trash'), path, expectedRevision: z.string().min(1).describe('Exact source revision from inspect.') }).strict(),
      z.object({ kind: z.literal('list-trash'), project: z.string().min(1), offset: z.number().int().min(0).default(0) }).strict(),
      z.object({ kind: z.literal('restore'), project: z.string().min(1), entryId: z.string().uuid(), expectedRevision: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('delete-permanently'), project: z.string().min(1), entryId: z.string().uuid(), expectedRevision: z.string().min(1) }).strict(),
      z
        .object({
          kind: z.literal('relocate'),
          path,
          destination: path,
          expectedRevision: z
            .string()
            .min(1)
            .describe('Exact opaque revision returned by inspecting the source path.'),
        })
        .strict(),
    ]),
  })
  .strict();

export const WORKSPACE_FILES_DESCRIPTION =
  'Inspect workspace entries, create folders, relocate, trash and restore native files through the human file owner. Use list_files to discover entries. Paths must identify an exact mounted project. Inspect first and pass its exact revision before relocate or trash. list-trash takes an exact project name/root and returns recoverable entry IDs and revisions. Restore uses that exact entry and refuses an occupied original name. delete-permanently applies only to a current Trash entry and opens the native human confirmation dialog; model-supplied approval is never accepted. Dirty drafts, reference projects and internal metadata are protected. Move whole native packages, not declared members. Relocation and restore preserve native identities. File Trash is local to its project and is not synchronized.';

export function createWorkspaceFilesTool(folders: WorkspaceFolder[]) {
  const inspectFile = async (target: ReturnType<typeof resolveWorkspaceEntry>) => {
    const canTrash = Boolean(
      target.relativePath && target.relativePath !== '.' && !target.folder.pinned
    );
    return { ...await inspectWorkspaceEntry(target), canTrash };
  };
  return resultTool({
    description: WORKSPACE_FILES_DESCRIPTION,
    inputSchema: workspaceFilesSchema,
    execute: async ({ operation }, { abortSignal }) => {
      let changed: boolean | 'unknown' = false;
      const partialEffects: Array<Record<string, unknown>> = [];
      const fail = (code: string, error: string) =>
        toolFailure({
          code,
          error,
          retriable: code === 'CANCELED',
          stateChanged: changed,
          partialEffects,
        });
      try {
        if (operation.kind === 'list-trash' || operation.kind === 'restore' || operation.kind === 'delete-permanently') {
          const project = resolveExplicitProjectRoot(folders, operation.project);
          if (!project || project.pinned) return fail('PROJECT_NOT_WRITABLE', 'Choose an exact mounted writable project.');
          if (operation.kind === 'list-trash') return toolSuccess(await listFileTrash(project.path, operation.offset));
          changed = 'unknown';
          const result = await mutateFileLifecycle({ kind: operation.kind === 'restore' ? 'restore' : 'purge', workspaceRoot: project.path,
            entryId: operation.entryId, expectedRevision: operation.expectedRevision }, abortSignal);
          if (!result) { changed = false; return fail('CANCELED', 'Permanent deletion was not confirmed.'); }
          changed = true;
          if ('warnings' in result && result.warnings.length) { partialEffects.push(result); return fail('FILE_LIFECYCLE_PARTIAL', result.warnings.join(' ')); }
          return toolSuccess(result);
        }
        const target = resolveWorkspaceEntry(
          folders,
          operation.path,
          operation.kind !== 'inspect',
          operation.kind === 'inspect'
        );
        if (operation.kind === 'inspect') {
          return toolSuccess(await inspectFile(target));
        }
        if (operation.kind === 'trash') {
          changed = 'unknown';
          const result = await mutateFileLifecycle({ kind: 'trash', workspaceRoot: target.folder.path, path: target.absolutePath, expectedRevision: operation.expectedRevision }, abortSignal);
          if (!result) { changed = false; return fail('CANCELED', 'Stopped before moving the file.'); }
          changed = true;
          if ('warnings' in result && result.warnings.length) { partialEffects.push(result); return fail('FILE_LIFECYCLE_PARTIAL', result.warnings.join(' ')); }
          return toolSuccess(result);
        }
        abortSignal?.throwIfAborted();
        return await withRendererWorkspaceMutation(target.folder.path, async (mutationToken) => {
          abortSignal?.throwIfAborted();
          if (operation.kind === 'relocate') {
            const current = await inspectFile(target);
            if (current.revision !== operation.expectedRevision)
              return fail(
                'STALE_FILE',
                'The entry changed. Inspect its current path before moving it.'
              );
            await assertWorkspaceDocumentsClean(target.absolutePath);
          }
          const destination =
            operation.kind === 'relocate'
              ? resolveWorkspaceEntry(folders, operation.destination, true)
              : target;
          if (destination.folder.path !== target.folder.path)
            return fail(
              'DIFFERENT_PROJECT',
              'Relocate within one project to preserve native identities.'
            );
          if (
            !(await platform().fs.validateWorkspacePath({
              workspaceRoot: destination.folder.path,
              path: destination.absolutePath,
              allowMissing: true,
              artifactNoun: 'workspace entry',
            }))
          )
            return fail('OUTSIDE_WORKSPACE', 'Destination is outside the admitted workspace.');
          if (await platform().fs.exists(destination.absolutePath))
            return fail(
              'DESTINATION_EXISTS',
              'Choose an unused destination; existing content is preserved.'
            );
          abortSignal?.throwIfAborted();
          changed = 'unknown';
          if (operation.kind === 'create-folder') {
            const slash = Math.max(
              target.absolutePath.lastIndexOf('/'),
              target.absolutePath.lastIndexOf('\\')
            );
            await createFolderArtifact({
              path: target.absolutePath,
              name: target.absolutePath.slice(slash + 1),
              parentPath: target.absolutePath.slice(0, slash),
              workspaceRoot: target.folder.path,
              createdBy: 'agent',
              mutationToken,
            });
          } else {
            const relocated = await relocateRegistryFile({
              workspaceRoot: target.folder.path,
              oldPath: target.absolutePath,
              newPath: destination.absolutePath,
              actor: 'agent',
              mutationToken,
            });
            partialEffects.push({
              kind: 'relocated',
              oldPath: target.relativePath,
              newPath: destination.relativePath,
            });
            await recordWorkspaceArtifactFileRenameInProjectMemory({
              oldPath: target.absolutePath,
              newPath: relocated.newPath,
              workspaceRoot: target.folder.path,
              mutationToken,
            });
          }
          changed = true;
          partialEffects.push({
            kind: operation.kind,
            project: destination.folder.path,
            path: destination.relativePath,
          });
          await reconcileWorkspaceAfterFilesChanged({
            workspaceRoot: target.folder.path,
            mutationToken,
            strict: true,
            notifyGitStatus: true,
          });
          return toolSuccess({
            ...(await inspectFile(destination)),
            changed: true,
            ...(abortSignal?.aborted
              ? {
                  stopRequested: true,
                  note: 'The native operation settled after Stop. Inspect this receipt before retrying.',
                }
              : {}),
          });
        });
      } catch (error) {
        if (error instanceof FileLifecycleError) {
          changed = error.receipt.stateChanged;
          if (changed !== false) partialEffects.push(error.receipt);
          return fail(error.receipt.code, error.message);
        }
        if (
          operation.kind === 'relocate' &&
          error instanceof Error &&
          error.message.includes('RELOCATE_SEQUENCE_PACKAGE_MEMBER:')
        ) {
          changed = false;
          return fail(
            'RELOCATE_SEQUENCE_PACKAGE_MEMBER',
            'Move the whole sequence package. No files were moved.'
          );
        }
        if (changed === false && abortSignal?.aborted)
          return fail('CANCELED', 'Stopped before changing files.');
        return fail(
          'WORKSPACE_FILE_FAILED',
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  });
}
