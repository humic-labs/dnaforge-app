export interface WorkspaceSessionCanvasState {
  readonly focusedPanelId: string | null;
  readonly panels: Readonly<
    Record<
      string,
      {
        readonly activeTabId: string | null;
        readonly tabs: readonly { readonly id: string }[];
      }
    >
  >;
}

export interface WorkspaceSessionCanvasSource {
  readonly getState: () => WorkspaceSessionCanvasState;
  readonly subscribe: (listener: () => void) => () => void;
}

interface WorkspaceSessionTabBinding {
  readonly workspaceId: string;
  readonly path: string;
}

interface WorkspaceSessionTabController {
  readonly getState: () => {
    readonly activeWorkspaceId: string | null;
    readonly activeFilePath: string | null;
    readonly openFiles: readonly { readonly file: { readonly path: string } }[];
  };
  readonly activateFile: (path: string) => void;
  readonly deactivateFile: () => void;
  readonly closeFile: (path: string) => void;
}

export function createWorkspaceSessionCanvasBindings(controller: WorkspaceSessionTabController) {
  const bindings = new Map<string, WorkspaceSessionTabBinding>();
  let canvasSource: WorkspaceSessionCanvasSource | null = null;
  let unsubscribeCanvas: (() => void) | null = null;

  const synchronize = (): void => {
    if (!canvasSource) return;
    const canvas = canvasSource.getState();
    const presentTabIds = new Set(
      Object.values(canvas.panels).flatMap((panel) => panel.tabs.map((tab) => tab.id))
    );
    const removed: WorkspaceSessionTabBinding[] = [];
    for (const [tabId, binding] of bindings) {
      if (presentTabIds.has(tabId)) continue;
      bindings.delete(tabId);
      removed.push(binding);
    }

    const session = controller.getState();
    for (const binding of removed) {
      if (binding.workspaceId !== session.activeWorkspaceId) continue;
      const stillPresented = [...bindings.values()].some(
        (candidate) =>
          candidate.workspaceId === binding.workspaceId && candidate.path === binding.path
      );
      if (!stillPresented) controller.closeFile(binding.path);
    }

    const focusedPanel = canvas.focusedPanelId ? canvas.panels[canvas.focusedPanelId] : null;
    const focusedBinding = focusedPanel?.activeTabId
      ? bindings.get(focusedPanel.activeTabId)
      : undefined;
    if (
      focusedBinding?.workspaceId === session.activeWorkspaceId &&
      session.openFiles.some((opened) => opened.file.path === focusedBinding.path)
    ) {
      if (session.activeFilePath !== focusedBinding.path) {
        controller.activateFile(focusedBinding.path);
      }
    } else if (session.activeFilePath !== null) {
      controller.deactivateFile();
    }
  };

  return {
    configure(source: WorkspaceSessionCanvasSource): void {
      if (canvasSource === source) return;
      unsubscribeCanvas?.();
      unsubscribeCanvas = null;
      canvasSource = source;
      if (bindings.size > 0) {
        unsubscribeCanvas = source.subscribe(synchronize);
        synchronize();
      }
    },
    bind(tabId: string, relativePath: string): void {
      const state = controller.getState();
      if (!state.activeWorkspaceId) return;
      if (!state.openFiles.some((opened) => opened.file.path === relativePath)) return;
      bindings.set(tabId, {
        workspaceId: state.activeWorkspaceId,
        path: relativePath,
      });
      if (!unsubscribeCanvas && canvasSource) {
        unsubscribeCanvas = canvasSource.subscribe(synchronize);
      }
      synchronize();
    },
  };
}
