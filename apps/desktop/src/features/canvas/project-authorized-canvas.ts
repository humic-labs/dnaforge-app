import type { AgentProjectScope } from '../../shared/agent-project-scope';
import { sequenceDocumentKey } from '../../shared/managed-sequence-document';
import { normalizePathForBoundary } from '../../shared/path-boundary';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import type { CanvasState, LayoutNode, Tab } from './types';

type CanvasProjection = Pick<CanvasState, 'panels' | 'layout' | 'focusedPanelId'>;

export function sameTabResource(first: Tab, second: Tab): boolean {
  const identity = (tab: Tab) => [
    tab.id,
    tab.type,
    tab.entityId,
    tab.sequenceDocument?.kind,
    tab.sequenceDocument ? sequenceDocumentKey(tab.sequenceDocument) : null,
    tab.trackView?.workspaceRoot,
    tab.trackView?.path,
    tab.artifactDocument?.workspaceRoot,
    tab.artifactDocument?.destinationPath,
    tab.artifactDocument?.artifactPath,
  ];
  return JSON.stringify(identity(first)) === JSON.stringify(identity(second));
}

export async function authorizedProjectTabs(
  tabs: readonly Tab[],
  projects: readonly WorkspaceFolder[],
  scope?: AgentProjectScope
): Promise<Tab[]> {
  if (scope?.kind !== 'project-roots') return [...tabs];
  const grantedRoots = new Set(scope.roots.map((root) => normalizePathForBoundary(root)));
  const approvedRoots = new Set(
    projects
      .map((project) => normalizePathForBoundary(project.path))
      .filter((root) => grantedRoots.has(root))
  );
  if (approvedRoots.size === 0) return [];

  const {
    getCatalogEntity,
    getCatalogEntityForFilePath,
    getCurrentSequenceFileForDocumentId,
    getWorkspaceRootById,
  } = await import('../../db/workspace-catalog');
  const rootsByWorkspace = new Map<number, Promise<string | null>>();
  const ownsWorkspace = async (workspaceId: number | null | undefined) => {
    if (workspaceId == null) return false;
    let root = rootsByWorkspace.get(workspaceId);
    if (!root) {
      root = getWorkspaceRootById(workspaceId);
      rootsByWorkspace.set(workspaceId, root);
    }
    const resolved = await root;
    return resolved !== null && approvedRoots.has(normalizePathForBoundary(resolved));
  };

  const permitted = await Promise.all(
    tabs.map(async (tab) => {
      const entity =
        (await getCatalogEntity(tab.entityId)) ?? (await getCatalogEntityForFilePath(tab.entityId));
      if (entity) return ownsWorkspace(entity.workspace_id);
      if (tab.type === 'sequence') {
        const documentId = tab.sequenceDocument
          ? sequenceDocumentKey(tab.sequenceDocument)
          : tab.entityId;
        const binding = await getCurrentSequenceFileForDocumentId(documentId);
        return ownsWorkspace(binding?.workspace_id);
      }
      if (tab.trackView?.path) {
        const view = await getCatalogEntityForFilePath(tab.trackView.path);
        return ownsWorkspace(view?.workspace_id);
      }
      return false;
    })
  );
  return tabs.filter((_tab, index) => permitted[index]);
}

function projectLayout(node: LayoutNode, panels: CanvasProjection['panels']): LayoutNode | null {
  if (node.type === 'panel') return panels[node.panelId] ? node : null;
  const retained = node.children.flatMap((child, index) => {
    const projected = projectLayout(child, panels);
    return projected ? [{ node: projected, size: node.sizes[index] ?? 0 }] : [];
  });
  if (retained.length === 0) return null;
  if (retained.length === 1) return retained[0].node;
  const total = retained.reduce((sum, child) => sum + child.size, 0);
  return {
    type: 'split',
    direction: node.direction,
    children: retained.map((child) => child.node),
    sizes: retained.map((child) =>
      total > 0 ? (child.size / total) * 100 : 100 / retained.length
    ),
  };
}

export async function projectAuthorizedCanvas(
  canvas: CanvasProjection,
  projects: readonly WorkspaceFolder[],
  scope?: AgentProjectScope
): Promise<CanvasProjection> {
  if (scope?.kind !== 'project-roots') return canvas;
  const allowed = new Set(
    await authorizedProjectTabs(
      Object.values(canvas.panels).flatMap((panel) => panel.tabs),
      projects,
      scope
    )
  );
  const panels: CanvasProjection['panels'] = {};
  for (const panel of Object.values(canvas.panels)) {
    const tabs = panel.tabs.filter((tab) => allowed.has(tab));
    if (tabs.length === 0) continue;
    panels[panel.id] = {
      ...panel,
      tabs,
      activeTabId: tabs.some((tab) => tab.id === panel.activeTabId) ? panel.activeTabId : null,
    };
  }
  return {
    panels,
    focusedPanelId:
      canvas.focusedPanelId && panels[canvas.focusedPanelId] ? canvas.focusedPanelId : null,
    layout: projectLayout(canvas.layout, panels) ?? {
      type: 'split',
      direction: 'horizontal',
      children: [],
      sizes: [],
    },
  };
}
