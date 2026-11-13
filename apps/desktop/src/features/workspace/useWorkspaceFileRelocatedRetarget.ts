import { useEffect } from 'react';
import {
  WORKSPACE_FILE_RELOCATED_EVENT,
  type WorkspaceFileRelocatedDetail,
} from '../../shared/workspace-relocate-types';
import { useCanvasStore } from '../canvas/public/store';

export function useWorkspaceFileRelocatedRetarget(): void {
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<WorkspaceFileRelocatedDetail>).detail;
      if (!detail || !detail.oldPath || !detail.newPath) return;
      const { oldPath, newPath } = detail;
      useCanvasStore.getState().retargetTabsUnderPath(oldPath, newPath);
    };
    window.addEventListener(WORKSPACE_FILE_RELOCATED_EVENT, handler);
    return () => window.removeEventListener(WORKSPACE_FILE_RELOCATED_EVENT, handler);
  }, []);
}
