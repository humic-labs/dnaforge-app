import { useEffect, useRef, type MutableRefObject } from 'react';
import { toUserMessage } from '@waypoint/user-messages';
import { platform } from '../platform';
import type { WorkspaceFolder } from '../stores/workspaceStore';
import { useToastStore } from '../stores/toast-store';
import type { UseWorkspaceReturn } from './useWorkspace';
import { openWorkspaceFromSource } from '../features/workspace-loader/open-workspace-from-source';
import { observeWorkspaceSetPath } from '../features/workspace-loader/workspace-telemetry';
import {
  loadWorkspaceDeliveryReceipts,
  rememberWorkspaceDeliveryReceipt,
} from '../features/workspace-loader/workspace-delivery-receipts';
import { soleWritableProjectRoot } from '../shared/project-root-selection';

type UseWorkspacePathSyncOptions = {
  workspacePath: string | null;
  workspaceLoading: boolean;
  folders: WorkspaceFolder[];
  addFolder: (path: string, name?: string, options?: { pinned?: boolean }) => void;
  setWorkspacePath: UseWorkspaceReturn['setWorkspacePath'];
  removingWorkspacePathRef: MutableRefObject<string | null>;
};

/** Keeps the legacy current-workspace setting and mounted project roots in sync. */
export function useWorkspacePathSync({
  workspacePath,
  workspaceLoading,
  folders,
  addFolder,
  setWorkspacePath,
  removingWorkspacePathRef,
}: UseWorkspacePathSyncOptions): void {
  const projectedWorkspacePathRef = useRef<string | null>(null);
  const deliveryIdsRef = useRef<Set<string> | null>(null);
  const inFlightDeliveryIdsRef = useRef(new Set<string>());
  if (deliveryIdsRef.current === null) {
    deliveryIdsRef.current = loadWorkspaceDeliveryReceipts(sessionStorage);
  }

  useEffect(() => {
    if (workspaceLoading) return;
    const workspacePathChanged = workspacePath !== projectedWorkspacePathRef.current;
    projectedWorkspacePathRef.current = workspacePath;

    if (
      workspacePath &&
      workspacePathChanged &&
      !folders.some((folder) => folder.path === workspacePath)
    ) {
      if (removingWorkspacePathRef.current === workspacePath) return;
      addFolder(workspacePath);
    }

    if (!workspacePath && folders.length > 0) {
      const userFolder = soleWritableProjectRoot(folders);
      if (userFolder) {
        if (removingWorkspacePathRef.current === userFolder.path) return;
        setWorkspacePath(userFolder.path);
      }
    }
    if (
      removingWorkspacePathRef.current &&
      workspacePath !== removingWorkspacePathRef.current &&
      !folders.some((folder) => folder.path === removingWorkspacePathRef.current)
    ) {
      removingWorkspacePathRef.current = null;
    }
  }, [
    workspacePath,
    workspaceLoading,
    folders,
    addFolder,
    setWorkspacePath,
    removingWorkspacePathRef,
  ]);

  useEffect(() => {
    try {
      const currentPlatform = platform();
      if (!currentPlatform?.on) return;
      return currentPlatform.on('workspace:set-path', (...args: unknown[]) => {
        const path = typeof args[0] === 'string' ? args[0] : '';
        if (!path) return;
        const deliveryId = typeof args[1] === 'string' ? args[1] : undefined;
        const telemetryContext = args[2];
        if (deliveryId) {
          const delivered = deliveryIdsRef.current;
          if (!delivered) return;
          if (delivered.has(deliveryId) || inFlightDeliveryIdsRef.current.has(deliveryId)) return;
          inFlightDeliveryIdsRef.current.add(deliveryId);
        }

        console.log('[App] Setting workspace from main process:', path);
        void openWorkspaceFromSource(
          { kind: 'local-folder', path },
          { inPlace: true, makeCurrent: true },
          { currentLegacyWorkspacePath: workspacePath, setLegacyWorkspacePath: setWorkspacePath }
        )
          .then(() => {
            if (deliveryId) {
              const delivered = deliveryIdsRef.current;
              if (
                !delivered ||
                !rememberWorkspaceDeliveryReceipt(delivered, deliveryId, sessionStorage)
              ) {
                return;
              }
            }
            observeWorkspaceSetPath(path, deliveryId, telemetryContext);
          })
          .catch((error) => {
            console.error('[App] Failed to mount workspace from main process:', error);
            useToastStore
              .getState()
              .addToast(toUserMessage(error, 'failure.failed-to-open-project'), {
                definition: 'app-failed-to-open-project',
              });
          })
          .finally(() => {
            if (deliveryId) inFlightDeliveryIdsRef.current.delete(deliveryId);
          });
      });
    } catch {}
  }, [setWorkspacePath, workspacePath]);
}
