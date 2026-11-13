import { platform } from '../../platform';
import {
  WORKSPACE_FILE_RELOCATED_EVENT,
  type RelocateEntityFileInput,
  type RelocateEntityFileResult,
  type WorkspaceFileRelocatedDetail,
} from '../../shared/workspace-relocate-types';

export async function relocateRegistryFile(
  input: RelocateEntityFileInput
): Promise<RelocateEntityFileResult> {
  const result = await platform().workspace.relocateEntityFile(input);
  dispatchWorkspaceFileRelocated({ oldPath: input.oldPath, newPath: result.newPath });
  return result;
}

export function dispatchWorkspaceFileRelocated(detail: WorkspaceFileRelocatedDetail): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<WorkspaceFileRelocatedDetail>(WORKSPACE_FILE_RELOCATED_EVENT, { detail })
  );
}
