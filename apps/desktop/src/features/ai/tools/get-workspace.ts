
import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import nativeAuthoringContract from '../../../../../../packages/core/agent-tools/native-authoring-contract.json';
import { useCanvasStore } from '../../canvas/public/store';
import { projectAuthorizedCanvas } from '../../canvas/public/project-authorized-canvas';
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
      const grantedRoots = projectScope?.kind === 'project-roots'
        ? new Set(projectScope.roots.map((root) => normalizePathForBoundary(root)))
        : null;
      const projects = (authorizedProjects ?? workspaceState.folders).filter(
        (project) => !grantedRoots || grantedRoots.has(normalizePathForBoundary(project.path))
      );
      const restricted = grantedRoots !== null;
      const approvedRoots = new Set(projects.map((project) => normalizePathForBoundary(project.path)));
      const displayedFolders = restricted
        ? workspaceState.folders.filter((folder) => approvedRoots.has(normalizePathForBoundary(folder.path)))
        : workspaceState.folders;
      const workspaceFile = restricted ? null : workspaceState.activeWorkspaceFile;
      const canvas = await projectAuthorizedCanvas(canvasState, projects, projectScope);
      const panels = Object.values(canvas.panels).map((panel) => ({
        id: panel.id,
        tabs: panel.tabs.map((tab) => {
          const iconContext = restricted ? undefined : projectTabStripTab(tab).iconContext;
          return {
            id: tab.id,
            type: tab.type,
            entityId: tab.entityId,
            label: tab.label,
            ...(iconContext && (iconContext.kind !== tab.type || iconContext.molecule || iconContext.path)
              ? { iconContext }
              : {}),
          };
        }),
        activeTabId: panel.activeTabId,
      }));
      return toolSuccess({
        ...(grantedCapabilities ? { capabilities: [...grantedCapabilities] } : {}),
        workspaceId: workspaceScopeFromState({ activeWorkspaceFile: workspaceFile, folders: displayedFolders }),
        workspaceFile,
        focusedPanelId: canvas.focusedPanelId,
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
        panels,
      });
    },
  });
}

export const getWorkspaceTool = createGetWorkspaceTool();
