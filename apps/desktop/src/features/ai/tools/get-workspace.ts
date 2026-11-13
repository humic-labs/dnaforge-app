
import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import nativeAuthoringContract from '../../../../../../packages/core/agent-tools/native-authoring-contract.json';
import { useCanvasStore } from '../../canvas/public/store';
import { useWorkspaceStore, workspaceScopeFromState } from '../../../stores/workspaceStore';

export const GET_WORKSPACE_DESCRIPTION =
  'Read mounted authoring projects, reference folders, tabs and current caller capabilities. Choose notebook and design destinations from projects; pinned referenceFolders are sources, not authoring destinations. ' +
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
        z.object({ id: z.string(), type: z.string(), entityId: z.string(), label: z.string() })
      ),
      activeTabId: z.string().nullable(),
    })
  ),
});

export function createGetWorkspaceTool(grantedCapabilities?: readonly string[]) {
  return resultTool({
    description: GET_WORKSPACE_DESCRIPTION,
    inputSchema: getWorkspaceSchema as z.ZodTypeAny,
    execute: async (_params: z.infer<typeof getWorkspaceSchema>) => {
      const canvasState = useCanvasStore.getState();
      const workspaceState = useWorkspaceStore.getState();
      return toolSuccess({
        ...(grantedCapabilities ? { capabilities: [...grantedCapabilities] } : {}),
        workspaceId: workspaceScopeFromState(workspaceState),
        workspaceFile: workspaceState.activeWorkspaceFile,
        focusedPanelId: canvasState.focusedPanelId,
        projects: workspaceState.folders
          .filter((folder) => !folder.pinned)
          .map((folder) => ({ name: folder.name, path: folder.path })),
        referenceFolders: workspaceState.folders
          .filter((folder) => folder.pinned)
          .map((folder) => ({ name: folder.name, path: folder.path })),
        folders: workspaceState.folders.map((folder) => ({
          name: folder.name,
          path: folder.path,
          ...(folder.pinned ? { pinned: true } : {}),
        })),
        panels: Object.values(canvasState.panels).map((panel) => ({
          id: panel.id,
          tabs: panel.tabs.map((t) => ({
            id: t.id,
            type: t.type,
            entityId: t.entityId,
            label: t.label,
          })),
          activeTabId: panel.activeTabId,
        })),
      });
    },
  });
}

export const getWorkspaceTool = createGetWorkspaceTool();
