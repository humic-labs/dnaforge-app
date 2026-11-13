export { workspaceProjectsOutputSchema } from './workspace-edit-output-schemas';
import { z } from 'zod';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import {
  getWorkspaceProjectControl,
  listWorkspaceLibrary,
  archiveWorkspaceByPath,
  trashWorkspaceByPath,
  renameWorkspaceByPath,
  restoreWorkspace,
  restoreFromTrash,
  renameProject,
  removalWouldLeaveNoWorkspace,
} from '../../workspace-loader/public/workspace-project-control';
import { assertWorkspaceDocumentsClean } from '../../workspace/public/workspace-document-guards';
import { getCurrentWorkspaceScope, useWorkspaceStore } from '../../../stores/workspaceStore';
import { contentFingerprint } from '../../../db/entity-substrate/adapter';
import type { AgentProjectScope } from '../../../shared/agent-project-scope';
import { normalizePathForBoundary } from '../../../shared/path-boundary';

const identity = { projectId: z.string().min(1), expectedRevision: z.string().min(1) };
export const workspaceProjectsSchema = z
  .object({
    operation: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('list'),
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(100).default(25),
        })
        .strict(),
      z.object({ kind: z.literal('create'), name: z.string().trim().min(1).max(200) }).strict(),
      z
        .object({
          kind: z.literal('open'),
          projectId: z.string().min(1),
          makeCurrent: z.boolean().default(true),
        })
        .strict(),
      z
        .object({
          kind: z.literal('import'),
          source: z.discriminatedUnion('kind', [
            z
              .object({
                kind: z.literal('local-folder'),
                path: z.string().min(1),
                name: z.string().optional(),
              })
              .strict(),
            z.object({ kind: z.literal('workspace-file'), path: z.string().min(1) }).strict(),
            z
              .object({
                kind: z.literal('git-clone'),
                remoteUrl: z.string().url(),
                ref: z.string().optional(),
              })
              .strict(),
            z
              .object({
                kind: z.literal('community-workspace'),
                id: z.string().min(1),
                version: z.string().optional(),
              })
              .strict(),
            z
              .object({
                kind: z.literal('sample-template'),
                templateId: z.string().min(1),
                mode: z.enum(['reuse', 'fresh']).optional(),
              })
              .strict(),
          ]),
        })
        .strict(),
      z
        .object({ kind: z.literal('rename'), ...identity, name: z.string().trim().min(1).max(200) })
        .strict(),
      z.object({ kind: z.literal('close'), ...identity }).strict(),
      z.object({ kind: z.literal('archive'), ...identity }).strict(),
      z.object({ kind: z.literal('trash'), ...identity }).strict(),
      z.object({ kind: z.literal('restore'), ...identity }).strict(),
    ]),
  })
  .strict();

export function createWorkspaceProjectsTool(projectScope?: AgentProjectScope) {
  return resultTool({
    description:
      'List, create, show, import, rename, hide, archive, trash or restore native projects through the human project lifecycle. List provides exact stable project IDs and revision tokens. Trash retains the native recovery period; no permanent purge. Dirty work and the last displayed project are protected. Showing or selecting a project changes presentation and defaults. Registered project access and explicit caller restrictions remain independent.',
    inputSchema: workspaceProjectsSchema,
    execute: async ({ operation }) => {
      let attempted = false;
      const fromWorkspaceId = getCurrentWorkspaceScope();
      const routing = () => ({
        workspaceTransition: { fromWorkspaceId, toWorkspaceId: getCurrentWorkspaceScope() },
      });
      const fail = (code: string, error: string) =>
        toolFailure({
          code,
          error,
          retriable: false,
          stateChanged: attempted ? 'unknown' : false,
          partialEffects: [],
        });
      try {
        const library = await listWorkspaceLibrary();
        const mounted = useWorkspaceStore.getState().folders;
        const managed = [...library.active, ...library.archived, ...library.trashed];
        const approvedRoots = projectScope?.kind === 'project-roots'
          ? new Set(projectScope.roots.map((root) => normalizePathForBoundary(root))) : null;
        const entries = [
          ...managed.map((project) => ({
            projectId: project.repoUuid ?? project.repoPath,
            name: project.name,
            path: project.repoPath,
            state:
              project.trashedAt !== null
                ? 'trashed'
                : project.archivedAt !== null
                  ? 'archived'
                  : 'active',
            mounted: mounted.some((folder) => folder.path === project.repoPath),
            readOnly: project.access === 'reference',
            revision: contentFingerprint(JSON.stringify(project)),
          })),
          ...mounted
            .filter((folder) => !managed.some((project) => project.repoPath === folder.path))
            .map((folder) => ({
              projectId: folder.path,
              name: folder.name,
              path: folder.path,
              state: 'unmanaged',
              mounted: true,
              readOnly: Boolean(folder.pinned),
              revision: contentFingerprint(JSON.stringify(folder)),
            })),
        ].filter((project) => !approvedRoots || approvedRoots.has(normalizePathForBoundary(project.path)));
        if (operation.kind === 'list')
          return toolSuccess({
            projects: entries.slice(operation.offset, operation.offset + operation.limit),
            total: entries.length,
            nextOffset:
              operation.offset + operation.limit < entries.length
                ? operation.offset + operation.limit
                : null,
          });
        const control = getWorkspaceProjectControl();
        if (!control)
          return fail(
            'PROJECT_CONTROLS_NOT_READY',
            'Wait for the application workspace to finish mounting.'
          );
        if (operation.kind === 'create' || operation.kind === 'import') {
          if (approvedRoots)
            return fail('PROJECT_SCOPE_RESTRICTED', 'Project creation and import require an app-following grant.');
          attempted = true;
          const opened = await control.open(
            operation.kind === 'create'
              ? { kind: 'empty', name: operation.name }
              : operation.source,
            { makeCurrent: true }
          );
          if (!opened)
            return fail(
              'PROJECT_OPEN_FAILED',
              'The native project loader could not complete this request.'
            );
          return toolSuccess({
            opened: true,
            mounted: useWorkspaceStore
              .getState()
              .folders.map((folder) => ({ name: folder.name, path: folder.path })),
            sessionRoutingChanged: true,
            ...routing(),
          });
        }
        const project = entries.find((project) => project.projectId === operation.projectId);
        if (!project)
          return fail('PROJECT_NOT_FOUND', 'List projects for an exact current identity.');
        if (operation.kind === 'open') {
          if (project.state === 'archived' || project.state === 'trashed')
            return fail('PROJECT_INACTIVE', 'Restore this project before opening it.');
          attempted = true;
          if (
            !(await control.open(
              { kind: 'local-folder', path: project.path, name: project.name },
              { inPlace: true, makeCurrent: operation.makeCurrent }
            ))
          )
            return fail('PROJECT_OPEN_FAILED', 'The native loader could not open this project.');
          return toolSuccess({
            projectId: project.projectId,
            opened: true,
            sessionRoutingChanged: true,
            ...routing(),
          });
        }
        if (project.revision !== operation.expectedRevision)
          return fail('STALE_PROJECT', 'List projects again before changing this one.');
        if (project.readOnly && operation.kind !== 'close')
          return fail('PROJECT_READ_ONLY', 'This project is a read-only reference.');
        if (['close', 'archive', 'trash'].includes(operation.kind)) {
          if (project.mounted && removalWouldLeaveNoWorkspace(mounted, project.path))
            return fail('LAST_PROJECT', 'Open another project before closing this one.');
          await assertWorkspaceDocumentsClean(project.path);
        }
        if (operation.kind !== 'close' && project.state === 'unmanaged')
          return fail(
            'UNMANAGED_PROJECT',
            'This folder has no managed project lifecycle. Import it as a managed project first.'
          );
        attempted = true;
        if (operation.kind === 'rename') {
          let detail = '';
          const outcome = await renameProject(
            { repoPath: project.path, currentName: project.name },
            {
              promptForName: async () => operation.name,
              rename: renameWorkspaceByPath,
              renameMountedFolder: (path, name) =>
                useWorkspaceStore.getState().renameFolder(path, name),
              refreshLibrary: async () => {
                await control.refresh();
              },
              toast: (message) => {
                detail = message;
              },
            }
          );
          if (outcome !== 'renamed' && outcome !== 'unchanged')
            return fail('PROJECT_RENAME_FAILED', detail || outcome);
        } else if (operation.kind === 'restore') {
          const entry = managed.find((candidate) => candidate.repoPath === project.path);
          const target = entry?.repoUuid ?? entry;
          const changed = !target
            ? 0
            : project.state === 'trashed'
              ? await restoreFromTrash(target)
              : project.state === 'archived'
                ? await restoreWorkspace(target)
                : 0;
          if (!changed)
            return fail('PROJECT_RESTORE_FAILED', 'No archived or trashed project was restored.');
        } else {
          if (operation.kind !== 'close') {
            const changed =
              operation.kind === 'archive'
                ? await archiveWorkspaceByPath(project.path)
                : await trashWorkspaceByPath(project.path);
            if (!changed)
              return fail('PROJECT_LIFECYCLE_FAILED', 'The native project state did not change.');
          }
          await control.unmount(project.path);
        }
        await control.refresh();
        return toolSuccess({
          projectId: project.projectId,
          applied: true,
          operation: operation.kind,
          sessionRoutingChanged: ['close', 'archive', 'trash'].includes(operation.kind),
          ...routing(),
        });
      } catch (error) {
        return fail(
          'PROJECT_OPERATION_FAILED',
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  });
}
