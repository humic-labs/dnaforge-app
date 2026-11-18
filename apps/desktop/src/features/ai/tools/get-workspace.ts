
import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import nativeAuthoringContract from '../../../../../../packages/core/agent-tools/native-authoring-contract.json';
import { useCanvasStore } from '../../canvas/public/store';
import { useWorkspaceStore, workspaceScopeFromState } from '../../../stores/workspaceStore';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import type { AgentProjectScope } from '../../../shared/agent-project-scope';
import { normalizePathForBoundary } from '../../../shared/path-boundary';
import { projectTabStripTab } from '../../canvas/tab-menu-presentation';

export const GET_WORKSPACE_DESCRIPTION =
  'Read authorized registered authoring projects, reference folders, displayed folders, tabs and current caller capabilities. Choose notebook and design destinations from projects; pinned referenceFolders are sources, not authoring destinations. Displayed folders and the current selection do not define project access. ' +
  nativeAuthoringContract.instructions;

export const getWorkspaceSchema = z.object({}).strict();

export const getWorkspaceOutputSchema = z.object({
  ok: z.literal(true),
  capabilities: z.array(z.string()).optional(),
  projects: z.array(z.object({ name: z.string(), path: z.string() }).strict()),
  referenceFolders: z.array(z.object({ name: z.string(), path: z.string() }).strict()),
  workspaceId: z.string().nullable(),
  workspaceFile: z.string().nullable(),
  focusedPanelId: z.string().nullable(),
  folders: z.array(
    z.object({ name: z.string(), path: z.string(), pinned: z.boolean().optional() })
  ),
  panels: z.array(
    z.object({
      id: z.string(),
      tabs: z.array(
        z.object({
          id: z.string(), type: z.string(), entityId: z.string(), label: z.string(),
          iconContext: z.object({
            kind: z.string().optional(), molecule: z.string().optional(), path: z.string().optional(),
            packageKind: z.string().optional(), isDirectory: z.boolean().optional(),
          }).optional(),
        })
      ),
      activeTabId: z.string().nullable(),
    })
  ),
});

export function createGetWorkspaceTool(grantedCapabilities?: readonly string[], authorizedProjects?: readonly WorkspaceFolder[], projectScope?: AgentProjectScope) {
  return resultTool({
    description: GET_WORKSPACE_DESCRIPTION,
    inputSchema: getWorkspaceSchema as z.ZodTypeAny,
    execute: async (_params: z.infer<typeof getWorkspaceSchema>) => {
      const canvasState = useCanvasStore.getState();
      const workspaceState = useWorkspaceStore.getState();
      const projects = authorizedProjects ?? workspaceState.folders;
      const restricted = projectScope?.kind === 'project-roots';
      const approvedRoots = new Set(projects.map((project) => normalizePathForBoundary(project.path)));
      const displayedFolders = restricted
        ? workspaceState.folders.filter((folder) => approvedRoots.has(normalizePathForBoundary(folder.path)))
        : workspaceState.folders;
      const workspaceFile = restricted ? null : workspaceState.activeWorkspaceFile;
      return toolSuccess({
        ...(grantedCapabilities ? { capabilities: [...grantedCapabilities] } : {}),
        workspaceId: workspaceScopeFromState({ activeWorkspaceFile: workspaceFile, folders: displayedFolders }),
        workspaceFile,
        focusedPanelId: canvasState.focusedPanelId,
        projects: projects
          .filter((folder) => !folder.pinned)
          .map((folder) => ({ name: folder.name, path: folder.path })),
        referenceFolders: projects
          .filter((folder) => folder.pinned)
          .map((folder) => ({ name: folder.name, path: folder.path })),
        folders: displayedFolders.map((folder) => ({
          name: folder.name,
          path: folder.path,
          ...(folder.pinned ? { pinned: true } : {}),
        })),
        panels: Object.values(canvasState.panels).map((panel) => ({
          id: panel.id,
          tabs: panel.tabs.map((t) => {
            const iconContext = projectTabStripTab(t).iconContext;
            return {
              id: t.id,
              type: t.type,
              entityId: t.entityId,
              label: t.label,
              ...(iconContext &&
                (iconContext.kind !== t.type || iconContext.molecule || iconContext.path)
                ? { iconContext }
                : {}),
            };
          }),
          activeTabId: panel.activeTabId,
        })),
      });
    },
  });
}

export const getWorkspaceTool = createGetWorkspaceTool();
